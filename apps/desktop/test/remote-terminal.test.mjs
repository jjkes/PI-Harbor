import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("@pi-harbor/shared");
const { makeRemoteSessionId } = await import("../electron/main/remote/backend-router.ts");
const { createRemoteBackend } = await import("../electron/main/remote/remote-backend.ts");
const { createRemoteEventBridge } = await import("../electron/main/remote/remote-event-bridge.ts");

const HOST_KEY = "hostA";
const HOST_SESSION_ID = "sess-1";
const REMOTE_SESSION_ID = makeRemoteSessionId(HOST_KEY, HOST_SESSION_ID);
const TERMINAL_ID = "term-1";

function fakeClient(responses = {}, { terminal = true } = {}) {
  const calls = [];
  return {
    calls,
    capabilities: () => ({ terminal }),
    request: async (method, params) => {
      calls.push({ method, params });
      const handler = responses[method];
      if (typeof handler === "function") return handler(params);
      if (handler === undefined) {
        throw Object.assign(new Error(`no fake for ${method}`), { errorCode: "INTERNAL" });
      }
      return handler;
    },
  };
}

function makeBackend(responses = {}, { confirmed = true, terminal = true } = {}) {
  const confirmCalls = [];
  const confirmTerminalOpen = async () => {
    confirmCalls.push({});
    return confirmed;
  };
  const client = fakeClient(responses, { terminal });
  const backend = createRemoteBackend({ hostKey: HOST_KEY, client, confirmTerminalOpen });
  return { backend, client, confirmCalls };
}

function makeBridge() {
  const events = [];
  const bridge = createRemoteEventBridge({
    hostKey: HOST_KEY,
    emit: (channel, payload) => events.push({ channel, payload }),
  });
  return { bridge, events };
}

function makeEnvelope(kind, payload = {}) {
  return {
    eventId: "e1",
    scope: "session",
    sessionId: HOST_SESSION_ID,
    epoch: "epoch-1",
    revision: 1,
    kind,
    occurredAt: "2026-09-18T10:00:00.000Z",
    payload,
  };
}

test("handles() covers terminal channels", () => {
  const { backend } = makeBackend();
  for (const channel of [
    IPC.invoke.terminalOpen,
    IPC.invoke.terminalInput,
    IPC.invoke.terminalResize,
    IPC.invoke.terminalInterrupt,
    IPC.invoke.terminalClose,
  ]) {
    assert.ok(backend.handles(channel), `${channel} should be handled`);
  }
});

test("terminalOpen forwards to RACP terminal/open and returns the host result", async () => {
  const { backend, client } = makeBackend({
    "terminal/open": () => ({ terminalId: TERMINAL_ID, replay: "", cols: 100, rows: 30 }),
  });
  const result = await backend.invoke(IPC.invoke.terminalOpen, [
    { sessionId: REMOTE_SESSION_ID, cols: 100, rows: 30 },
  ]);
  assert.deepEqual(result, { terminalId: TERMINAL_ID, replay: "", cols: 100, rows: 30 });
  assert.equal(client.calls[0].method, "terminal/open");
  assert.equal(client.calls[0].params.sessionId, HOST_SESSION_ID);
  assert.equal(client.calls[0].params.cols, 100);
  assert.equal(client.calls[0].params.rows, 30);
});

test("terminalOpen reattaches when terminalId is provided", async () => {
  const { backend, client } = makeBackend({
    "terminal/open": () => ({ terminalId: TERMINAL_ID, replay: "cmVwbGF5", cols: 80, rows: 24 }),
  });
  const result = await backend.invoke(IPC.invoke.terminalOpen, [
    { sessionId: REMOTE_SESSION_ID, terminalId: TERMINAL_ID },
  ]);
  assert.equal(result.terminalId, TERMINAL_ID);
  assert.equal(client.calls[0].params.terminalId, TERMINAL_ID);
});

test("terminalInput forwards base64 data", async () => {
  const { backend, client } = makeBackend({ "terminal/input": () => ({ ok: true }) });
  const data = Buffer.from("hello", "utf8").toString("base64");
  const result = await backend.invoke(IPC.invoke.terminalInput, [
    { sessionId: REMOTE_SESSION_ID, terminalId: TERMINAL_ID, data },
  ]);
  assert.deepEqual(result, { ok: true });
  assert.equal(client.calls[0].method, "terminal/input");
  assert.equal(client.calls[0].params.sessionId, HOST_SESSION_ID);
  assert.equal(client.calls[0].params.terminalId, TERMINAL_ID);
  assert.equal(client.calls[0].params.data, data);
});

test("terminalResize forwards cols and rows", async () => {
  const { backend, client } = makeBackend({ "terminal/resize": () => ({ ok: true }) });
  const result = await backend.invoke(IPC.invoke.terminalResize, [
    { sessionId: REMOTE_SESSION_ID, terminalId: TERMINAL_ID, cols: 120, rows: 40 },
  ]);
  assert.deepEqual(result, { ok: true });
  assert.equal(client.calls[0].method, "terminal/resize");
  assert.deepEqual(client.calls[0].params, { sessionId: HOST_SESSION_ID, terminalId: TERMINAL_ID, cols: 120, rows: 40 });
});

test("terminalInterrupt forwards to RACP terminal/interrupt", async () => {
  const { backend, client } = makeBackend({ "terminal/interrupt": () => ({ ok: true }) });
  const result = await backend.invoke(IPC.invoke.terminalInterrupt, [
    { sessionId: REMOTE_SESSION_ID, terminalId: TERMINAL_ID },
  ]);
  assert.deepEqual(result, { ok: true });
  assert.equal(client.calls[0].method, "terminal/interrupt");
  assert.deepEqual(client.calls[0].params, { sessionId: HOST_SESSION_ID, terminalId: TERMINAL_ID });
});

test("terminalClose forwards to RACP terminal/close", async () => {
  const { backend, client } = makeBackend({ "terminal/close": () => ({ ok: true }) });
  const result = await backend.invoke(IPC.invoke.terminalClose, [
    { sessionId: REMOTE_SESSION_ID, terminalId: TERMINAL_ID },
  ]);
  assert.deepEqual(result, { ok: true });
  assert.equal(client.calls[0].method, "terminal/close");
  assert.deepEqual(client.calls[0].params, { sessionId: HOST_SESSION_ID, terminalId: TERMINAL_ID });
});


test("terminalOpen requires remote terminal capability", async () => {
  const { backend } = makeBackend({ "terminal/open": () => ({ terminalId: TERMINAL_ID }) }, { terminal: false });
  await assert.rejects(
    backend.invoke(IPC.invoke.terminalOpen, [{ sessionId: REMOTE_SESSION_ID, cols: 80, rows: 24 }]),
    (e) => e.errorCode === "CAPABILITY_UNAVAILABLE" && e.message.includes("does not support interactive terminals"),
  );
});

test("terminalInput requires remote terminal capability", async () => {
  const { backend } = makeBackend({ "terminal/input": () => ({ ok: true }) }, { terminal: false });
  await assert.rejects(
    backend.invoke(IPC.invoke.terminalInput, [{ sessionId: REMOTE_SESSION_ID, terminalId: TERMINAL_ID, data: "aQ==" }]),
    (e) => e.errorCode === "CAPABILITY_UNAVAILABLE",
  );
});

test("terminalOpen prompts for confirmation on new terminals", async () => {
  const { backend, client, confirmCalls } = makeBackend({
    "terminal/open": () => ({ terminalId: TERMINAL_ID, replay: "", cols: 80, rows: 24 }),
  });
  await backend.invoke(IPC.invoke.terminalOpen, [{ sessionId: REMOTE_SESSION_ID, cols: 80, rows: 24 }]);
  assert.equal(confirmCalls.length, 1);
  assert.equal(client.calls[0].method, "terminal/open");
});

test("terminalOpen does not prompt when terminalId is provided", async () => {
  const { backend, client, confirmCalls } = makeBackend({
    "terminal/open": () => ({ terminalId: TERMINAL_ID, replay: "", cols: 80, rows: 24 }),
  });
  await backend.invoke(IPC.invoke.terminalOpen, [{ sessionId: REMOTE_SESSION_ID, terminalId: TERMINAL_ID }]);
  assert.equal(confirmCalls.length, 0);
  assert.equal(client.calls[0].params.terminalId, TERMINAL_ID);
});

test("terminalOpen rejects when user cancels", async () => {
  const { backend, client, confirmCalls } = makeBackend(
    { "terminal/open": () => ({ terminalId: TERMINAL_ID }) },
    { confirmed: false },
  );
  await assert.rejects(
    backend.invoke(IPC.invoke.terminalOpen, [{ sessionId: REMOTE_SESSION_ID }]),
    (e) => e.errorCode === "CANCELLED",
  );
  assert.equal(confirmCalls.length, 1);
  assert.equal(client.calls.length, 0);
});

test("an unsupported terminal channel fails closed with INTERNAL", async () => {
  const { backend } = makeBackend();
  await assert.rejects(
    backend.invoke("pi-harbor/terminal/unknown", [{ terminalId: TERMINAL_ID }]),
    (error) => error.errorCode === "INTERNAL",
  );
});

test("event bridge translates terminal.output to terminalOutput", () => {
  const { bridge, events } = makeBridge();
  const data = Buffer.from("hello", "utf8").toString("base64");
  bridge.handle(makeEnvelope("terminal.output", { terminalId: TERMINAL_ID, data }));
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, IPC.event.terminalOutput);
  assert.equal(events[0].payload.sessionId, REMOTE_SESSION_ID);
  assert.equal(events[0].payload.terminalId, TERMINAL_ID);
  assert.equal(events[0].payload.data, data);
});

test("event bridge translates terminal.changed opened to terminalChanged", () => {
  const { bridge, events } = makeBridge();
  bridge.handle(makeEnvelope("terminal.changed", { terminalId: TERMINAL_ID, state: "opened" }));
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, IPC.event.terminalChanged);
  assert.equal(events[0].payload.sessionId, REMOTE_SESSION_ID);
  assert.equal(events[0].payload.terminalId, TERMINAL_ID);
  assert.equal(events[0].payload.state, "opened");
});

test("event bridge translates terminal.changed exited with code", () => {
  const { bridge, events } = makeBridge();
  bridge.handle(makeEnvelope("terminal.changed", { terminalId: TERMINAL_ID, state: "exited", code: 0 }));
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, IPC.event.terminalChanged);
  assert.equal(events[0].payload.state, "exited");
  assert.equal(events[0].payload.code, 0);
});

test("event bridge drops terminal events missing a terminalId", () => {
  const { bridge, events } = makeBridge();
  bridge.handle(makeEnvelope("terminal.output", { data: "x" }));
  bridge.handle(makeEnvelope("terminal.changed", { state: "opened" }));
  assert.equal(events.length, 0);
});
