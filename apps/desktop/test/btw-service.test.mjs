import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStore } from "zustand/vanilla";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const model = await import("../src/features/chat/btw/btw-model.ts");
const { createBtwController, btwErrorText } = await import("../src/features/chat/btw/btw-service.ts");

const SESSION = "session-1";
const VIEW = { messages: [{ id: "m1" }], compactionCount: 0, running: false };

/**
 * The controller with its I/O replaced: `ask`/`abort`/`onEvent` and the app
 * store are the only external boundaries, so the whole workflow runs here.
 */
function harness(overrides = {}) {
  const calls = [];
  const toasts = [];
  const warnings = [];
  const presence = { value: overrides.presence ?? "open" };
  let deliver;
  let tabsChanged;
  let sequence = 0;
  const store = createStore(() => model.emptyBtwState());

  const api = {
    ask: async (request) => {
      calls.push(["ask", request]);
      if (overrides.askError) throw overrides.askError;
      return { accepted: true };
    },
    abort: async (request) => {
      calls.push(["abort", request.runId]);
      return overrides.abortResult ?? { aborted: true };
    },
    onEvent: (listener) => {
      deliver = listener;
      return () => {
        deliver = undefined;
      };
    },
  };
  const host = {
    activeSessionId: () => ("activeSessionId" in overrides ? overrides.activeSessionId : SESSION),
    session: (sessionId) => overrides.session ?? { id: sessionId, source: "desktop" },
    mainView: () => overrides.mainView ?? VIEW,
    openTab: (sessionId) => calls.push(["openTab", sessionId]),
    tabPresence: () => presence.value,
    subscribeTabs: (listener) => {
      tabsChanged = listener;
      return () => {
        tabsChanged = undefined;
      };
    },
    toast: (message, variant) => toasts.push([message, variant]),
  };

  const controller = createBtwController({
    api,
    host,
    store,
    t: (key) => key,
    newRunId: () => `run-${++sequence}`,
    now: () => 1_000,
    warn: (message) => warnings.push(message),
  });

  const thread = () => model.btwThreadOf(store.getState(), SESSION);
  const emit = (envelope) => deliver?.(envelope);
  return {
    controller,
    calls,
    toasts,
    warnings,
    presence,
    store,
    thread,
    emit,
    closeTab: () => {
      presence.value = "closed";
      tabsChanged();
    },
    removeSession: () => {
      presence.value = "gone";
      tabsChanged();
    },
  };
}

test("opening needs a local desktop session", () => {
  const missing = harness({ activeSessionId: undefined });
  assert.equal(missing.controller.open(), null);
  assert.deepEqual(missing.toasts, [["errors.BTW_NO_SESSION", "warning"]]);
  assert.deepEqual(missing.calls, []);

  const native = harness({ session: { id: "native-pi:7", source: "native-pi" } });
  assert.equal(native.controller.open(), null);
  assert.deepEqual(native.toasts, [["errors.BTW_UNAVAILABLE", "warning"]]);
  assert.deepEqual(native.calls, []);

  const remote = harness({ session: { id: "remote:host:1", source: "remote" } });
  assert.equal(remote.controller.open(), null);
  assert.deepEqual(remote.toasts, [["errors.BTW_UNAVAILABLE", "warning"]]);
});

test("opening focuses the tab and asks for its input", () => {
  const harnessed = harness();
  assert.equal(harnessed.controller.open(), SESSION);
  assert.deepEqual(harnessed.calls, [["openTab", SESSION]]);
  assert.equal(harnessed.store.getState().focusSessionId, SESSION);
  harnessed.controller.consumeFocus(SESSION);
  assert.equal(harnessed.store.getState().focusSessionId, null);
});

test("/btw without a question opens the tab and sends nothing", async () => {
  const harnessed = harness();
  assert.equal(await harnessed.controller.runCommand(""), true);
  assert.deepEqual(harnessed.calls, [["openTab", SESSION]]);
  assert.equal(harnessed.thread().turns.length, 0);
});

test("/btw with a question asks it as a side question", async () => {
  const harnessed = harness();
  assert.equal(await harnessed.controller.runCommand("  why cap retries?  "), true);

  const ask = harnessed.calls.find((call) => call[0] === "ask")[1];
  assert.equal(ask.sessionId, SESSION);
  assert.equal(ask.question, "why cap retries?");
  assert.deepEqual(ask.history, []);
  assert.equal(ask.runId, "run-1");
  assert.equal(harnessed.thread().activeRunId, "run-1");
  assert.equal(harnessed.thread().turns[0].status, "pending");
  assert.equal(harnessed.thread().turns[0].question, "why cap retries?");
});

test("a follow-up carries the answered earlier turns", async () => {
  const harnessed = harness();
  await harnessed.controller.ask(SESSION, "first?");
  harnessed.emit({
    runId: "run-1",
    sessionId: SESSION,
    seq: 0,
    event: { type: "text_delta", delta: "because" },
  });
  harnessed.emit({ runId: "run-1", sessionId: SESSION, seq: 1, event: { type: "done", stopReason: "stop" } });

  await harnessed.controller.ask(SESSION, "second?");
  const asks = harnessed.calls.filter((call) => call[0] === "ask");
  assert.equal(asks.length, 2);
  assert.deepEqual(asks[1][1].history, [{ question: "first?", answer: "because" }]);
});

test("a rejected question leaves no turn behind and explains why", async () => {
  const refusal = Object.assign(new Error("compact the main conversation"), {
    code: "BTW_CONTEXT_FULL",
  });
  const harnessed = harness({ askError: refusal });
  assert.equal(await harnessed.controller.ask(SESSION, "why?"), false);
  assert.equal(harnessed.thread().turns.length, 0);
  assert.equal(harnessed.thread().activeRunId, null);
  assert.deepEqual(harnessed.toasts, [["errors.BTW_CONTEXT_FULL", "error"]]);
});

test("one side question at a time", async () => {
  const harnessed = harness();
  await harnessed.controller.ask(SESSION, "first?");
  assert.equal(await harnessed.controller.ask(SESSION, "second?"), false);
  assert.equal(harnessed.calls.filter((call) => call[0] === "ask").length, 1);
  assert.deepEqual(harnessed.toasts, [["errors.BTW_BUSY", "warning"]]);
});

test("empty and oversized questions never reach the runtime", async () => {
  const harnessed = harness();
  assert.equal(await harnessed.controller.ask(SESSION, "   "), false);
  assert.equal(await harnessed.controller.ask(SESSION, "x".repeat(8_001)), false);
  assert.deepEqual(harnessed.calls, []);
  assert.deepEqual(harnessed.toasts, [["panel.btw.questionTooLong", "warning"]]);
});

test("events of the running question are folded into the thread", async () => {
  const harnessed = harness();
  await harnessed.controller.ask(SESSION, "why?");
  harnessed.emit({
    runId: "run-1",
    sessionId: SESSION,
    seq: 0,
    event: { type: "started", providerId: "p", modelId: "m", mainTurnRunning: false },
  });
  harnessed.emit({ runId: "run-1", sessionId: SESSION, seq: 1, event: { type: "text_delta", delta: "Because." } });
  harnessed.emit({ runId: "run-1", sessionId: SESSION, seq: 2, event: { type: "done", stopReason: "stop" } });

  const turn = harnessed.thread().turns[0];
  assert.equal(turn.answer, "Because.");
  assert.equal(turn.status, "done");
  assert.equal(harnessed.thread().activeRunId, null);
});

test("malformed side-question events are ignored and reported", async () => {
  const harnessed = harness();
  await harnessed.controller.ask(SESSION, "why?");
  harnessed.emit({ runId: "run-1", sessionId: SESSION });
  harnessed.emit("not an envelope");
  assert.equal(harnessed.thread().turns[0].status, "pending");
  assert.equal(harnessed.warnings.length, 2);
});

test("stopping a run asks the runtime, and a run it no longer has settles as stopped", async () => {
  const stopping = harness();
  await stopping.controller.ask(SESSION, "why?");
  await stopping.controller.stop(SESSION);
  assert.deepEqual(stopping.calls.filter((call) => call[0] === "abort"), [["abort", "run-1"]]);
  assert.equal(stopping.thread().turns[0].status, "pending");

  const unknown = harness({ abortResult: { aborted: false } });
  await unknown.controller.ask(SESSION, "why?");
  await unknown.controller.stop(SESSION);
  assert.equal(unknown.thread().turns[0].status, "aborted");
  assert.equal(unknown.thread().activeRunId, null);
});

test("closing the tab stops the run and keeps the thread", async () => {
  const harnessed = harness();
  await harnessed.controller.ask(SESSION, "why?");
  harnessed.closeTab();
  assert.deepEqual(harnessed.calls.filter((call) => call[0] === "abort"), [["abort", "run-1"]]);
  assert.equal(harnessed.thread().turns.length, 1);
});

test("deleting the session forgets its thread and stops its run", async () => {
  const harnessed = harness();
  await harnessed.controller.ask(SESSION, "why?");
  harnessed.removeSession();
  assert.equal(harnessed.thread().turns.length, 0);
  assert.equal(harnessed.store.getState().threads[SESSION], undefined);
  assert.deepEqual(harnessed.calls.filter((call) => call[0] === "abort"), [["abort", "run-1"]]);
});

test("a failed question is replaced by its retry", async () => {
  const harnessed = harness();
  await harnessed.controller.ask(SESSION, "why?");
  harnessed.emit({
    runId: "run-1",
    sessionId: SESSION,
    seq: 0,
    event: { type: "error", error: { code: "BTW_CONTEXT_UNAVAILABLE", message: "no snapshot", retriable: true } },
  });

  assert.equal(await harnessed.controller.retry(SESSION, "run-1"), true);
  assert.equal(harnessed.thread().turns.length, 1);
  assert.equal(harnessed.thread().turns[0].runId, "run-2");
  assert.equal(harnessed.thread().turns[0].question, "why?");
  assert.equal(harnessed.thread().turns[0].status, "pending");
});

test("clearing and sending the draft keep the thread consistent", async () => {
  const harnessed = harness();
  await harnessed.controller.ask(SESSION, "why?");
  harnessed.emit({ runId: "run-1", sessionId: SESSION, seq: 0, event: { type: "done", stopReason: "stop" } });
  harnessed.controller.clear(SESSION);
  assert.equal(harnessed.thread().turns.length, 0);

  harnessed.controller.setDraft(SESSION, "next question?");
  await harnessed.controller.submitDraft(SESSION);
  assert.equal(harnessed.thread().draft, "");
  assert.equal(harnessed.thread().turns[0].question, "next question?");
});

test("a draft survives a rejected submission", async () => {
  const harnessed = harness({ askError: Object.assign(new Error("busy"), { code: "BTW_BUSY" }) });
  harnessed.controller.setDraft(SESSION, "keep me");
  assert.equal(await harnessed.controller.submitDraft(SESSION), false);
  assert.equal(harnessed.thread().draft, "keep me");
});

test("disposing detaches the event and panel subscriptions", async () => {
  const harnessed = harness();
  harnessed.controller.open();
  harnessed.controller.dispose();
  harnessed.emit({ runId: "run-1", sessionId: SESSION, seq: 0, event: { type: "text_delta", delta: "late" } });
  assert.equal(harnessed.thread().turns.length, 0);
});

test("a failure is explained with the shared error copy", () => {
  const t = (key) => key;
  assert.equal(btwErrorText(t, { code: "BTW_CONTEXT_FULL", message: "too long" }), "errors.BTW_CONTEXT_FULL");
  assert.equal(btwErrorText(t, { code: "", message: "gateway down" }), "gateway down");
  assert.equal(btwErrorText(t, { code: "", message: "  " }), "panel.btw.failed");
  assert.equal(
    btwErrorText(t, { code: "UNSUPPORTED", message: "no handler" }),
    "panel.btw.desktopOnly",
  );
});
