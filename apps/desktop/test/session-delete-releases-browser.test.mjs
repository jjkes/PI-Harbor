import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import * as Value from "typebox/value";
import ts from "typescript";
import * as shared from "@pi-harbor/shared";

// Web access cannot reach the browser view channel, which answers as a no-op
// for web clients (channel-policy.ts). Deleting a session must therefore
// release its desktop browser pages on the host (ADR 0342).

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
    "@pi-harbor/shared": shared,
    "../importers": {},
    "../services/session-collaboration": {},
    "../services/session-context": {},
    "../bootstrap/remote-hosts.js": { getActiveRemoteHostsBoot: () => null },
    "../services/session-search": {},
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unexpected IPC dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const { registerSessionIpc } = loadSessionIpc();

function sessionIpc({ refuse = false, releaseError = null } = {}) {
  const handlers = new Map();
  const hostCalls = [];
  const released = [];
  const logs = [];
  const host = {
    async call(method, params) {
      hostCalls.push([method, params]);
      if (refuse) throw new Error("session is busy");
      return { ok: true };
    },
  };
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => null,
    activeTurns: new Map(),
    sessionProjects: new Map([["session-1", null]]),
    persistenceOutbox: { dropSession: async () => {} },
    forgetTranscriptRewriteHistory: () => {},
    logger: { app: (...entry) => logs.push(entry) },
    plugins: { broadcastEvent() {} },
    closeBrowserSession(sessionId) {
      released.push(sessionId);
      if (releaseError) throw releaseError;
    },
  });
  return {
    hostCalls,
    released,
    logs,
    deleteSession: (id) => handlers.get(shared.IPC.invoke.sessionDelete)(id),
  };
}

test("deleting a session releases its desktop browser pages after the host confirms", async () => {
  const ipc = sessionIpc();
  assert.deepEqual(await ipc.deleteSession("session-1"), { ok: true });
  assert.deepEqual(ipc.hostCalls, [["session.delete", { id: "session-1" }]]);
  assert.deepEqual(ipc.released, ["session-1"]);
});

test("a refused session delete leaves the desktop browser pages alone", async () => {
  const ipc = sessionIpc({ refuse: true });
  await assert.rejects(ipc.deleteSession("session-1"), /session is busy/);
  assert.deepEqual(ipc.released, []);
});

test("a failed browser release is logged and does not fail a delete the host confirmed", async () => {
  const ipc = sessionIpc({ releaseError: new Error("view destroyed") });
  assert.deepEqual(await ipc.deleteSession("session-1"), { ok: true });
  assert.ok(
    ipc.logs.some(
      ([category, level, , meta]) =>
        category === "session" && level === "warn" && meta?.sessionId === "session-1",
    ),
  );
});
