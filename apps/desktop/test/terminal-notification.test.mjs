import assert from "node:assert/strict";
import test from "node:test";

const {
  normalizeTerminalOutput,
  normalizeTerminalChanged,
} = await import("../electron/main/terminal-notification.ts");

const SESSION_ID = "sess-1";
const TERMINAL_ID = "term-1";

test("normalizeTerminalOutput prefers data over output", () => {
  const event = normalizeTerminalOutput({
    sessionId: SESSION_ID,
    terminalId: TERMINAL_ID,
    data: "data-value",
    output: "output-value",
    stream: "stderr",
  });
  assert.equal(event?.data, "data-value");
  assert.equal(event?.stream, "stderr");
});

test("normalizeTerminalOutput falls back to output", () => {
  const event = normalizeTerminalOutput({
    sessionId: SESSION_ID,
    terminalId: TERMINAL_ID,
    output: "output-value",
  });
  assert.equal(event?.data, "output-value");
  assert.equal(event?.stream, "stdout");
});

test("normalizeTerminalOutput defaults stream to stdout", () => {
  const event = normalizeTerminalOutput({
    sessionId: SESSION_ID,
    terminalId: TERMINAL_ID,
    data: "x",
  });
  assert.equal(event?.stream, "stdout");
});

test("normalizeTerminalOutput rejects non-records", () => {
  assert.equal(normalizeTerminalOutput(null), undefined);
  assert.equal(normalizeTerminalOutput("string"), undefined);
  assert.equal(normalizeTerminalOutput(42), undefined);
});

test("normalizeTerminalOutput requires sessionId and terminalId", () => {
  assert.equal(normalizeTerminalOutput({ terminalId: TERMINAL_ID, data: "x" }), undefined);
  assert.equal(normalizeTerminalOutput({ sessionId: SESSION_ID, data: "x" }), undefined);
});

test("normalizeTerminalChanged maps open to opened", () => {
  const event = normalizeTerminalChanged({
    sessionId: SESSION_ID,
    terminalId: TERMINAL_ID,
    state: "open",
  });
  assert.equal(event?.state, "opened");
  assert.equal(event?.code, undefined);
});

test("normalizeTerminalChanged preserves opened/closed/exited", () => {
  for (const state of ["opened", "closed", "exited"]) {
    const event = normalizeTerminalChanged({
      sessionId: SESSION_ID,
      terminalId: TERMINAL_ID,
      state,
    });
    assert.equal(event?.state, state);
  }
});

test("normalizeTerminalChanged maps exitCode to code", () => {
  const event = normalizeTerminalChanged({
    sessionId: SESSION_ID,
    terminalId: TERMINAL_ID,
    state: "exited",
    exitCode: 42,
  });
  assert.equal(event?.code, 42);
});

test("normalizeTerminalChanged accepts code as well", () => {
  const event = normalizeTerminalChanged({
    sessionId: SESSION_ID,
    terminalId: TERMINAL_ID,
    state: "exited",
    code: 7,
  });
  assert.equal(event?.code, 7);
});

test("normalizeTerminalChanged drops invalid states", () => {
  assert.equal(
    normalizeTerminalChanged({
      sessionId: SESSION_ID,
      terminalId: TERMINAL_ID,
      state: "unknown",
    }),
    undefined,
  );
});
