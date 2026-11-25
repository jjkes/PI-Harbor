import assert from "node:assert/strict";
import test from "node:test";
import { IPC } from "@pi-harbor/shared";

const { registerLocalTerminalIpc } = await import(
  "../electron/main/ipc/local-terminal-ipc.ts"
);

function makeRegistrar() {
  const handlers = new Map();
  return {
    handlers,
    ipcMain: {},
    handle: (channel, fn) => handlers.set(channel, fn),
    handleWithEvent: () => {
      throw new Error("unused");
    },
    assertMainWindowSender: () => {},
  };
}

function makeHost() {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      return {
        terminalId: "term-test-1",
        cols: params.cols,
        rows: params.rows,
        replay: "",
      };
    },
  };
}

function setup({ confirmed = true } = {}) {
  const registrar = makeRegistrar();
  const host = makeHost();
  const confirmCalls = [];
  const confirmTerminalOpen = async () => {
    confirmCalls.push({});
    return confirmed;
  };
  registerLocalTerminalIpc({
    registrar,
    getHost: () => host,
    confirmTerminalOpen,
    checkPlatform: () => true,
  });
  const open = registrar.handlers.get(IPC.invoke.terminalOpen);
  return { open, host, confirmCalls };
}

test("terminalOpen rejects non-integer cols", async () => {
  const { open } = setup();
  for (const cols of [0, -1, 1.5, 1001, NaN, "100"]) {
    await assert.rejects(
      open({ sessionId: "sess-1", cols, rows: 24 }),
      (e) => e.errorCode === "INVALID_ARGUMENT" && e.message.includes("cols"),
    );
  }
});

test("terminalOpen rejects non-integer rows", async () => {
  const { open } = setup();
  for (const rows of [0, -10, 30.7, 1001, NaN, "24"]) {
    await assert.rejects(
      open({ sessionId: "sess-1", cols: 80, rows }),
      (e) => e.errorCode === "INVALID_ARGUMENT" && e.message.includes("rows"),
    );
  }
});

test("terminalOpen uses defaults only when cols/rows are omitted", async () => {
  const { open, host } = setup();
  await open({ sessionId: "sess-1" });
  assert.equal(host.calls.length, 1);
  assert.deepEqual(host.calls[0].params, {
    sessionId: "sess-1",
    cols: 80,
    rows: 24,
    userConfirmed: true,
  });
});

test("terminalOpen ignores renderer-supplied userConfirmed", async () => {
  const { open, host, confirmCalls } = setup({ confirmed: false });
  await assert.rejects(
    open({ sessionId: "sess-1", userConfirmed: true }),
    (e) => e.errorCode === "CANCELLED",
  );
  assert.equal(confirmCalls.length, 1);
  assert.equal(host.calls.length, 0);
});

test("terminalOpen does not call host when user cancels", async () => {
  const { open, host } = setup({ confirmed: false });
  await assert.rejects(open({ sessionId: "sess-1" }), {
    errorCode: "CANCELLED",
  });
  assert.equal(host.calls.length, 0);
});

test("terminalOpen calls host with userConfirmed true after confirmation", async () => {
  const { open, host } = setup({ confirmed: true });
  const result = await open({ sessionId: "sess-1", cols: 100, rows: 30 });
  assert.equal(host.calls.length, 1);
  const { method, params } = host.calls[0];
  assert.equal(method, "terminal.open");
  assert.deepEqual(params, {
    sessionId: "sess-1",
    cols: 100,
    rows: 30,
    userConfirmed: true,
  });
  assert.equal(result.terminalId, "term-test-1");
});

test("terminalOpen preserves explicit valid cols and rows", async () => {
  const { open, host } = setup();
  await open({ sessionId: "sess-1", cols: 1, rows: 1 });
  assert.equal(host.calls[0].params.cols, 1);
  assert.equal(host.calls[0].params.rows, 1);
  await open({ sessionId: "sess-1", cols: 1000, rows: 1000 });
  assert.equal(host.calls[1].params.cols, 1000);
  assert.equal(host.calls[1].params.rows, 1000);
});

function setupWithPlatform({ confirmed = true, platformSupported = true } = {}) {
  const registrar = makeRegistrar();
  const host = makeHost();
  const confirmCalls = [];
  const confirmTerminalOpen = async () => {
    confirmCalls.push({});
    return confirmed;
  };
  registerLocalTerminalIpc({
    registrar,
    getHost: () => host,
    confirmTerminalOpen,
    checkPlatform: () => platformSupported,
  });
  return {
    open: registrar.handlers.get(IPC.invoke.terminalOpen),
    input: registrar.handlers.get(IPC.invoke.terminalInput),
    resize: registrar.handlers.get(IPC.invoke.terminalResize),
    interrupt: registrar.handlers.get(IPC.invoke.terminalInterrupt),
    close: registrar.handlers.get(IPC.invoke.terminalClose),
    host,
    confirmCalls,
  };
}

test("terminalOpen rejects non-Linux platforms with CAPABILITY_UNAVAILABLE", async () => {
  const { open } = setupWithPlatform({ platformSupported: false });
  await assert.rejects(open({ sessionId: "sess-1" }), {
    errorCode: "CAPABILITY_UNAVAILABLE",
    message: /only supported on Linux/,
  });
});

test("terminalInput rejects non-Linux platforms", async () => {
  const { input } = setupWithPlatform({ platformSupported: false });
  await assert.rejects(
    input({ sessionId: "sess-1", terminalId: "term-1", data: "aGVsbG8=" }),
    (e) => e.errorCode === "CAPABILITY_UNAVAILABLE",
  );
});

test("terminalResize rejects non-Linux platforms", async () => {
  const { resize } = setupWithPlatform({ platformSupported: false });
  await assert.rejects(
    resize({ sessionId: "sess-1", terminalId: "term-1", cols: 80, rows: 24 }),
    (e) => e.errorCode === "CAPABILITY_UNAVAILABLE",
  );
});

test("terminalInterrupt rejects non-Linux platforms", async () => {
  const { interrupt } = setupWithPlatform({ platformSupported: false });
  await assert.rejects(
    interrupt({ sessionId: "sess-1", terminalId: "term-1" }),
    (e) => e.errorCode === "CAPABILITY_UNAVAILABLE",
  );
});

test("terminalClose rejects non-Linux platforms", async () => {
  const { close } = setupWithPlatform({ platformSupported: false });
  await assert.rejects(
    close({ sessionId: "sess-1", terminalId: "term-1" }),
    (e) => e.errorCode === "CAPABILITY_UNAVAILABLE",
  );
});
