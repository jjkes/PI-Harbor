import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { ErrorCodes, IPC } = await import("@pi-harbor/shared");
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");

function approval(overrides = {}) {
  return {
    proposalId: "proposal-1",
    sessionId: "session-1",
    turnId: "turn-1",
    toolCallId: "call-1",
    version: 2,
    action: "approve",
    targetPermissionMode: "auto",
    ...overrides,
  };
}

function makeHarness(session = {
  id: "session-1",
  source: "desktop",
  capabilities: { canConfigureModel: true },
}) {
  const handlers = new Map();
  const hostCalls = [];
  const settlements = [];
  const host = {
    async call(method, params) {
      hostCalls.push({ method, params });
      if (method === "session.get") return { session };
      if (method === "plans.resolve") {
        return {
          ok: true,
          state: "inactive",
          action: params.action,
          targetPermissionMode: params.targetPermissionMode,
          targetModel: params.targetModel,
          proposal: {
            id: params.proposalId,
            sessionId: params.sessionId,
            turnId: params.turnId,
            toolCallId: params.toolCallId,
            kind: "plan",
            title: "Plan",
            markdown: "plan",
            plan: "plan",
            question: "Continue?",
            version: params.version,
            status: params.action === "approve" ? "approved" : "rejected",
            createdAt: "2026-10-28T00:00:00.000Z",
            updatedAt: "2026-10-28T00:00:00.000Z",
            targetModel: params.targetModel,
          },
        };
      }
      assert.fail(`unexpected host RPC ${method}`);
    },
  };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => null,
    getAgentHostBridge: () => ({
      settleApproval: (id, outcome) => settlements.push({ id, outcome }),
    }),
    dispatchApprovedPlan: async () => {},
    dispatchExecutionForProposal: async () => {},
  });
  return {
    hostCalls,
    settlements,
    resolve: (request) => handlers.get(IPC.invoke.plansResolve)(request),
  };
}

test("plansResolve normalizes and forwards targetModel without leaking it to native settlement", async () => {
  const harness = makeHarness();
  await harness.resolve(approval({
    targetModel: { providerId: "  provider-b ", modelId: " model-b  ", thinkingLevel: "high" },
  }));
  assert.deepEqual(harness.hostCalls.map((call) => call.method), ["session.get", "plans.resolve"]);
  assert.deepEqual(harness.hostCalls[1].params.targetModel, {
    providerId: "provider-b",
    modelId: "model-b",
    thinkingLevel: "high",
  });
  assert.deepEqual(harness.settlements, [{
    id: "proposal-1",
    outcome: { decision: "approve", permissionMode: "auto" },
  }]);
});

test("plansResolve rejects malformed targets and targets on reject before host resolution", async () => {
  const harness = makeHarness();
  const invalid = [
    [],
    "provider/model",
    {},
    { providerId: " ", modelId: "model" },
    { providerId: "provider", modelId: "" },
    { providerId: "provider", modelId: "model", thinkingLevel: "turbo" },
    { providerId: "provider", modelId: "model", thinkingLevel: null },
  ];
  for (const targetModel of invalid) {
    await assert.rejects(
      harness.resolve(approval({ targetModel })),
      (error) => error.errorCode === ErrorCodes.PLAN_TARGET_MODEL_INVALID,
    );
  }
  await assert.rejects(
    harness.resolve(approval({
      action: "reject",
      targetPermissionMode: undefined,
      targetModel: { providerId: "provider", modelId: "model" },
    })),
    (error) => error.errorCode === ErrorCodes.PLAN_TARGET_MODEL_INVALID,
  );
  assert.equal(harness.hostCalls.length, 0);
});

test("plansResolve refuses targetModel for native and capability-blocked sessions", async () => {
  const native = makeHarness();
  await assert.rejects(
    native.resolve(approval({
      sessionId: "native-pi:fixture",
      targetModel: { providerId: "provider", modelId: "model" },
    })),
    (error) => error.errorCode === ErrorCodes.PLAN_TARGET_MODEL_INVALID,
  );
  assert.equal(native.hostCalls.length, 0);

  for (const session of [
    { id: "session-1", source: "pi-native" },
    { id: "session-1", source: "remote", capabilities: { canConfigureModel: true } },
    { id: "session-1", source: "desktop", capabilities: { canConfigureModel: false } },
  ]) {
    const blocked = makeHarness(session);
    await assert.rejects(
      blocked.resolve(approval({
        targetModel: { providerId: "provider", modelId: "model" },
      })),
      (error) => error.errorCode === ErrorCodes.PLAN_TARGET_MODEL_INVALID,
    );
    assert.deepEqual(blocked.hostCalls.map((call) => call.method), ["session.get"]);
  }
});

test("plansResolve preserves the legacy payload when targetModel is absent or null", async () => {
  for (const targetModel of [undefined, null]) {
    const harness = makeHarness();
    await harness.resolve(approval({ targetModel }));
    assert.deepEqual(harness.hostCalls, [{
      method: "plans.resolve",
      params: {
        proposalId: "proposal-1",
        sessionId: "session-1",
        turnId: "turn-1",
        toolCallId: "call-1",
        action: "approve",
        version: 2,
        targetPermissionMode: "auto",
      },
    }]);
  }
});
