import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const model = await import("../src/features/chat/btw/btw-model.ts");
const { btwWorkPanelTab, isKnownWorkPanelTab, openWorkPanelTabState, sanitizeWorkPanelTabsState } =
  await import("../src/lib/work-panel-tabs.ts");

const SESSION = "session-1";
const BASELINE = { settledCount: 0, compactionCount: 0, mainRunning: false };
const ENVELOPE = { runId: "run-1", sessionId: SESSION, seq: 0 };

/** A state holding one running turn. */
function started(overrides = {}) {
  return model.beginBtwTurn(model.emptyBtwState(), SESSION, {
    runId: "run-1",
    question: "Why cap retries?",
    baseline: BASELINE,
    askedAt: 1_000,
    ...overrides,
  });
}

function apply(state, seq, event) {
  return model.applyBtwEnvelope(state, { ...ENVELOPE, seq, event });
}

function turnOf(state, index = 0) {
  return model.btwThreadOf(state, SESSION).turns[index];
}

function view(ids, overrides = {}) {
  return {
    messages: ids.map((id) => ({ id })),
    compactionCount: 0,
    running: false,
    ...overrides,
  };
}

test("a question becomes a pending turn and marks the session busy", () => {
  const baseline = model.btwBaselineFor(view(["m1"], { running: true }));
  const state = started({ baseline });

  const thread = model.btwThreadOf(state, SESSION);
  assert.equal(thread.activeRunId, "run-1");
  assert.equal(thread.turns.length, 1);
  assert.equal(turnOf(state).status, "pending");
  assert.equal(turnOf(state).question, "Why cap retries?");
  assert.equal(turnOf(state).lastSeq, -1);
  assert.equal(baseline.lastMessageId, "m1");
  assert.equal(baseline.mainRunning, true);
  assert.equal(model.btwThreadOf(model.emptyBtwState(), SESSION).turns.length, 0);
});

test("text and usage accumulate and the terminal event frees the session", () => {
  let state = started();
  state = apply(state, 0, {
    type: "started",
    providerId: "provider-a",
    modelId: "model-a",
    mainTurnRunning: true,
  });
  state = apply(state, 1, { type: "text_delta", delta: "Because " });
  state = apply(state, 2, { type: "text_delta", delta: "it is." });
  state = apply(state, 3, { type: "usage", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
  state = apply(state, 4, { type: "usage", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } });
  state = apply(state, 5, { type: "done", stopReason: "stop" });

  const turn = turnOf(state);
  assert.equal(turn.answer, "Because it is.");
  assert.equal(turn.status, "done");
  assert.equal(turn.providerId, "provider-a");
  assert.equal(turn.modelId, "model-a");
  assert.equal(turn.baseline.mainRunning, true);
  assert.deepEqual(turn.usage, { inputTokens: 15, outputTokens: 3, totalTokens: 18 });
  assert.equal(model.btwThreadOf(state, SESSION).activeRunId, null);
});

test("tool rows keep what was read and how the call ended", () => {
  let state = started();
  state = apply(state, 0, {
    type: "tool_start",
    toolCallId: "btw:run-1:a",
    toolName: "Read",
    args: { path: "src/app.ts" },
  });
  state = apply(state, 1, {
    type: "tool_start",
    toolCallId: "btw:run-1:b",
    toolName: "Grep",
    args: { pattern: "retry" },
  });
  state = apply(state, 2, { type: "tool_end", toolCallId: "btw:run-1:a", ok: true });
  state = apply(state, 3, {
    type: "tool_end",
    toolCallId: "btw:run-1:b",
    ok: false,
    errorCode: "TOOL_DISABLED_IN_READ_ONLY",
  });

  assert.deepEqual(turnOf(state).tools, [
    { toolCallId: "btw:run-1:a", toolName: "Read", summary: "src/app.ts", state: "ok" },
    {
      toolCallId: "btw:run-1:b",
      toolName: "Grep",
      summary: "retry",
      state: "failed",
      errorCode: "TOOL_DISABLED_IN_READ_ONLY",
    },
  ]);
});

test("unknown runs, replayed sequences, and events after the end change nothing", () => {
  let state = started();
  state = apply(state, 1, { type: "text_delta", delta: "A" });

  const unknownRun = model.applyBtwEnvelope(state, { ...ENVELOPE, runId: "run-2", seq: 9, event: { type: "text_delta", delta: "B" } });
  assert.equal(unknownRun, state);

  const replayed = apply(state, 1, { type: "text_delta", delta: "C" });
  assert.equal(replayed, state);

  const older = apply(state, 0, { type: "text_delta", delta: "D" });
  assert.equal(older, state);

  const done = apply(state, 2, { type: "done", stopReason: "stop" });
  const afterEnd = apply(done, 3, { type: "text_delta", delta: "E" });
  assert.equal(afterEnd, done);
  assert.equal(turnOf(done).answer, "A");
});

test("an error keeps the partial answer and stops running tool rows", () => {
  let state = started();
  state = apply(state, 0, { type: "text_delta", delta: "Half an answer" });
  state = apply(state, 1, { type: "tool_start", toolCallId: "btw:run-1:a", toolName: "Glob", args: { glob: "*.ts" } });
  state = apply(state, 2, {
    type: "error",
    error: { code: "BTW_CONTEXT_FULL", message: "too long", retriable: false },
  });

  const turn = turnOf(state);
  assert.equal(turn.status, "error");
  assert.equal(turn.answer, "Half an answer");
  assert.equal(turn.error.code, "BTW_CONTEXT_FULL");
  assert.equal(turn.tools[0].state, "stopped");
  assert.equal(model.btwThreadOf(state, SESSION).activeRunId, null);
});

test("a run the runtime no longer has settles as stopped", () => {
  const state = started();
  const settled = model.settleBtwTurnAborted(state, SESSION, "run-1");
  assert.equal(turnOf(settled).status, "aborted");
  assert.equal(model.btwThreadOf(settled, SESSION).activeRunId, null);

  const done = apply(state, 1, { type: "done", stopReason: "stop" });
  assert.equal(model.settleBtwTurnAborted(done, SESSION, "run-1"), done);
  assert.equal(model.settleBtwTurnAborted(state, SESSION, "run-9"), state);
});

test("staleness compares the baseline with the main conversation", () => {
  const baseline = model.btwBaselineFor(view(["m1", "m2"]));
  assert.deepEqual(model.btwStaleness(baseline, view(["m1", "m2"])), { kind: "current" });
  assert.deepEqual(model.btwStaleness(baseline, view(["m1", "m2", "m3"])), { kind: "newer", count: 1 });
  assert.deepEqual(model.btwStaleness(baseline, view(["m1", "m2", "m3", "m4"])), {
    kind: "newer",
    count: 2,
  });
  assert.deepEqual(model.btwStaleness(baseline, view(["m1"])), { kind: "changed" });
  assert.deepEqual(model.btwStaleness(baseline, view(["m1", "m2"], { compactionCount: 1 })), {
    kind: "compacted",
  });

  const running = model.btwBaselineFor(view(["m1"], { running: true }));
  assert.deepEqual(model.btwStaleness(running, view(["m1"], { running: true })), { kind: "midTurn" });
  assert.deepEqual(model.btwStaleness(running, view(["m1"])), { kind: "current" });
  assert.deepEqual(model.btwStaleness(model.btwBaselineFor(view([])), view(["m1"])), {
    kind: "newer",
    count: 1,
  });
});

test("a streaming reply is not part of the baseline", () => {
  const baseline = model.btwBaselineFor({
    messages: [{ id: "m1" }, { id: "m2", status: "streaming" }],
    compactionCount: 2,
    running: true,
  });
  assert.equal(baseline.lastMessageId, "m1");
  assert.equal(baseline.settledCount, 1);
  assert.equal(baseline.compactionCount, 2);
  assert.equal(baseline.mainRunning, true);
});

test("history carries answered turns only, newest ones that fit", () => {
  const turns = [
    { ...turnOf(started()), runId: "a", status: "done", answer: "first" },
    { ...turnOf(started()), runId: "b", status: "error", answer: "failed" },
    { ...turnOf(started()), runId: "c", status: "done", answer: "   " },
    { ...turnOf(started()), runId: "d", status: "done", answer: "second" },
  ];
  assert.deepEqual(
    model.btwHistoryFor(turns).map((turn) => [turn.question, turn.answer]),
    [
      ["Why cap retries?", "first"],
      ["Why cap retries?", "second"],
    ],
  );

  const many = Array.from({ length: 25 }, (_, index) => ({
    ...turnOf(started()),
    runId: `run-${index}`,
    status: "done",
    question: `q${index}`,
    answer: `a${index}`,
  }));
  const kept = model.btwHistoryFor(many);
  assert.equal(kept.length, 20);
  assert.equal(kept[0].question, "q5");
  assert.equal(kept[19].question, "q24");
});

test("the composer recognizes /btw and leaves other text alone", () => {
  assert.deepEqual(model.parseBtwCommand("/btw"), { question: "" });
  assert.deepEqual(model.parseBtwCommand("/btw   why do we cap retries?"), {
    question: "why do we cap retries?",
  });
  assert.deepEqual(model.parseBtwCommand("/btw\nwhy?"), { question: "why?" });
  assert.equal(model.parseBtwCommand("/btwx why?"), null);
  assert.equal(model.parseBtwCommand("/compact"), null);
  assert.equal(model.parseBtwCommand("why?"), null);
  assert.equal(model.parseBtwCommand("/"), null);
});

test("a side question has to be non-empty and within the shared limit", () => {
  assert.equal(model.btwQuestionProblem(""), "empty");
  assert.equal(model.btwQuestionProblem("   "), "empty");
  assert.equal(model.btwQuestionProblem("x".repeat(8_000)), null);
  assert.equal(model.btwQuestionProblem("x".repeat(8_001)), "tooLong");
});

test("tab presence tells a closed tab from a removed session", () => {
  assert.equal(model.btwTabPresence([{ kind: "btw" }], undefined), "open");
  assert.equal(model.btwTabPresence(undefined, [{ kind: "btw" }]), "open");
  assert.equal(model.btwTabPresence([{ kind: "file" }], undefined), "closed");
  assert.equal(model.btwTabPresence(undefined, []), "gone");
  assert.equal(model.btwTabPresence(undefined, undefined), "gone");
});

test("clearing drops answered turns but never interrupts a run", () => {
  const idle = apply(started(), 1, { type: "done", stopReason: "stop" });
  assert.equal(model.btwThreadOf(model.clearBtwThread(idle, SESSION), SESSION).turns.length, 0);

  const running = started();
  assert.equal(model.clearBtwThread(running, SESSION), running);
  assert.equal(model.clearBtwThread(model.emptyBtwState(), SESSION).threads[SESSION], undefined);
});

test("dropping a session forgets its thread and its focus request", () => {
  const focused = model.requestBtwFocus(started(), SESSION);
  assert.equal(focused.focusSessionId, SESSION);
  const dropped = model.dropBtwThread(focused, SESSION);
  assert.equal(dropped.threads[SESSION], undefined);
  assert.equal(dropped.focusSessionId, null);
  assert.equal(model.dropBtwThread(dropped, SESSION), dropped);
});

test("the draft is per session and focus is consumed once", () => {
  let state = model.setBtwDraft(model.emptyBtwState(), SESSION, "half a question");
  assert.equal(model.btwThreadOf(state, SESSION).draft, "half a question");
  assert.equal(model.btwThreadOf(state, "session-2").draft, "");
  assert.equal(model.setBtwDraft(state, SESSION, "half a question"), state);

  state = model.requestBtwFocus(state, SESSION);
  state = model.consumeBtwFocus(state, SESSION);
  assert.equal(state.focusSessionId, null);
  assert.equal(model.consumeBtwFocus(state, SESSION), state);
});

test("events are validated before they reach a turn", () => {
  assert.deepEqual(
    model.parseBtwEventEnvelope({ ...ENVELOPE, event: { type: "started", providerId: "p", modelId: "m", mainTurnRunning: false } }),
    { ...ENVELOPE, event: { type: "started", providerId: "p", modelId: "m", mainTurnRunning: false } },
  );
  assert.deepEqual(model.parseBtwEventEnvelope({ ...ENVELOPE, event: { type: "text_delta", delta: "x" } }), {
    ...ENVELOPE,
    event: { type: "text_delta", delta: "x" },
  });
  assert.equal(model.parseBtwEventEnvelope({ ...ENVELOPE, seq: -1, event: { type: "text_delta", delta: "x" } }), undefined);
  assert.equal(model.parseBtwEventEnvelope({ runId: "run-1", event: { type: "text_delta", delta: "x" } }), undefined);
  assert.equal(model.parseBtwEventEnvelope({ ...ENVELOPE, event: { type: "unknown" } }), undefined);
  assert.equal(model.parseBtwEventEnvelope({ ...ENVELOPE, event: { type: "tool_end", toolCallId: "a" } }), undefined);
  assert.equal(model.parseBtwEventEnvelope({ ...ENVELOPE, event: { type: "usage", usage: "12" } }), undefined);
  assert.equal(model.parseBtwEventEnvelope({ ...ENVELOPE, event: { type: "done", stopReason: "length" } }), undefined);
  assert.equal(model.parseBtwEventEnvelope({ ...ENVELOPE, event: { type: "error", error: { code: "X" } } }), undefined);
  assert.equal(model.parseBtwEventEnvelope(null), undefined);
});

test("tool rows shorten long arguments and skip non-string ones", () => {
  assert.equal(model.btwToolSummary({ path: "  src/app.ts  " }), "src/app.ts");
  assert.equal(model.btwToolSummary({ path: 3, pattern: "retry" }), "retry");
  assert.equal(model.btwToolSummary({}), undefined);
  assert.equal(model.btwToolSummary("src/app.ts"), undefined);

  const long = model.btwToolSummary({ path: "x".repeat(200) });
  assert.equal(long.length, 120);
  assert.ok(long.endsWith("…"));
});

test("usage without a total falls back to input plus output", () => {
  assert.deepEqual(model.addBtwUsage(undefined, { inputTokens: 2, outputTokens: 3, totalTokens: 0 }), {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
  });
  assert.deepEqual(
    model.addBtwUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, { inputTokens: -4, outputTokens: 0, totalTokens: 0 }),
    { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  );
});

test("the BTW tab is a known, singleton work-panel tab", () => {
  const tab = btwWorkPanelTab();
  assert.deepEqual(tab, { id: "btw", kind: "btw" });
  assert.equal(isKnownWorkPanelTab(tab), true);
  assert.deepEqual(openWorkPanelTabState({ tabs: [], activeTabId: null }, tab), {
    tabs: [tab],
    activeTabId: "btw",
  });
  assert.deepEqual(
    sanitizeWorkPanelTabsState({ tabs: [tab], activeTabId: "btw" }),
    { tabs: [tab], activeTabId: "btw" },
  );
});
