/**
 * The context viewer's channel, end to end below the UI: the renderer API goes
 * through the preload allowlist to Main, Main reads the whole transcript from
 * host-core and replays it with the real agent-runtime helper. Only host-core
 * is stubbed.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import i18n from "i18next";
import test from "node:test";
import * as Value from "typebox/value";
import ts from "typescript";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import { IPC, IPC_WHITELIST } from "../../../packages/shared/src/protocol.ts";

function load(relative, imports, globals = {}) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", ...Object.keys(globals), outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
    return imports[id];
  }, module.exports, module, ...Object.values(globals));
  return module.exports;
}

const shared = { ErrorCodes, IPC, IPC_WHITELIST };
const sessionContext = load("../electron/main/services/session-context.ts", {
  "@pi-harbor/agent-runtime": await import("@pi-harbor/agent-runtime"),
});
const { registerSessionIpc } = load("../electron/main/ipc/session-ipc.ts", {
  electron: { shell: {} },
  "node:fs": fs,
  "node:path": path,
  "typebox/value": Value,
  "@pi-harbor/shared": shared,
  "../importers": {},
  "../services/session-collaboration": {},
  "../services/session-context": sessionContext,
  "../bootstrap/remote-hosts.js": { getActiveRemoteHostsBoot: () => null },
  "../services/session-search": {},
});

function harness(read) {
  const handlers = new Map();
  const calls = [];
  let host = { call: async (method, input) => { calls.push({ method, input }); return read(method, input); } };
  const unexpected = () => assert.fail("a context read must not load or mutate session state");
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => null,
    sessionCapabilityContext: unexpected,
    enrichSession: unexpected,
    acquireSessionOperation: unexpected,
    plugins: { broadcastEvent: unexpected },
    persistenceOutbox: { dropSession: unexpected },
    logger: { app: unexpected },
    activeTurns: new Map(),
    sessionProjects: new Map(),
  });
  const handle = handlers.get(IPC.invoke.sessionContextGet);
  assert.equal(typeof handle, "function");
  return { handle, calls, clearHost: () => { host = null; } };
}

function rendererApi(handle) {
  let bridge;
  load("../electron/preload/index.ts", {
    electron: {
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: async (channel, ...args) => {
        assert.equal(channel, IPC.invoke.sessionContextGet);
        return { ok: true, data: await handle(...args) };
      } },
      webUtils: {},
    },
    "@pi-harbor/shared": shared,
    "@pi-harbor/shared/protocol": shared,
  });
  const { api } = load("../src/lib/api.ts", {
    "@pi-harbor/shared": shared,
    "./plan-history": load("../src/lib/plan-history.ts", {}),
    "./remote-ipc-safety": load("../src/lib/remote-ipc-safety.ts", { "@pi-harbor/shared": shared, i18next: { default: i18n } }),
    "./remote-session-safety": load("../src/lib/remote-session-safety.ts", {}),
  }, { window: { piDesktop: bridge } });
  return api;
}

const tool = { name: "Read", description: "Read a file.", parameters: { type: "object", properties: {} } };
const row = (id, message, createdAt) => ({
  id, role: "system", content: "", createdAt,
  modelSystem: { version: 1, messageJson: JSON.stringify(message) },
});
const transcript = [
  { id: "u1", role: "user", content: "Hi", createdAt: "2026-11-05T01:00:00.000Z" },
  row("s1", { role: "system", content: "You are Pi.", timestamp: 1, toolsAdded: [tool] }, "2026-11-05T01:00:01.000Z"),
  row("s2", { role: "system", content: "", timestamp: 2, sections: { skills: "Use skills." } }, "2026-11-05T01:00:02.000Z"),
];

test("the renderer reads the replayed system prompt and tools of a local session", async () => {
  const { handle, calls } = harness(async () => ({ session: { id: "local", messages: transcript } }));
  const snapshot = await rendererApi(handle).getSessionContext("local");
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.sessionId, "local");
  assert.match(snapshot.systemPrompt, /You are Pi\./);
  assert.match(snapshot.systemPrompt, /Use skills\./);
  assert.deepEqual(snapshot.tools, [tool]);
  assert.equal(snapshot.updatedAt, "2026-11-05T01:00:02.000Z");
  // The whole transcript: a windowed or truncated read could miss system rows.
  assert.deepEqual(calls, [{ method: "session.get", input: { id: "local" } }]);
});

test("a session with no recorded system state reads as empty", async () => {
  const { handle } = harness(async () => ({ session: { id: "fresh", messages: [transcript[0]] } }));
  assert.deepEqual(await handle({ sessionId: "fresh" }), { status: "empty", sessionId: "fresh" });
});

test("remote and native Pi sessions are unavailable without touching the host", async () => {
  const { handle, calls } = harness(async () => assert.fail("no host read"));
  assert.deepEqual(await handle({ sessionId: "remote:host-1:abc" }), {
    status: "unavailable", sessionId: "remote:host-1:abc", reason: "remote",
  });
  assert.deepEqual(await handle({ sessionId: "native-pi:abc" }), {
    status: "unavailable", sessionId: "native-pi:abc", reason: "native",
  });
  assert.deepEqual(calls, []);
});

test("failures stay visible instead of reading as an empty context", async () => {
  const missing = harness(async () => ({ session: null }));
  await assert.rejects(missing.handle({ sessionId: "gone" }), /session not found/);
  const broken = harness(async () => ({
    session: { id: "broken", messages: [{ ...transcript[1], modelSystem: { version: 1, messageJson: "{" } }] },
  }));
  await assert.rejects(broken.handle({ sessionId: "broken" }));
  const offline = harness(async () => ({ session: null }));
  offline.clearHost();
  await assert.rejects(offline.handle({ sessionId: "local" }), /host unavailable/);
  await assert.rejects(offline.handle({ sessionId: "" }), (error) => error.errorCode === ErrorCodes.INVALID_ARGUMENT);
});
