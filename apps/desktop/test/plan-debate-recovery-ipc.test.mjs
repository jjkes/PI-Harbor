/**
 * Contract tests for the plan-debate recovery IPC module.
 *
 * These tests register the handlers against a fake registrar and mock sidecar,
 * then call the registered functions directly. They verify parameter validation,
 * sidecar forwarding, stable error mapping, remote-session refusal, and trace
 * identity — without touching a real runtime or model.
 */
import assert from "node:assert/strict";
import test from "node:test";

const { IPC } = await import("@pi-harbor/shared/protocol");
const { ErrorCodes } = await import("@pi-harbor/shared");
const { registerPlanDebateRecoveryIpc } = await import(
  "../electron/main/ipc/plan-debate-recovery-ipc.ts"
);

function makeRegistrar() {
  const handlers = new Map();
  return {
    handlers,
    handle: (channel, fn) => handlers.set(channel, fn),
  };
}

function makeSidecar(responses) {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      const response = responses[method];
      if (typeof response === "function") return response(params);
      return response;
    },
  };
}

function handlerFor(registrar, channel) {
  const fn = registrar.handlers.get(channel);
  if (typeof fn !== "function") {
    throw new Error(`channel ${channel} is not registered`);
  }
  return fn;
}

test("registers both recovery channels", () => {
  const registrar = makeRegistrar();
  registerPlanDebateRecoveryIpc({ registrar, getSidecar: () => null });
  assert.equal(typeof handlerFor(registrar, IPC.invoke.planDebateRetry), "function");
  assert.equal(typeof handlerFor(registrar, IPC.invoke.planDebateCancel), "function");
});

test("retry forwards to agent.planDebateRetry and echoes the traceId", async () => {
  const registrar = makeRegistrar();
  const sidecar = makeSidecar({
    "agent.planDebateRetry": { ok: true, round: 7, sourceRoundId: 5, proposed: true, started: true },
  });
  registerPlanDebateRecoveryIpc({ registrar, getSidecar: () => sidecar });

  const traceId = "trace-retry-1";
  const result = await handlerFor(registrar, IPC.invoke.planDebateRetry)({
    sessionId: "s1",
    sourceRound: 5,
    traceId,
  });

  assert.deepEqual(result, {
    ok: true,
    round: 7,
    sourceRoundId: 5,
    proposed: true,
    started: true,
    traceId,
  });
  assert.equal(sidecar.calls.length, 1);
  assert.deepEqual(sidecar.calls[0], {
    method: "agent.planDebateRetry",
    params: { sessionId: "s1", sourceRound: 5 },
  });
});

test("cancel forwards to agent.planDebateCancel and preserves stopTimedOut", async () => {
  const registrar = makeRegistrar();
  const sidecar = makeSidecar({
    "agent.planDebateCancel": { ok: true, cancelled: true, round: 3, stopTimedOut: true },
  });
  registerPlanDebateRecoveryIpc({ registrar, getSidecar: () => sidecar });

  const traceId = "trace-cancel-1";
  const result = await handlerFor(registrar, IPC.invoke.planDebateCancel)({
    sessionId: "s1",
    round: 3,
    traceId,
  });

  assert.deepEqual(result, {
    ok: true,
    cancelled: true,
    round: 3,
    stopTimedOut: true,
    traceId,
  });
  assert.equal(sidecar.calls.length, 1);
  assert.deepEqual(sidecar.calls[0], {
    method: "agent.planDebateCancel",
    params: { sessionId: "s1", round: 3 },
  });
});

test("invalid retry params return a stable INVALID_ARGUMENT error", async () => {
  const registrar = makeRegistrar();
  registerPlanDebateRecoveryIpc({ registrar, getSidecar: () => null });
  const invoke = handlerFor(registrar, IPC.invoke.planDebateRetry);

  for (const raw of [
    null,
    {},
    { sessionId: "" },
    { sessionId: "s1" },
    { sessionId: "s1", sourceRound: 0 },
    { sessionId: "s1", sourceRound: -1 },
    { sessionId: "s1", sourceRound: 1.5 },
    { sessionId: "s1", sourceRound: 1_000_001 },
  ]) {
    const result = await invoke(raw);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, ErrorCodes.INVALID_ARGUMENT);
    assert.equal(result.retryable, false);
    assert.ok(typeof result.traceId === "string");
  }
});

test("invalid cancel params return a stable INVALID_ARGUMENT error", async () => {
  const registrar = makeRegistrar();
  registerPlanDebateRecoveryIpc({ registrar, getSidecar: () => null });
  const invoke = handlerFor(registrar, IPC.invoke.planDebateCancel);

  for (const raw of [
    null,
    {},
    { sessionId: "" },
    { sessionId: "s1" },
    { sessionId: "s1", round: 0 },
    { sessionId: "s1", round: -1 },
    { sessionId: "s1", round: 1.5 },
    { sessionId: "s1", round: 1_000_001 },
  ]) {
    const result = await invoke(raw);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, ErrorCodes.INVALID_ARGUMENT);
    assert.equal(result.retryable, false);
    assert.ok(typeof result.traceId === "string");
  }
});

test("remote sessions are refused with CAPABILITY_UNAVAILABLE", async () => {
  const registrar = makeRegistrar();
  registerPlanDebateRecoveryIpc({ registrar, getSidecar: () => null });
  const traceId = "trace-remote";

  const retry = await handlerFor(registrar, IPC.invoke.planDebateRetry)({
    sessionId: "remote:host1:s1",
    sourceRound: 2,
    traceId,
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.errorCode, ErrorCodes.CAPABILITY_UNAVAILABLE);
  assert.equal(retry.retryable, false);
  assert.equal(retry.traceId, traceId);

  const cancel = await handlerFor(registrar, IPC.invoke.planDebateCancel)({
    sessionId: "remote:host1:s1",
    round: 2,
    traceId,
  });
  assert.equal(cancel.ok, false);
  assert.equal(cancel.errorCode, ErrorCodes.CAPABILITY_UNAVAILABLE);
  assert.equal(cancel.retryable, false);
  assert.equal(cancel.traceId, traceId);
});

test("missing sidecar returns a retryable HOST_UNAVAILABLE error", async () => {
  const registrar = makeRegistrar();
  registerPlanDebateRecoveryIpc({ registrar, getSidecar: () => null });
  const traceId = "trace-no-sidecar";

  const retry = await handlerFor(registrar, IPC.invoke.planDebateRetry)({
    sessionId: "s1",
    sourceRound: 2,
    traceId,
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.errorCode, ErrorCodes.HOST_UNAVAILABLE);
  assert.equal(retry.retryable, true);
  assert.equal(retry.traceId, traceId);

  const cancel = await handlerFor(registrar, IPC.invoke.planDebateCancel)({
    sessionId: "s1",
    round: 2,
    traceId,
  });
  assert.equal(cancel.ok, false);
  assert.equal(cancel.errorCode, ErrorCodes.HOST_UNAVAILABLE);
  assert.equal(cancel.retryable, true);
  assert.equal(cancel.traceId, traceId);
});

test("sidecar ok:false result maps to a stable error with derived retryable", async () => {
  const registrar = makeRegistrar();
  const sidecar = makeSidecar({
    "agent.planDebateRetry": {
      ok: false,
      errorCode: "PLAN_DEBATE_NOT_FOUND",
      message: "No source round",
    },
    "agent.planDebateCancel": {
      ok: false,
      errorCode: "PLAN_DEBATE_ACTIVE",
      message: "Round still active",
    },
  });
  registerPlanDebateRecoveryIpc({ registrar, getSidecar: () => sidecar });

  const retry = await handlerFor(registrar, IPC.invoke.planDebateRetry)({
    sessionId: "s1",
    sourceRound: 2,
    traceId: "t1",
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.errorCode, "PLAN_DEBATE_NOT_FOUND");
  assert.equal(retry.retryable, false);
  assert.equal(retry.traceId, "t1");

  const cancel = await handlerFor(registrar, IPC.invoke.planDebateCancel)({
    sessionId: "s1",
    round: 2,
    traceId: "t2",
  });
  assert.equal(cancel.ok, false);
  assert.equal(cancel.errorCode, "PLAN_DEBATE_ACTIVE");
  assert.equal(cancel.retryable, false);
  assert.equal(cancel.traceId, "t2");
});

test("sidecar throw maps to a stable error without leaking internal details", async () => {
  const registrar = makeRegistrar();
  const sidecar = makeSidecar({
    "agent.planDebateRetry": () => {
      const error = new Error("internal stack trace that must not leak");
      error.errorCode = "PLAN_DEBATE_NOT_FOUND";
      throw error;
    },
    "agent.planDebateCancel": () => {
      throw new Error("unexpected explosion");
    },
  });
  registerPlanDebateRecoveryIpc({ registrar, getSidecar: () => sidecar });

  const retry = await handlerFor(registrar, IPC.invoke.planDebateRetry)({
    sessionId: "s1",
    sourceRound: 2,
    traceId: "t1",
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.errorCode, "PLAN_DEBATE_NOT_FOUND");
  assert.equal(retry.traceId, "t1");
  assert.ok(!retry.message.includes("internal stack trace"));

  const cancel = await handlerFor(registrar, IPC.invoke.planDebateCancel)({
    sessionId: "s1",
    round: 2,
    traceId: "t2",
  });
  assert.equal(cancel.ok, false);
  assert.equal(cancel.errorCode, ErrorCodes.INTERNAL);
  assert.equal(cancel.retryable, false);
  assert.equal(cancel.traceId, "t2");
  assert.equal(cancel.message, "Plan-debate cancel failed");
});

test("a missing traceId is replaced by a generated id", async () => {
  const registrar = makeRegistrar();
  const sidecar = makeSidecar({
    "agent.planDebateRetry": { ok: true, round: 2, sourceRoundId: 1, proposed: false },
    "agent.planDebateCancel": { ok: true, cancelled: false, round: 1, stopTimedOut: false },
  });
  registerPlanDebateRecoveryIpc({ registrar, getSidecar: () => sidecar });

  const retry = await handlerFor(registrar, IPC.invoke.planDebateRetry)({
    sessionId: "s1",
    sourceRound: 1,
  });
  assert.equal(retry.ok, true);
  assert.ok(typeof retry.traceId === "string" && retry.traceId.length > 0);

  const cancel = await handlerFor(registrar, IPC.invoke.planDebateCancel)({
    sessionId: "s1",
    round: 1,
  });
  assert.equal(cancel.ok, true);
  assert.ok(typeof cancel.traceId === "string" && cancel.traceId.length > 0);
});


test("cancel stopTimedOut is surfaced so the user can retry", async () => {
  const registrar = makeRegistrar();
  const sidecar = makeSidecar({
    "agent.planDebateCancel": { ok: true, cancelled: true, round: 4, stopTimedOut: true },
  });
  registerPlanDebateRecoveryIpc({ registrar, getSidecar: () => sidecar });

  const result = await handlerFor(registrar, IPC.invoke.planDebateCancel)({
    sessionId: "s1",
    round: 4,
    traceId: "t-stop",
  });
  assert.deepEqual(result, {
    ok: true,
    cancelled: true,
    round: 4,
    stopTimedOut: true,
    traceId: "t-stop",
  });
});

test("consecutive recovery calls are not collapsed or deduplicated by the handler", async () => {
  const registrar = makeRegistrar();
  const sidecar = makeSidecar({
    "agent.planDebateRetry": { ok: true, round: 8, sourceRoundId: 5, proposed: false },
  });
  registerPlanDebateRecoveryIpc({ registrar, getSidecar: () => sidecar });
  const invoke = handlerFor(registrar, IPC.invoke.planDebateRetry);

  const first = await invoke({ sessionId: "s1", sourceRound: 5, traceId: "t1" });
  const second = await invoke({ sessionId: "s1", sourceRound: 5, traceId: "t2" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(sidecar.calls.length, 2);
  assert.equal(sidecar.calls[0].params.sessionId, "s1");
  assert.equal(sidecar.calls[1].params.sessionId, "s1");
});

test("retry and cancel keep the requested session id unchanged", async () => {
  const registrar = makeRegistrar();
  const sidecar = makeSidecar({
    "agent.planDebateRetry": { ok: true, round: 3, sourceRoundId: 2, proposed: false },
    "agent.planDebateCancel": { ok: true, cancelled: true, round: 3, stopTimedOut: false },
  });
  registerPlanDebateRecoveryIpc({ registrar, getSidecar: () => sidecar });

  await handlerFor(registrar, IPC.invoke.planDebateRetry)({
    sessionId: "session-a",
    sourceRound: 2,
    traceId: "t-a",
  });
  await handlerFor(registrar, IPC.invoke.planDebateCancel)({
    sessionId: "session-b",
    round: 3,
    traceId: "t-b",
  });

  assert.equal(sidecar.calls[0].params.sessionId, "session-a");
  assert.equal(sidecar.calls[1].params.sessionId, "session-b");
});

test("retry phase is passed through when the round is already running", async () => {
  const registrar = makeRegistrar();
  const sidecar = makeSidecar({
    "agent.planDebateRetry": { ok: true, round: 3, sourceRoundId: 2, proposed: false, started: false, phase: "draft" },
  });
  registerPlanDebateRecoveryIpc({ registrar, getSidecar: () => sidecar });

  const result = await handlerFor(registrar, IPC.invoke.planDebateRetry)({
    sessionId: "s1",
    sourceRound: 2,
    traceId: "t-phase",
  });

  assert.deepEqual(result, {
    ok: true,
    round: 3,
    sourceRoundId: 2,
    proposed: false,
    started: false,
    phase: "draft",
    traceId: "t-phase",
  });
});

test("sidecar retryable flag is preferred over derived retryable", async () => {
  const registrar = makeRegistrar();
  const sidecar = makeSidecar({
    "agent.planDebateRetry": { ok: false, errorCode: "PLAN_DEBATE_UNAVAILABLE", message: "No delegates", retryable: true },
  });
  registerPlanDebateRecoveryIpc({ registrar, getSidecar: () => sidecar });

  const result = await handlerFor(registrar, IPC.invoke.planDebateRetry)({
    sessionId: "s1",
    sourceRound: 2,
    traceId: "t-retryable",
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "PLAN_DEBATE_UNAVAILABLE");
  assert.equal(result.retryable, true);
  assert.equal(result.traceId, "t-retryable");
});

