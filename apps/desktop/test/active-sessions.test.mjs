import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  activeSessionProject,
  clipPreviewText,
  selectActiveSessions,
  TRANSCRIPT_PREVIEW_LINE_LIMIT,
  TRANSCRIPT_PREVIEW_TEXT_LIMIT,
  transcriptPreviewLines,
} = await import("../src/features/active-sessions/active-sessions-model.ts");
const { createSessionRuntime, SESSION_TRANSCRIPT_CACHE_LIMIT } = await import(
  "../src/stores/runtime/session-runtime.ts"
);

/*
 * Which sessions the Active sessions page shows and what a pane previews, plus
 * the runtime contract a pane relies on: a watched transcript projection is
 * notified on every write and stays resident while it is watched. The page
 * itself is driven through the renderer in active-sessions-user-path.test.mjs.
 */

const at = (minute) => `2026-10-01T09:${String(minute).padStart(2, "0")}:00.000Z`;
const session = (id, minute, overrides = {}) => ({
  id,
  title: id,
  messageCount: 1,
  mode: "agent",
  thinkingLevel: "medium",
  permissionMode: "inherit",
  createdAt: at(minute),
  updatedAt: at(minute),
  ...overrides,
});
const permission = (sessionId, toolName) => ({
  requestId: `${sessionId}-request`,
  sessionId,
  toolCallId: `${sessionId}-call`,
  toolName,
  argsPreview: {},
  risk: "high",
  reason: "Needs approval",
});
const message = (id, role, content, overrides = {}) => ({
  id,
  role,
  content,
  createdAt: at(30),
  ...overrides,
});

function runtimeHarness(initial = {}) {
  let runtime;
  let state = {
    activeSessionId: undefined,
    messages: [],
    retainedSessionIds: [],
    retainedTranscripts: {},
    runningSessions: {},
    sessionHistory: {},
    ...initial,
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
  return { runtime, get: access.get };
}

test("running and approval-waiting sessions get panes in creation order", () => {
  const entries = selectActiveSessions({
    sessions: [
      session("review", 20, { updatedAt: at(59) }),
      session("idle", 5),
      session("build", 10),
      session("nightly", 1, { scheduledRun: true }),
      session("blocked", 40),
      session("done", 2),
    ],
    runningSessions: { review: true, build: true, nightly: true, idle: false },
    pendingPermissions: {
      review: [permission("review", "bash")],
      blocked: [permission("blocked", "write")],
    },
    pendingAsks: {},
    pendingPlans: {},
  });
  // A pending permission outranks running, as on the sidebar row. Idle,
  // finished, and automation sessions stay off the grid, and recent activity
  // never reorders it.
  assert.deepEqual(
    entries.map((entry) => [entry.session.id, entry.status]),
    [["build", "running"], ["review", "permission"], ["blocked", "permission"]],
  );
});

test("a running session parked on a question reads as waiting for input", () => {
  const ask = (sessionId) => [{
    sessionId,
    requestId: `${sessionId}-ask`,
    toolCallId: `${sessionId}-ask-call`,
    questions: [{ question: "Which path?", options: ["A", "B"] }],
  }];
  const entries = selectActiveSessions({
    sessions: [
      session("asking", 10),
      session("reviewing", 20),
      session("both", 30),
    ],
    runningSessions: { asking: true, both: true },
    pendingPermissions: { both: [permission("both", "bash")] },
    pendingAsks: { asking: ask("asking"), both: ask("both") },
    pendingPlans: {
      reviewing: { id: "reviewing-plan", sessionId: "reviewing", status: "pending" },
    },
  });
  // The question relabels the running pane; a plan review alone leaves the
  // session idle and off the grid; a permission still outranks a question.
  assert.deepEqual(
    entries.map((entry) => [entry.session.id, entry.status]),
    [["asking", "input"], ["both", "permission"]],
  );
});

test("a pane names its project as the conversation topbar does", () => {
  const project = (overrides, projectMeta = {}) =>
    activeSessionProject(session("pane", 1, overrides), projectMeta);
  assert.equal(project({ projectPath: "/work/harbor/" }), "harbor");
  assert.equal(
    project({ projectPath: "/work/harbor" }, { "/work/harbor": { name: " Harbor app " } }),
    "Harbor app",
  );
  assert.equal(project({}), null, "a temporary session names no project");
  assert.equal(
    project({ source: "remote", remoteHostLabel: "build-box", remoteWorkspaceLabel: "api" }),
    "api",
  );
  assert.equal(project({ source: "remote", remoteHostLabel: "build-box" }), "build-box");
});

test("a pane previews the newest top-level transcript rows as compact text", () => {
  const longReply = `${"draft ".repeat(120)}final answer`;
  const lines = transcriptPreviewLines([
    message("instructions", "system", "internal prompt"),
    message("declarations", "user", "tool declarations", {
      modelSystem: { version: 1, messageJson: "{}" },
    }),
    message("prompt", "user", "Expanded template text", { command: "/release-notes  v0.22" }),
    message("peer", "user", "Please review the plan", {
      sessionMessage: {
        messageId: "peer-message",
        sourceSessionId: "planner",
        sourceTitle: " Planner ",
        targetSessionId: "review",
        kind: "request",
      },
    }),
    message("call-1", "tool", "", { toolName: "bash", toolCallId: "call-1", toolStatus: "running" }),
    message("nested-call", "tool", "", { toolName: "read", parentToolCallId: "call-1" }),
    message("nested-reply", "assistant", "subagent step", { nestedParentToolCallId: "call-1" }),
    message("legacy", "tool", "", { toolName: "grep" }),
    message("aborted", "tool", "", { toolName: "edit", status: "aborted" }),
    message("thinking-only", "assistant", "   ", { thinking: "planning" }),
    message("reply", "assistant", longReply, { status: "streaming" }),
  ]);

  assert.deepEqual(lines.slice(0, 5), [
    { id: "prompt", kind: "user", text: "/release-notes v0.22" },
    { id: "peer", kind: "user", text: "Please review the plan", from: "Planner" },
    { id: "call-1", kind: "tool", toolName: "bash", status: "running" },
    { id: "legacy", kind: "tool", toolName: "grep", status: "success" },
    { id: "aborted", kind: "tool", toolName: "edit", status: "error" },
  ]);
  assert.equal(lines.length, 6);
  // A streaming reply keeps its end, so the newest output stays visible.
  const reply = lines[5];
  assert.equal(reply.kind, "assistant");
  assert.ok(reply.text.startsWith("…"));
  assert.ok(reply.text.endsWith("final answer"));
  assert.ok(reply.text.length <= TRANSCRIPT_PREVIEW_TEXT_LIMIT + 1);
});

test("a pane keeps only the newest preview rows, oldest first", () => {
  const messages = Array.from({ length: TRANSCRIPT_PREVIEW_LINE_LIMIT + 5 }, (_, index) =>
    message(`row-${index}`, "assistant", `reply ${index}`));
  const lines = transcriptPreviewLines(messages);
  assert.equal(lines.length, TRANSCRIPT_PREVIEW_LINE_LIMIT);
  assert.equal(lines[0].id, "row-5");
  assert.equal(lines.at(-1).id, `row-${TRANSCRIPT_PREVIEW_LINE_LIMIT + 4}`);
});

test("clipped preview text keeps whole characters at the cut", () => {
  // Three emoji are six UTF-16 units; a five-unit cut splits the third one.
  assert.equal(clipPreviewText("😀😀😀", "start", 5), "😀😀…");
  assert.equal(clipPreviewText("😀😀😀", "end", 5), "…😀😀");
  assert.equal(clipPreviewText("  short \n  prompt ", "start"), "short prompt");
});

test("a watched transcript is notified on writes and stays resident under cache pressure", () => {
  const { runtime, get } = runtimeHarness();
  let writes = 0;
  const stop = runtime.observeTranscript("watched", () => {
    writes += 1;
  });
  runtime.cacheSessionTranscript("watched", [message("w1", "user", "watch me")]);
  assert.equal(writes, 1);
  runtime.cacheSessionTranscript("other", [message("o1", "user", "elsewhere")]);
  assert.equal(writes, 1, "another session's write notified this observer");

  for (let index = 0; index < SESSION_TRANSCRIPT_CACHE_LIMIT; index += 1) {
    runtime.cacheSessionTranscript(`filler-${index}`, [message(`f${index}`, "user", "filler")]);
  }
  assert.equal(runtime.sessionTranscriptCache.size, SESSION_TRANSCRIPT_CACHE_LIMIT);
  assert.equal(runtime.sessionTranscriptCache.has("other"), false, "unwatched projections no longer evict");
  assert.deepEqual(runtime.peekTranscript("watched", get())?.map((row) => row.id), ["w1"]);

  stop();
  runtime.cacheSessionTranscript("after", [message("a1", "user", "after")]);
  assert.equal(runtime.sessionTranscriptCache.has("watched"), false, "a released projection stayed pinned");
  assert.equal(runtime.sessionTranscriptCache.size, SESSION_TRANSCRIPT_CACHE_LIMIT);
  assert.equal(writes, 1);
});

test("stopping one observation leaves the others notified", () => {
  const { runtime } = runtimeHarness();
  let writes = 0;
  const stopFirst = runtime.observeTranscript("watched", () => {
    writes += 1;
  });
  const stopSecond = runtime.observeTranscript("watched", () => {
    writes += 10;
  });
  runtime.cacheSessionTranscript("watched", []);
  assert.equal(writes, 11);
  stopFirst();
  runtime.cacheSessionTranscript("watched", []);
  assert.equal(writes, 21);
  stopSecond();
  runtime.cacheSessionTranscript("watched", []);
  assert.equal(writes, 21);
});

test("background agent events stream into a watched projection", () => {
  const { runtime, get } = runtimeHarness();
  runtime.cacheSessionTranscript("background", [
    message("prompt", "user", "Draft the notes", { createdAt: at(10) }),
  ]);
  let writes = 0;
  runtime.observeTranscript("background", () => {
    writes += 1;
  });
  runtime.cacheBackgroundTranscriptEvent({
    sessionId: "background",
    ts: Date.parse(at(11)),
    event: {
      type: "message_start",
      message: message("reply", "assistant", "Drafting", { createdAt: at(11), status: "streaming" }),
    },
  });
  assert.equal(writes, 1);
  assert.deepEqual(
    runtime.peekTranscript("background", get())?.map((row) => [row.id, row.content]),
    [["prompt", "Draft the notes"], ["reply", "Drafting"]],
  );
});

test("peeking prefers the live transcript, then the cache, then a retained pane", () => {
  const live = [message("live", "assistant", "live")];
  const retained = [message("retained", "assistant", "retained")];
  const { runtime, get } = runtimeHarness({
    activeSessionId: "active",
    messages: live,
    retainedTranscripts: { pane: retained },
  });
  runtime.cacheSessionTranscript("active", [message("stale", "assistant", "stale")]);
  runtime.cacheSessionTranscript("cached", [message("cached", "assistant", "cached")]);

  assert.equal(runtime.peekTranscript("active", get()), live);
  assert.deepEqual(runtime.peekTranscript("cached", get())?.map((row) => row.id), ["cached"]);
  assert.equal(runtime.peekTranscript("pane", get()), retained);
  assert.equal(runtime.peekTranscript("unknown", get()), undefined);
  // The live message count reads the same projection.
  assert.equal(runtime.liveMessageCountForSession("active", get()), 1);
  assert.equal(runtime.liveMessageCountForSession("unknown", get()), 0);
});
