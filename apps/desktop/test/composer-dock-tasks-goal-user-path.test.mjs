import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * The composer dock's background-task side and its Goal line, driven the way
 * a user meets them. The task side lists only rows the user can act on, so
 * registry history, a row whose post-exit grace window closed and a removed
 * row leave no tab, header count, badge or empty container behind. An
 * approved Goal stays named above the header while it is queued or running,
 * collapsed or not, opens its contract, and leaves when the run ends; a Plan
 * execution never takes that line.
 */

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const PROBE = "DOCK_TASKS_GOAL_PROBE ";

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-harbor/i18n";
import { IPC } from "@pi-harbor/shared";
import { TaskDock } from "../../apps/desktop/src/components/TaskDock";
import { preferredFileWorkPanelTab } from "../../apps/desktop/src/lib/work-panel-tabs";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import "../../apps/desktop/src/styles/tokens.css";
import "../../apps/desktop/src/styles/ui-kit.css";
import "../../apps/desktop/src/styles/composer.css";

const errors = [];
const reportError = console.error.bind(console);
console.error = (...args) => {
  errors.push(args.map((item) => (item && item.stack) || String(item)).join(" "));
  reportError(...args);
};
window.addEventListener("error", (event) => errors.push("error: " + ((event.error && event.error.stack) || event.message)));
window.addEventListener("unhandledrejection", (event) =>
  errors.push("rejection: " + ((event.reason && event.reason.stack) || String(event.reason))));

// The grace window after a command exits reads Date.now(), so moving the clock
// forward closes it without a ten-second wait. Timers and React keep real time.
let skew = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + skew;

const calls = [];
const listeners = new Map();
let backgroundTasks = [];
const handlers = {
  [IPC.invoke.backgroundTasksList]: () => ({ tasks: backgroundTasks, version: calls.length }),
  [IPC.invoke.todosGet]: (request) => ({ sessionId: request.sessionId, todos: [], revision: 0, updatedAt: 0 }),
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
    return { ok: true, data: await handler(...args) };
  },
};
const emit = (channel, payload) => { for (const callback of listeners.get(channel) || []) callback(payload); };

let version = 1;
function setTasks(tasks) {
  backgroundTasks = tasks;
  version += 1;
  emit(IPC.event.backgroundTasksChanged, { version });
}
function command(id, state) {
  const task = { id, sessionId: "s1", command: "pnpm " + id, commandShellId: "bash", state, elapsedMs: 1000 };
  if (state !== "running") task.exitCode = 0;
  return task;
}
function setTodos(sessionId, todos) {
  flushSync(() => useAppStore.setState((state) => ({ sessionTodos: Object.assign({}, state.sessionTodos, {
    [sessionId]: { sessionId, todos, revision: 5, updatedAt: 1 },
  }) })));
}
function setCheckpoint(sessionId, proposal) {
  flushSync(() => useAppStore.setState((state) => ({ planCheckpoints: Object.assign({}, state.planCheckpoints, {
    [sessionId]: proposal,
  }) })));
}

// Mounted the way the composer mounts it: one instance that follows the
// active session instead of remounting per session.
function Surface() {
  const sessionId = useAppStore((state) => state.activeSessionId);
  return React.createElement("div", { id: "dock-host", style: { width: "760px" } },
    sessionId ? React.createElement(TaskDock, { sessionId }) : null);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(label, predicate, timeout) {
  const deadline = Date.now() + (timeout || 4000);
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
const host = () => document.getElementById("dock-host");
const dock = () => document.querySelector("#dock-host .dock");
const header = () => document.querySelector("#dock-host .dock-header");
const headerMain = () => document.querySelector("#dock-host .dock-header-main");
const headerText = () => (document.querySelector("#dock-host .dock-header-text") || {}).textContent;
const expanded = () => headerMain().getAttribute("aria-expanded") === "true";
const tabs = () => [...document.querySelectorAll('#dock-host [role="tab"]')];
const tasksTab = () => tabs().find((item) => item.textContent.indexOf(i18n.t("taskDock.tabTasks")) === 0);
const badge = () => {
  const node = tasksTab() && tasksTab().querySelector(".dock-tab-badge");
  return node ? node.textContent : null;
};
const taskRows = () => [...document.querySelectorAll("#dock-host .task-row")];
const todoList = () => document.querySelector("#dock-host .todo-dock-list");
const goalRow = () => document.querySelector("#dock-host .dock-goal");
const goalPart = (selector) => (goalRow().querySelector(selector) || {}).textContent;
const progress = (completed, total) => i18n.t("chat.todo.progress", { completed, total });

window.dockTasksGoalProbe = async () => {
  const metrics = {};
  try {
    await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
      resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
    const quiet = document.createElement("style");
    quiet.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
    document.head.appendChild(quiet);
    backgroundTasks = [command("old-build", "exited")];
    useAppStore.setState({ activeSessionId: "s1", messages: [], runningSessions: {}, sessionTodos: {}, planCheckpoints: {} });
    const rootNode = createRoot(document.getElementById("root"));
    flushSync(() => rootNode.render(React.createElement(Surface)));

    // 1. Registry history the dock never saw running is nothing to act on: no
    //    container, no header count, no empty panel.
    await waitFor("mount reads", () => calls.some((call) => call.channel === IPC.invoke.todosGet)
      && calls.some((call) => call.channel === IPC.invoke.backgroundTasksList));
    await sleep(50);
    check(!dock(), "registry history opened the dock", dock() && dock().outerHTML.slice(0, 600));

    // 2. A command starts: the dock counts the one row it lists, not the
    //    history beside it.
    setTasks([command("old-build", "exited"), command("dev", "running")]);
    await waitFor("a running row", () => taskRows().length === 1);
    check(headerText() === i18n.t("backgroundTasks.headerCount", { count: 1 }),
      "the header counts rows the panel does not list", headerText());
    check(document.querySelector("#dock-host .dock-header-main .dock-live"), "the header lost its live count");
    check(tabs().length === 0, "one side drew a tab list", tabs().length);
    check(!expanded(), "the dock opened itself");
    check(taskRows()[0].getAttribute("data-state") === "running", "the listed row is not the live command");

    // 3. The command exits: its row stays through the grace window so it can
    //    still be read or removed, and nothing claims to run.
    setTasks([command("old-build", "exited"), command("dev", "exited")]);
    await waitFor("an exited row", () => taskRows().length === 1
      && taskRows()[0].getAttribute("data-state") === "exited");
    check(headerText() === i18n.t("backgroundTasks.headerCount", { count: 1 }), "the exited row left the count", headerText());
    check(!document.querySelector("#dock-host .dock-live"), "an exited command still shows as running");

    // 4. The grace window closes: the last row leaves and takes the container
    //    with it.
    skew += 11000;
    setTasks(backgroundTasks.slice());
    await waitFor("the dock closed after the grace window", () => !dock());

    // 5. A checklist alone opens the dock again, still without tabs.
    setTodos("s1", [{ content: "Wire the dock", status: "in_progress" }, { content: "Write the docs", status: "pending" }]);
    await waitFor("the checklist header", () => headerText() === progress(0, 2));
    check(tabs().length === 0, "a lone checklist drew tabs", tabs().length);

    // 6. A command starts while the dock is collapsed: its tab appears with a
    //    badge for work the user has not looked at.
    setTasks([command("old-build", "exited"), command("dev", "exited"), command("test", "running")]);
    await waitFor("two tabs", () => tabs().length === 2 && tasksTab());
    check(badge() === "1", "the new command raised no badge", badge());

    // 7. That command exits and its grace window closes unseen: the tab and its
    //    badge leave with the row, and the checklist keeps the dock.
    setTasks([command("old-build", "exited"), command("dev", "exited"), command("test", "exited")]);
    await waitFor("the exited row", () => taskRows().some((row) => row.getAttribute("data-state") === "exited"));
    skew += 11000;
    setTasks(backgroundTasks.slice());
    await waitFor("the task tab left with its last row", () => tabs().length === 0);
    check(taskRows().length === 0, "rows outlived the grace window", taskRows().length);
    check(headerText() === progress(0, 2), "the header lost the checklist", headerText());

    // 8. The next command starts the badge over instead of carrying a row that
    //    already left.
    setTasks([command("old-build", "exited"), command("dev", "exited"), command("test", "exited"),
      command("lint", "running")]);
    await waitFor("the task tab returned", () => tabs().length === 2 && tasksTab());
    check(badge() === "1", "the badge kept a row that already left", badge());

    // 9. Entering the tab clears the badge; removing the last finished row
    //    hands the dock back to the checklist instead of an empty panel.
    tasksTab().click();
    await waitFor("the tasks tab opened", () => expanded() && tasksTab().getAttribute("aria-selected") === "true");
    check(badge() === null, "entering the tab kept its badge", badge());
    setTasks([command("old-build", "exited"), command("dev", "exited"), command("test", "exited"),
      command("lint", "exited")]);
    const dismiss = await waitFor("the remove control", () => {
      const row = taskRows().find((item) => item.getAttribute("data-state") === "exited");
      return row && row.querySelector("button.task-action");
    });
    dismiss.click();
    await waitFor("the task tab left with the removed row", () => tabs().length === 0);
    check(taskRows().length === 0, "the removed row is still listed", taskRows().length);
    check(todoList() && !todoList().closest(".dock-panel").hidden, "the checklist is not the panel on screen");

    // 10. Another session: nothing of the first one follows it.
    flushSync(() => useAppStore.setState({ activeSessionId: "s2" }));
    await waitFor("the second session's checklist read", () => calls.some((call) =>
      call.channel === IPC.invoke.todosGet && call.args[0] && call.args[0].sessionId === "s2"));
    await sleep(50);
    check(!dock(), "the first session's work followed the switch", dock() && dock().outerHTML.slice(0, 600));

    // 11. An approved Goal is queued: the dock names it on a line of its own,
    //     with no header to expand while nothing else is listed.
    const goal = { id: "goal-1", sessionId: "s2", turnId: "turn-1", toolCallId: "call-goal-1", kind: "goal",
      title: "Ship the composer dock goal row with live progress", markdown: "# Goal", question: "Approve?",
      artifact: { relativePath: ".pi/goal/ship-dock.md", sha256: "0".repeat(64), sizeBytes: 6 }, version: 1,
      status: "approved", createdAt: "2026-10-31T08:00:00.000Z", updatedAt: "2026-10-31T08:00:01.000Z",
      executionId: "exec-1", executionState: "queued" };
    setCheckpoint("s2", goal);
    await waitFor("the goal line", () => goalRow());
    check(goalRow().getAttribute("data-phase") === "queued", "the goal line lost its phase", goalRow().getAttribute("data-phase"));
    check(goalPart(".dock-goal-label") === i18n.t("taskDock.goal"), "the goal line is not labelled", goalRow().textContent);
    check(goalPart(".dock-goal-text") === goal.title, "the goal line does not name the goal", goalRow().textContent);
    check(goalPart(".dock-goal-state") === i18n.t("taskDock.goalQueued"), "the queued goal does not say so", goalRow().textContent);
    check(!goalRow().querySelector(".dock-live-dot"), "a queued goal shows as running");
    check(!header(), "a lone goal drew a header to expand");

    // 12. The run starts: the line says so, with the live dot.
    setCheckpoint("s2", Object.assign({}, goal, { executionState: "running" }));
    await waitFor("the running goal", () => goalRow() && goalRow().getAttribute("data-phase") === "running");
    check(goalPart(".dock-goal-state") === i18n.t("taskDock.goalRunning"), "the running goal does not say so", goalRow().textContent);
    check(goalRow().querySelector(".dock-live-dot"), "the running goal has no live dot");

    // 13. The agent writes its checklist: step progress joins under the goal,
    //     and collapsing the dock keeps the goal in view.
    setTodos("s2", [{ content: "Write the row", status: "completed" }, { content: "Wire the dock", status: "in_progress" },
      { content: "Document it", status: "pending" }]);
    await waitFor("the checklist under the goal", () => headerText() === progress(1, 3));
    check(dock().firstElementChild === goalRow(), "the goal is not the dock's first line");
    if (expanded()) headerMain().click();
    await waitFor("collapsed", () => !expanded());
    check(goalRow().getBoundingClientRect().height > 0, "the collapsed dock hid the goal");
    check(!goalRow().closest(".dock-content"), "the goal sits inside the disclosure");

    // 14. The composer narrows: the title ellipsizes and the phase stays on the line.
    host().style.width = "260px";
    const title = await waitFor("a narrow goal line", () => {
      const node = goalRow().querySelector(".dock-goal-text");
      return node && node.clientWidth > 0 && node.clientWidth < node.scrollWidth ? node : null;
    });
    const line = goalRow().getBoundingClientRect();
    const phase = goalRow().querySelector(".dock-goal-state").getBoundingClientRect();
    metrics.narrowGoal = { title: [title.scrollWidth, title.clientWidth], line: [goalRow().scrollWidth, goalRow().clientWidth] };
    check(phase.left >= line.left && phase.right <= line.right + 0.5, "the phase left the goal line",
      [phase.left, phase.right, line.left, line.right]);
    check(goalRow().scrollWidth <= goalRow().clientWidth, "the goal line overflows", metrics.narrowGoal);
    host().style.width = "760px";

    // 15. The title opens the approved contract in the work panel.
    const expected = preferredFileWorkPanelTab(goal.artifact.relativePath, useAppStore.getState().pluginViews).id;
    const open = goalRow().querySelector("button.dock-goal-title");
    check(open && open.getAttribute("title"), "the contract control does not say what it opens");
    open.click();
    await waitFor("the contract tab", () => {
      const state = useAppStore.getState();
      return state.workPanelOpen && state.activeWorkPanelTabId === expected;
    });

    // 16. The run ends: the goal leaves the dock and the checklist stays.
    setCheckpoint("s2", Object.assign({}, goal, { executionState: "completed" }));
    await waitFor("the goal left", () => !goalRow());
    check(headerText() === progress(1, 3), "the checklist left with the goal", headerText());

    // 17. A Plan execution never takes the goal line.
    setCheckpoint("s2", Object.assign({}, goal, { id: "goal-2", executionId: "exec-2", executionState: "running" }));
    await waitFor("the next goal", () => goalRow());
    setCheckpoint("s2", Object.assign({}, goal, { id: "plan-1", kind: "plan", executionId: "exec-3", executionState: "running" }));
    await waitFor("a running plan left the goal line", () => !goalRow());

    // 18. A goal without a title or contract file still names itself, with
    //     nothing to open.
    setCheckpoint("s2", Object.assign({}, goal, { id: "goal-3", title: "", artifact: undefined, executionId: "exec-4" }));
    await waitFor("the untitled goal", () => goalRow());
    check(goalPart(".dock-goal-text") === i18n.t("goal.untitled"), "the untitled goal has no name", goalRow().textContent);
    check(!goalRow().querySelector("button"), "a goal without a contract offers to open one");

    return { passed: true, errors, metrics, channels: [...new Set(calls.map((call) => call.channel))] };
  } catch (error) {
    const element = document.querySelector("#dock-host .dock");
    return { passed: false, error: String((error && error.stack) || error), errors, metrics,
      channels: [...new Set(calls.map((call) => call.channel))], dock: element ? element.outerHTML.slice(0, 4000) : null };
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
  '    const result = await win.webContents.executeJavaScript("new Promise((resolve) => { const tick = () => window.dockTasksGoalProbe ? resolve(window.dockTasksGoalProbe()) : setTimeout(tick, 20); tick(); })");',
  `    console.log(${JSON.stringify(PROBE)} + JSON.stringify(result));`,
  "    app.exit(0);",
  "  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }",
  "});",
].join("\n");

test("the composer dock lists only actionable background tasks and keeps a running goal in view", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-dock-tasks-goal-"));
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
    t.diagnostic(`dock metrics ${JSON.stringify(result.metrics)}`);
    assert.equal(result.passed, true, JSON.stringify(result, null, 2).slice(0, 8000));
    assert.deepEqual(result.errors, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
