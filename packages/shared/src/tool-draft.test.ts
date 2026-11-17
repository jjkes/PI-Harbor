import { describe, expect, it } from "vitest";
import type { ToolDraftChange } from "./types.js";
import {
  TOOL_DRAFT_GAP,
  applyToolDraftChanges,
  diffToolDraftArgs,
  mergeToolDraftEvents,
  snapshotToolDraftArgs,
  toolDraftPayloadChars,
  type ToolDraftAgentEvent,
} from "./tool-draft.js";

function frame(changes: ToolDraftChange[], phase: ToolDraftAgentEvent["phase"] = "streaming"): ToolDraftAgentEvent {
  return {
    type: "tool_draft",
    toolCallId: "call-1",
    toolName: "Write",
    messageId: "m1",
    phase,
    ...(phase === "streaming" ? { changes } : {}),
  };
}

/** Partial argument objects the way a streaming JSON parser reports them. */
function writeStream(content: string, chunk: number): unknown[] {
  const steps: unknown[] = [{}, { path: "src/a" }, { path: "src/a.ts" }];
  for (let end = 0; end <= content.length; end += chunk) {
    steps.push({ path: "src/a.ts", content: content.slice(0, end) });
  }
  steps.push({ path: "src/a.ts", content });
  return steps;
}

describe("applyToolDraftChanges", () => {
  it("builds arguments from sets and appends without mutating the input", () => {
    const start = { path: "a" };
    const next = applyToolDraftChanges(start, [
      { op: "append", path: ["path"], text: ".ts", offset: 1 },
      { op: "set", path: ["content"], value: "x" },
      { op: "append", path: ["content"], text: "yz", offset: 1 },
    ]);
    expect(next).toEqual({ path: "a.ts", content: "xyz" });
    expect(start).toEqual({ path: "a" });
  });

  it("creates arrays for numeric segments and objects for keys", () => {
    expect(applyToolDraftChanges(undefined, [
      { op: "set", path: ["todos", 0, "title"], value: "write" },
    ])).toEqual({ todos: [{ title: "write" }] });
  });

  it("reports a gap when an append does not line up with its string", () => {
    expect(applyToolDraftChanges({ content: "ab" }, [
      { op: "append", path: ["content"], text: "d", offset: 3 },
    ])).toBe(TOOL_DRAFT_GAP);
    expect(applyToolDraftChanges({ content: 1 }, [
      { op: "append", path: ["content"], text: "d", offset: 1 },
    ])).toBe(TOOL_DRAFT_GAP);
    expect(applyToolDraftChanges({}, [
      { op: "append", path: ["content"], text: "d", offset: 0 },
    ])).toBe(TOOL_DRAFT_GAP);
  });

  it("refuses an index that would allocate a huge sparse array", () => {
    expect(applyToolDraftChanges([], [
      { op: "set", path: [1_000_000], value: "x" },
    ])).toBe(TOOL_DRAFT_GAP);
  });

  it("keeps a __proto__ key as data instead of rewriting the prototype", () => {
    const next = applyToolDraftChanges({}, [
      { op: "set", path: ["__proto__", "polluted"], value: true },
    ]) as Record<string, unknown>;
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(next, "__proto__")).toBe(true);
  });
});

describe("diffToolDraftArgs", () => {
  it("round-trips a streamed Write and sends each character once", () => {
    const content = "line\n".repeat(2_000);
    const steps = writeStream(content, 37);
    let previous: unknown;
    let rebuilt: unknown;
    let chars = 0;
    let frames = 0;
    for (const step of steps) {
      const next = snapshotToolDraftArgs(step);
      const changes = diffToolDraftArgs(previous, next);
      previous = next;
      if (changes.length === 0) continue;
      frames += 1;
      chars += toolDraftPayloadChars(frame(changes));
      rebuilt = applyToolDraftChanges(rebuilt, changes);
    }
    expect(rebuilt).toEqual({ path: "src/a.ts", content });
    expect(chars).toBeLessThanOrEqual(2 * content.length + 1024 * frames);
    // Without deltas the same stream would carry ~N²/2/chunk characters.
    expect(chars).toBeLessThan(content.length * 2);
  });

  it("replaces a string that shrank or was rewritten", () => {
    expect(diffToolDraftArgs({ a: "abc" }, { a: "ab" })).toEqual([
      { op: "set", path: ["a"], value: "ab" },
    ]);
  });

  it("replaces the parent when a key disappears", () => {
    expect(diffToolDraftArgs({ a: "x", b: "y" }, { a: "x" })).toEqual([
      { op: "set", path: [], value: { a: "x" } },
    ]);
  });

  it("walks a growing array and appends inside its newest item", () => {
    const previous = { todos: [{ title: "wr" }] };
    const next = { todos: [{ title: "write" }, { title: "" }] };
    const changes = diffToolDraftArgs(previous, next);
    expect(changes).toEqual([
      { op: "append", path: ["todos", 0, "title"], text: "ite", offset: 2 },
      { op: "set", path: ["todos", 1], value: { title: "" } },
    ]);
    expect(applyToolDraftChanges(previous, changes)).toEqual(next);
  });
});

describe("mergeToolDraftEvents", () => {
  it("folds contiguous appends and a set followed by appends", () => {
    const merged = mergeToolDraftEvents(
      frame([{ op: "set", path: ["content"], value: "a" }]),
      frame([
        { op: "append", path: ["content"], text: "b", offset: 1 },
        { op: "append", path: ["content"], text: "c", offset: 2 },
      ]),
    );
    expect(merged?.changes).toEqual([{ op: "set", path: ["content"], value: "abc" }]);
  });

  it("never reorders writes to overlapping paths", () => {
    const earlier: ToolDraftChange[] = [
      { op: "set", path: ["content"], value: "ab" },
      { op: "set", path: [], value: { content: "Z" } },
    ];
    const later: ToolDraftChange[] = [{ op: "append", path: ["content"], text: "c", offset: 1 }];
    const merged = mergeToolDraftEvents(frame(earlier), frame(later))!;
    expect(applyToolDraftChanges(undefined, merged.changes ?? [])).toEqual(
      applyToolDraftChanges(applyToolDraftChanges(undefined, earlier), later),
    );
    expect(merged.changes).toHaveLength(3);
  });

  it("keeps lifecycle frames and other calls separate", () => {
    const streaming = frame([{ op: "set", path: [], value: {} }]);
    expect(mergeToolDraftEvents(streaming, frame([], "complete"))).toBeUndefined();
    expect(mergeToolDraftEvents(streaming, { ...streaming, toolCallId: "call-2" })).toBeUndefined();
  });
});

describe("snapshotToolDraftArgs", () => {
  it("is not affected by later mutation of the provider's object", () => {
    const live = { path: "a", nested: { items: ["x"] } };
    const snapshot = snapshotToolDraftArgs(live);
    live.path = "b";
    live.nested.items.push("y");
    expect(snapshot).toEqual({ path: "a", nested: { items: ["x"] } });
  });

  it("gives up past its node budget", () => {
    expect(snapshotToolDraftArgs({ items: Array.from({ length: 50 }, () => "x") }, 10)).toBeUndefined();
  });
});
