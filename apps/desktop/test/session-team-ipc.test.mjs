import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import * as Value from "typebox/value";
import ts from "typescript";
import {
  ErrorCodes,
  IPC,
  SessionTeamUpdateSchema,
} from "@pi-harbor/shared";

function loadSessionIpc() {
  const file = new URL("../electron/main/ipc/session-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const imports = {
    electron: { shell: {} },
    "node:fs": fs,
    "node:path": path,
    "typebox/value": Value,
    "@pi-harbor/shared": { ErrorCodes, IPC, SessionTeamUpdateSchema },
    "../importers": {},
    "../services/session-collaboration": {},
    "../services/session-context": {},
    "../bootstrap/remote-hosts.js": { getActiveRemoteHostsBoot: () => null },
    "../services/session-search": {},
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected IPC dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

const { registerSessionIpc } = loadSessionIpc();
const stored = {
  sessionId: "session-1",
  enabled: true,
  members: [{ agent: "explorer", model: { providerId: "local", modelId: "fast" } }],
  revision: 7,
};

function harness(respond = async (method) => {
  if (method === "session.team.set") return { ...stored, revision: stored.revision + 1 };
  return stored;
}, options = {}) {
  const handlers = new Map();
  const calls = [];
  let host = {
    call: async (method, input) => {
      calls.push({ method, input });
      return respond(method, input);
    },
  };
  const unexpected = () => assert.fail("team IPC must not touch unrelated session state");
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => options.sidecar ?? null,
    activeTurns: new Map(),
    sessionProjects: new Map(),
    persistenceOutbox: {},
    logger: options.logger ?? { app: unexpected },
    plugins: { broadcastEvent: unexpected },
    sessionCapabilityContext: unexpected,
    enrichSession: unexpected,
    acquireSessionOperation: unexpected,
    ...(options.resolveDelegationLaunch
      ? { resolveDelegationLaunch: options.resolveDelegationLaunch }
      : {}),
  });
  return {
    get: handlers.get(IPC.invoke.sessionTeamGet),
    update: handlers.get(IPC.invoke.sessionTeamUpdate),
    calls,
    clearHost: () => { host = null; },
  };
}

test("session team get validates and forwards only the normalized session id", async () => {
  const { get, calls } = harness();
  assert.equal(typeof get, "function");
  assert.deepEqual(await get({ sessionId: " session-1 ", ignored: true }), stored);
  assert.deepEqual(calls, [{
    method: "session.team.get",
    input: { sessionId: "session-1" },
  }]);
});

test("session team get rejects invalid session ids before calling the host", async () => {
  const { get, calls } = harness();
  for (const input of [
    undefined, null, {}, "session-1", { sessionId: null }, { sessionId: 42 },
    { sessionId: "" }, { sessionId: " \n\t " }, { sessionId: "s".repeat(257) },
  ]) {
    await assert.rejects(get(input), { errorCode: ErrorCodes.INVALID_ARGUMENT });
  }
  assert.deepEqual(calls, []);
});

test("session team IPC rejects Native Pi sessions before host access", async () => {
  const { get, update, calls } = harness();
  await assert.rejects(get({ sessionId: "native-pi:session-1" }), {
    errorCode: ErrorCodes.INVALID_ARGUMENT,
  });
  await assert.rejects(update({
    sessionId: "native-pi:session-1",
    expectedRevision: 0,
    enabled: true,
  }), { errorCode: ErrorCodes.INVALID_ARGUMENT });
  assert.deepEqual(calls, []);
});

test("session team update forwards the validated optimistic-concurrency payload", async () => {
  const { update, calls } = harness();
  const result = await update({
    sessionId: " session-1 ",
    expectedRevision: 7,
    enabled: true,
    members: [{ agent: "explorer", model: { providerId: "local", modelId: "fast" } }],
  });
  assert.deepEqual(result, { ...stored, revision: 8 });
  assert.deepEqual(calls, [{
    method: "session.team.set",
    input: {
      sessionId: "session-1",
      expectedRevision: 7,
      enabled: true,
      members: [{ agent: "explorer", model: { providerId: "local", modelId: "fast" } }],
    },
  }]);
});

test("session team update forwards member session settings unchanged", async () => {
  const { update, calls } = harness();
  const members = [
    { agent: "explorer", enabled: false },
    {
      agent: "code-reviewer",
      model: { providerId: "local", modelId: "fast" },
      tools: ["inherit", "Read", "Edit"],
      thinkingLevel: "high",
    },
  ];
  await update({ sessionId: "session-1", expectedRevision: 7, members });
  assert.deepEqual(calls, [{
    method: "session.team.set",
    input: { sessionId: "session-1", expectedRevision: 7, members },
  }]);
});

test("a partial team update does not invent enabled or members fields", async () => {
  const { update, calls } = harness();
  await update({ sessionId: "session-1", expectedRevision: 7 });
  assert.deepEqual(calls[0].input, { sessionId: "session-1", expectedRevision: 7 });
});

test("session team update forwards each quality gate and invents neither", async () => {
  const { update, calls } = harness();
  await update({ sessionId: "session-1", expectedRevision: 7, reviewGate: true });
  await update({ sessionId: "session-1", expectedRevision: 8, qaGate: false });
  await update({
    sessionId: "session-1",
    expectedRevision: 9,
    reviewGate: false,
    qaGate: true,
  });
  assert.deepEqual(calls.map((call) => call.input), [
    { sessionId: "session-1", expectedRevision: 7, reviewGate: true },
    { sessionId: "session-1", expectedRevision: 8, qaGate: false },
    { sessionId: "session-1", expectedRevision: 9, reviewGate: false, qaGate: true },
  ]);
  // A gate-less update must not carry a gate key: an absent gate keeps the stored one.
  await update({ sessionId: "session-1", expectedRevision: 10, enabled: true });
  assert.deepEqual(calls[3].input, {
    sessionId: "session-1",
    expectedRevision: 10,
    enabled: true,
  });
  assert.equal("reviewGate" in calls[3].input, false);
  assert.equal("qaGate" in calls[3].input, false);
});

test("session team update applies the shared schema before calling the host", async () => {
  const { update, calls } = harness();
  const valid = {
    sessionId: "session-1",
    expectedRevision: 7,
    enabled: true,
    members: [{ agent: "explorer" }],
  };
  for (const input of [
    undefined,
    null,
    {},
    { ...valid, expectedRevision: -1 },
    { ...valid, expectedRevision: 1.5 },
    { ...valid, sessionId: "" },
    { ...valid, enabled: "yes" },
    { ...valid, members: [{ agent: "explorer" }, { agent: " Explorer " }] },
    { ...valid, members: [{ agent: "explorer", model: { providerId: "local" } }] },
    { ...valid, members: [{ agent: "explorer", tools: [] }] },
    { ...valid, members: [{ agent: "explorer", tools: ["Read", "Read"] }] },
    { ...valid, members: [{ agent: "explorer", tools: ["SessionTask"] }] },
    { ...valid, members: [{ agent: "explorer", thinkingLevel: "extreme" }] },
    { ...valid, members: [{ agent: "explorer", enabled: "no" }] },
    { ...valid, members: [{ agent: "explorer", prompt: "Rewrite the role" }] },
    { ...valid, unexpected: true },
    { ...valid, reviewGate: "yes" },
    { ...valid, qaGate: 1 },
    { ...valid, reviewGate: null },
    { expectedRevision: 7, reviewGate: true },
  ]) {
    await assert.rejects(update(input), { errorCode: ErrorCodes.INVALID_ARGUMENT });
  }
  assert.deepEqual(calls, []);
});

test("team IPC does not reuse a host that disappeared", async () => {
  const { get, clearHost, calls } = harness();
  await get({ sessionId: "session-1" });
  clearHost();
  await assert.rejects(get({ sessionId: "session-1" }), /host unavailable/);
  assert.equal(calls.length, 1);
});

/**
 * A runtime snapshots its roster at launch, so the only way a stored update
 * reaches a turn that is already running is Main pushing the recomposed state.
 */
function liveSidecar(running, sidecarCalls) {
  return {
    call: async (method, params) => {
      sidecarCalls.push({ method, params });
      if (method === "agent.getStatus") return { status: { isRunning: running } };
      return { applied: true };
    },
  };
}

test("a running turn receives the recomposed roster after the stored update", async () => {
  const sidecarCalls = [];
  const resolved = [];
  const launch = {
    definitions: [{ name: "explorer", model: { providerId: "local", modelId: "fast" } }],
    providers: { "local/fast": { id: "local", modelId: "fast" } },
    subagentModelKeys: [],
    team: { enabled: true, revision: 8 },
  };
  const { update, calls } = harness(
    async (method) => {
      if (method === "session.team.set") return { ...stored, revision: 8 };
      if (method === "session.get") return { session: { id: "session-1", projectPath: "/work" } };
      assert.fail(`unexpected host call: ${method}`);
    },
    {
      sidecar: liveSidecar(true, sidecarCalls),
      resolveDelegationLaunch: async (sessionId, session) => {
        resolved.push({ sessionId, session });
        return launch;
      },
    },
  );

  const result = await update({
    sessionId: "session-1",
    expectedRevision: 7,
    members: [{ agent: "explorer", model: { providerId: "local", modelId: "fast" } }],
  });

  assert.deepEqual(result, { ...stored, revision: 8 });
  // The stored write comes first: the pushed state must describe what the host
  // already committed, never a payload the renderer only proposed.
  assert.deepEqual(calls.map((call) => call.method), ["session.team.set", "session.get"]);
  assert.deepEqual(sidecarCalls.map((call) => call.method), [
    "agent.getStatus",
    "agent.updateDelegationLaunch",
  ]);
  assert.deepEqual(resolved, [
    { sessionId: "session-1", session: { id: "session-1", projectPath: "/work" } },
  ]);
  assert.deepEqual(sidecarCalls[1].params, {
    sessionId: "session-1",
    subagents: launch.definitions,
    subagentProviders: launch.providers,
    subagentModelKeys: [],
    team: launch.team,
  });
});

test("an idle session needs no push: its next prompt already carries the roster", async () => {
  const sidecarCalls = [];
  let composed = 0;
  const { update, calls } = harness(
    async (method) => {
      if (method === "session.team.set") return { ...stored, revision: 8 };
      assert.fail(`unexpected host call: ${method}`);
    },
    {
      sidecar: liveSidecar(false, sidecarCalls),
      resolveDelegationLaunch: async () => {
        composed += 1;
        assert.fail("an idle runtime must not compose a roster");
      },
    },
  );

  await update({ sessionId: "session-1", expectedRevision: 7, enabled: false });

  assert.deepEqual(calls.map((call) => call.method), ["session.team.set"]);
  assert.deepEqual(sidecarCalls.map((call) => call.method), ["agent.getStatus"]);
  assert.equal(composed, 0);
  assert.equal(sidecarCalls.length, 1);
});

test("a failed push never fails the stored update", async () => {
  const sidecarCalls = [];
  const logged = [];
  const { update, calls } = harness(
    async (method) => {
      if (method === "session.team.set") return { ...stored, revision: 8 };
      if (method === "session.get") return { session: { id: "session-1" } };
      assert.fail(`unexpected host call: ${method}`);
    },
    {
      sidecar: liveSidecar(true, sidecarCalls),
      resolveDelegationLaunch: async () => {
        throw Object.assign(new Error("provider list unavailable"), {
          errorCode: "HOST_UNAVAILABLE",
        });
      },
      logger: { app: (...args) => logged.push(args) },
    },
  );

  const result = await update({ sessionId: "session-1", expectedRevision: 7, enabled: true });

  // The configuration is stored, so the next launch applies it: a refresh that
  // could not reach the running turn is a diagnostic, not a lost edit.
  assert.deepEqual(result, { ...stored, revision: 8 });
  assert.deepEqual(calls.map((call) => call.method), ["session.team.set", "session.get"]);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1], "warn");
  assert.deepEqual(logged[0][3].data, { errorCode: "HOST_UNAVAILABLE" });
});
