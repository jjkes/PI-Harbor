import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  canConfigurePlanExecutionModel,
  planExecutionModelDisplayLabel,
  planExecutionTargetForApproval,
  resolvePlanExecutionModel,
  resolveSessionExecutionModel,
} = await import("../src/lib/plan-execution-model.ts");
const {
  PLAN_EXECUTION_MODEL_STORAGE_KEY,
  readPlanExecutionModel,
  rememberPlanExecutionModel,
} = await import("../src/lib/plan-approval-preferences.ts");
const { createEventsSlice } = await import("../src/stores/slices/events-slice.ts");
const { createInteractionSlice } = await import("../src/stores/slices/interaction-slice.ts");
const { api } = await import("../src/lib/api.ts");

function binding(id, defaultThinkingLevel = "low") {
  return {
    id,
    contextWindow: 128_000,
    maxTokens: 8_192,
    thinkingLevels: ["off", "low", "high"],
    defaultThinkingLevel,
  };
}

function provider(id, name, modelId, overrides = {}) {
  return {
    id,
    name,
    enabled: true,
    hasSecret: true,
    authKind: "api-key",
    defaultModelId: modelId,
    models: [binding(modelId)],
    supportsReasoning: true,
    supportedThinkingLevels: ["off", "low", "high"],
    ...overrides,
  };
}

const providerA = provider("provider-a", "Planning", "model-a");
const providerB = provider("provider-b", "Execution", "model-b", {
  models: [binding("model-b", "high")],
});
const providers = [providerA, providerB];
const session = {
  id: "session-1",
  source: "desktop",
  providerId: "provider-a",
  modelId: "model-a",
  thinkingLevel: "low",
  supportsReasoning: true,
  supportedThinkingLevels: ["off", "low", "high"],
  capabilities: { canConfigureModel: true },
};
const context = { session, providers, providerModels: {}, settings: null, recentModels: [] };

test("execution model defaults to a valid remembered target, then to Composer's session model", () => {
  assert.deepEqual(resolvePlanExecutionModel({
    ...context,
    remembered: { providerId: "provider-b", modelId: "model-b", thinkingLevel: "high" },
  }), { providerId: "provider-b", modelId: "model-b", thinkingLevel: "high" });
  assert.deepEqual(resolvePlanExecutionModel({ ...context, remembered: null }), {
    providerId: "provider-a",
    modelId: "model-a",
    thinkingLevel: "low",
  });
});

test("disabled providers and removed remembered models fall back to the session", () => {
  for (const remembered of [
    { providerId: "provider-b", modelId: "model-b", thinkingLevel: "high" },
    { providerId: "provider-b", modelId: "removed", thinkingLevel: "high" },
  ]) {
    const disabled = remembered.modelId === "model-b";
    assert.deepEqual(resolvePlanExecutionModel({
      ...context,
      providers: [providerA, disabled ? { ...providerB, enabled: false } : providerB],
      remembered,
    }), { providerId: "provider-a", modelId: "model-a", thinkingLevel: "low" });
  }
});

test("an unpinned session inherits the provider model and binding default like Composer", () => {
  assert.deepEqual(resolveSessionExecutionModel({
    ...context,
    session: { ...session, modelId: undefined, thinkingLevel: undefined },
  }), { providerId: "provider-a", modelId: "model-a", thinkingLevel: "low" });
});

test("approval sends only a changed target and always includes its effective thinking level", () => {
  const sessionModel = resolveSessionExecutionModel(context);
  assert.equal(planExecutionTargetForApproval({
    selection: sessionModel,
    sessionModel,
    providers,
    providerModels: {},
  }), undefined);
  assert.deepEqual(planExecutionTargetForApproval({
    selection: { providerId: "provider-b", modelId: "model-b", thinkingLevel: "high" },
    sessionModel,
    providers,
    providerModels: {},
  }), { providerId: "provider-b", modelId: "model-b", thinkingLevel: "high" });
  assert.deepEqual(planExecutionTargetForApproval({
    selection: { providerId: "provider-a", modelId: "model-a", thinkingLevel: "high" },
    sessionModel,
    providers,
    providerModels: {},
  }), { providerId: "provider-a", modelId: "model-a", thinkingLevel: "high" });
  assert.deepEqual(planExecutionTargetForApproval({
    selection: { providerId: "provider-b", modelId: "model-b", thinkingLevel: "high" },
    sessionModel,
    providers: [providerA, {
      ...providerB,
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
      models: [{ ...binding("model-b", "off"), thinkingLevels: ["off"] }],
    }],
    providerModels: {},
  }), { providerId: "provider-b", modelId: "model-b", thinkingLevel: "off" });
});

test("native, remote, and capability-blocked sessions cannot select an execution model", () => {
  assert.equal(canConfigurePlanExecutionModel(session, session.id), true);
  assert.equal(canConfigurePlanExecutionModel({ ...session, source: "pi-native" }, session.id), false);
  assert.equal(canConfigurePlanExecutionModel(session, "native-pi:fixture"), false);
  assert.equal(canConfigurePlanExecutionModel({
    ...session,
    capabilities: { canConfigureModel: false },
  }, session.id), false);
  assert.equal(canConfigurePlanExecutionModel(undefined, "remote:host:session"), false);
  assert.equal(canConfigurePlanExecutionModel({
    ...session,
    source: "remote",
    capabilities: { canConfigureModel: true },
  }, session.id), false);
});

test("history labels use provider display names, configured aliases, and thinking level", () => {
  const aliased = {
    ...providerB,
    models: [{ ...binding("model-b", "high"), alias: "Fast implementation" }],
  };
  assert.equal(planExecutionModelDisplayLabel({
    providerId: "provider-b",
    modelId: "model-b",
    thinkingLevel: "high",
  }, [providerA, aliased]), "Execution · Fast implementation · high");
});

test("remembered execution model is validated and storage failures stay non-fatal", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map();
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
    });
    const selected = { providerId: "provider-b", modelId: "model-b", thinkingLevel: "high" };
    rememberPlanExecutionModel(selected);
    assert.deepEqual(readPlanExecutionModel(), selected);
    values.set(PLAN_EXECUTION_MODEL_STORAGE_KEY, JSON.stringify({
      providerId: "provider-b",
      modelId: "model-b",
      thinkingLevel: "turbo",
    }));
    assert.equal(readPlanExecutionModel(), null);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem() { throw new Error("blocked"); },
        setItem() { throw new Error("full"); },
      },
    });
    assert.equal(readPlanExecutionModel(), null);
    assert.doesNotThrow(() => rememberPlanExecutionModel(selected));
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
});

function proposal(overrides = {}) {
  return {
    id: "proposal-1",
    sessionId: "session-1",
    turnId: "turn-1",
    toolCallId: "call-1",
    kind: "plan",
    title: "Plan",
    markdown: "plan",
    plan: "plan",
    question: "Continue?",
    version: 1,
    status: "approved",
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
}

function stateHarness(state) {
  return {
    get: () => state,
    set: (update) => Object.assign(state, typeof update === "function" ? update(state) : update),
  };
}

function eventSlice(state) {
  const runtime = {
    liveSessionTranscripts: new Set(),
    sessionTranscriptCache: new Map(),
    cacheSessionTranscript: (id, rows) => runtime.sessionTranscriptCache.set(id, rows),
    nextPlanSyncGeneration() {},
    cacheBackgroundTranscriptEvent() {},
  };
  return createEventsSlice({
    ...stateHarness(state),
    runtime,
    withoutRecordKey: (record, key) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== key)),
    sessionModeForPlanningState: () => "agent",
    openPlanArtifact() {},
    notifyInteractivePrompt() {},
    flushPendingSessionConfiguration: async () => {},
    assistantErrorMessage: (error) => error,
    withCompactionMark: (_marks, mark) => [mark],
  });
}

function eventState() {
  return {
    activeSessionId: null,
    sessions: [{ ...session, mode: "plan", permissionMode: "ask" }],
    planningStates: {},
    planCheckpoints: { "session-1": proposal({ status: "pending" }) },
    pendingPlans: { "session-1": proposal({ status: "pending" }) },
    runningSessions: {},
    isRunning: false,
    messages: [],
    retainedTranscripts: {},
    pluginViews: [],
    refreshSessions: async () => {},
    refreshQueuedPrompts: async () => {},
  };
}

const committedTarget = { providerId: "provider-b", modelId: "model-b", thinkingLevel: "high" };

test("host planning changes apply the committed model to the Composer session immediately", () => {
  const state = eventState();
  eventSlice(state).handlePlansChanged({
    sessionId: "session-1",
    state: "inactive",
    kind: "plan",
    action: "approve",
    targetModel: committedTarget,
    proposal: proposal({ targetModel: committedTarget, executionState: "queued" }),
  });
  assert.equal(state.sessions[0].providerId, "provider-b");
  assert.equal(state.sessions[0].modelId, "model-b");
  assert.equal(state.sessions[0].thinkingLevel, "high");
  assert.equal(state.sessions[0].mode, "agent");
  assert.equal(state.sessions[0].supportsReasoning, undefined);
});

test("completed execution events do not reapply the old target over a newer Composer choice", () => {
  const state = eventState();
  eventSlice(state).handlePlansChanged({
    sessionId: "session-1",
    state: "inactive",
    kind: "plan",
    action: "approve",
    targetModel: committedTarget,
    proposal: proposal({ targetModel: committedTarget, executionState: "completed" }),
  });
  assert.equal(state.sessions[0].providerId, "provider-a");
  assert.equal(state.sessions[0].modelId, "model-a");
  assert.equal(state.sessions[0].thinkingLevel, "low");
});

test("runtime planning_state projections never write the session model", () => {
  const state = eventState();
  eventSlice(state).handleAgentEvent({
    sessionId: "session-1",
    ts: 1,
    event: {
      type: "planning_state",
      state: "inactive",
      kind: "plan",
      action: "approve",
      targetModel: committedTarget,
      proposal: proposal({ targetModel: committedTarget }),
    },
  });
  assert.equal(state.sessions[0].providerId, "provider-a");
  assert.equal(state.sessions[0].modelId, "model-a");
  assert.equal(state.sessions[0].thinkingLevel, "low");
});

test("resolvePlan forwards the host's committed model through the existing planning path", async () => {
  const original = api.resolvePlan;
  const events = [];
  const state = {
    pendingPlans: { "session-1": proposal({ status: "pending" }) },
    handlePlansChanged: (event) => events.push(event),
  };
  const slice = createInteractionSlice({
    ...stateHarness(state),
    runtime: {},
    interactionRuntime: { planResolutionRequests: new Map() },
  });
  const request = {
    proposalId: "proposal-1",
    sessionId: "session-1",
    turnId: "turn-1",
    toolCallId: "call-1",
    version: 1,
    action: "approve",
    targetPermissionMode: "auto",
    targetModel: committedTarget,
  };
  try {
    api.resolvePlan = async () => ({
      ok: true,
      state: "inactive",
      action: "approve",
      targetModel: committedTarget,
      proposal: proposal({ targetModel: committedTarget }),
    });
    await slice.resolvePlan(request);
  } finally {
    api.resolvePlan = original;
  }
  assert.deepEqual(events[0].targetModel, committedTarget);
});

test("approval picker and history use the shared Composer model surface", async () => {
  const [bar, picker, history] = await Promise.all([
    readFile(new URL("../src/components/PlanApprovalBar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/PlanExecutionModelPicker.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/chat/transcript/PlanHistoryCard.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(bar, /executionModelConfigurable && executionModel/);
  assert.match(bar, /\.\.\.\(targetModel \? \{ targetModel \} : \{\}\)/);
  assert.match(picker, /activeSessionId: null/);
  assert.match(picker, /useComposerModelMenu/);
  assert.match(picker, /ComposerModelPicker/);
  assert.match(history, /proposal\.targetModel/);
  assert.match(history, /planExecutionModelDisplayLabel/);
  assert.match(history, /t\("planExecution\.historyLabel", \{/);
  assert.match(history, /model: planExecutionModelDisplayLabel/);
  assert.doesNotMatch(history, /historyLabel"\)\}: /);
});
