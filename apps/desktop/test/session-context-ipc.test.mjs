/**
 * The context viewer's channel, end to end below the UI: the renderer API goes
 * through the preload allowlist to Main, Main reads the session's context
 * transcript from host-core and replays it with the real agent-runtime
 * helper. Only host-core is stubbed.
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
// The built package, as Main and the renderer import it (its `.js` specifiers
// resolve there; a direct `.ts` import would need the repo's import hook).
const sharedRuntime = await import("@pi-harbor/shared");

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

const shared = { ...sharedRuntime, ErrorCodes, IPC, IPC_WHITELIST };
const backendRouter = load("../electron/main/remote/backend-router.ts", { "@pi-harbor/shared": shared });
const sessionContext = load("../electron/main/services/session-context.ts", {
  "@pi-harbor/agent-runtime": await import("@pi-harbor/agent-runtime"),
  "@pi-harbor/shared": shared,
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

/**
 * The renderer API over the real preload bridge. Main's side mirrors
 * `ipc/register.ts`: the real backend router sees each call first, so a
 * `remote:` call never reaches the local handler.
 */
function rendererApi(handle) {
  const router = backendRouter.createBackendRouter();
  let bridge;
  load("../electron/preload/index.ts", {
    electron: {
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: async (channel, ...args) => {
        assert.equal(channel, IPC.invoke.sessionContextGet);
        try {
          const outcome = await router.route(channel, args);
          return { ok: true, data: outcome === backendRouter.ROUTE_LOCAL ? await handle(...args) : outcome.value };
        } catch (error) {
          return { ok: false, error: { code: error.errorCode ?? ErrorCodes.INTERNAL, message: error.message } };
        }
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
  const { handle, calls } = harness(async () => ({ transcript: { messages: transcript } }));
  const snapshot = await rendererApi(handle).getSessionContext("local");
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.sessionId, "local");
  assert.match(snapshot.systemPrompt, /You are Pi\./);
  assert.match(snapshot.systemPrompt, /Use skills\./);
  assert.deepEqual(snapshot.tools, [tool]);
  assert.equal(snapshot.updatedAt, "2026-11-05T01:00:02.000Z");
  // The lean whole-transcript read, never `session.get` and its payloads.
  assert.deepEqual(calls, [{ method: "session.contextTranscript", input: { id: "local" } }]);
});

test("the latest checkpoint the host returns governs the replay", async () => {
  const folded = { role: "system", content: "Checkpoint prompt.", timestamp: 1 };
  const compaction = {
    throughMessageId: "s1", createdAt: "2026-11-05T01:00:01.500Z",
    details: { systemMessageJson: JSON.stringify(folded) },
  };
  const { handle } = harness(async () => ({ transcript: { messages: transcript, compaction } }));
  const snapshot = await handle({ sessionId: "local" });
  assert.match(snapshot.systemPrompt, /Checkpoint prompt\./);
  assert.doesNotMatch(snapshot.systemPrompt, /You are Pi\./);
  assert.deepEqual(snapshot.tools, []);
});

test("a session with no recorded system state reads as empty", async () => {
  const { handle } = harness(async () => ({ transcript: { messages: [transcript[0]] } }));
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
  const missing = harness(async () => ({ transcript: null }));
  await assert.rejects(missing.handle({ sessionId: "gone" }), /session not found/);
  const broken = harness(async () => ({
    transcript: { messages: [{ ...transcript[1], modelSystem: { version: 1, messageJson: "{" } }] },
  }));
  await assert.rejects(broken.handle({ sessionId: "broken" }));
  const offline = harness(async () => ({ transcript: null }));
  offline.clearHost();
  await assert.rejects(offline.handle({ sessionId: "local" }), /host unavailable/);
  await assert.rejects(offline.handle({ sessionId: "" }), (error) => error.errorCode === ErrorCodes.INVALID_ARGUMENT);
});

test("the renderer explains remote and Pi CLI sessions without asking any host", async () => {
  const { handle, calls } = harness(async () => assert.fail("no host read"));
  const api = rendererApi(handle);
  // The backend router keeps a `remote:` call remote even with no paired host,
  // and no host serves this channel, so the renderer must answer it itself.
  assert.deepEqual(await api.getSessionContext("remote:host-1:abc"), {
    status: "unavailable", sessionId: "remote:host-1:abc", reason: "remote",
  });
  assert.deepEqual(await api.getSessionContext("native-pi:abc"), {
    status: "unavailable", sessionId: "native-pi:abc", reason: "native",
  });
  assert.deepEqual(calls, []);
});

test("an invalid id still reaches Main, which keeps its own error", async () => {
  const { handle } = harness(async () => assert.fail("no host read"));
  const api = rendererApi(handle);
  for (const id of ["remote:", "remote:host:", "", `native-pi:${"x".repeat(250)}`]) {
    // The router rejects a malformed remote id; the IPC handler rejects an
    // empty or oversized one. The fast path must not answer for either.
    await assert.rejects(api.getSessionContext(id), (error) => error.code === ErrorCodes.INVALID_ARGUMENT, id);
  }
});
