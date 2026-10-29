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
}) {
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
    getSidecar: () => null,
    activeTurns: new Map(),
    sessionProjects: new Map(),
    persistenceOutbox: {},
    logger: { app: unexpected },
    plugins: { broadcastEvent: unexpected },
    sessionCapabilityContext: unexpected,
    enrichSession: unexpected,
    acquireSessionOperation: unexpected,
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

test("a partial team update does not invent enabled or members fields", async () => {
  const { update, calls } = harness();
  await update({ sessionId: "session-1", expectedRevision: 7 });
  assert.deepEqual(calls[0].input, { sessionId: "session-1", expectedRevision: 7 });
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
    { ...valid, unexpected: true },
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
