import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ContextCompactionRecord, UiMessage } from "@pi-harbor/shared";
import { projectHistoryContextEntries } from "./history-projection.js";
import { replaySessionSystemContext, type SystemContextCheckpoint } from "./session-system-context.js";
import { readSystemMessage } from "./system-transcript-journal.js";

const at = (minute: number) => `2026-11-05T00:${String(minute).padStart(2, "0")}:00.000Z`;
const tool = (name: string) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} } });
const initial = { role: "system", content: "Base prompt", timestamp: 1, toolsAdded: [tool("Read")] };
const delta = { role: "system", content: "", timestamp: 3, toolsRemoved: [{ name: "Read" }], toolsAdded: [tool("Grep")] };
const folded = { role: "system", content: "Checkpoint prompt", timestamp: 2, toolsAdded: [tool("Glob")] };

function user(id: string, minute: number): UiMessage {
  return { id, role: "user", content: id, createdAt: at(minute) };
}
function system(id: string, message: object, minute: number, beforeMessageId: string, extra: Partial<UiMessage> = {}): UiMessage {
  return {
    id, role: "system", content: "", createdAt: at(minute),
    modelSystem: { version: 1, messageJson: JSON.stringify(message), beforeMessageId },
    ...extra,
  };
}
function checkpoint(throughMessageId: string): ContextCompactionRecord {
  return {
    id: "cp", summary: "Past work", throughMessageId, tokensBefore: 100, createdAt: at(4),
    details: { systemMessageJson: JSON.stringify(folded) },
  };
}

const history: UiMessage[] = [
  user("u1", 1),
  { id: "a1", role: "assistant", content: "Done.", createdAt: at(2) },
  { id: "t1", role: "tool", content: "", createdAt: at(2), toolCallId: "t1", toolName: "Read" },
  user("u2", 5),
  system("s1", initial, 0, "u1"),
  system("s2", delta, 5, "u2"),
];

describe("replaySessionSystemContext", () => {
  it("folds every system row in transcript order", () => {
    expect(replaySessionSystemContext(history)).toEqual({
      systemPrompt: "Base prompt",
      tools: [tool("Grep")],
      updatedAt: at(5),
    });
  });

  it("starts from the latest checkpoint and keeps only later rows", () => {
    expect(replaySessionSystemContext(history, checkpoint("a1"))).toEqual({
      systemPrompt: "Checkpoint prompt",
      tools: [tool("Glob"), tool("Grep")],
      updatedAt: at(5),
    });
  });

  it("anchors only on a carrier id the runtime synthesizes", () => {
    // `t2` has no assistant above it, so the runtime synthesizes `t2:carrier`;
    // `t3` reuses that carrier and `t1` rides on `a1`, so neither id exists.
    const orphaned: UiMessage[] = [
      user("u1", 1),
      { id: "a1", role: "assistant", content: "Done.", createdAt: at(2) },
      { id: "t1", role: "tool", content: "", createdAt: at(2), toolCallId: "t1", toolName: "Read" },
      user("u2", 3),
      { id: "t2", role: "tool", content: "", createdAt: at(3), toolCallId: "t2", toolName: "Read" },
      { id: "t3", role: "tool", content: "", createdAt: at(3), toolCallId: "t3", toolName: "Read" },
      user("u3", 5),
      system("s1", initial, 0, "u1"),
      system("s2", delta, 5, "u3"),
    ];
    expect(replaySessionSystemContext(orphaned, checkpoint("t2:carrier"))).toEqual({
      systemPrompt: "Checkpoint prompt",
      tools: [tool("Glob"), tool("Grep")],
      updatedAt: at(5),
    });
    for (const invented of ["t1:carrier", "t3:carrier"]) {
      expect(replaySessionSystemContext(orphaned, checkpoint(invented))).toEqual(replaySessionSystemContext(orphaned));
    }
  });

  it("applies a legacy checkpoint without folded system state, as the runtime does", () => {
    const legacy = { ...checkpoint("a1"), details: {} };
    // Earlier system rows are discarded with the rest of the history before the anchor.
    expect(replaySessionSystemContext(history, legacy)).toEqual({
      systemPrompt: "",
      tools: [tool("Grep")],
      updatedAt: at(5),
    });
  });

  it("ignores a checkpoint anchored on a row the runtime drops", () => {
    const failed: UiMessage[] = history.map((row) =>
      row.id === "a1" ? { ...row, status: "error" as const } : row);
    expect(replaySessionSystemContext(failed, checkpoint("a1"))).toEqual(replaySessionSystemContext(failed));
  });

  it("ignores a checkpoint anchored on a reply the runtime drops as empty", () => {
    // No text, no thinking once an echoed replay placeholder is removed, and no
    // tool call after it: the runtime restores no entry for either row.
    const empties: UiMessage[] = [
      { id: "a1", role: "assistant", content: "  ", createdAt: at(2) },
      { id: "a1", role: "assistant", content: "", thinking: "[reasoning not retained for this turn]", createdAt: at(2) },
    ];
    for (const empty of empties) {
      const rows = [user("u1", 1), empty, user("u2", 5), system("s1", initial, 0, "u1"), system("s2", delta, 5, "u2")];
      expect(replaySessionSystemContext(rows, checkpoint("a1"))).toEqual(replaySessionSystemContext(rows));
    }
  });

  it("anchors on an empty reply that a following tool call keeps", () => {
    const rows: UiMessage[] = [
      user("u1", 1),
      { id: "a1", role: "assistant", content: "", createdAt: at(2) },
      { id: "t1", role: "tool", content: "", createdAt: at(2), toolCallId: "t1", toolName: "Read" },
      user("u2", 5),
      system("s1", initial, 0, "u1"),
      system("s2", delta, 5, "u2"),
    ];
    expect(replaySessionSystemContext(rows, checkpoint("a1"))?.systemPrompt).toBe("Checkpoint prompt");
  });

  it("ignores a checkpoint whose anchor no longer exists, as the runtime does", () => {
    expect(replaySessionSystemContext(history, checkpoint("deleted"))).toEqual(replaySessionSystemContext(history));
  });

  it("never replays a subagent's system rows into the parent context", () => {
    const delegated = system("sub", { role: "system", content: "Delegate prompt", timestamp: 4 }, 6, "u2", {
      parentToolCallId: "task-1",
    });
    expect(replaySessionSystemContext([...history, delegated])?.systemPrompt).toBe("Base prompt");
  });

  it("fails on a malformed row instead of showing a partial fold", () => {
    const broken: UiMessage = { ...system("bad", initial, 6, "u2"), modelSystem: { version: 1, messageJson: "{" } };
    expect(() => replaySessionSystemContext([...history, broken])).toThrow();
  });

  it("returns null before anything was declared", () => {
    expect(replaySessionSystemContext([])).toBeNull();
    expect(replaySessionSystemContext([user("u1", 1)])).toBeNull();
  });

  it("keeps each tool's constrained sampling, and omits it when undeclared", () => {
    const strict = { ...tool("Write"), constrainedSampling: { type: "json_schema", strict: "require" } };
    const grammar = { ...tool("Patch"), constrainedSampling: { type: "grammar", variants: { openai_lark: "start: ITEM" } } };
    const optedOut = { ...tool("Shell"), constrainedSampling: false };
    const declared = { role: "system", content: "Base prompt", timestamp: 1, toolsAdded: [strict, grammar, optedOut, tool("Read")] };
    const replay = replaySessionSystemContext([user("u1", 1), system("s1", declared, 0, "u1")]);
    expect(replay?.tools).toEqual([strict, grammar, optedOut, tool("Read")]);
    expect(replay?.tools.at(-1)).not.toHaveProperty("constrainedSampling");
  });
});

/**
 * host-core's `session.contextTranscript` returns `lean` for the rows
 * `session.get` returns as `full` (checked in
 * `crates/host-core/src/sessions/context_transcript_tests.rs`). Every field it
 * drops is set on some `full` row, so a projection that started reading one
 * would no longer agree here.
 */
type ContextTranscriptContract = {
  full: UiMessage[];
  lean: UiMessage[];
  checkpoints: { name: string; full: ContextCompactionRecord; lean: SystemContextCheckpoint }[];
};
const contract = JSON.parse(readFileSync(new URL(
  "../../../crates/host-core/src/sessions/context_transcript.contract.json", import.meta.url,
), "utf8")) as ContextTranscriptContract;

describe("the session.contextTranscript contract", () => {
  const outcome = (rows: UiMessage[], checkpoint: SystemContextCheckpoint) => {
    try {
      return replaySessionSystemContext(rows, checkpoint);
    } catch (error) {
      return { threw: String(error) };
    }
  };

  it("keeps the runtime's entry layout", () => {
    const layout = (rows: UiMessage[]) =>
      projectHistoryContextEntries(rows, (row) => readSystemMessage(row.modelSystem?.messageJson)).map((entry) => entry.id);
    expect(layout(contract.lean)).toEqual(layout(contract.full));
    expect(layout(contract.full)).toEqual([
      "s1", "u1", "u-session", "a-streaming", "a-signed", "a-search", "a-carrier", "t-kept", "t-error",
      "u2", "t-orphan:carrier", "t-orphan", "s2", "u3",
    ]);
  });

  it("replays every checkpoint case to the result of the full read", () => {
    const prompts: Record<string, string | undefined> = {};
    for (const { name, full, lean } of contract.checkpoints) {
      const expected = outcome(contract.full, full);
      expect(outcome(contract.lean, lean), name).toEqual(expected);
      prompts[name] = expected && "systemPrompt" in expected ? expected.systemPrompt : undefined;
    }
    // Each case takes a different branch of the replay.
    expect(prompts).toEqual({
      folded: "Checkpoint prompt", legacy: "", dropped: "Base prompt", carrier: "Checkpoint prompt",
      nonObjectDetails: "", nullJson: undefined,
    });
    expect(outcome(contract.lean, contract.checkpoints.find((c) => c.name === "nullJson")!.lean)).toHaveProperty("threw");
  });
});
