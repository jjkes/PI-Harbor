import { describe, expect, it } from "vitest";
import type { ContextCompactionRecord, UiMessage } from "@pi-harbor/shared";
import { replaySessionSystemContext } from "./session-system-context.js";

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

  it("accepts the synthetic carrier id a tool row restored without its assistant anchors on", () => {
    // No assistant precedes the tool row, so the runtime synthesizes `t2:carrier`.
    const orphaned: UiMessage[] = [
      user("u1", 1),
      { id: "t2", role: "tool", content: "", createdAt: at(2), toolCallId: "t2", toolName: "Read" },
      user("u2", 5),
      system("s1", initial, 0, "u1"),
      system("s2", delta, 5, "u2"),
    ];
    expect(replaySessionSystemContext(orphaned, checkpoint("t2:carrier"))?.systemPrompt).toBe("Checkpoint prompt");
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
});
