#!/usr/bin/env node
// Team mode user path: renderer service -> Main IPC -> real Host and sidecar.
// Only model transport, provider credentials and unrelated Host surfaces are
// fixtures. No account, paid provider, running Desktop or user profile is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as Value from "typebox/value";
import { createServer as createViteServer } from "vite";
import {
  ErrorCodes,
  IPC,
  PROTOCOL_VERSION,
  SessionTeamUpdateSchema,
} from "../packages/shared/dist/index.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { createAgentHostBridge } = await import("../apps/desktop/electron/main/agent-host-bridge.ts");
const { registerAgentIpc } = await import("../apps/desktop/electron/main/ipc/agent-ipc.ts");
const { PersistenceOutbox } = await import("../apps/desktop/electron/main/persistence-outbox.ts");
const { createEventPersistence } = await import("../apps/desktop/electron/main/runtime/event-persistence.ts");
const { createSessionCoordination } = await import("../apps/desktop/electron/main/runtime/session-coordination.ts");
const { composeTeamLaunch, readSessionTeamConfig } = await import("../apps/desktop/electron/main/runtime/team-launch.ts");

// Load the production session IPC module while replacing only unrelated import
// surfaces. The Team handlers and their shared validation remain production code.
function loadSessionIpc(shared) {
  const file = new URL("../apps/desktop/electron/main/ipc/session-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const imports = {
    electron: { shell: {} },
    "node:fs": { mkdirSync },
    "node:path": { isAbsolute: () => false, join, relative: () => "", resolve: () => "" },
    "typebox/value": Value,
    "@pi-harbor/shared": { ...shared, ErrorCodes, IPC, SessionTeamUpdateSchema },
    "../importers": {},
    "../services/session-collaboration": {},
    "../bootstrap/remote-hosts.js": { getActiveRemoteHostsBoot: () => null },
    "../services/session-search": {},
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected session IPC dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

if (process.platform === "win32") {
  throw new Error("Team mode E2E requires Linux/macOS HOME isolation; no Host writes were attempted.");
}
const root = mkdtempSync(join(tmpdir(), "pi-team-mode-e2e-"));
const dataDir = join(root, "data");
const homeDir = join(root, "home");
const projectPath = join(root, "project");
for (const path of [dataDir, homeDir, projectPath]) mkdirSync(path);
const env = {
  ...process.env,
  HOME: homeDir,
  USERPROFILE: homeDir,
  PI_HARBOR_DATA_DIR: dataDir,
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  ALL_PROXY: "",
  NO_PROXY: "127.0.0.1,localhost",
};
const host = new Host(resolveHostBinary(), dataDir, { env });
const hostFacade = {
  call: (method, params) => host.call(method, params),
  isAvailable: () => !host.exited,
};
const handlers = new Map();
const pending = new Map();
const events = [];
const requests = [];
const liveMessages = new Map();
const launches = [];
const activeTurns = new Map();
const activeTurnUsages = new Map();
const observers = new Set();
const heldL2 = new Set();
let child;
let lines;
let vite;
let bridge;
let sessionId;
let scenario = "success";
let eventWork = Promise.resolve();
let eventError;
let stderr = "";
let requestSequence = 0;
const requestCounts = new Map();

const changed = () => { for (const check of [...observers]) check(); };
function until(predicate, label, timeoutMs = 20_000) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      observers.delete(check);
      error ? reject(error) : resolve();
    };
    const check = () => {
      if (eventError) finish(eventError);
      else {
        try {
          if (predicate()) finish();
        } catch (error) {
          finish(error);
        }
      }
    };
    const timer = setTimeout(() => finish(new Error(
      `${label}\n${stderr}\nLast request: ${JSON.stringify(requests.at(-1)).slice(-6000)}`,
    )), timeoutMs);
    observers.add(check);
    check();
  });
}
function send(message) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}
function rpc(method, params) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout: ${method}\n${stderr}`));
    }, 20_000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}
const invoke = (channel, args) => {
  const handler = handlers.get(channel);
  assert.equal(typeof handler, "function", `Missing production Main handler: ${channel}`);
  return handler(...args);
};

function reply(res, model, delta, reason = "stop") {
  const base = {
    id: `team-fixture-${++requestSequence}`,
    object: "chat.completion.chunk",
    created: 1,
    model,
  };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  })}\n\n`);
  res.end("data: [DONE]\n\n");
}
function toolCall(id, name, args) {
  return {
    index: 0,
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}
async function respondModel(req, res) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const payload = JSON.parse(raw);
  requests.push({ scenario, payload });
  const count = requestCounts.get(payload.model) ?? 0;
  requestCounts.set(payload.model, count + 1);

  if (payload.model === "parent") {
    if (count === 0) {
      reply(res, payload.model, {
        tool_calls: [toolCall(`root-${scenario}`, "Task", {
          agent: "explorer",
          task: scenario === "success" ? "Build the two-level result." : "Hold the nested tree open.",
          description: "L1 coordinator",
        })],
      }, "tool_calls");
    } else {
      reply(res, payload.model, {
        content: scenario === "success" && count >= 2
          ? "Team completed."
          : scenario === "cascade" && count >= 2
            ? "Nested stop confirmed."
            : "Root is waiting for its delegate.",
      });
    }
  } else if (payload.model === "l1-default") {
    if (count === 0) {
      reply(res, payload.model, {
        tool_calls: [toolCall(`nested-${scenario}`, "Task", {
          agent: "worker",
          task: "Produce the L2 report.",
          description: "L2 worker",
        })],
      }, "tool_calls");
    } else if (count === 1) {
      reply(res, payload.model, { content: "L1 is idle while L2 runs." });
    } else {
      reply(res, payload.model, { content: "L1 integrated the L2 outcome." });
    }
  } else if (payload.model === "worker-card") {
    if (scenario === "cascade") {
      heldL2.add(res);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": held L2 stream\n\n");
      res.on("close", () => {
        heldL2.delete(res);
        changed();
      });
    } else if (count === 0) {
      reply(res, payload.model, {
        tool_calls: [toolCall("illegal-l3", "Task", {
          agent: "worker",
          task: "Attempt to exceed the Team depth ceiling.",
        })],
      }, "tool_calls");
    } else {
      reply(res, payload.model, { content: "L2 report after rejected L3." });
    }
  } else {
    throw new Error(`Unexpected model request: ${payload.model}`);
  }
  changed();
}
const model = createServer((req, res) => {
  void respondModel(req, res).catch((error) => {
    eventError = error;
    if (!res.headersSent) res.writeHead(500);
    res.end(String(error));
    changed();
  });
});

const coordination = createSessionCoordination({
  activeTurns,
  getMainWindow: () => null,
  getViewingSessionId: () => null,
});
async function finishTurn(id, reason, _errorCode, options = {}) {
  const turnId = options.turnId ?? activeTurns.get(id);
  if (!turnId || activeTurns.get(id) !== turnId) return;
  await host.call("session.endTurn", {
    turnId,
    status: reason,
    createNotification: false,
  });
  activeTurns.delete(id);
  bridge?.agentHost.endTurn(
    id,
    turnId,
    reason === "aborted" ? "interrupted" : reason === "error" ? "failed" : "completed",
  );
  changed();
}
async function ingest(envelope) {
  events.push(envelope);
  const persisted = eventPersistence.persistAgentEvent(envelope);
  const message = envelope.event.type === "message_end"
    ? envelope.event.message
    : persisted;
  if (message) liveMessages.set(message.id, message);
  if (envelope.parentToolCallId || envelope.event.type !== "agent_end") {
    bridge?.ingest(envelope);
  }
  changed();
}

const provider = (modelId, baseUrl) => ({
  id: "fixture",
  name: "Fixture",
  modelId,
  baseUrl,
  apiKey: "",
  authKind: "none",
  apiStyle: "openai-chat",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
});
const commandShell = {
  id: "bash",
  label: "Bash",
  dialect: "posix",
  available: true,
  isDefault: true,
};
const definitions = [
  {
    name: "explorer",
    description: "L1 coordinator",
    tools: ["Read"],
    prompt: "Coordinate one nested worker.",
    source: "builtin",
    model: { providerId: "fixture", modelId: "l1-default" },
    fallbackModels: [{ providerId: "fixture", modelId: "l1-fallback" }],
  },
  {
    name: "worker",
    description: "L2 worker",
    tools: ["Read"],
    prompt: "Produce a bounded report.",
    source: "builtin",
    model: { providerId: "fixture", modelId: "worker-definition" },
    fallbackModels: [{ providerId: "fixture", modelId: "worker-fallback" }],
  },
  {
    name: "fixer",
    description: "Member removed by the user",
    tools: ["Read"],
    prompt: "Not schedulable.",
    source: "builtin",
  },
];

let eventPersistence;
const previousWindow = globalThis.window;
try {
  await host.start(PROTOCOL_VERSION);
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${model.address().port}/v1`;
  child = spawn(process.execPath, [
    fileURLToPath(new URL("../packages/agent-runtime/dist/sidecar.js", import.meta.url)),
  ], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-12_000);
  });
  lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "host.proxy") {
      void host.call(message.params.method, message.params.params).then(
        (result) => send({ id: message.id, result }),
        (error) => send({
          id: message.id,
          error: {
            code: -32000,
            message: error.message,
            data: { errorCode: error.errorCode },
          },
        }),
      );
    } else if (message.id != null) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      message.error
        ? entry.reject(new Error(JSON.stringify(message.error)))
        : entry.resolve(message.result);
    } else if (message.method === "agent.event") {
      eventWork = eventWork.then(() => ingest(message.params)).catch((error) => {
        eventError = error;
        changed();
      });
    }
  });
  const sidecar = {
    call: rpc,
    setProjectInstructionRoot() {},
    clearProjectInstructionRoot() {},
    clearVendorAuthBindings() {},
  };
  const persistenceOutbox = new PersistenceOutbox(dataDir, () => undefined);
  eventPersistence = createEventPersistence({
    runtimeState: { host: hostFacade },
    steeringReplies: new Set(),
    completionNoticeTurns: new Set(),
    activeTurns,
    activeToolCalls: new Map(),
    activeToolCallKey: (id, callId) => `${id}:${callId}`,
    approvedExecutionIdsBySession: new Map(),
    approvedExecutionTurns: new Map(),
    pendingExecutionFinishes: new Map(),
    planSubmissionTurnIds: new Set(),
    planSubmissionTurnKey: (id, turnId) => `${id}:${turnId}`,
    inflightCheckpointer: {
      observe() {},
      async flush() {},
      settleIf() {},
    },
    persistenceOutbox,
    addActiveTurnUsage() {},
    logger: { app() {} },
    finishTurn,
    isStaleTerminalEvent: () => false,
    transcriptRewrite: coordination,
    async finishApprovedExecution() {},
    emitAgentEvent() {},
  });

  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => hostFacade,
    getSidecar: () => sidecar,
    getAgentHostBridge: () => bridge,
    logger: { app() {} },
    dataDir,
    activeTurns,
    completionNoticeTurns: new Set(),
    recordTurnStart: coordination.recordTurnStart,
    activeTurnUsages,
    vendorOAuth: { async resolveAuth() { throw new Error("OAuth is not used by this fixture"); } },
    agentExtensions: { cancelPrompts() {} },
    cancelSessionTools() {},
    persistenceOutbox,
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    acquireSessionOperation: coordination.acquireSessionOperation,
    isTurnDispatchable: coordination.isTurnDispatchable,
    lockAbortReason: coordination.lockAbortReason,
    finishTurn,
    async resolveAgentRuntimeLaunch(id) {
      const team = await readSessionTeamConfig(hostFacade, id, false);
      const composed = await composeTeamLaunch(team, definitions, async (roster) => {
        const providers = {};
        for (const definition of roster) {
          for (const pin of [definition.model, ...(definition.fallbackModels ?? [])]) {
            if (pin) providers[`${pin.providerId}/${pin.modelId}`] = provider(pin.modelId, baseUrl);
          }
        }
        return { providers, diagnostics: [] };
      });
      assert.ok(composed, "Team launch must be enabled for this user path");
      launches.push(composed);
      return {
        providerId: "fixture",
        modelId: "parent",
        projectPath,
        sidecarParams: {
          sessionId: id,
          mode: "agent",
          provider: provider("parent", baseUrl),
          projectPath,
          thinkingLevel: "off",
          commandShell,
          subagents: composed.definitions,
          subagentProviders: composed.providers,
          team: composed.team,
        },
      };
    },
    emitAgentEvent: (envelope) => bridge?.ingest(envelope),
    setNotificationViewingSessionId() {},
    async optionalWorkspaceRoot() { return projectPath; },
    composerCommandService: { async buildComposerCommands() { return []; } },
    async loadComposerTemplatesCached() { return []; },
    async finishApprovedExecution() {},
    async dispatchApprovedPlan() {},
    async dispatchExecutionForProposal() {},
  });

  const shared = await import("../packages/shared/dist/index.js");
  const { registerSessionIpc } = loadSessionIpc(shared);
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => hostFacade,
    getSidecar: () => sidecar,
    dataDir,
    activeTurns,
    sessionProjects: new Map(),
    persistenceOutbox,
    logger: { app() {} },
    plugins: { broadcastEvent() {} },
    async sessionCapabilityContext() { return { providers: [], defaults: {} }; },
    enrichSession: (session) => session,
    acquireSessionOperation: coordination.acquireSessionOperation,
    beginTranscriptRewrite: coordination.beginTranscriptRewrite,
    forgetTranscriptRewriteHistory() {},
    stripWinLongPrefix: (path) => path,
  });

  bridge = createAgentHostBridge({
    channels: IPC.invoke,
    getHost: () => hostFacade,
    invoke,
    isSessionBusy: coordination.isSessionBusy,
    log() {},
  });
  await bridge.agentHost.start();
  sessionId = (await host.call("session.create", {
    title: "Team mode fixture",
    mode: "agent",
    projectPath,
  })).session.id;

  globalThis.window = {
    piDesktop: {
      invoke: async (channel, ...args) => ({ ok: true, data: await invoke(channel, args) }),
    },
  };
  vite = await createViteServer({
    root: fileURLToPath(new URL("../apps/desktop", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { createTeamService } = await vite.ssrLoadModule("/src/features/team/team-service.ts");
  const { createTeamStore } = await vite.ssrLoadModule("/src/features/team/team-store.ts");
  const { buildTeamGraph } = await vite.ssrLoadModule("/src/features/team/team-graph-model.ts");
  const target = { id: sessionId, source: "desktop" };
  const page = {
    owned: [],
    builtins: definitions.map((definition) => ({ ...definition, enabled: true })),
  };
  const store = createTeamStore();
  const service = createTeamService({ store, loadSubagentPage: async () => page });

  await service.load(target);
  const enabled = await service.toggle(target);
  assert.deepEqual(enabled.members.map((member) => member.agent), ["explorer", "worker", "fixer"]);
  assert.ok(enabled.members.every((member) => member.model === undefined));
  await service.removeMember(target, "fixer");
  const configured = await service.setMemberModel(target, "worker", {
    providerId: "fixture",
    modelId: "worker-card",
  });
  assert.equal(configured.revision, 3);
  assert.deepEqual(configured.members, [
    { agent: "explorer" },
    { agent: "worker", model: { providerId: "fixture", modelId: "worker-card" } },
  ]);
  console.log("PASS Team roster: first enable seeds, removal persists, and one card locks its model");

  await invoke(IPC.invoke.agentPrompt, [{ sessionId, content: "Start the team." }]);
  await until(
    () => [...liveMessages.values()].some((message) => message.content === "Team completed."),
    "The two-level Team turn did not complete",
  );
  await eventWork;
  await eventPersistence.flush();
  await persistenceOutbox.flush(() => hostFacade);

  const successLaunch = launches.at(-1);
  assert.deepEqual(successLaunch.definitions.map((definition) => definition.name), ["explorer", "worker"]);
  assert.deepEqual(successLaunch.definitions[1].model, { providerId: "fixture", modelId: "worker-card" });
  assert.deepEqual(successLaunch.definitions[1].fallbackModels, []);
  assert.equal(successLaunch.team.revision, 3);
  assert.ok(!Object.hasOwn(successLaunch, "subagentModelKeys"));
  const parentTask = requests.find(({ payload }) => payload.model === "parent")
    ?.payload.tools.find((tool) => tool.function?.name === "Task");
  assert.ok(parentTask, "The root Task declaration was not sent");
  assert.ok(!JSON.stringify(parentTask).includes('"model"'), "Team Task must not expose model override");
  const l1Request = requests.find(({ payload }) => payload.model === "l1-default");
  const l2Requests = requests.filter(({ payload }) => payload.model === "worker-card");
  const toolNames = (request) => request.payload.tools.map((tool) => tool.function.name);
  assert.ok(toolNames(l1Request).includes("Task"));
  assert.ok(l2Requests.length >= 2, "L2 must receive the unknown-Task result and continue");
  assert.ok(l2Requests.every((request) => !toolNames(request).includes("Task")));
  assert.ok(events.some((envelope) =>
    envelope.event.type === "tool_end" &&
    envelope.event.toolCallId === "illegal-l3" &&
    envelope.event.isError
  ));
  const successGraph = buildTeamGraph([...liveMessages.values()]);
  const successNodes = successGraph.nodes.filter((node) => node.rootId === successGraph.turns[0]?.rootIds[0]);
  assert.equal(successGraph.nodes.filter((node) => node.depth === 2).length, 1);
  assert.equal(successGraph.nodes.filter((node) => (node.depth ?? 0) > 2).length, 0);
  assert.ok(successGraph.nodes.every((node) => node.status === "completed"));
  assert.ok(successNodes.length >= 1);
  console.log("PASS Team execution: card pins reach real models; L0 → L1 → L2 completes and L3 is rejected");

  scenario = "cascade";
  requestCounts.clear();
  liveMessages.clear();
  await invoke(IPC.invoke.agentPrompt, [{ sessionId, content: "Start the stop scenario." }]);
  await until(() => heldL2.size === 1, "L2 did not reach its held stream");
  let runningRoot;
  let runningChild;
  let runningGraph;
  await until(() => {
    runningGraph = buildTeamGraph([...liveMessages.values()]);
    runningRoot = runningGraph.nodes.find((node) => node.depth === 1 && node.status === "running");
    runningChild = runningGraph.nodes.find((node) => node.depth === 2 && node.status === "running");
    return Boolean(runningRoot?.delegationId && runningChild?.delegationId);
  }, "The live L1/L2 graph did not become visible");
  assert.ok(runningRoot?.delegationId);
  assert.ok(runningChild?.delegationId);
  assert.equal(runningChild.ownerId, runningRoot.id);
  const stopped = await invoke(IPC.invoke.agentStopSubagents, [{
    sessionId,
    delegationIds: [runningRoot.delegationId],
  }]);
  assert.deepEqual(stopped.pending, [], "The stopped subtree remained pending");
  await until(
    () => [...liveMessages.values()].some((message) => message.content === "Nested stop confirmed."),
    "The parent did not settle after the subtree stop",
  );
  await eventWork;
  await eventPersistence.flush();
  await persistenceOutbox.flush(() => hostFacade);
  const stoppedGraph = buildTeamGraph([...liveMessages.values()]);
  const stoppedNodes = stoppedGraph.nodes.filter((node) => node.depth === 1 || node.depth === 2);
  assert.equal(stoppedNodes.length, 2);
  assert.ok(stoppedNodes.every((node) => node.status === "stopped"));
  assert.equal(heldL2.size, 0, "The L2 provider stream survived its owner's stop");
  console.log("PASS Team graph and stop: live Main → L1 → L2 lineage is visible and user Stop cancels the subtree");

  await host.restart(PROTOCOL_VERSION);
  const restoredStore = createTeamStore();
  const restoredService = createTeamService({
    store: restoredStore,
    loadSubagentPage: async () => page,
  });
  const restoredConfig = await restoredService.load(target);
  assert.deepEqual(restoredConfig, configured);
  const restoredHistory = await host.call("session.get", { id: sessionId });
  const restoredGraph = buildTeamGraph(restoredHistory.session.messages);
  assert.equal(restoredGraph.nodes.filter((node) => node.depth === 2).length, 2);
  assert.equal(restoredGraph.nodes.filter((node) => node.status === "completed").length, 2);
  assert.equal(restoredGraph.nodes.filter((node) => node.status === "stopped").length, 2);
  assert.equal(restoredGraph.nodes.filter((node) => (node.depth ?? 0) > 2).length, 0);
  assert.ok(restoredHistory.session.messages.some((message) =>
    message.role === "user" &&
    message.parentToolCallId &&
    String(message.content).includes("L2 report after rejected L3")
  ), "The persisted L1 barrier prompt did not survive restart");
  console.log("PASS Team restart: roster, nested graph, stopped states and L1 report history rebuild from Host");
} finally {
  globalThis.window = previousWindow;
  await vite?.close();
  for (const entry of pending.values()) clearTimeout(entry.timer);
  lines?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  for (const res of heldL2) if (!res.writableEnded) res.destroy();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await host.stop();
  rmSync(root, { recursive: true, force: true });
}
