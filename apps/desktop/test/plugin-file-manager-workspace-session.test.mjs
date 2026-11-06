/**
 * The bundled File Manager must open a project-workspace session's files from
 * that workspace's folder, not from the parent checkout. A plan artifact is
 * written to `<workspace>/.pi/plan/<file>.md`, and the plan card opens exactly
 * that workspace-relative path in the docked File Manager view.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");
const fileManagerDir = join(desktopRoot, "resources/plugins/pi.file-manager");

process.env.PI_HARBOR_DATA_DIR = mkdtempSync(join(tmpdir(), "pi-fm-workspace-data-"));

register(new URL("helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function makeFolder(files) {
  const dir = mkdtempSync(join(tmpdir(), "pi-fm-workspace-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

const PLAN = ".pi/plan/demo-plan.md";
const SESSION = "workspace-session";

async function harness(t, { parent, workspace }) {
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    // The window shows the parent project; only the session knows its workspace.
    getWorkspacePath: () => parent,
    getWorkspaceInfo: () => ({ path: parent, name: "parent" }),
    getWorkspaceInfoForSession: async (sessionId) =>
      sessionId === SESSION ? { path: workspace, name: "feature" } : null,
    getWorkspacePathForSession: (sessionId) => (sessionId === SESSION ? workspace : null),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  await runtime.loadFromPath(fileManagerDir, ["ui.view", "fs.read"]);
  const view = (channel, payload) =>
    runtime.invokePanelBridge("pi.file-manager", channel, payload, { sessionId: SESSION });
  return { runtime, view };
}

test("a docked File Manager view opens a workspace session's plan file", async (t) => {
  const parent = makeFolder({ "README.md": "parent checkout" });
  const workspace = makeFolder({ "README.md": "workspace", [PLAN]: "# Plan\n" });
  const { view } = await harness(t, { parent, workspace });

  // The view polls workspace.get to learn its root.
  const info = await view("workspace.get", {});
  assert.equal(info?.path, workspace);

  const hello = await view("fm.hello", {});
  assert.equal(hello?.ok, true, JSON.stringify(hello));
  assert.equal(hello.root?.path, workspace);

  // The plan card hands the view the workspace-relative artifact path.
  const read = await view("fm.read", { path: PLAN, workspacePath: info.path });
  assert.equal(read?.ok, true, JSON.stringify(read));
  assert.equal(read.path, PLAN);
});

test("a page still holding the parent root cannot open the workspace plan", async (t) => {
  // Why the view host never re-points a live page at another root: the page
  // stamps its reads with the root it cached, and the File Manager refuses a
  // read whose root disagrees with the session's, so the plan would be lost.
  const parent = makeFolder({ "README.md": "parent checkout" });
  const workspace = makeFolder({ "README.md": "workspace", [PLAN]: "# Plan\n" });
  const { view } = await harness(t, { parent, workspace });

  const stale = await view("fm.read", { path: PLAN, workspacePath: parent });
  assert.equal(stale?.ok, false);
  assert.equal(stale.code, "WORKSPACE_CHANGED");
});
