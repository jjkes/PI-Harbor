/**
 * A docked plugin view page caches the workspace root it reads through
 * `pi.workspace.get`, so the view host keeps one page per root instead of
 * re-pointing a live page at another session's folder. Re-pointing made the
 * File Manager resolve a project-workspace plan path against the parent
 * checkout until its next poll, and the requested file was lost.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { register } from "node:module";
import test from "node:test";
import ts from "typescript";

register(new URL("helpers/ts-import-hooks.mjs", import.meta.url));
const senders = await import("../electron/main/plugin-panel-senders.ts");
const location = await import("../electron/main/plugin-view-location.ts");
const bounds = await import("../electron/main/plugin-view-bounds.ts");
const scale = await import("../electron/main/plugin-view-scale.ts");
const chrome = await import("../electron/shared/plugin-panel-chrome.ts");

let nextContentsId = 1;
class FakeWebContents {
  constructor() {
    this.id = nextContentsId++;
    this.destroyed = false;
    this.sent = [];
    this.urls = [];
    this.listeners = [];
  }
  isDestroyed() { return this.destroyed; }
  loadURL(url) { this.urls.push(url); return Promise.resolve(); }
  send(channel, payload) { this.sent.push({ channel, payload }); }
  setWindowOpenHandler() {}
  setZoomFactor() {}
  on(event, handler) { this.listeners.push({ event, handler, once: false }); }
  once(event, handler) { this.listeners.push({ event, handler, once: true }); }
  emit(event) {
    for (const listener of [...this.listeners]) {
      if (listener.event !== event) continue;
      if (listener.once) this.listeners.splice(this.listeners.indexOf(listener), 1);
      listener.handler();
    }
  }
  close() { this.destroyed = true; this.emit("destroyed"); }
}

const created = [];
class FakeView {
  constructor() {
    this.webContents = new FakeWebContents();
    created.push(this);
  }
  setBounds() {}
}

function loadViewHost() {
  const file = new URL("../electron/main/plugin-view-host.ts", import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const dependencies = {
    electron: {
      session: { fromPartition: () => ({}) },
      shell: { openExternal: async () => undefined },
      WebContentsView: FakeView,
    },
    "node:path": { join: (...parts) => parts.join("/") },
    "./module-path": { getModuleDirectory: () => "/main" },
    "./safe-open-external": { parseAllowedExternalUrl: () => null },
    "./plugin-panel-senders": senders,
    "./plugin-view-location": location,
    "./plugin-view-bounds": bounds,
    "./plugin-view-scale": scale,
    "./plugin-panel-host": {
      applyPluginEgressPolicy: () => undefined,
      pluginSessionPartition: (pluginId) => `persist:plugin-${pluginId}`,
    },
    "../shared/plugin-panel-chrome": chrome,
  };
  const module = { exports: {} };
  const source = outputText.replaceAll("import.meta.url", JSON.stringify("file:///main/plugin-view-host.js"));
  new Function("require", "exports", "module", source)(
    (id) => {
      assert.ok(Object.hasOwn(dependencies, id), `unexpected view host dependency: ${id}`);
      return dependencies[id];
    },
    module.exports,
    module,
  );
  return module.exports.PluginViewHost;
}

const PluginViewHost = loadViewHost();
const PLUGIN = "pi.file-manager";
const VIEW = "manager";

function request(overrides = {}) {
  return {
    pluginId: PLUGIN,
    viewId: VIEW,
    locale: "en",
    theme: "dark",
    htmlPath: "/plugins/pi.file-manager/views/index.html",
    ...overrides,
  };
}

function harness() {
  created.length = 0;
  const children = [];
  const window = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, getZoomFactor: () => 1, on() {}, removeListener() {} },
    contentView: {
      children,
      addChildView: (view) => children.push(view),
      removeChildView: (view) => children.splice(children.indexOf(view), 1),
    },
  };
  const host = new PluginViewHost();
  const surfaces = [];
  host.onSurface = (surface) => surfaces.push(surface);
  host.setWindow(window);
  return { host, surfaces, attached: () => [...children] };
}

test("a session on another workspace root gets its own page instead of re-pointing the shared one", () => {
  const { host, attached } = harness();
  host.open(request({ sessionId: "parent", scope: "/repo" }));
  host.setVisible(PLUGIN, VIEW, true);
  const [parentPage] = created;
  assert.deepEqual(attached(), [parentPage]);

  host.open(request({ sessionId: "workspace", scope: "/repo/.pi/worktree/feature", location: ".pi/plan/demo.md" }));

  assert.equal(created.length, 2, "the workspace session must not reuse the parent checkout's page");
  const [, workspacePage] = created;
  assert.deepEqual(attached(), [workspacePage]);
  assert.match(workspacePage.webContents.urls.at(-1), /piViewOpen=\.pi%2Fplan%2Fdemo\.md/);
  // The parent page keeps its root and its owner; it never sees the plan path.
  assert.deepEqual(parentPage.webContents.sent, []);
  assert.equal(host.sessionIdForSender(parentPage.webContents.id), "parent");
  assert.equal(host.sessionIdForSender(workspacePage.webContents.id), "workspace");

  host.open(request({ sessionId: "parent", scope: "/repo" }));
  assert.equal(created.length, 2);
  assert.deepEqual(attached(), [parentPage]);
});

test("sessions on the same root share one page", () => {
  const { host } = harness();
  host.open(request({ sessionId: "a", scope: "/repo" }));
  host.open(request({ sessionId: "b", scope: "/repo" }));
  assert.equal(created.length, 1);
  assert.equal(host.sessionIdForSender(created[0].webContents.id), "b");
});

test("a show request that arrives before the page exists attaches it once opened", () => {
  const { host, attached, surfaces } = harness();
  host.setVisible(PLUGIN, VIEW, true);
  assert.deepEqual(attached(), []);

  host.open(request({ sessionId: "workspace", scope: "/repo/.pi/worktree/feature" }));

  assert.deepEqual(attached(), [created[0]]);
  assert.deepEqual(
    { pluginId: surfaces.at(-1)?.pluginId, viewId: surfaces.at(-1)?.viewId },
    { pluginId: PLUGIN, viewId: VIEW },
  );
});

test("a hide request before the page exists keeps it hidden", () => {
  const { host, attached } = harness();
  host.setVisible(PLUGIN, VIEW, true);
  host.setVisible(PLUGIN, VIEW, false);
  host.open(request({ sessionId: "workspace", scope: "/repo/.pi/worktree/feature" }));
  assert.deepEqual(attached(), []);
});

test("closing a view drops its page for every root", () => {
  const { host, attached } = harness();
  host.open(request({ sessionId: "parent", scope: "/repo" }));
  host.open(request({ sessionId: "workspace", scope: "/repo/.pi/worktree/feature" }));
  host.setVisible(PLUGIN, VIEW, true);

  host.close(PLUGIN, VIEW);

  assert.ok(created.every((page) => page.webContents.isDestroyed()));
  assert.deepEqual(attached(), []);
  assert.equal(host.has(PLUGIN, VIEW), false);
});

test("a view no session owns keeps a single page", () => {
  const { host } = harness();
  host.open(request());
  host.open(request({ location: "README.md" }));
  assert.equal(created.length, 1);
  assert.equal(host.has(PLUGIN, VIEW), true);
});

test("a session switch never shows the previous session's page while the new root resolves", () => {
  const { host, attached } = harness();
  host.open(request({ sessionId: "parent", scope: "/repo" }));
  host.setVisible(PLUGIN, VIEW, true);
  const [parentPage] = created;

  // The workspace tab mounts: its open starts resolving, then its show request
  // arrives before the root does.
  host.beginOpen(PLUGIN, VIEW, "workspace");
  host.setVisible(PLUGIN, VIEW, false);
  host.setVisible(PLUGIN, VIEW, true);
  assert.deepEqual(attached(), [], "the parent checkout must not be shown for the workspace session");
  assert.equal(host.sessionIdForSender(parentPage.webContents.id), "parent");

  host.open(request({ sessionId: "workspace", scope: "/repo/.pi/worktree/feature" }));
  assert.deepEqual(attached(), [created[1]]);

  // Switching back reuses the parent's cached page once its open lands.
  host.beginOpen(PLUGIN, VIEW, "parent");
  assert.deepEqual(attached(), []);
  host.open(request({ sessionId: "parent", scope: "/repo" }));
  assert.equal(created.length, 2);
  assert.deepEqual(attached(), [parentPage]);
});

test("the owning session's own re-open keeps its page on screen", () => {
  const { host, attached } = harness();
  host.open(request({ sessionId: "workspace", scope: "/repo/.pi/worktree/feature" }));
  host.setVisible(PLUGIN, VIEW, true);
  host.beginOpen(PLUGIN, VIEW, "workspace");
  assert.deepEqual(attached(), [created[0]]);
});
