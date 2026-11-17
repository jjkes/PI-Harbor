import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { createEventsSlice } = await import("../src/stores/slices/events-slice.ts");
const { withoutRecordKey, withCompactionMark, openPlanArtifact } = await import("../src/stores/helpers/store-helpers.ts");

/*
 * User path for live tool-call drafts: the real store event handler receives
 * the envelopes the runtime emits, and every assertion reads the transcript
 * rows the chat renders.
 */

const assistant = (id, overrides = {}) => ({
  id, role: "assistant", content: "", createdAt: "2026-11-17T00:00:00Z", status: "streaming", ...overrides,
});
let clock = 0;
const at = (sessionId, event, extra = {}) => ({ sessionId, ts: ++clock, event, ...extra });
const draft = (toolCallId, phase, changes, messageId = "m1") => ({
  type: "tool_draft", toolCallId, toolName: "Write", messageId, phase, ...(changes ? { changes } : {}),
});
const open = (toolCallId, messageId) => draft(toolCallId, "streaming", [{ op: "set", path: [], value: {} }], messageId);

function harness({ active = [], background = [] } = {}) {
  let runtime;
  let state = {
    activeSessionId: "active", messages: active,
    retainedSessionIds: ["active", "background"],
    retainedTranscripts: { active, background },
    runningSessions: { active: true, background: true },
    sessionHistory: {}, agentStatuses: {}, pendingPermissions: {}, pendingAsks: {}, askDrafts: {},
    latestTurnResults: {}, sessionOutcomes: {}, sessionCompactions: {}, isRunning: true,
    refreshSessions: async () => {}, refreshQueuedPrompts: async () => {}, showToast: () => {},
  };
  const access = {
    get: () => state,
    set: (patch) => {
      const previous = state;
      const next = typeof patch === "function" ? patch(state) : patch;
      if (next === state) return;
      state = { ...state, ...next };
      runtime?.syncTranscriptProjection(state, previous);
    },
  };
  runtime = createSessionRuntime(access);
  runtime.cacheSessionTranscript("background", background);
  Object.assign(state, createEventsSlice({
    ...access, runtime, withoutRecordKey, withCompactionMark, openPlanArtifact,
    notifyInteractivePrompt: () => {},
    flushPendingSessionConfiguration: async () => {},
    flushPendingSessionConfiguration: async () => {},
    assistantErrorMessage: (error) => assistant("error-row", { content: error.message, status: "error", isError: true }),
  }));
  return { ...access, runtime, send: (envelope) => state.handleAgentEvent(envelope) };
}

test("a streaming Write shows one row that grows, waits, runs once in place and settles", () => {
  const h = harness({ active: [assistant("m1")] });
  h.send(at("active", draft("write-1", "streaming", [{ op: "set", path: ["path"], value: "src/a.ts" }])));
  h.send(at("active", draft("write-1", "streaming", [{ op: "set", path: ["content"], value: "ab" }])));
  // The semantic complete frame flushes the queued streaming frames first.
  h.send(at("active", draft("write-1", "complete")));
  let rows = h.get().messages.filter((row) => row.role === "tool");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toolDraft.phase, "complete");
  assert.deepEqual(rows[0].toolArgs, { path: "src/a.ts", content: "ab" });
  const drafted = rows[0];

  h.send(at("active", draft("write-1", "streaming", [{ op: "append", path: ["content"], text: "c", offset: 2 }])));
  h.send(at("active", { type: "tool_start", toolCallId: "write-1", toolName: "Write", args: { path: "src/a.ts", content: "abc" } }));
  rows = h.get().messages.filter((row) => row.role === "tool");
  assert.equal(rows.length, 1, "tool_start must reuse the draft row");
  assert.equal(rows[0].id, "write-1");
  assert.equal(rows[0].toolDraft, undefined);
  assert.equal(rows[0].toolStatus, "running");
  assert.deepEqual(rows[0].toolArgs, { path: "src/a.ts", content: "abc" });
  assert.equal(rows[0].createdAt, drafted.createdAt);
  assert.equal(h.get().messages.indexOf(rows[0]), h.get().messages.length - 1);

  h.send(at("active", { type: "tool_end", toolCallId: "write-1", result: "ok", isError: false }));
  rows = h.get().messages.filter((row) => row.role === "tool");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toolStatus, "success");
  assert.equal(rows[0].toolDraft, undefined);
});

test("discarded drafts disappear, a late frame cannot recreate them, and started calls stay", () => {
  const h = harness({ active: [assistant("m1")] });
  h.send(at("active", open("write-1", "m1")));
  h.send(at("active", open("write-2", "m1")));
  h.send(at("active", { type: "tool_start", toolCallId: "write-2", toolName: "Write", args: {} }));
  h.send(at("active", draft("write-1", "discarded")));
  h.send(at("active", draft("write-2", "discarded")));
  h.send(at("active", open("write-1", "m1")));
  const rows = h.get().messages.filter((row) => row.role === "tool");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "write-2");
  assert.equal(rows[0].toolDraft, undefined);
});

test("a missed append marks the row as gapped and tool_start still delivers the final arguments", () => {
  const h = harness({ active: [assistant("m1")] });
  h.send(at("active", draft("write-1", "streaming", [{ op: "set", path: ["content"], value: "ab" }])));
  // Flush the first frame so the row exists before the misaligned append.
  h.send(at("active", { type: "turn_start" }));
  h.send(at("active", draft("write-1", "streaming", [{ op: "append", path: ["content"], text: "d", offset: 3 }])));
  h.send(at("active", draft("write-1", "complete")));
  let rows = h.get().messages.filter((row) => row.role === "tool");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toolDraft.gap, true);
  assert.equal(rows[0].toolArgs.content, "ab");
  h.send(at("active", { type: "tool_start", toolCallId: "write-1", toolName: "Write", args: { content: "abcd" } }));
  rows = h.get().messages.filter((row) => row.role === "tool");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toolArgs.content, "abcd");
  assert.equal(rows[0].toolDraft, undefined);
});

test("an errored assistant end removes only that response's drafts", () => {
  const h = harness({ active: [assistant("m1"), assistant("m2")] });
  h.send(at("active", open("write-1", "m1")));
  h.send(at("active", open("write-2", "m2")));
  h.send(at("active", { type: "message_end", message: assistant("m1", { status: "error" }) }));
  assert.deepEqual(h.get().messages.filter((row) => row.role === "tool").map((row) => row.id), ["write-2"]);
});

test("turn and run endings sweep their scope, and a subagent draft keeps its own lineage", () => {
  const h = harness({ active: [assistant("m1"), assistant("child", { parentToolCallId: "task-1" })] });
  h.send(at("active", open("write-parent", "m1")));
  h.send(at("active", open("write-child", "child"), { parentToolCallId: "task-1", agentName: "writer" }));
  h.send(at("active", { type: "turn_end" }));
  assert.deepEqual(h.get().messages.filter((row) => row.role === "tool").map((row) => row.id), ["write-child"]);
  h.send(at("active", { type: "agent_end", messageIds: [] }));
  assert.deepEqual(h.get().messages.filter((row) => row.role === "tool").map((row) => row.id), ["write-child"]);
  const child = h.get().messages.find((row) => row.id === "write-child");
  assert.equal(child.parentToolCallId, "task-1");
  assert.equal(child.agentName, "writer");
  assert.equal(child.toolDraft.phase, "streaming");
  h.send(at("active", { type: "error", error: { code: "STREAM_FAILED", message: "down" } }));
  assert.deepEqual(h.get().messages.filter((row) => row.role === "tool"), []);
});

test("a background session projects the same single row without disturbing the active one", () => {
  const active = [assistant("active-answer")];
  const h = harness({ active, background: [assistant("m1")] });
  const retained = h.get().retainedTranscripts;
  h.send(at("background", draft("bg-write", "streaming", [{ op: "set", path: ["path"], value: "a.ts" }])));
  h.send(at("background", draft("bg-write", "complete")));
  h.send(at("background", { type: "tool_start", toolCallId: "bg-write", toolName: "Write", args: { path: "a.ts" } }));
  assert.equal(h.get().messages, active);
  assert.equal(h.get().retainedTranscripts, retained);
  const cached = h.runtime.sessionTranscriptCache.get("background");
  const rows = cached.filter((row) => row.role === "tool");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toolStatus, "running");
  assert.equal(rows[0].toolDraft, undefined);
});

test("a live compaction_end keeps the model summary for its divider", () => {
  const h = harness();
  h.send(at("active", {
    type: "compaction_end", reason: "threshold", ok: true, tokensBefore: 1_000, willRetry: false,
    mark: { id: "cp-1", throughMessageId: "m1", generation: 1, summaryTokens: 120, summarized: true },
    summary: "## Goal\nShip the preview.",
  }));
  assert.deepEqual(h.get().sessionCompactions.active, [
    { id: "cp-1", throughMessageId: "m1", generation: 1, summaryTokens: 120, summarized: true, summary: "## Goal\nShip the preview." },
  ]);
});
