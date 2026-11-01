import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/* A Team user toggles one row, bulk-switches the roster, opens member settings,
   closes it with Escape, and jumps to role management in Settings. */
const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const PROBE = "TEAM_ROSTER_PICKER_PROBE ";

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-harbor/i18n";
import { IPC } from "@pi-harbor/shared";
import { TaskDock } from "../../apps/desktop/src/components/TaskDock";
import { SlotSessionProvider } from "../../apps/desktop/src/plugins/renderer-slots/use-slots";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { teamStore } from "../../apps/desktop/src/features/team/team-store";
import "../../apps/desktop/src/styles/tokens.css";
import "../../apps/desktop/src/styles/ui-kit.css";
import "../../apps/desktop/src/styles/settings.css";
import "../../apps/desktop/src/styles/composer.css";
import "../../apps/desktop/src/styles/messages.css";

const errors = [];
const reportError = console.error.bind(console);
console.error = (...args) => {
  errors.push(args.map((item) => (item && item.stack) || String(item)).join(" "));
  reportError(...args);
};
window.addEventListener("error", (event) => errors.push("error: " + ((event.error && event.error.stack) || event.message)));
window.addEventListener("unhandledrejection", (event) =>
  errors.push("rejection: " + ((event.reason && event.reason.stack) || String(event.reason))));

const calls = [];
const listeners = new Map();
const role = (name, enabled, tools) => ({
  name,
  description: name + " role",
  tools: tools || ["Read"],
  prompt: "Work as " + name + ".",
  source: "builtin",
  permission: "ask",
  enabled,
});
const builtins = [role("explorer", true), role("reviewer", true, ["Read", "Write"]), role("archived", false)];
let hostConfig = { sessionId: "s1", enabled: true, members: [{ agent: "explorer" }], revision: 3 };
const handlers = {
  [IPC.invoke.backgroundTasksList]: () => ({ tasks: [], version: 0 }),
  [IPC.invoke.todosGet]: (request) => ({ sessionId: request.sessionId, todos: [], revision: 0, updatedAt: 0 }),
  [IPC.invoke.sessionTeamGet]: () => hostConfig,
  [IPC.invoke.sessionTeamUpdate]: (update) => {
    if (update.expectedRevision !== hostConfig.revision) {
      throw Object.assign(new Error("stale team revision"), { code: "SESSION_TEAM_REVISION_CONFLICT" });
    }
    const change = Object.assign({}, update);
    delete change.expectedRevision;
    hostConfig = Object.assign({}, hostConfig, change, { revision: hostConfig.revision + 1 });
    return hostConfig;
  },
  [IPC.invoke.subagentList]: () => ({ subagents: [] }),
  [IPC.invoke.subagentCatalog]: () => ({ subagents: builtins, builtins, diagnostics: [], projectPath: null }),
};
window.piDesktop = {
  platform: "darwin",
  on(channel, callback) {
    const set = listeners.get(channel) || new Set();
    set.add(callback);
    listeners.set(channel, set);
    return () => set.delete(callback);
  },
  async invoke(channel, ...args) {
    calls.push({ channel, args });
    const handler = handlers[channel];
    if (!handler) return { ok: false, error: { code: "UNSTUBBED", message: "Unstubbed IPC " + channel } };
    try {
      return { ok: true, data: await handler(...args) };
    } catch (error) {
      return { ok: false, error: { code: error.code || "HOST_ERROR", message: error.message || String(error) } };
    }
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(label, predicate, timeout) {
  const deadline = Date.now() + (timeout || 5000);
  let last;
  while (Date.now() < deadline) {
    try {
      last = predicate();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(16);
  }
  throw new Error("timed out: " + label + (last instanceof Error ? " (" + last.message + ")" : ""));
}
function check(condition, message, detail) {
  if (!condition) throw new Error(message + (detail === undefined ? "" : " " + JSON.stringify(detail)));
}
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const dock = () => document.querySelector(".dock");
const membersButton = () => document.querySelector(".team-roster-picker-trigger");
const popover = () => document.querySelector(".team-roster-picker-menu");
const rows = () => [...document.querySelectorAll(".team-roster-picker-list > li")];
const row = (name) => rows().find((item) => item.querySelector(".team-member-name").textContent === name);
const memberSwitch = (name) => row(name).querySelector('[role="switch"]');
const writes = () => calls.filter((call) => call.channel === IPC.invoke.sessionTeamUpdate);
const button = (label) => [...popover().querySelectorAll("button")].find((item) => item.textContent.trim() === label);
const sheet = () => document.querySelector(".team-member-overlay");

function Surface() {
  return React.createElement(SlotSessionProvider, { sessionId: "s1", value: "s1" },
    React.createElement("div", { style: { width: "760px" } }, React.createElement(TaskDock, { sessionId: "s1" })));
}

window.teamRosterPickerProbe = async () => {
  const metrics = {};
  try {
    await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
      resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
    const quiet = document.createElement("style");
    quiet.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
    document.head.appendChild(quiet);
    useAppStore.setState({
      activeSessionId: "s1",
      sessions: [{ id: "s1", source: "local", title: "Team session" }],
      messages: [],
      runningSessions: {},
      sessionTodos: {},
      settingsTab: "general",
    });
    teamStore.setState({ sessions: { s1: {
      config: hostConfig, loading: false, saving: false, error: null, errorCode: null,
    } } });
    const rootNode = createRoot(document.getElementById("root"));
    flushSync(() => rootNode.render(React.createElement(Surface)));
    await waitFor("the Team dock", () => dock());
    if (!membersButton()) dock().querySelector(".dock-header-main").click();
    await waitFor("the loaded Members button", () => membersButton()
      && membersButton().textContent.indexOf("Members 1/2") >= 0);
    check(!calls.some((call) => call.channel === IPC.invoke.sessionTeamGet),
      "the picker loaded Team config instead of using the composer's owner");

    membersButton().click();
    await waitFor("the open roster", () => popover() && popover().classList.contains("is-open") && rows().length === 3);
    check(popover().getAttribute("role") === "dialog", "the roster is not a dialog");
    check(memberSwitch("archived").disabled, "a Settings-disabled role can be toggled");
    check(row("archived").textContent.indexOf("Disabled in Settings") >= 0, "the disabled explanation is missing");

    // A press on the row's content hits the full-row switch, not the pencil.
    const bounds = row("reviewer").getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.left + 32, bounds.top + bounds.height / 2);
    check(hit && hit.getAttribute("role") === "switch", "the row content is not covered by its switch",
      hit && hit.outerHTML);
    hit.click();
    await waitFor("the single-member write", () => writes().length === 1);
    check(same(writes()[0].args[0], { sessionId: "s1", expectedRevision: 3,
      members: [{ agent: "explorer" }, { agent: "reviewer" }] }), "single-row write", writes()[0].args);
    await waitFor("two enabled members", () => membersButton().textContent.indexOf("Members 2/2") >= 0);
    check(memberSwitch("reviewer").getAttribute("aria-checked") === "true", "the row did not become checked");
    const rowFill = getComputedStyle(memberSwitch("reviewer")).backgroundColor;
    check(rowFill === "rgba(0, 0, 0, 0)" || rowFill === "transparent",
      "the on switch paints its track across the whole row", rowFill);

    button("Disable all").click();
    await waitFor("one disable-all write", () => writes().length === 2);
    check(same(writes()[1].args[0], { sessionId: "s1", expectedRevision: 4, members: [] }),
      "disable-all wrote more than one request or the wrong roster", writes().map((call) => call.args));
    await waitFor("all eligible members off", () => membersButton().textContent.indexOf("Members 0/2") >= 0);
    check(button("Disable all").disabled, "disable-all stayed armed for a no-op");

    button("Enable all").click();
    await waitFor("one enable-all write", () => writes().length === 3);
    check(same(writes()[2].args[0], { sessionId: "s1", expectedRevision: 5,
      members: [{ agent: "explorer" }, { agent: "reviewer" }] }),
      "enable-all wrote more than one request or included a Settings-disabled role", writes().map((call) => call.args));
    await waitFor("all eligible members on", () => membersButton().textContent.indexOf("Members 2/2") >= 0);

    row("explorer").querySelector(".team-member-edit").click();
    const overlay = await waitFor("the portaled member sheet", () => sheet());
    check(!popover(), "the roster stayed open behind the member sheet");
    check(overlay.parentElement === document.body, "the sheet is trapped inside the dock");
    await waitFor("focus inside the sheet", () => overlay.contains(document.activeElement));
    check(writes().length === 3, "opening the sheet wrote the roster");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await waitFor("Escape closes the sheet", () => !sheet());
    await waitFor("focus returns to Members", () => document.activeElement === membersButton());
    check(!popover(), "Escape reopened the roster");

    membersButton().click();
    await waitFor("the roster reopens", () => popover() && popover().classList.contains("is-open"));
    button("Manage roles in Settings").click();
    await waitFor("the Subagents settings tab", () => useAppStore.getState().settingsTab === "subagents");
    check(!popover(), "role management left the roster open");
    check(writes().length === 3, "role management wrote the roster");
    Object.assign(metrics, { writes: writes().map((call) => call.args[0]), focusRestored: true });
    return { passed: true, errors, metrics };
  } catch (error) {
    return { passed: false, error: String((error && error.stack) || error), errors, metrics,
      writes: writes().map((call) => call.args[0]),
      html: document.body.innerHTML.slice(0, 5000) };
  }
};
`;

const main = [
  'const { app, BrowserWindow } = require("electron");',
  'const path = require("node:path");',
  'app.setPath("userData", path.join(__dirname, "profile"));',
  "app.whenReady().then(async () => {",
  "  const win = new BrowserWindow({ show: false, width: 1200, height: 900,",
  "    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });",
  "  try {",
  '    await win.loadFile(path.join(__dirname, "index.html"));',
  '    const result = await win.webContents.executeJavaScript("new Promise((resolve) => { const tick = () => window.teamRosterPickerProbe ? resolve(window.teamRosterPickerProbe()) : setTimeout(tick, 20); tick(); })");',
  `    console.log(${JSON.stringify(PROBE)} + JSON.stringify(result));`,
  "    app.exit(0);",
  "  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }",
  "});",
].join("\n");

test("a Team user selects members in the composer dock and manages their settings", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-team-roster-picker-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      loader: { ".woff2": "file", ".woff": "file", ".ttf": "file", ".svg": "file", ".png": "file" },
      logLevel: "error",
      alias: {
        "@pi-harbor/i18n": join(root, "packages/i18n/src"),
        "@pi-harbor/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), main);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    const line = output.split(/\r?\n/).find((item) => item.startsWith(PROBE));
    assert.ok(line, output.slice(-6000));
    assert.equal(code, 0, output.slice(-6000));
    const result = JSON.parse(line.slice(PROBE.length));
    t.diagnostic(`roster writes ${JSON.stringify(result.metrics)}`);
    assert.equal(result.passed, true, JSON.stringify(result, null, 2).slice(0, 9000));
    assert.deepEqual(result.errors, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
