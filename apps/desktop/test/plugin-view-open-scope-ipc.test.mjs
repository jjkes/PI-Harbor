/**
 * `pluginViewOpen` opens a docked view for the workspace root its owning
 * session resolves to, so the view host can keep one page per root. Root
 * resolution is asynchronous; only the newest open of a view may decide which
 * page it shows.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { IPC } from "../../../packages/shared/src/protocol.ts";
import { pluginProviderCatalogEntries } from "../electron/main/plugin-provider-catalog.ts";
import { createSessionPushGate } from "../electron/main/plugin-session-push-gate.ts";

function loadPluginUiIpc() {
  const file = new URL("../electron/main/ipc/plugin-ui-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const module = { exports: {} };
  const dependencies = {
    "node:fs": { existsSync: () => true },
    "node:path": { join: (...parts) => parts.join("/") },
    "@pi-harbor/shared": { IPC },
    "@pi-harbor/plugin-sdk": {
      normalizeThemeAssetPath: (path) => path,
      pluginThemeId: (...parts) => parts.join(":"),
      resolvePluginLocalizedString: (value) => value,
      themeAssetUrl: (value) => value,
    },
    "../browser-host": { BROWSER_PLUGIN_ID: "pi.browser", BROWSER_VIEW_ID: "browser" },
    "../plugin-runtime": { resolveInsidePlugin: () => "/plugin/index.html" },
    "../plugin-view-host": { pluginViewKey: (...parts) => parts.join("/") },
    "../plugin-panel-host": {},
    "../plugin-provider-catalog": { pluginProviderCatalogEntries },
    "../plugin-session-push-gate": { createSessionPushGate },
  };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(dependencies, id), `unexpected plugin UI dependency: ${id}`);
      return dependencies[id];
    },
    module.exports,
    module,
  );
  return module.exports.registerPluginUiIpc;
}

const registerPluginUiIpc = loadPluginUiIpc();

function loadedPlugin(id, viewId) {
  return {
    path: `/plugins/${id}`,
    permissions: new Set(["ui.view"]),
    manifest: { id, contributes: { views: [{ id: viewId, entry: "views/index.html" }] } },
  };
}

function harness({ workspaceRootForSession }) {
  const handlers = new Map();
  const opened = [];
  const calls = [];
  const loaded = new Map([
    ["pi.file-manager", loadedPlugin("pi.file-manager", "manager")],
    ["pi.browser", loadedPlugin("pi.browser", "browser")],
  ]);
  registerPluginUiIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    plugins: {
      getLoaded: (id) => loaded.get(id),
      listLoaded: () => [...loaded.values()],
      workspaceRootForSession,
    },
    browserHost: { setChromeSession: () => undefined },
    pluginViews: {
      open: (request) => opened.push(request),
      beginOpen: (_pluginId, _viewId, sessionId) => calls.push(`beginOpen:${sessionId}`),
      close: () => calls.push("close"),
    },
    pluginPanels: {},
    pluginActiveInProject: () => true,
    currentWorkspacePath: () => "/repo",
    getUpdaterLocale: () => "en",
    getPluginPanelTheme: () => "dark",
    setActivePluginSession: () => undefined,
    settleComposerSuggestion: () => undefined,
  });
  const open = (payload) => handlers.get(IPC.invoke.pluginViewOpen)(payload);
  const close = (payload) => handlers.get(IPC.invoke.pluginViewClose)(payload);
  return { open, close, opened, loaded, calls };
}

const FM = { pluginId: "pi.file-manager", viewId: "manager" };

test("a docked view opens for the root its session resolves to", async () => {
  const roots = { parent: "/repo", workspace: "/repo/.pi/worktree/feature" };
  const { open, opened } = harness({ workspaceRootForSession: async (id) => roots[id] ?? null });

  await open({ ...FM, sessionId: "workspace", location: ".pi/plan/demo.md" });
  await open({ ...FM, sessionId: "parent" });

  assert.deepEqual(
    opened.map(({ sessionId, scope, location }) => ({ sessionId, scope, location })),
    [
      { sessionId: "workspace", scope: "/repo/.pi/worktree/feature", location: ".pi/plan/demo.md" },
      { sessionId: "parent", scope: "/repo", location: undefined },
    ],
  );
});

test("a session whose root does not resolve gets a page of its own", async () => {
  const { open, opened } = harness({
    workspaceRootForSession: async (id) => {
      if (id === "missing") throw Object.assign(new Error("gone"), { errorCode: "WORKSPACE_MISSING" });
      return null;
    },
  });
  await open({ ...FM, sessionId: "missing" });
  await open({ ...FM, sessionId: "unknown" });
  assert.deepEqual(opened.map((request) => request.scope), ["session:missing", "session:unknown"]);
});

test("a slower open never overrides a newer one", async () => {
  const pending = new Map();
  const { open, opened } = harness({
    workspaceRootForSession: (id) => new Promise((resolve) => pending.set(id, resolve)),
  });
  const first = open({ ...FM, sessionId: "parent" });
  const second = open({ ...FM, sessionId: "workspace" });
  pending.get("workspace")("/repo/.pi/worktree/feature");
  await second;
  pending.get("parent")("/repo");
  await first;
  assert.deepEqual(opened.map((request) => request.sessionId), ["workspace"]);
});

test("browser and sessionless opens never wait for a root", async () => {
  let lookups = 0;
  const { open, opened } = harness({
    workspaceRootForSession: async () => {
      lookups += 1;
      return "/repo";
    },
  });
  await open({ pluginId: "pi.browser", viewId: "browser", sessionId: "parent" });
  await open({ ...FM });
  assert.equal(lookups, 0);
  assert.deepEqual(opened.map((request) => request.scope), [undefined, undefined]);
});

test("a plugin unloaded while its root resolves is not opened", async () => {
  let resolveRoot;
  const { open, opened, loaded } = harness({
    workspaceRootForSession: () => new Promise((resolve) => { resolveRoot = resolve; }),
  });
  const pendingOpen = open({ ...FM, sessionId: "workspace" });
  loaded.delete("pi.file-manager");
  resolveRoot("/repo/.pi/worktree/feature");
  await assert.rejects(pendingOpen, /plugin not loaded/);
  assert.deepEqual(opened, []);
});

test("a close cancels an open still resolving its root", async () => {
  let resolveRoot;
  const { open, close, opened, calls } = harness({
    workspaceRootForSession: () => new Promise((resolve) => { resolveRoot = resolve; }),
  });
  const pendingOpen = open({ ...FM, sessionId: "workspace" });
  await close({ ...FM });
  resolveRoot("/repo/.pi/worktree/feature");
  await pendingOpen;
  assert.deepEqual(opened, []);
  assert.deepEqual(calls, ["beginOpen:workspace", "close"]);
});

test("a resolving open first releases the page another session showed", async () => {
  const { open, calls } = harness({ workspaceRootForSession: async () => "/repo" });
  await open({ ...FM, sessionId: "workspace" });
  await open({ pluginId: "pi.browser", viewId: "browser", sessionId: "workspace" });
  await open({ ...FM });
  // Only a session-owned, non-browser open resolves a root, so only it releases.
  assert.deepEqual(calls, ["beginOpen:workspace"]);
});
