import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { IPC } from "@pi-harbor/shared/protocol";
import { NATIVE_PI_SESSION_PREFIX } from "../../../packages/shared/dist/remote-session-id.js";
import { ErrorCodes } from "../../../packages/shared/dist/errors.js";

function loadHandoffService() {
  const file = new URL(
    "../electron/main/runtime/plan-debate-handoff.ts",
    import.meta.url,
  );
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const imports = {
    "@pi-harbor/shared": {
      ErrorCodes,
      IPC,
      NATIVE_PI_SESSION_PREFIX,
    },
    "../prompt-attachments": {
      durableUserMessageId: (_requested, _existing) => "user-msg-1",
    },
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected handoff service dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

const {
  buildHandoffContent,
  executePlanDebateHandoff,
  registerPlanDebateHandoffIpc,
} = loadHandoffService();

const validRequest = {
  sourceSessionId: "session-1",
  targetMode: "team",
  round: 1,
  selection: { kind: "merged", round: 1, text: "## Plan\n\n1. Persist the round." },
  userAddendum: "Also do Y",
  traceId: "trace-abc",
};

function defaultHostResponse(method, input, options) {
  if (method === "session.team.handoffCheck") {
    const members = options.teamMembers ?? [{ agent: "explorer", enabled: true }];
    const isEligible = input.targetMode !== "team" || members.some((m) => m.enabled !== false);
    return {
      ok: isEligible,
      enabled: options.handoffCheckEnabled ?? options.teamEnabled ?? true,
      revision: options.teamRevision ?? 5,
      targetMode: input.targetMode,
      members,
    };
  }
  if (method === "session.team.handoffPrepare") {
    if (options.prepareError) {
      throw Object.assign(new Error(options.prepareError.message), {
        errorCode: options.prepareError.code,
        data: { retriable: options.prepareError.retriable },
      });
    }
    return {
      ok: true,
      enabled: options.teamEnabled ?? true,
      revision: options.teamRevision ?? 5,
      targetMode: input.targetMode,
      members: options.teamMembers ?? [],
    };
  }
  if (method === "session.team.set") {
    return { ok: true };
  }
  if (method === "settings.get") return {};
  if (method === "session.get") {
    if (options.sessionMissing) return { session: null };
    return { session: { id: input.id ?? "session-1", messages: [] } };
  }
  if (method === "session.beginTurn") return { turnId: options.turnId ?? "turn-1" };
  if (method === "session.appendMessage") return { ok: true };
  throw new Error(`unexpected host call: ${method}`);
}

function harness(options = {}) {
  const handlers = new Map();
  const hostCalls = [];
  const sidecarCalls = [];
  const events = [];
  const logs = [];
  const turnStarts = [];
  const finishTurnCalls = [];

  const host = {
    call: async (method, input) => {
      hostCalls.push({ method, input });
      return defaultHostResponse(method, input, options);
    },
  };
  const sidecar = {
    setProjectInstructionRoot: (sessionId, root) => {
      sidecarCalls.push({ type: "setProjectInstructionRoot", sessionId, root });
    },
    call: async (method, params) => {
      sidecarCalls.push({ method, params });
      if (options.sidecarError) {
        throw Object.assign(new Error(options.sidecarError.message), {
          errorCode: options.sidecarError.code,
          data: { retriable: options.sidecarError.retriable },
        });
      }
      return { accepted: true, turnId: params.turnId ?? "turn-1" };
    },
  };

  const activeTurns = new Map();
  const activeTurnUsages = new Map();

  const deps = {
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => (options.hostUnavailable ? null : host),
    getSidecar: () => (options.sidecarUnavailable ? null : sidecar),
    resolveAgentRuntimeLaunch: async () => ({
      providerId: "provider-1",
      modelId: "model-1",
      projectPath: "/work/project",
      sidecarParams: {
        sessionId: "session-1",
        mode: "agent",
        provider: {
          id: "provider-1",
          modelId: "model-1",
          apiKey: "",
          authKind: "none",
        },
        commandShell: { id: "bash", available: true },
      },
    }),
    acquireSessionOperation: async () => () => {},
    finishTurn: async (...args) => {
      finishTurnCalls.push(args);
      activeTurns.delete(args[0]);
    },
    isSessionBusy: (sessionId) => activeTurns.has(sessionId),
    activeTurns,
    recordTurnStart: (sessionId, turnId) => turnStarts.push({ sessionId, turnId }),
    activeTurnUsages,
    emitAgentEvent: (envelope) => events.push(envelope),
    logger: { app: (...args) => logs.push(args) },
  };

  registerPlanDebateHandoffIpc(deps);

  return {
    handoff: handlers.get(IPC.invoke.planDebateHandoff),
    hostCalls,
    sidecarCalls,
    events,
    logs,
    activeTurns,
    activeTurnUsages,
    turnStarts,
    finishTurnCalls,
  };
}

test("buildHandoffContent returns the selection text alone when there is no addendum", () => {
  const selection = { kind: "merged", text: "plan text" };
  assert.equal(buildHandoffContent(selection), "plan text");
});

test("buildHandoffContent appends a trimmed addendum after a blank line", () => {
  const selection = { kind: "merged", text: "plan text" };
  assert.equal(buildHandoffContent(selection, "more context"), "plan text\n\nmore context");
});

test("buildHandoffContent drops a whitespace-only addendum", () => {
  const selection = { kind: "merged", text: "plan text" };
  assert.equal(buildHandoffContent(selection, "   \n  "), "plan text");
});

test("registerPlanDebateHandoffIpc binds the expected channel", () => {
  const { handoff } = harness();
  assert.equal(typeof handoff, "function");
});

test("executePlanDebateHandoff validates the request shape", async () => {
  const { handoff } = harness();
  for (const bad of [
    null,
    {},
    { ...validRequest, sourceSessionId: "" },
    { ...validRequest, sourceSessionId: "   " },
    { ...validRequest, targetMode: "unknown" },
    { ...validRequest, targetMode: undefined },
    { ...validRequest, round: 0 },
    { ...validRequest, round: 1.5 },
    { ...validRequest, round: "one" },
    { ...validRequest, selection: { kind: "merged" } },
    { ...validRequest, selection: { kind: "draft", text: "x" } },
    { ...validRequest, traceId: "" },
    { ...validRequest, userAddendum: 123 },
    { ...validRequest, selection: { kind: "merged", round: 2, text: "x" } },
  ]) {
    const result = await handoff(bad);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
    assert.equal(result.errorCode, ErrorCodes.INVALID_ARGUMENT);
  }
});

test("rejects oversized selection text, addendum, round and role", async () => {
  const { handoff } = harness();
  const huge = "x".repeat(256 * 1024 + 1);
  const bigAddendum = "x".repeat(64 * 1024 + 1);
  const cases = [
    { ...validRequest, selection: { ...validRequest.selection, text: huge } },
    { ...validRequest, userAddendum: bigAddendum },
    { ...validRequest, round: 1_000_001, selection: { ...validRequest.selection, round: 1_000_001 } },
    {
      ...validRequest,
      targetMode: "single-agent",
      selection: { kind: "draft", round: 1, role: "x".repeat(81), text: "plan" },
    },
  ];
  for (const req of cases) {
    const result = await handoff(req);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(req).slice(0, 80)}`);
    assert.equal(result.errorCode, ErrorCodes.INVALID_ARGUMENT);
  }
});

test("native Pi sessions are rejected before the host is touched", async () => {
  const { handoff, hostCalls } = harness();
  const result = await handoff({
    ...validRequest,
    sourceSessionId: `${NATIVE_PI_SESSION_PREFIX}session-1`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "NATIVE_PI_UNSUPPORTED");
  assert.equal(hostCalls.length, 0);
});

test("handoff returns HOST_UNAVAILABLE when the backend is not ready", async () => {
  const { handoff, hostCalls } = harness({ hostUnavailable: true });
  const result = await handoff(validRequest);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, ErrorCodes.HOST_UNAVAILABLE);
  assert.equal(result.retryable, true);
  assert.equal(hostCalls.length, 0);
});

test("handoff returns AGENT_BUSY when the session already has an active turn and makes no side effects", async () => {
  const { handoff, activeTurns, hostCalls, sidecarCalls } = harness();
  activeTurns.set("session-1", "turn-existing");
  const result = await handoff(validRequest);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, ErrorCodes.AGENT_BUSY);
  assert.equal(result.retryable, true);
  assert.equal(hostCalls.find((c) => c.method === "session.team.handoffPrepare"), undefined);
  assert.equal(hostCalls.find((c) => c.method === "session.beginTurn"), undefined);
  assert.equal(sidecarCalls.length, 0);
});

test("handoff checks eligibility before prepare and rejects team without enabling", async () => {
  const { handoff, hostCalls } = harness({
    handoffCheckEnabled: false,
    teamEnabled: false,
    teamMembers: [],
    prepareError: { code: "SHOULD_NOT_REACH", message: "boom", retriable: false },
  });
  // Make the roster empty so handoffCheck rejects before prepare.
  const result = await handoff(validRequest);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "TEAM_NOT_ELIGIBLE");
  assert.equal(result.retryable, false);
  assert.equal(hostCalls.find((c) => c.method === "session.team.handoffPrepare"), undefined);
  assert.equal(hostCalls.find((c) => c.method === "session.beginTurn"), undefined);
});

test("handoff forwards host prepare errors without creating a turn", async () => {
  const { handoff, hostCalls, sidecarCalls } = harness({
    prepareError: { code: "TEAM_NOT_ELIGIBLE", message: "team mode not allowed", retriable: false },
  });
  const result = await handoff(validRequest);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "TEAM_NOT_ELIGIBLE");
  assert.equal(result.retryable, false);
  assert.equal(hostCalls.find((c) => c.method === "session.beginTurn"), undefined);
  assert.equal(sidecarCalls.length, 0);
});

test("handoff returns NOT_FOUND when the session disappears after prepare and compensates team enable", async () => {
  const { handoff, hostCalls } = harness({
    handoffCheckEnabled: false,
    teamEnabled: true,
    teamRevision: 7,
    sessionMissing: true,
  });
  const result = await handoff(validRequest);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, ErrorCodes.NOT_FOUND);

  const setCall = hostCalls.find((c) => c.method === "session.team.set");
  assert.ok(setCall, "team enable compensation should be attempted");
  assert.equal(setCall.input.sessionId, "session-1");
  assert.equal(setCall.input.expectedRevision, 7);
  assert.equal(setCall.input.enabled, false);
});

test("handoff does not compensate when team was already enabled", async () => {
  const { handoff, hostCalls } = harness({
    handoffCheckEnabled: true,
    teamEnabled: true,
    sessionMissing: true,
  });
  const result = await handoff(validRequest);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, ErrorCodes.NOT_FOUND);
  assert.equal(hostCalls.find((c) => c.method === "session.team.set"), undefined);
});

test("team handoff enables team mode in the sidecar payload", async () => {
  const { handoff, hostCalls, sidecarCalls, activeTurns, turnStarts, events, logs } = harness({
    handoffCheckEnabled: false,
    teamEnabled: true,
    teamRevision: 7,
  });
  const result = await handoff(validRequest);
  assert.equal(result.ok, true);
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.traceId, validRequest.traceId);

  const prepare = hostCalls.find((c) => c.method === "session.team.handoffPrepare");
  assert.deepEqual(prepare.input, { sessionId: "session-1", targetMode: "team" });

  const beginTurn = hostCalls.find((c) => c.method === "session.beginTurn");
  assert.deepEqual(beginTurn.input, {
    sessionId: "session-1",
    providerId: "provider-1",
    modelId: "model-1",
  });

  const append = hostCalls.find((c) => c.method === "session.appendMessage");
  assert.equal(append.input.sessionId, "session-1");
  assert.equal(append.input.turnId, "turn-1");
  assert.equal(append.input.message.role, "user");
  assert.ok(append.input.message.content.includes("1. Persist the round."));
  assert.ok(append.input.message.content.includes("Also do Y"));

  assert.equal(activeTurns.get("session-1"), "turn-1");
  assert.deepEqual(turnStarts, [{ sessionId: "session-1", turnId: "turn-1" }]);

  const sidecarCall = sidecarCalls.find((c) => c.method === "agent.planDebateHandoff");
  assert.deepEqual(sidecarCall.params.team, { enabled: true, revision: 7 });
  assert.equal(sidecarCall.params.content, append.input.message.content);
  assert.equal(sidecarCall.params.turnId, "turn-1");
  assert.equal(sidecarCall.params.userMessageId, "user-msg-1");

  assert.equal(events.length, 2);
  assert.equal(events[0].event.type, "message_start");
  assert.equal(events[1].event.type, "message_end");
  assert.equal(events[0].event.message.content, append.input.message.content);

  const acceptedLog = logs.find((l) => l[2] === "plan debate handoff accepted");
  assert.ok(acceptedLog);
  assert.equal(acceptedLog[3].planBytes, Buffer.byteLength(validRequest.selection.text));
  assert.equal(acceptedLog[3].addendumBytes, Buffer.byteLength(validRequest.userAddendum));
  assert.equal("text" in acceptedLog[3], false);
});

test("single-agent handoff omits team state from the sidecar payload", async () => {
  const { handoff, sidecarCalls } = harness({ teamEnabled: false, teamRevision: 2 });
  const result = await handoff({ ...validRequest, targetMode: "single-agent" });
  assert.equal(result.ok, true);
  const sidecarCall = sidecarCalls.find((c) => c.method === "agent.planDebateHandoff");
  assert.equal("team" in sidecarCall.params, false);
});

test("handoff finishes the turn and clears activeTurns on sidecar failure", async () => {
  const { handoff, finishTurnCalls, activeTurns } = harness({
    sidecarError: { code: "MODEL_NOT_CONFIGURED", message: "no model", retriable: false },
  });
  const result = await handoff(validRequest);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "MODEL_NOT_CONFIGURED");
  assert.equal(finishTurnCalls.length, 1);
  assert.deepEqual(finishTurnCalls[0], ["session-1", "error", "MODEL_NOT_CONFIGURED", { turnId: "turn-1" }]);
  assert.equal(activeTurns.has("session-1"), false);
});

test("handoff can be retried after a sidecar failure without AGENT_BUSY", async () => {
  let sidecarFailures = 1;
  const activeTurns = new Map();
  const finishTurnCalls = [];
  const host = {
    call: async (method, input) => defaultHostResponse(method, input, {}),
  };
  const sidecar = {
    call: async (method, params) => {
      if (sidecarFailures > 0 && method === "agent.planDebateHandoff") {
        sidecarFailures -= 1;
        throw Object.assign(new Error("transient"), { errorCode: "HOST_UNAVAILABLE" });
      }
      return { accepted: true, turnId: params.turnId ?? "turn-1" };
    },
  };

  const runHandoff = () =>
    executePlanDebateHandoff(
      {
        getHost: () => host,
        getSidecar: () => sidecar,
        resolveAgentRuntimeLaunch: async () => ({
          providerId: "p",
          modelId: "m",
          sidecarParams: { sessionId: "session-1", mode: "agent" },
        }),
        acquireSessionOperation: async () => () => {},
        isSessionBusy: (id) => activeTurns.has(id),
        activeTurns,
        recordTurnStart: () => {},
        finishTurn: async (...args) => {
          finishTurnCalls.push(args);
          activeTurns.delete(args[0]);
        },
        emitAgentEvent: () => {},
        logger: { app: () => {} },
      },
      validRequest,
    );

  const first = await runHandoff();
  assert.equal(first.ok, false);
  assert.equal(first.errorCode, "HOST_UNAVAILABLE");
  assert.equal(activeTurns.has("session-1"), false);

  const second = await runHandoff();
  assert.equal(second.ok, true);
  assert.equal(second.turnId, "turn-1");
});

test("session A handoff is independent of an active turn in session B", async () => {
  const { handoff, activeTurns, turnStarts } = harness();
  activeTurns.set("session-b", "turn-b");
  const result = await handoff({ ...validRequest, sourceSessionId: "session-a" });
  assert.equal(result.ok, true);
  assert.equal(activeTurns.get("session-a"), "turn-1");
  assert.equal(activeTurns.get("session-b"), "turn-b");
  assert.ok(turnStarts.some((t) => t.sessionId === "session-a"));
});

test("error mapping does not leak raw non-error values and keeps traceId/errorCode/retryable", async () => {
  const activeTurns = new Map();
  const result = await executePlanDebateHandoff(
    {
      getHost: () => ({
        call: async () => {
          throw { errorCode: "HOST_UNAVAILABLE", huge: "x".repeat(2000) };
        },
      }),
      getSidecar: () => ({ call: async () => ({}) }),
      resolveAgentRuntimeLaunch: async () => ({ providerId: "p", modelId: "m", sidecarParams: {} }),
      acquireSessionOperation: async () => () => {},
      isSessionBusy: () => false,
      activeTurns,
      recordTurnStart: () => {},
      finishTurn: async () => {},
      emitAgentEvent: () => {},
      logger: { app: () => {} },
    },
    validRequest,
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "HOST_UNAVAILABLE");
  assert.equal(result.retryable, true);
  assert.equal(result.traceId, validRequest.traceId);
  assert.equal(result.message.includes("x".repeat(2000)), false);
});
