import assert from "node:assert/strict";
import test from "node:test";

const { IPC } = await import("@pi-harbor/shared");
const { BtwRunRegistry } = await import("../electron/main/runtime/btw-runs.ts");
const { registerBtwIpc } = await import("../electron/main/ipc/btw-ipc.ts");

function fakeSender(id) {
  const listeners = new Map();
  const add = (event, listener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  };
  return {
    id,
    on: add,
    once: add,
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

function harness({ session = { id: "s1", source: "desktop" }, running = false, askError } = {}) {
  const handlers = new Map();
  const calls = [];
  const aborted = [];
  const btwRuns = new BtwRunRegistry({ send: () => {}, abort: (runId) => aborted.push(runId) });
  registerBtwIpc({
    registrar: { handleWithEvent: (channel, fn) => handlers.set(channel, fn) },
    getHost: () => ({
      call: async (method, params) => {
        calls.push(["host", method, params]);
        if (method === "session.get") return { session };
        if (method === "settings.get") return { theme: "dark" };
        throw new Error(`unexpected host method ${method}`);
      },
    }),
    getSidecar: () => ({
      call: async (method, params) => {
        calls.push(["sidecar", method, params]);
        if (askError && method === "btw.ask") throw askError;
        return method === "btw.ask" ? { accepted: true } : { aborted: true };
      },
    }),
    activeTurns: new Map(running ? [["s1", "turn-1"]] : []),
    resolveAgentRuntimeLaunch: async (sessionId, resolvedSession, settings) => {
      calls.push(["launch", sessionId, resolvedSession.id, settings.theme]);
      return { sidecarParams: { sessionId, provider: { id: "p1" } } };
    },
    btwRuns,
  });
  return {
    calls,
    aborted,
    btwRuns,
    ask: (request, sender = fakeSender(7)) => handlers.get(IPC.invoke.btwAsk)({ sender }, request),
    abort: (runId) => handlers.get(IPC.invoke.btwAbort)({ sender: fakeSender(7) }, { runId }),
  };
}

const request = (overrides = {}) => ({
  sessionId: "s1",
  runId: "run-1",
  question: "What changed?",
  history: [],
  ...overrides,
});

const started = { type: "started", providerId: "p", modelId: "m", mainTurnRunning: false };

test("btwAsk forwards a valid question with the launch it resolved and tracks the run", async () => {
  const h = harness();
  assert.deepEqual(await h.ask(request()), { accepted: true });
  assert.deepEqual(h.calls, [
    ["host", "session.get", { id: "s1", messageLimit: 1 }],
    ["host", "settings.get", undefined],
    ["launch", "s1", "s1", "dark"],
    [
      "sidecar",
      "btw.ask",
      {
        sessionId: "s1",
        runId: "run-1",
        question: "What changed?",
        history: [],
        launchIfAbsent: { sessionId: "s1", provider: { id: "p1" } },
      },
    ],
  ]);
  assert.equal(h.btwRuns.has("run-1"), true);
});

test("btwAsk refuses remote and Pi-native ids before any host call", async () => {
  const h = harness();
  for (const sessionId of ["remote:host-a:s1", "native-pi:abc"]) {
    await assert.rejects(h.ask(request({ sessionId })), { errorCode: "BTW_UNAVAILABLE" });
  }
  assert.deepEqual(h.calls, []);
});

test("btwAsk refuses a session the host does not report as local", async () => {
  const h = harness({ session: { id: "s1", source: "remote" } });
  await assert.rejects(h.ask(request()), { errorCode: "BTW_UNAVAILABLE" });
  assert.equal(h.calls.some(([target]) => target === "sidecar"), false);
  assert.equal(h.btwRuns.has("run-1"), false);
});

test("btwAsk rejects a malformed request before any work", async () => {
  const h = harness();
  await assert.rejects(h.ask(request({ runId: "bad id!" })), { errorCode: "INVALID_ARGUMENT" });
  await assert.rejects(h.ask(request({ question: "" })), { errorCode: "INVALID_ARGUMENT" });
  assert.deepEqual(h.calls, []);
});

test("btwAsk does not resolve a launch while a main turn runs", async () => {
  const h = harness({ running: true });
  await h.ask(request());
  assert.equal(h.calls.some(([target, method]) => target === "launch" || method === "settings.get"), false);
  const ask = h.calls.find(([target, method]) => target === "sidecar" && method === "btw.ask");
  assert.equal(ask[2].launchIfAbsent, undefined);
});

test("btwAsk untracks a run the sidecar refuses", async () => {
  const busy = Object.assign(new Error("busy"), { errorCode: "BTW_BUSY" });
  const h = harness({ askError: busy });
  await assert.rejects(h.ask(request()), { errorCode: "BTW_BUSY" });
  assert.equal(h.btwRuns.has("run-1"), false);
});

test("a renderer reload, crash, or close aborts the runs it started", async () => {
  const h = harness();
  const sender = fakeSender(9);
  await h.ask(request({ runId: "run-a" }), sender);
  sender.emit("did-start-navigation", {}, "app://index.html", true, true);
  assert.deepEqual(h.aborted, [], "an in-page navigation keeps the run");
  sender.emit("did-start-navigation", {}, "app://index.html", false, true);
  assert.deepEqual(h.aborted, ["run-a"]);
  assert.equal(h.btwRuns.has("run-a"), false);
  await h.ask(request({ runId: "run-b" }), sender);
  sender.emit("destroyed");
  assert.deepEqual(h.aborted, ["run-a", "run-b"]);
});

test("btwAbort forwards only runs Main started", async () => {
  const h = harness();
  assert.deepEqual(await h.abort("run-x"), { aborted: false });
  assert.equal(h.calls.length, 0);
  await h.ask(request());
  assert.deepEqual(await h.abort("run-1"), { aborted: true });
  assert.deepEqual(h.calls.at(-1), ["sidecar", "btw.abort", { runId: "run-1" }]);
});

test("the registry forwards a tracked run in order and releases it at its terminal event", () => {
  const sent = [];
  const registry = new BtwRunRegistry({ send: (envelope) => sent.push(envelope), abort: () => {} });
  registry.track("r1", "s1");
  const envelope = (seq, event, runId = "r1", sessionId = "s1") => ({ runId, sessionId, seq, event });
  registry.forward(envelope(0, started));
  registry.forward(envelope(0, { type: "text_delta", delta: "stale" }));
  registry.forward(envelope(1, { type: "text_delta", delta: "unknown run" }, "r2"));
  registry.forward(envelope(1, { type: "text_delta", delta: "wrong session" }, "r1", "s2"));
  registry.forward({ runId: "r1" });
  registry.forward(envelope(1, { type: "done", stopReason: "stop" }));
  registry.forward(envelope(2, { type: "text_delta", delta: "late" }));
  assert.deepEqual(sent.map((item) => [item.seq, item.event.type]), [[0, "started"], [1, "done"]]);
  assert.equal(registry.has("r1"), false);
});

test("a sidecar exit ends every active run with BTW_RUNTIME_EXITED", () => {
  const sent = [];
  const registry = new BtwRunRegistry({ send: (envelope) => sent.push(envelope), abort: () => {} });
  registry.track("r1", "s1");
  registry.track("r2", "s2");
  registry.forward({ runId: "r1", sessionId: "s1", seq: 0, event: started });
  registry.failAll();
  assert.deepEqual(
    sent.slice(1).map((item) => [item.runId, item.seq, item.event.type, item.event.error.code]),
    [
      ["r1", 1, "error", "BTW_RUNTIME_EXITED"],
      ["r2", 0, "error", "BTW_RUNTIME_EXITED"],
    ],
  );
  assert.equal(registry.has("r1") || registry.has("r2"), false);
});

test("deleting a session aborts its runs and still routes their end", () => {
  const aborted = [];
  const registry = new BtwRunRegistry({ send: () => {}, abort: (runId) => aborted.push(runId) });
  registry.track("r1", "s1");
  registry.track("r2", "s2");
  registry.abortSession("s1");
  assert.deepEqual(aborted, ["r1"]);
  assert.equal(registry.has("r1"), true);
});
