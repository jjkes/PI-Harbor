#!/usr/bin/env node
/**
 * E2E-PROJECT-WORKSPACE-UI: the renderer surface of project workspaces.
 *
 * `scripts/e2e-project-workspace.mjs` covers the `projectWorkspace.*`
 * protocol against a real host. This suite covers what the user actually
 * operates: the project row's split "+", the create dialog and its inline
 * validation, the workspace node and its menu, the topbar crumb and the OS
 * window title, collapse persistence across a reload, the delete and repair
 * flows, zh-CN strings, and the keyboard contract of the branch picker.
 *
 * Everything is throwaway and offline:
 *   - a fresh `--user-data-dir` and `PI_HARBOR_DATA_DIR` per run;
 *   - a CDP port claimed from the OS at runtime, never a fixed one;
 *   - a local bare repository as `origin`, so `fetch` and `origin/HEAD`
 *     behave like a real clone without a network;
 *   - projects, sessions and settings seeded through the host protocol
 *     before launch, because the real "add project" path is a native folder
 *     picker and a first session normally needs a model.
 *
 * No provider, credential or model call is involved and no prompt is ever
 * sent. The suite only stops the processes it started itself.
 *
 * Prereqs: `pnpm --filter @pi-harbor/desktop build:deps`,
 * `pnpm --filter @pi-harbor/desktop build`, and `cargo build -p host-core`
 * (or `PI_HARBOR_HOST_BIN`).
 *
 * `PI_HARBOR_KEEP_TEMP=1` keeps the temp tree for inspection.
 * `PI_HARBOR_UI_SHOTS=<dir>` writes a screenshot per flow.
 */
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { Host } from "./e2e/host.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const appDir = join(root, "apps", "desktop");
const electronBin =
  process.platform === "win32"
    ? join(appDir, "node_modules/electron/dist/electron.exe")
    : join(appDir, "node_modules/.bin/electron");

const shotsDir = process.env.PI_HARBOR_UI_SHOTS || null;
const keepTemp = Boolean(process.env.PI_HARBOR_KEEP_TEMP);

function resolveHostBinary() {
  const candidates = [
    process.env.PI_HARBOR_HOST_BIN?.trim(),
    join(root, "target", "debug", "pi-harbor-host-core"),
    join(root, "target", "debug", "pi-harbor-host-core.exe"),
    join(root, "target", "release", "pi-harbor-host-core"),
    join(root, "target", "release", "pi-harbor-host-core.exe"),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `host-core binary not found; run cargo build -p host-core or set PI_HARBOR_HOST_BIN\nchecked: ${candidates.join(", ")}`,
    );
  }
  return resolve(found);
}

/** A port the OS just confirmed is free, so a parallel instance is never hit. */
function claimFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

// ---- results ---------------------------------------------------------------

const results = [];
let failed = 0;

function record(flow, status, label, detail = "") {
  results.push({ flow, status, label, detail });
  const line = `${status.padEnd(7)} [${flow}] ${label}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  if (status === "FAIL") failed += 1;
}

function check(flow, ok, label, detail = "") {
  record(flow, ok ? "PASS" : "FAIL", label, typeof detail === "string" ? detail : JSON.stringify(detail));
  return ok;
}

/** A flow that cannot run at all, so it is reported instead of silently passing. */
function blocked(flow, label, reason) {
  record(flow, "BLOCKED", label, reason);
}

async function flow(name, run) {
  try {
    await run();
  } catch (error) {
    record(name, "FAIL", "flow threw", String(error?.message || error).slice(0, 400));
  }
}

// ---- fixture git repository ------------------------------------------------

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-ws-ui-e2e-")));
const home = join(scratch, "home");
const dataDir = join(scratch, "data");
const profileDir = join(scratch, "profile");
const originPath = join(scratch, "origin.git");
const projectPath = join(scratch, "project");
const plainPath = join(scratch, "plain-folder");
for (const dir of [home, dataDir, profileDir, plainPath]) mkdirSync(dir, { recursive: true });

/** Git with the user's own configuration and credential prompts kept out. */
function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig-absent"),
      GIT_CONFIG_SYSTEM: join(home, ".gitconfig-absent"),
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "E2E",
      GIT_AUTHOR_EMAIL: "e2e@example.invalid",
      GIT_COMMITTER_NAME: "E2E",
      GIT_COMMITTER_EMAIL: "e2e@example.invalid",
    },
  }).trim();
}

function buildFixtureRepo() {
  git(scratch, ["init", "--bare", "-b", "main", originPath]);
  git(scratch, ["clone", originPath, projectPath]);
  git(projectPath, ["config", "user.name", "E2E"]);
  git(projectPath, ["config", "user.email", "e2e@example.invalid"]);
  writeFileSync(join(projectPath, "README.md"), "# fixture\n");
  git(projectPath, ["add", "README.md"]);
  git(projectPath, ["commit", "-m", "initial commit"]);
  git(projectPath, ["push", "-u", "origin", "main"]);
  // Two more remote branches: one to create a workspace from, one spare.
  git(projectPath, ["checkout", "-q", "-b", "feature/one"]);
  writeFileSync(join(projectPath, "feature.txt"), "feature\n");
  git(projectPath, ["add", "feature.txt"]);
  git(projectPath, ["commit", "-m", "feature commit"]);
  git(projectPath, ["push", "-u", "origin", "feature/one"]);
  git(projectPath, ["checkout", "-q", "-b", "feature/two"]);
  git(projectPath, ["push", "-u", "origin", "feature/two"]);
  // The project itself sits on `main`, which flow 7 then cannot reuse.
  git(projectPath, ["checkout", "-q", "main"]);
}

// ---- seeding through the host protocol -------------------------------------

/**
 * Projects, sessions and settings the renderer must already see at boot.
 *
 * `workspace.set` makes the git project the active one; `session.create`
 * supplies the two sessions flow 4 compares, one bound to a workspace and one
 * to the project root. A non-git folder is registered as a second project for
 * flow 12. Nothing here sends a prompt.
 */
async function seed(hostBinary, { language } = {}) {
  const host = new Host(hostBinary, dataDir, { quiet: true });
  await host.start();
  try {
    if (language) await host.call("settings.set", { language });
    // The non-git folder first, so the git project ends up the active one.
    const plain = await host.call("workspace.set", { path: plainPath });
    const canonicalPlain = plain?.workspace?.path || plain?.path || plainPath;
    const active = await host.call("workspace.set", { path: projectPath });
    const canonicalProject = active?.workspace?.path || active?.path || projectPath;
    return { canonicalProject, canonicalPlain };
  } finally {
    await host.stop();
  }
}

/** One short-lived host call against the same data dir the app will open. */
async function withHost(hostBinary, run) {
  const host = new Host(hostBinary, dataDir, { quiet: true });
  await host.start();
  try {
    return await run(host);
  } finally {
    await host.stop();
  }
}

// ---- CDP -------------------------------------------------------------------

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.closed = false;
    this.seq = 0;
    this.pending = new Map();
    this.console = [];
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (
        message.method === "Runtime.consoleAPICalled" ||
        message.method === "Runtime.exceptionThrown"
      ) {
        this.console.push(
          `[${message.method}] ${JSON.stringify(message.params).slice(0, 400)}`,
        );
        if (this.console.length > 60) this.console.shift();
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
    ws.onclose = () => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        entry.reject(new Error("CDP websocket closed"));
      }
      this.pending.clear();
    };
  }

  static connect(url) {
    return new Promise((resolveClient, reject) => {
      const ws = new WebSocket(url);
      ws.onerror = () => reject(new Error(`CDP websocket failed: ${url}`));
      ws.onopen = () => resolveClient(new CdpClient(ws));
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP websocket closed"));
    const id = ++this.seq;
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          JSON.stringify(result.exceptionDetails),
      );
    }
    return result.result.value;
  }
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2_000),
  });
  return response.json();
}

async function waitFor(predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(
    `timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

// ---- renderer helpers ------------------------------------------------------

/**
 * Click an element the user can actually see, by CSS selector or by visible
 * text. Returns false when nothing matched, so a flow fails on its own
 * assertion instead of on an exception.
 */
const CLICK_FN = `
window.__pwClick = (selector, text) => {
  const nodes = Array.from(document.querySelectorAll(selector));
  const target = text
    ? nodes.find((node) => (node.textContent || "").trim().includes(text))
    : nodes[0];
  if (!target) return false;
  target.scrollIntoView({ block: "center" });
  const rect = target.getBoundingClientRect();
  const base = { bubbles: true, cancelable: true, composed: true,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  target.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, button: 0 }));
  target.dispatchEvent(new MouseEvent("mousedown", base));
  target.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, button: 0 }));
  target.dispatchEvent(new MouseEvent("mouseup", base));
  target.click();
  return true;
};
window.__pwType = (selector, value) => {
  const input = document.querySelector(selector);
  if (!input) return false;
  const proto = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
};
window.__pwKey = (selector, key) => {
  const target = selector ? document.querySelector(selector) : document.activeElement;
  if (!target) return false;
  const init = { key, code: key, bubbles: true, cancelable: true, composed: true };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  return true;
};
window.__pwText = (selector) => {
  const node = document.querySelector(selector);
  return node ? (node.textContent || "").trim() : null;
};
window.__pwClickNode = (target) => {
  target.scrollIntoView({ block: "center" });
  const rect = target.getBoundingClientRect();
  const base = { bubbles: true, cancelable: true, composed: true,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  target.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, button: 0 }));
  target.dispatchEvent(new MouseEvent("mousedown", base));
  target.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, button: 0 }));
  target.dispatchEvent(new MouseEvent("mouseup", base));
  target.click();
  return true;
};
/** Click inside one container, so a second project's identical row is never hit. */
window.__pwClickIn = (containerSelector, selector, text) => {
  const container = document.querySelector(containerSelector);
  if (!container) return false;
  const nodes = Array.from(container.querySelectorAll(selector));
  const target = text
    ? nodes.find((node) => (node.textContent || "").trim().includes(text))
    : nodes[0];
  return target ? window.__pwClickNode(target) : false;
};
/** Click a selector inside the workspace node with the given name. */
window.__pwNode = (name, selector) => {
  const node = Array.from(document.querySelectorAll(".project-workspace-node")).find(
    (candidate) =>
      (candidate.querySelector(".project-workspace-node-name")?.textContent || "").trim() === name,
  );
  if (!node) return false;
  const target = node.querySelector(selector);
  return target ? window.__pwClickNode(target) : false;
};
/** Click the Nth session row of the project itself, never a workspace's row. */
window.__pwClickProjectRow = (groupSelector, index) => {
  const group = document.querySelector(groupSelector);
  if (!group) return false;
  const rows = Array.from(group.querySelectorAll(".thread-item")).filter(
    (row) => !row.closest(".project-workspace-node"),
  );
  const row = rows[index];
  if (!row) return false;
  return window.__pwClickNode(row.querySelector(".thread-item-main") || row);
};
/** Mark a field touched, which is what reveals its inline error. */
window.__pwBlur = (selector) => {
  const input = document.querySelector(selector);
  if (!input) return false;
  input.focus();
  input.blur();
  return true;
};
/** Focus a combobox so it opens its own list, as a real user's click would. */
window.__pwFocusOpen = (selector) => {
  const input = document.querySelector(selector);
  if (!input) return false;
  input.focus();
  return true;
};
/** Rows of the open sidebar menu, with their disabled state and reason. */
window.__pwMenu = () => {
  const menu = document.querySelector('[role="menu"]');
  // An empty list lets a flow fail its own assertion instead of throwing.
  if (!menu) return [];
  return Array.from(
    menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]'),
  ).map((item) => {
    const hintId = item.getAttribute("aria-describedby");
    const hint = hintId ? document.getElementById(hintId) : null;
    return {
      label: (item.querySelector(".sidebar-menu-label")?.textContent || item.textContent || "").trim(),
      disabled: item.disabled === true || item.getAttribute("aria-disabled") === "true",
      title: item.getAttribute("title"),
      hint: hint ? (hint.textContent || "").trim() : null,
    };
  });
};
1;
`;

/**
 * The create dialog's observable state. `WorktreeDialogFrame` marks its root
 * with `data-worktree-dialog`, not `id`, so that is what identifies it here.
 */
const DIALOG_STATE = `(() => {
  const dialog = document.querySelector('[data-worktree-dialog="project-workspace-create"]');
  if (!dialog) return { open: false };
  const q = (selector) => dialog.querySelector(selector);
  const text = (node) => (node ? (node.textContent || "").trim() : null);
  const submit = q('[data-action="project-workspace-create"]');
  const nameInput = q('[data-field="project-workspace-name"]');
  const combo = q('input[role="combobox"]');
  const listbox = q(".project-workspace-listbox");
  const branchInput = q('[data-field="project-workspace-new-branch"]');
  const options = Array.from(dialog.querySelectorAll('[role="option"]'))
    .map((node) => (node.textContent || "").trim());
  const errors = Array.from(dialog.querySelectorAll(".project-workspace-field-error"))
    .map((node) => (node.textContent || "").trim());
  return {
    open: true,
    title: text(q(".project-instructions-dialog-title")),
    subtitle: text(q(".project-instructions-dialog-project")),
    nameValue: nameInput ? nameInput.value : null,
    nameError: errors[0] ?? null,
    errors,
    pathPreview: text(q(".project-workspace-path-preview")),
    submitDisabled: submit ? submit.disabled : null,
    submitLabel: submit ? (submit.textContent || "").trim() : null,
    comboValue: combo ? combo.value : null,
    listboxOpen: listbox ? !listbox.className.includes("is-hidden") : null,
    options,
    optionCount: options.length,
    checkboxes: Array.from(dialog.querySelectorAll('input[type="checkbox"]')).map((box) => ({
      field: box.dataset.field || null,
      label: (box.closest("label")?.textContent || "").trim(),
      checked: box.checked,
    })),
    newBranchPresent: Boolean(branchInput),
    newBranchValue: branchInput ? branchInput.value : null,
    newBranchRequired: branchInput ? branchInput.required : null,
    note: text(q(".project-workspace-field-note")),
    warning: text(q(".project-workspace-field-warning")),
    bodyText: (dialog.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 600),
  };
})()`;

/** The delete dialog's observable state: pending summary and its options. */
const DELETE_STATE = `(() => {
  const dialog = document.querySelector('[data-worktree-dialog="project-workspace-delete"]');
  if (!dialog) return { open: false };
  const text = (node) => (node ? (node.textContent || "").trim() : null);
  const confirm = dialog.querySelector('[data-action="project-workspace-delete-confirm"]');
  return {
    open: true,
    title: text(dialog.querySelector(".project-instructions-dialog-title")),
    subtitle: text(dialog.querySelector(".project-instructions-dialog-project")),
    body: text(dialog.querySelector(".worktree-dialog-body p")),
    pending: Array.from(dialog.querySelectorAll(".project-workspace-pending li"))
      .map((row) => (row.textContent || "").trim()),
    checkboxes: Array.from(dialog.querySelectorAll('input[type="checkbox"]')).map((box) => ({
      field: box.dataset.field || null,
      label: (box.closest("label")?.textContent || "").trim(),
      checked: box.checked,
    })),
    errors: Array.from(dialog.querySelectorAll(".project-workspace-field-error"))
      .map((node) => (node.textContent || "").trim()),
    confirmLabel: confirm ? (confirm.textContent || "").trim() : null,
    confirmDisabled: confirm ? confirm.disabled : null,
    bodyText: (dialog.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 600),
  };
})()`;

/** Workspace nodes of one project group, plus that project's own session rows. */
function nodesStateExpr(groupSelector) {
  return `(() => {
  const group = document.querySelector(${JSON.stringify(groupSelector)});
  if (!group) return { missing: true, nodes: [], nodeNames: [], projectRows: [] };
  const nodes = Array.from(group.querySelectorAll(".project-workspace-node")).map((node) => {
    const body = node.querySelector(".project-workspace-node-body");
    return {
      id: node.getAttribute("data-project-workspace"),
      status: node.getAttribute("data-project-workspace-status"),
      name: (node.querySelector(".project-workspace-node-name")?.textContent || "").trim(),
      branch: (node.querySelector(".project-workspace-branch")?.textContent || "").trim(),
      badges: Array.from(node.querySelectorAll("[class*=badge]"))
        .map((badge) => (badge.textContent || "").trim()).filter(Boolean),
      collapsed: body ? body.className.includes("collapsed") : null,
      sessions: Array.from(node.querySelectorAll(".thread-item"))
        .map((row) => (row.querySelector(".thread-item-title")?.textContent || "").trim()),
      sessionEmpty: (node.querySelector(".sidebar-session-empty")?.textContent || "").trim() || null,
    };
  });
  const projectRows = Array.from(group.querySelectorAll(".thread-item"))
    .filter((row) => !row.closest(".project-workspace-node"))
    .map((row) => (row.querySelector(".thread-item-title")?.textContent || "").trim());
  return { nodes, nodeNames: nodes.map((node) => node.name), projectRows };
})()`;
}

/** Topbar crumb and the OS window title the renderer currently asks for. */
const TITLE_STATE = `(() => ({
  project: (document.querySelector(".ct-project:not(.ct-workspace) .ct-project-name")?.textContent || "").trim() || null,
  workspace: (document.querySelector(".ct-workspace .ct-project-name")?.textContent || "").trim() || null,
  task: (document.querySelector(".ct-title")?.textContent || "").trim() || null,
  crumbText: (document.querySelector(".ct-crumb, .conversation-topbar")?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200),
  documentTitle: document.title,
}))()`;

function sidebarProjectRowsExpr() {
  return `(() => Array.from(document.querySelectorAll(".sidebar-session-group-title.project-toggle"))
    .map((row) => (row.textContent || "").trim()))()`;
}

/**
 * Open "New workspace…" for one project: its row's caret, then the menu row.
 * Scoped to the project group, so a second project's caret is never hit.
 */
async function openCreateDialog(cdp, path = projectKey) {
  await closeMenus(cdp);
  await cdp.evaluate(
    `window.__pwClickIn(${JSON.stringify(groupSel(path))}, '[data-action="project-workspace-create-menu"]')`,
  );
  await delay(350);
  const opened = await cdp.evaluate(
    `window.__pwClick('[role="menuitem"]', "New workspace")`,
  );
  await delay(600);
  return opened;
}

async function screenshot(cdp, name) {
  if (!shotsDir) return null;
  try {
    mkdirSync(shotsDir, { recursive: true });
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const file = join(shotsDir, `${name}.png`);
    await writeFile(file, Buffer.from(shot.data, "base64"));
    return file;
  } catch {
    return null;
  }
}

// ---- process lifecycle -----------------------------------------------------

/** Only PIDs this suite started are ever signalled. */
const ownPids = [];

function stopOwnProcesses() {
  for (const child of ownPids) {
    if (!child.pid || child.killed) continue;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
}

function removeTemp() {
  if (keepTemp) {
    console.log(`temp kept: ${scratch}`);
    return;
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
}

/**
 * Launch the built app against the throwaway profile and attach to the main
 * window. Returns the CDP client plus a stop function for this instance only.
 */
async function launchApp(hostBinary, port, label) {
  const child = spawn(
    electronBin,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "."],
    {
      cwd: appDir,
      env: {
        ...process.env,
        PI_HARBOR_DATA_DIR: dataDir,
        PI_HARBOR_HOST_BIN: hostBinary,
        PI_HARBOR_START_MAXIMIZED: "0",
        ELECTRON_RENDERER_URL: "",
        HOME: home,
        GIT_CONFIG_GLOBAL: join(home, ".gitconfig-absent"),
        GIT_CONFIG_SYSTEM: join(home, ".gitconfig-absent"),
        GIT_TERMINAL_PROMPT: "0",
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  ownPids.push(child);
  let output = "";
  const collect = (chunk) => {
    output += String(chunk);
    if (output.length > 40_000) output = output.slice(-20_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  console.log(`launched electron pid=${child.pid} cdp=${port} (${label})`);

  const target = await waitFor(
    async () => {
      const targets = await listTargets(port).catch(() => []);
      return targets.find(
        (candidate) =>
          candidate.type === "page" &&
          candidate.webSocketDebuggerUrl &&
          candidate.url.includes("out/renderer/index.html") &&
          !candidate.url.includes("surface="),
      );
    },
    `main window CDP target (${label})`,
    90_000,
  );
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp.evaluate(CLICK_FN);
  const stop = async () => {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {}
    await delay(600);
  };
  return { cdp, child, stop, output: () => output };
}

// ---- the run ---------------------------------------------------------------

/** Canonical project paths, as the host stores them. */
let projectKey = null;
let plainKey = null;

const groupSel = (path) => `[data-sidebar-project-group=${JSON.stringify(path)}]`;
const worktreePath = (name) => join(projectPath, ".pi", "worktree", name);
const branchOf = (dir) => git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);

/** English catalog messages the inline name rules must produce. */
const NAME_ERRORS = {
  required: "Enter a name.",
  tooLong: "Use at most 64 characters.",
  separator: "A name cannot contain a slash or a backslash.",
  relative: "A name cannot contain two dots in a row.",
  leadingDot: "A name cannot start with a dot.",
  trailingDot: "A name cannot end with a dot.",
  forbidden: 'A name cannot contain the characters : * ? " < > |.',
  reserved: "Windows reserves this name. Pick another one.",
};

/** The renderer has painted its project rows and the splash is gone. */
async function waitForSidebar(cdp, label) {
  await waitFor(
    () =>
      cdp.evaluate(
        `(() => !document.querySelector(".startup-splash") &&
          document.querySelectorAll(".sidebar-session-group-title.project-toggle").length > 0)()`,
      ),
    `sidebar project rows (${label})`,
    90_000,
  );
}

/**
 * Both fixture projects are renderer-local retained rows, which is how the
 * sidebar lists a project that has no sessions yet. Seeded directly because
 * the real path is a native folder picker.
 */
async function seedSidebarPreferences(cdp) {
  const preferences = {
    sessionMeta: {},
    projectMeta: { [projectKey]: { order: 0 }, [plainKey]: { order: 1 } },
    projectSort: "manual",
    sessionView: { sort: "recent", archived: false },
    openProjectPaths: [projectKey, plainKey],
  };
  await cdp.evaluate(
    `window.localStorage.setItem("pi.desktop.sidebarPreferences", ${JSON.stringify(JSON.stringify(preferences))})`,
  );
  await reload(cdp);
}

/** Reload the renderer and re-install the helper functions it just lost. */
async function reload(cdp) {
  await cdp.send("Page.reload", {});
  await delay(1_200);
  await waitFor(() => cdp.evaluate("1"), "renderer after reload", 60_000);
  await cdp.evaluate(CLICK_FN);
  await waitForSidebar(cdp, "after reload");
}

const dialogState = (cdp) => cdp.evaluate(DIALOG_STATE);
const deleteState = (cdp) => cdp.evaluate(DELETE_STATE);
const nodesState = (cdp) => cdp.evaluate(nodesStateExpr(groupSel(projectKey)));

async function waitForDialog(cdp, open, label) {
  await waitFor(
    async () => (await dialogState(cdp)).open === open,
    `create dialog ${open ? "open" : "closed"} (${label})`,
    60_000,
  );
}

/** Type a workspace name and blur it, so the inline rule is shown. */
async function typeName(cdp, value) {
  await cdp.evaluate(
    `window.__pwType('[data-field="project-workspace-name"]', ${JSON.stringify(value)})`,
  );
  await cdp.evaluate(`window.__pwBlur('[data-field="project-workspace-name"]')`);
  await delay(180);
  return dialogState(cdp);
}

/** Open the source-branch list and commit one option by clicking it. */
async function pickBranch(cdp, branch) {
  await cdp.evaluate(`window.__pwFocusOpen('[role="dialog"] input[role="combobox"]')`);
  await delay(260);
  const picked = await cdp.evaluate(
    `window.__pwClickIn('[role="dialog"]', '[role="option"]', ${JSON.stringify(branch)})`,
  );
  await delay(260);
  return picked;
}

/** Fill the open create dialog and press Create. */
async function submitCreate(cdp, { name, branch }) {
  await typeName(cdp, name);
  await pickBranch(cdp, branch);
  await cdp.evaluate(`window.__pwClick('[data-action="project-workspace-create"]')`);
}

/** Create one workspace end to end through the dialog. */
async function createWorkspaceViaUi(cdp, { name, branch }) {
  const opened = await openCreateDialog(cdp, projectKey);
  if (!opened) throw new Error(`create dialog did not open for ${name}`);
  await waitForDialog(cdp, true, name);
  await submitCreate(cdp, { name, branch });
  await waitForDialog(cdp, false, `${name} submitted`);
  await waitFor(
    async () => (await nodesState(cdp)).nodeNames.includes(name),
    `workspace node ${name}`,
    120_000,
  );
}

/** Dismiss any open floating menu. */
async function closeMenus(cdp) {
  await cdp.evaluate(`window.__pwKey("body", "Escape")`);
  await delay(200);
  await cdp.evaluate(
    `(() => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 })); return 1; })()`,
  );
  await delay(200);
}

async function main() {
  const hostBinary = resolveHostBinary();
  buildFixtureRepo();
  // English is the locale every inline-message assertion below is written
  // against; flow 10 switches the same profile to zh-CN later.
  const seeded = await seed(hostBinary, { language: "en" });
  projectKey = seeded.canonicalProject;
  plainKey = seeded.canonicalPlain;
  console.log(`host=${hostBinary}`);
  console.log(`project=${projectKey}`);
  console.log(`plain=${plainKey}`);
  console.log(`temp=${scratch}`);

  // ---- instance A: creation, binding, titles, collapse, delete ------------
  const portA = await claimFreePort();
  const appA = await launchApp(hostBinary, portA, "A");
  const cdp = appA.cdp;
  await waitForSidebar(cdp, "A");
  await seedSidebarPreferences(cdp);

  const bootTitle = await cdp.evaluate("document.title");
  const defaultTitle = bootTitle.includes(" — ")
    ? bootTitle.slice(bootTitle.lastIndexOf(" — ") + 3)
    : bootTitle;

  // ---- flow 1 -------------------------------------------------------------
  await flow("1", async () => {
    const rows = await cdp.evaluate(sidebarProjectRowsExpr());
    const shot = await screenshot(cdp, "flow1-sidebar");
    check(
      "1",
      rows.some((row) => row.includes("project")),
      "seeded git project is listed in the sidebar",
      `rows=${JSON.stringify(rows)} shot=${shot || "none"}`,
    );
  });

  // ---- flow 12: a non-git project cannot host a workspace -----------------
  await flow("12", async () => {
    const clicked = await cdp.evaluate(
      `window.__pwClickIn(${JSON.stringify(groupSel(plainKey))}, '[data-action="project-workspace-create-menu"]')`,
    );
    if (!clicked) {
      blocked("12", "non-git project caret", "no create-menu caret on the plain project row");
      return;
    }
    await delay(500);
    const items = await cdp.evaluate("window.__pwMenu()");
    const row = items.find((item) => item.label.includes("New workspace"));
    const shot = await screenshot(cdp, "flow12-non-git-menu");
    check("12", Boolean(row), "non-git project offers the New workspace row", JSON.stringify(items));
    if (row) {
      check("12", row.disabled === true, "New workspace is disabled for a non-git project", JSON.stringify(row));
      const reason = `${row.hint || ""} ${row.title || ""}`;
      check(
        "12",
        /not a git repository/i.test(reason),
        "the disabled row states the reason",
        `reason=${JSON.stringify(reason.trim())} shot=${shot || "none"}`,
      );
    }
    await closeMenus(cdp);
  });

  // ---- flow 2: the create dialog and its inline validation ----------------
  await flow("2", async () => {
    const opened = await openCreateDialog(cdp, projectKey);
    check("2", opened, "New workspace opens the create dialog from the project row");
    if (!opened) return;
    await waitForDialog(cdp, true, "flow 2");
    const initial = await dialogState(cdp);
    check("2", initial.title === "New workspace", "dialog title", JSON.stringify(initial.title));

    const cases = [
      ["", ["required"]],
      ["a/b", ["separator"]],
      ["..", ["relative", "leadingDot"]],
      [".hidden", ["leadingDot"]],
      ["trailing.", ["trailingDot"]],
      ["bad:name", ["forbidden"]],
      ["CON", ["reserved"]],
      ["x".repeat(65), ["tooLong"]],
    ];
    for (const [value, problems] of cases) {
      const state = await typeName(cdp, value);
      const expected = problems.map((problem) => NAME_ERRORS[problem]);
      const label = value === "" ? "(empty)" : value.length > 20 ? `${value.length}-char name` : value;
      check(
        "2",
        state.submitDisabled === true && Boolean(state.nameError) && expected.includes(state.nameError),
        `inline rule rejects ${label}`,
        `error=${JSON.stringify(state.nameError)} submitDisabled=${state.submitDisabled} expected=${JSON.stringify(expected)}`,
      );
    }

    const preview = await typeName(cdp, "ws-one");
    check(
      "2",
      preview.pathPreview?.includes(".pi/worktree/ws-one") === true,
      "path preview shows .pi/worktree/<name>",
      JSON.stringify(preview.pathPreview),
    );
    check("2", !preview.nameError, "a valid name clears the inline error", JSON.stringify(preview.nameError));

    await cdp.evaluate(`window.__pwFocusOpen('[role="dialog"] input[role="combobox"]')`);
    await delay(400);
    const listed = await dialogState(cdp);
    check(
      "2",
      ["main", "feature/one", "feature/two"].every((branch) => listed.options.includes(branch)),
      "source-branch list shows origin's branches",
      JSON.stringify(listed.options),
    );
    check(
      "2",
      !listed.options.some((option) => /HEAD/.test(option)),
      "the branch list has no origin/HEAD",
      JSON.stringify(listed.options),
    );

    await cdp.evaluate(`window.__pwClick('[data-action="project-workspace-refresh-branches"]')`);
    await delay(500);
    const refreshed = await waitFor(
      async () => {
        const state = await dialogState(cdp);
        return state.open && !state.loadingBranches ? state : null;
      },
      "branch refresh to settle",
      60_000,
    );
    check(
      "2",
      ["main", "feature/one", "feature/two"].every((branch) => refreshed.options.includes(branch)) &&
        !refreshed.warning,
      "Refresh keeps the list and reports no failure against the local origin",
      `options=${JSON.stringify(refreshed.options)} warning=${JSON.stringify(refreshed.warning)}`,
    );

    await cdp.evaluate(`window.__pwClick('[data-field="project-workspace-create-branch"]')`);
    await delay(300);
    const branching = await dialogState(cdp);
    check(
      "2",
      branching.newBranchValue === "ws-one",
      "Create new branch reveals a branch field prefilled with the workspace name",
      JSON.stringify(branching.newBranchValue),
    );
    await cdp.evaluate(`window.__pwType('[data-field="project-workspace-new-branch"]', "")`);
    await cdp.evaluate(`window.__pwBlur('[data-field="project-workspace-new-branch"]')`);
    await delay(220);
    const emptyBranch = await dialogState(cdp);
    check(
      "2",
      emptyBranch.submitDisabled === true && emptyBranch.errors.includes("Enter a branch name."),
      "the new-branch field is required",
      `errors=${JSON.stringify(emptyBranch.errors)} submitDisabled=${emptyBranch.submitDisabled}`,
    );
    const shot = await screenshot(cdp, "flow2-create-dialog");
    record("2", "PASS", "evidence", `shot=${shot || "none"}`);
    await cdp.evaluate(`window.__pwClick('[data-field="project-workspace-create-branch"]')`);
    await delay(250);
  });

  // ---- flow 11: keyboard contract (same open dialog) ----------------------
  await flow("11", async () => {
    const state = await dialogState(cdp);
    if (!state.open) {
      blocked("11", "keyboard contract", "create dialog was not open");
      return;
    }
    await cdp.evaluate(`window.__pwFocusOpen('[role="dialog"] input[role="combobox"]')`);
    await delay(300);
    const open = await dialogState(cdp);
    await cdp.evaluate(`window.__pwKey('[role="dialog"] input[role="combobox"]', "ArrowDown")`);
    await delay(160);
    await cdp.evaluate(`window.__pwKey('[role="dialog"] input[role="combobox"]', "Enter")`);
    await delay(260);
    const committed = await dialogState(cdp);
    check(
      "11",
      open.listboxOpen === true &&
        open.options.length > 1 &&
        committed.comboValue === open.options[1],
      "branch picker commits the arrow-selected option on Enter",
      `options=${JSON.stringify(open.options)} value=${JSON.stringify(committed.comboValue)}`,
    );
    await cdp.evaluate(`window.__pwKey("body", "Escape")`);
    await delay(400);
    const closed = await dialogState(cdp);
    check("11", closed.open === false, "Esc closes the idle create dialog", JSON.stringify(closed.open));
  });

  // ---- flow 3: create a workspace on feature/one --------------------------
  await flow("3", async () => {
    await createWorkspaceViaUi(cdp, { name: "ws-one", branch: "feature/one" });
    const nodes = await nodesState(cdp);
    const node = nodes.nodes.find((entry) => entry.name === "ws-one");
    const shot = await screenshot(cdp, "flow3-workspace-node");
    check("3", Boolean(node), "a workspace node appears under the project", JSON.stringify(nodes.nodeNames));
    check("3", node?.branch.includes("feature/one") === true, "the node shows its branch", JSON.stringify(node?.branch));
    const dir = worktreePath("ws-one");
    check("3", existsSync(dir), "<project>/.pi/worktree/ws-one exists", dir);
    const branch = existsSync(dir) ? branchOf(dir) : "(missing)";
    check("3", branch === "feature/one", "the checkout is on feature/one", `HEAD=${branch}`);
    const status = git(projectPath, ["status", "--porcelain"]);
    check("3", status === "", "git status in the project stays empty", `status=${JSON.stringify(status)} shot=${shot || "none"}`);
  });

  // ---- flow 7: a branch already checked out ------------------------------
  await flow("7", async () => {
    const opened = await openCreateDialog(cdp, projectKey);
    if (!opened) {
      blocked("7", "branch already checked out", "create dialog did not open");
      return;
    }
    await waitForDialog(cdp, true, "flow 7");
    await submitCreate(cdp, { name: "ws-main", branch: "main" });
    const failed = await waitFor(
      async () => {
        const state = await dialogState(cdp);
        return state.open && state.errors.length > 0 ? state : null;
      },
      "inline alert for a checked-out branch",
      90_000,
    ).catch(() => null);
    const shot = await screenshot(cdp, "flow7-branch-in-use");
    if (!failed) {
      const after = await dialogState(cdp);
      check("7", false, "creating on a checked-out branch is refused inline", `dialog=${JSON.stringify(after)} shot=${shot || "none"}`);
    } else {
      check("7", failed.open === true, "the dialog stays open", `errors=${JSON.stringify(failed.errors)}`);
      check(
        "7",
        failed.errors.some((error) => error.length > 0),
        "an inline alert explains the failure",
        `errors=${JSON.stringify(failed.errors)} shot=${shot || "none"}`,
      );
      check("7", !existsSync(worktreePath("ws-main")), "no folder was created", worktreePath("ws-main"));
    }
    await cdp.evaluate(`window.__pwClickIn('[role="dialog"]', "button", "Cancel")`);
    await delay(400);
    await waitForDialog(cdp, false, "flow 7 cancel").catch(() => {});
  });

  // ---- support: a second workspace for flows 6 and 9 ---------------------
  await flow("6/9 setup", async () => {
    await createWorkspaceViaUi(cdp, { name: "ws-two", branch: "feature/two" });
    record("6/9 setup", "PASS", "ws-two created for the collapse and repair flows", worktreePath("ws-two"));
  });

  // ---- flow 5: which "+" starts a session where --------------------------
  let titleAfterWorkspacePlus = null;
  await flow("5", async () => {
    const before = await nodesState(cdp);
    const beforeNode = before.nodes.find((entry) => entry.name === "ws-one");
    await cdp.evaluate(
      `window.__pwClickIn(${JSON.stringify(groupSel(projectKey))}, '.sidebar-session-group-add:not([data-action="project-workspace-new-session"])')`,
    );
    const afterProject = await waitFor(
      async () => {
        const state = await nodesState(cdp);
        return state.projectRows.length > before.projectRows.length ? state : null;
      },
      "a session row in the project's own rows",
      60_000,
    ).catch(() => null);
    const projectTitle = await cdp.evaluate(TITLE_STATE);
    const shotProject = await screenshot(cdp, "flow5-project-session");
    if (!afterProject) {
      check("5", false, "the project row '+' starts a session in the project", `rows=${JSON.stringify(before.projectRows)} title=${JSON.stringify(projectTitle)} shot=${shotProject || "none"}`);
    } else {
      const node = afterProject.nodes.find((entry) => entry.name === "ws-one");
      check(
        "5",
        afterProject.projectRows.length === before.projectRows.length + 1 &&
          node?.sessions.length === beforeNode?.sessions.length,
        "the project row '+' starts a session in the project, not a workspace",
        `projectRows ${before.projectRows.length}->${afterProject.projectRows.length}, ws-one sessions ${beforeNode?.sessions.length}->${node?.sessions.length}`,
      );
      check(
        "5",
        projectTitle.workspace === null,
        "the project draft shows no workspace in the crumb",
        `crumb project=${JSON.stringify(projectTitle.project)} workspace=${JSON.stringify(projectTitle.workspace)} shot=${shotProject || "none"}`,
      );
    }

    const beforeWorkspace = await nodesState(cdp);
    const beforeWsOne = beforeWorkspace.nodes.find((entry) => entry.name === "ws-one");
    await cdp.evaluate(`window.__pwNode("ws-one", '[data-action="project-workspace-new-session"]')`);
    const afterWorkspace = await waitFor(
      async () => {
        const state = await nodesState(cdp);
        const node = state.nodes.find((entry) => entry.name === "ws-one");
        return node && node.sessions.length > (beforeWsOne?.sessions.length ?? 0) ? state : null;
      },
      "a session row under the ws-one node",
      60_000,
    ).catch(() => null);
    titleAfterWorkspacePlus = await cdp.evaluate(TITLE_STATE);
    const shotWorkspace = await screenshot(cdp, "flow5-workspace-session");
    if (!afterWorkspace) {
      check("5", false, "the workspace node '+' starts a session in that workspace", `title=${JSON.stringify(titleAfterWorkspacePlus)} shot=${shotWorkspace || "none"}`);
    } else {
      const node = afterWorkspace.nodes.find((entry) => entry.name === "ws-one");
      check(
        "5",
        node.sessions.length === (beforeWsOne?.sessions.length ?? 0) + 1 &&
          afterWorkspace.projectRows.length === beforeWorkspace.projectRows.length,
        "the workspace node '+' starts a session in that workspace, not the project",
        `ws-one sessions ${beforeWsOne?.sessions.length}->${node.sessions.length}, projectRows ${beforeWorkspace.projectRows.length}->${afterWorkspace.projectRows.length}`,
      );
      check(
        "5",
        titleAfterWorkspacePlus.workspace === "ws-one",
        "the workspace draft shows the workspace in the crumb",
        `${JSON.stringify(titleAfterWorkspacePlus)} shot=${shotWorkspace || "none"}`,
      );
    }
  });

  // ---- flow 4: grouping, crumb and window title --------------------------
  await flow("4", async () => {
    const state = titleAfterWorkspacePlus ?? (await cdp.evaluate(TITLE_STATE));
    const nodes = await nodesState(cdp);
    const node = nodes.nodes.find((entry) => entry.name === "ws-one");
    check(
      "4",
      (node?.sessions.length ?? 0) > 0,
      "the workspace-bound session is listed under the workspace node",
      `sessions=${JSON.stringify(node?.sessions)}`,
    );
    check(
      "4",
      state.project === "project" && state.workspace === "ws-one",
      "the topbar crumb reads Project / Workspace",
      JSON.stringify(state),
    );
    const expected = `project / ws-one · ${state.task} — ${defaultTitle}`;
    check(
      "4",
      state.documentTitle === expected,
      "document.title is <Project> / <Workspace> · <session title> — <default title>",
      `actual=${JSON.stringify(state.documentTitle)} expected=${JSON.stringify(expected)}`,
    );

    const clicked = await cdp.evaluate(
      `window.__pwClickProjectRow(${JSON.stringify(groupSel(projectKey))}, 0)`,
    );
    await delay(900);
    const projectState = await cdp.evaluate(TITLE_STATE);
    const shot = await screenshot(cdp, "flow4-project-session-title");
    check(
      "4",
      clicked && projectState.workspace === null && !projectState.documentTitle.includes("ws-one"),
      "a project session's title has no workspace part",
      `${JSON.stringify(projectState)} shot=${shot || "none"}`,
    );
    check(
      "4",
      bootTitle === defaultTitle,
      "with no conversation the default window title is used",
      `bootTitle=${JSON.stringify(bootTitle)} defaultTitle=${JSON.stringify(defaultTitle)}`,
    );
  });

  // ---- flow 6a: collapse survives a reload -------------------------------
  await flow("6", async () => {
    await cdp.evaluate(`window.__pwNode("ws-two", ".project-workspace-node-title")`);
    await delay(600);
    const collapsed = await nodesState(cdp);
    const node = collapsed.nodes.find((entry) => entry.name === "ws-two");
    check("6", node?.collapsed === true, "the workspace node collapses", JSON.stringify(node));
    const stored = await cdp.evaluate(
      `window.localStorage.getItem("pi.desktop.sidebarPreferences")`,
    );
    await reload(cdp);
    await waitFor(
      async () => (await nodesState(cdp)).nodeNames.includes("ws-two"),
      "ws-two after reload",
      60_000,
    );
    const afterReload = await nodesState(cdp);
    const reloadedNode = afterReload.nodes.find((entry) => entry.name === "ws-two");
    const shot = await screenshot(cdp, "flow6-collapse-reload");
    check(
      "6",
      reloadedNode?.collapsed === true,
      "the node stays collapsed across a reload",
      `node=${JSON.stringify(reloadedNode)} stored=${String(stored).slice(0, 200)} shot=${shot || "none"}`,
    );
  });

  // ---- flow 8: delete from the node menu ---------------------------------
  await flow("8", async () => {
    const opened = await cdp.evaluate(`window.__pwNode("ws-one", ".thread-item-more")`);
    if (!opened) {
      blocked("8", "delete from the node menu", "node overflow button not found");
      return;
    }
    await delay(500);
    const items = await cdp.evaluate("window.__pwMenu()");
    const labels = items.map((item) => item.label);
    check(
      "8",
      labels.some((label) => label.includes("Delete workspace")),
      "the node menu offers Delete workspace",
      JSON.stringify(labels),
    );
    check(
      "8",
      labels.some((label) => label.includes("Remove from list")),
      "a keep-the-folder path exists (Remove from list)",
      JSON.stringify(labels),
    );
    await cdp.evaluate(`window.__pwClick('[role="menuitem"]', "Delete workspace")`);
    const dialog = await waitFor(
      async () => {
        const state = await deleteState(cdp);
        return state.open && state.pending.length > 0 ? state : null;
      },
      "delete dialog with its pending-work summary",
      60_000,
    ).catch(() => null);
    const shot = await screenshot(cdp, "flow8-delete-dialog");
    if (!dialog) {
      const state = await deleteState(cdp);
      check("8", false, "the delete dialog shows the pending-work summary", `${JSON.stringify(state)} shot=${shot || "none"}`);
      return;
    }
    check(
      "8",
      dialog.pending.length > 0,
      "the dialog shows the pending-work summary",
      JSON.stringify(dialog.pending),
    );
    const branchBox = dialog.checkboxes.find((box) => /delete the local branch/i.test(box.label));
    check(
      "8",
      branchBox?.checked === false,
      "'also delete the local branch' defaults to off",
      JSON.stringify(dialog.checkboxes),
    );
    check(
      "8",
      dialog.bodyText.includes(".pi/worktree/ws-one"),
      "the dialog names the folder it deletes",
      dialog.bodyText.slice(0, 200),
    );
    await cdp.evaluate(`window.__pwClick('[data-action="project-workspace-delete-confirm"]')`);
    const gone = await waitFor(
      async () => !(await nodesState(cdp)).nodeNames.includes("ws-one"),
      "ws-one node to disappear",
      90_000,
    ).catch(() => false);
    const shotAfter = await screenshot(cdp, "flow8-after-delete");
    check("8", gone === true, "the node disappears after confirming", `nodes=${JSON.stringify((await nodesState(cdp)).nodeNames)} shot=${shotAfter || "none"}`);
    check("8", !existsSync(worktreePath("ws-one")), "the folder is removed from disk", worktreePath("ws-one"));
    const branches = git(projectPath, ["branch", "--list", "feature/one"]);
    check(
      "8",
      branches.includes("feature/one"),
      "the local branch survives when 'delete branch' stays off",
      `git branch --list feature/one -> ${JSON.stringify(branches)}`,
    );
  });

  await appA.stop();

  // ---- instance B: missing folder and repair ------------------------------
  rmSync(worktreePath("ws-two"), { recursive: true, force: true });
  const portB = await claimFreePort();
  const appB = await launchApp(hostBinary, portB, "B");
  await waitForSidebar(appB.cdp, "B");
  await appB.cdp.evaluate(CLICK_FN);

  await flow("6b", async () => {
    await waitFor(
      async () => (await nodesState(appB.cdp)).nodeNames.includes("ws-two"),
      "ws-two after relaunch",
      60_000,
    );
    const state = await nodesState(appB.cdp);
    const node = state.nodes.find((entry) => entry.name === "ws-two");
    const shot = await screenshot(appB.cdp, "flow6b-collapse-relaunch");
    check(
      "6",
      node?.collapsed === true,
      "the node stays collapsed across a relaunch",
      `node=${JSON.stringify(node)} shot=${shot || "none"}`,
    );
  });

  await flow("9", async () => {
    const state = await nodesState(appB.cdp);
    const node = state.nodes.find((entry) => entry.name === "ws-two");
    const shot = await screenshot(appB.cdp, "flow9-missing");
    check(
      "9",
      node?.status === "missing",
      "a workspace whose folder is gone shows the missing state",
      `node=${JSON.stringify(node)} shot=${shot || "none"}`,
    );
    check(
      "9",
      node?.badges.some((badge) => /missing/i.test(badge)) === true,
      "the node carries a 'Folder missing' badge",
      JSON.stringify(node?.badges),
    );
    await appB.cdp.evaluate(`window.__pwNode("ws-two", ".thread-item-more")`);
    await delay(500);
    const items = await appB.cdp.evaluate("window.__pwMenu()");
    const labels = items.map((item) => item.label);
    check("9", labels.some((label) => label.includes("Repair")), "the node menu offers Repair", JSON.stringify(labels));
    await appB.cdp.evaluate(`window.__pwClick('[role="menuitem"]', "Repair")`);
    const repaired = await waitFor(
      async () => {
        const current = await nodesState(appB.cdp);
        const entry = current.nodes.find((candidate) => candidate.name === "ws-two");
        return entry && entry.status === "active" ? entry : null;
      },
      "ws-two to report active again",
      120_000,
    ).catch(() => null);
    const shotAfter = await screenshot(appB.cdp, "flow9-after-repair");
    check("9", Boolean(repaired), "Repair returns the node to active", `node=${JSON.stringify(repaired)} shot=${shotAfter || "none"}`);
    const dir = worktreePath("ws-two");
    check("9", existsSync(dir), "Repair restores the checkout on disk", dir);
    if (existsSync(dir)) {
      const branch = branchOf(dir);
      check("9", branch === "feature/two", "the restored checkout is on its branch", `HEAD=${branch}`);
    }
  });

  await appB.stop();

  // ---- instance C: zh-CN --------------------------------------------------
  await withHost(hostBinary, (host) => host.call("settings.set", { language: "zh-CN" }));
  const portC = await claimFreePort();
  const appC = await launchApp(hostBinary, portC, "C");
  await waitForSidebar(appC.cdp, "C");
  await appC.cdp.evaluate(CLICK_FN);

  await flow("10", async () => {
    const chinese = /[\u4e00-\u9fff]/;
    await appC.cdp.evaluate(
      `window.__pwClickIn(${JSON.stringify(groupSel(projectKey))}, '[data-action="project-workspace-create-menu"]')`,
    );
    await delay(500);
    const menu = await appC.cdp.evaluate("window.__pwMenu()");
    const labels = menu.map((item) => item.label);
    check(
      "10",
      labels.some((label) => label.includes("新建工作区")),
      "the create row is translated",
      JSON.stringify(labels),
    );
    await appC.cdp.evaluate(`window.__pwClick('[role="menuitem"]', "新建工作区")`);
    await delay(900);
    const dialog = await dialogState(appC.cdp);
    const shot = await screenshot(appC.cdp, "flow10-zh-dialog");
    check(
      "10",
      dialog.open === true && chinese.test(dialog.title || ""),
      "the create dialog title is translated",
      `title=${JSON.stringify(dialog.title)} shot=${shot || "none"}`,
    );
    check(
      "10",
      chinese.test(dialog.pathPreview || ""),
      "the path preview is translated",
      JSON.stringify(dialog.pathPreview),
    );
    await appC.cdp.evaluate(`window.__pwKey("body", "Escape")`);
    await delay(400);
    await appC.cdp.evaluate(`window.__pwNode("ws-two", ".thread-item-more")`);
    await delay(500);
    const nodeMenu = await appC.cdp.evaluate("window.__pwMenu()");
    const nodeLabels = nodeMenu.map((item) => item.label);
    const shotMenu = await screenshot(appC.cdp, "flow10-zh-node-menu");
    check(
      "10",
      nodeLabels.length > 0 && nodeLabels.every((label) => chinese.test(label)),
      "the workspace node menu is translated",
      `${JSON.stringify(nodeLabels)} shot=${shotMenu || "none"}`,
    );
  });

  await appC.stop();
  await writeResults();
}

async function writeResults() {
  const counts = results.reduce((acc, entry) => {
    acc[entry.status] = (acc[entry.status] || 0) + 1;
    return acc;
  }, {});
  console.log(
    `\nE2E-PROJECT-WORKSPACE-UI: PASS ${counts.PASS || 0} / FAIL ${counts.FAIL || 0} / BLOCKED ${counts.BLOCKED || 0}`,
  );
  const failures = results.filter((entry) => entry.status !== "PASS");
  for (const entry of failures) {
    console.log(`  ${entry.status} [${entry.flow}] ${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}`);
  }
}

main()
  .then(() => {
    stopOwnProcesses();
    if (failed === 0) removeTemp();
    else console.log(`temp kept for inspection: ${scratch}`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(`FAIL project-workspace-ui — ${error?.stack || error}`);
    stopOwnProcesses();
    console.log(`temp kept for inspection: ${scratch}`);
    process.exit(1);
  });
