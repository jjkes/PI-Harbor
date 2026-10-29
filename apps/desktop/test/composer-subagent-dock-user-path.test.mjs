import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * The composer dock's subagent side, driven the way a user meets it: the dock
 * appears collapsed when the first delegate starts, opens onto the session's
 * graph, opens a delegate's work-panel tab, stops one delegate and then all of
 * them, follows a resumed delegate, narrows with the composer, and turns to the
 * graph when a delegate starts while it is collapsed but only raises a count or
 * a badge while another side is open. The transcript renders beside it from the
 * same store, so both copies of a node are checked against each other.
 */

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const PROBE = "SUBAGENT_DOCK_PROBE ";

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-harbor/i18n";
import { IPC } from "@pi-harbor/shared";
import { TaskDock } from "../../apps/desktop/src/components/TaskDock";
import { TranscriptHistory } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { SlotSessionProvider } from "../../apps/desktop/src/plugins/renderer-slots/use-slots";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { collectLiveDelegationEntries } from "../../apps/desktop/src/lib/live-delegation-entries";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import "../../apps/desktop/src/styles/tokens.css";
import "../../apps/desktop/src/styles/ui-kit.css";
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
let backgroundTasks = [];
let stopRelease = () => {};
const handlers = {
  [IPC.invoke.backgroundTasksList]: () => ({ tasks: backgroundTasks, version: calls.length }),
  [IPC.invoke.todosGet]: (request) => ({ sessionId: request.sessionId, todos: [], revision: 0, updatedAt: 0 }),
  [IPC.invoke.agentStopSubagents]: () => new Promise((resolve) => { stopRelease = resolve; }),
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

let clock = Date.parse("2026-10-29T08:00:00.000Z");
const at = () => new Date(clock += 1000).toISOString();
const user = (id, content) => ({ id, role: "user", content, createdAt: at() });
const reply = (id, content) => ({ id, role: "assistant", content, createdAt: at() });
const childRow = (id, parentToolCallId, content) => ({ id, role: "assistant", content, parentToolCallId, createdAt: at() });
function task(id, agent, options) {
  const settings = options || {};
  const args = { agent, description: "Work for " + agent, prompt: "Do the " + agent + " work." };
  if (settings.resume) args.resume = settings.resume;
  const message = { id, role: "tool", toolName: "Task", toolCallId: "call-" + id, toolArgs: args,
    toolStatus: settings.delegationId ? "success" : "running", content: "", createdAt: at() };
  if (settings.delegationId) {
    message.toolResult = { content: [{ type: "text", text: "Started " + agent + "." }],
      details: { delegationId: settings.delegationId, status: "running", startedAt: clock } };
  }
  return message;
}
function settle(message, status, delegationId) {
  const previous = (message.toolResult && message.toolResult.details) || {};
  return Object.assign({}, message, { toolStatus: "success", toolResult: {
    content: [{ type: "text", text: "Delegate " + status + "." }],
    details: Object.assign({ startedAt: clock }, previous,
      { delegationId: delegationId || previous.delegationId, status, completedAt: clock += 1000 }),
  } });
}
const setMessages = (update) => flushSync(() => useAppStore.setState((state) => ({ messages: update(state.messages) })));
const replaceMessage = (id, update) =>
  setMessages((messages) => messages.map((message) => (message.id === id ? update(message) : message)));

function Surface() {
  const messages = useAppStore((state) => state.messages);
  const running = useAppStore((state) => state.runningSessions.s1 === true);
  const entries = React.useMemo(() => buildTranscriptEntries(messages).entries, [messages]);
  const liveDelegations = React.useMemo(
    () => collectLiveDelegationEntries(entries.slice(0, -1), entries[entries.length - 1], running),
    [entries, running],
  );
  return React.createElement(SlotSessionProvider, { sessionId: "s1", value: "s1" },
    React.createElement("div", { id: "transcript" },
      React.createElement(TranscriptHistory, { entries, isRunning: running, liveDelegations })),
    React.createElement("div", { id: "dock-host", style: { width: "760px" } },
      React.createElement(TaskDock, { sessionId: "s1" })));
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
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const host = () => document.getElementById("dock-host");
const dock = () => document.querySelector("#dock-host .dock");
const transcript = () => document.getElementById("transcript");
const dockNodes = () => (dock() ? [...dock().querySelectorAll(".subagent-topology-node")] : []);
const nameOf = (node) => (node.querySelector(".subagent-topology-node-title") || {}).textContent || "";
const outcomeOf = (node) => {
  const classes = [...node.classList].filter((name) => name.indexOf("outcome-") === 0);
  return classes.indexOf("outcome-creating") >= 0 ? "creating" : (classes[0] || "").slice(8);
};
const dockGraph = () => dockNodes().map((node) => nameOf(node) + ":" + outcomeOf(node));
const dockNode = (name) => dockNodes().find((node) => nameOf(node) === name);
const transcriptNode = (id) => transcript().querySelector('.subagent-topology-node[data-message-id="' + id + '"]');
const headerText = () => (dock().querySelector(".dock-header-text") || {}).textContent;
const headerLive = () => {
  const live = dock().querySelector(".dock-header-main .dock-live");
  return live ? live.textContent.trim() : "";
};
const expanded = () => dock().classList.contains("is-expanded");
const header = () => dock().querySelector(".dock-header-main");
const tabs = () => [...dock().querySelectorAll('[role="tab"]')];
const tab = (label) => tabs().find((item) => item.textContent.indexOf(label) === 0);
const panelOf = (item) => document.getElementById(item.getAttribute("aria-controls"));
const stopCalls = () => calls.filter((call) => call.channel === IPC.invoke.agentStopSubagents);
const columns = () =>
  getComputedStyle(dock().querySelector(".subagent-topology")).gridTemplateColumns.trim().split(/\s+/).length;
const measure = () => {
  const panel = dock().querySelector(".subagent-dock-panel");
  const graph = dock().querySelector(".subagent-topology");
  return { width: panel.clientWidth, panelHeight: panel.clientHeight, contentHeight: panel.scrollHeight,
    graphHeight: Math.round(graph.getBoundingClientRect().height),
    nodeHeights: dockNodes().map((node) => Math.round(node.getBoundingClientRect().height)), columns: columns() };
};
const fit = () => {
  const list = dock().querySelector(".dock-tablist");
  const row = dock().querySelector(".dock-header");
  return { tabs: [list.scrollWidth, list.clientWidth], header: [row.scrollWidth, row.clientWidth] };
};
function parity(required) {
  let compared = 0;
  for (const node of dockNodes()) {
    const id = node.getAttribute("data-message-id");
    const twin = transcriptNode(id);
    if (!twin) {
      check(required.indexOf(id) < 0, "the transcript does not draw " + id,
        [...transcript().querySelectorAll(".subagent-topology-node")].map((item) => item.getAttribute("data-message-id")));
      continue;
    }
    check(outcomeOf(twin) === outcomeOf(node), "the dock and the transcript disagree about " + id,
      [outcomeOf(node), outcomeOf(twin)]);
    compared += 1;
  }
  return compared;
}

window.subagentDockProbe = async () => {
  const metrics = {};
  const parityCounts = [];
  try {
    await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
      resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
    const quiet = document.createElement("style");
    quiet.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
    document.head.appendChild(quiet);
    useAppStore.setState({ activeSessionId: "s1", messages: [], runningSessions: { s1: true }, sessionTodos: {} });
    const rootNode = createRoot(document.getElementById("root"));
    flushSync(() => rootNode.render(React.createElement(Surface)));

    // 1. Nothing to show yet: the dock takes no room before the first delegate.
    await waitFor("mount reads", () => calls.some((call) => call.channel === IPC.invoke.todosGet)
      && calls.some((call) => call.channel === IPC.invoke.backgroundTasksList));
    await sleep(50);
    check(!dock(), "the dock rendered before any delegate");

    // 2. The first delegates start: the dock appears collapsed with a summary.
    setMessages(() => [user("u1", "Map the repository."), reply("m1", "Delegating."),
      task("t1", "explorer", { delegationId: "d-1" }), childRow("c1", "call-t1", "Reading the repository."),
      task("t2", "reviewer")]);
    await waitFor("the dock appears", () => dock());
    check(!expanded(), "the dock opened on its own");
    check(headerText() === "2 subagents", "collapsed header", headerText());
    check(headerLive() === "2 running", "collapsed live count", headerLive());
    check(tabs().length === 0, "tabs for a single side", tabs().length);
    check(dockNodes().length === 0, "the graph is mounted while collapsed", dockNodes().length);

    // 3. Opening the dock shows the graph; the transcript keeps the announcements.
    header().click();
    await waitFor("the graph opens", () => dockNodes().length === 2);
    check(same(dockGraph(), ["explorer:running", "reviewer:creating"]), "first graph", dockGraph());
    check(dock().querySelectorAll("[aria-live]").length === 0, "the dock announces node status");
    check(transcript().querySelectorAll('.subagent-topology-node [aria-live="polite"]').length >= 2,
      "the transcript stopped announcing node status");
    const dockRoot = dock().querySelector(".subagent-topology-root-copy > span").textContent;
    const cardRoots = transcript().querySelectorAll(".subagent-topology-root-copy > span");
    check(cardRoots.length >= 1 && cardRoots[cardRoots.length - 1].textContent === dockRoot, "root summary",
      [dockRoot, cardRoots.length]);
    check(dock().querySelector(".subagent-dock-toolbar .subagent-stop-button"), "no stop-all control while running");
    parityCounts.push(parity(["t1", "t2"]));

    // 4. A node opens its delegate's work-panel tab, and both copies follow it.
    dockNode("explorer").querySelector(".subagent-topology-node-header").click();
    await waitFor("the work-panel tab opens", () => {
      const state = useAppStore.getState();
      return state.workPanelOpen && String(state.activeWorkPanelTabId || "").indexOf("subagent:") === 0;
    });
    await waitFor("both headers expanded", () =>
      dockNode("explorer").querySelector(".subagent-topology-node-header").getAttribute("aria-expanded") === "true"
      && transcriptNode("t1").querySelector(".subagent-topology-node-header").getAttribute("aria-expanded") === "true");

    // 5. Stopping one delegate from the dock: one request, both copies stopping.
    dockNode("explorer").querySelector(".subagent-stop-button").click();
    await waitFor("the stop request", () => stopCalls().length === 1);
    check(same(stopCalls()[0].args[0], { sessionId: "s1", delegationIds: ["d-1"] }), "stop payload", stopCalls()[0].args);
    const stopping = () => dockNode("explorer").querySelector(".subagent-stop-button").disabled
      && transcriptNode("t1").querySelector(".subagent-stop-button").disabled;
    await waitFor("both copies stopping", stopping);
    stopRelease({ pending: ["d-1"] });
    await sleep(50);
    check(stopping(), "a pending stop released its controls early");
    replaceMessage("t1", (message) => settle(message, "stopped"));
    await waitFor("the delegate settles", () => same(dockGraph(), ["reviewer:creating", "explorer:stopped"]));
    check(!dockNode("explorer").querySelector(".subagent-stop-button"), "a stopped node keeps its stop control");
    check(headerLive() === "1 running", "live count after one stop", headerLive());

    // 6. Stop all: one request for the session, then the idle toolbar is gone.
    dock().querySelector(".subagent-dock-toolbar .subagent-stop-button").click();
    await waitFor("the stop-all request", () => stopCalls().length === 2);
    check(same(stopCalls()[1].args[0], { sessionId: "s1" }), "stop-all payload", stopCalls()[1].args);
    stopRelease({ pending: [] });
    replaceMessage("t2", (message) => settle(message, "stopped", "d-2"));
    await waitFor("everything settles", () => same(dockGraph(), ["explorer:stopped", "reviewer:stopped"]));
    check(getComputedStyle(dock().querySelector(".subagent-dock-toolbar")).display === "none",
      "the idle toolbar still takes room");
    check(headerLive() === "", "idle live count", headerLive());

    // 7. A second turn resumes the explorer: one node per delegate, newest first.
    setMessages((messages) => messages.concat([user("u2", "Continue."), reply("m2", "Resuming."),
      task("t3", "explorer", { delegationId: "d-3", resume: "d-1" }),
      settle(task("t4", "scout", { delegationId: "d-4" }), "completed")]));
    await waitFor("the merged graph", () => same(dockGraph(), ["explorer:running", "scout:completed", "reviewer:stopped"]));
    check(!dockNodes().some((node) => node.getAttribute("data-message-id") === "t1"), "the resumed delegate is drawn twice");
    check(headerText() === "3 subagents" && headerLive() === "1 running", "merged header", [headerText(), headerLive()]);
    parityCounts.push(parity(["t3", "t4"]));

    // 8. The composer narrows: the graph stacks, as the transcript card does.
    metrics.wide = measure();
    check(metrics.wide.columns === 3, "a wide composer lost the three-column graph", metrics.wide);
    host().style.width = "420px";
    await waitFor("the graph stacks", () => columns() === 1);
    metrics.narrow = measure();
    host().style.width = "760px";
    await waitFor("the graph widens again", () => columns() === 3);

    // 9. Collapsing unmounts the graph, so a closed dock runs no node clocks.
    header().click();
    await waitFor("collapsed", () => !expanded());
    check(dockNodes().length === 0, "a collapsed dock keeps the graph mounted", dockNodes().length);

    // 10. Three sides: each tab shows its own panel and hides the others.
    flushSync(() => useAppStore.setState((state) => ({ sessionTodos: Object.assign({}, state.sessionTodos, {
      s1: { sessionId: "s1", todos: [{ content: "Wire the dock", status: "in_progress" },
        { content: "Write the docs", status: "pending" }], revision: 5, updatedAt: clock },
    }) })));
    backgroundTasks = [{ id: "bg-1", sessionId: "s1", command: "pnpm test", commandShellId: "bash",
      state: "running", elapsedMs: 1000 }];
    emit(IPC.event.backgroundTasksChanged, { version: 2 });
    await waitFor("three tabs", () => tabs().length === 3);
    check(same(tabs().map((item) => item.textContent.replace(/[0-9]+$/, "")), ["Todo", "Background tasks", "Subagents"]),
      "tab labels", tabs().map((item) => item.textContent));
    check(dock().querySelector(".dock-header-current"), "the header stopped following the checklist");
    check(tab("Subagents").getAttribute("aria-selected") === "true", "the collapsed dock lost its subagent tab",
      tabs().map((item) => item.getAttribute("aria-selected")));
    metrics.tabsWide = fit();
    host().style.width = "420px";
    await sleep(50);
    metrics.tabsNarrow = fit();
    host().style.width = "760px";
    await sleep(50);
    tab("Todo").click();
    await waitFor("the todo tab", () => expanded() && tab("Todo").getAttribute("aria-selected") === "true");
    check(!panelOf(tab("Todo")).hidden && panelOf(tab("Background tasks")).hidden && panelOf(tab("Subagents")).hidden,
      "the checklist shares the dock with another panel",
      [panelOf(tab("Todo")).hidden, panelOf(tab("Background tasks")).hidden, panelOf(tab("Subagents")).hidden]);
    check(dockNodes().length === 0, "the graph is mounted behind the checklist");
    tab("Background tasks").click();
    await waitFor("the tasks tab", () => tab("Background tasks").getAttribute("aria-selected") === "true");
    check(panelOf(tab("Todo")).hidden && !panelOf(tab("Background tasks")).hidden && panelOf(tab("Subagents")).hidden,
      "the task list shares the dock with another panel");
    tab("Todo").click();
    await waitFor("the todo tab again", () => tab("Todo").getAttribute("aria-selected") === "true");
    header().click();
    await waitFor("collapsed again", () => !expanded());

    // 11. A delegate starts while collapsed: opening the dock shows the graph.
    setMessages((messages) => messages.concat([task("t5", "tester", { delegationId: "d-5" })]));
    await waitFor("the subagent tab is chosen", () => tab("Subagents").getAttribute("aria-selected") === "true");
    check(!expanded(), "a new delegate opened the dock");
    check(dock().querySelector(".dock-header-current"), "the header left the checklist");
    check((tab("Subagents").querySelector(".dock-live") || {}).textContent === "2", "tab live count",
      tab("Subagents").textContent);
    header().click();
    await waitFor("the graph is what opens", () => expanded()
      && same(dockGraph(), ["explorer:running", "tester:running", "scout:completed", "reviewer:stopped"]));
    check(panelOf(tab("Todo")).hidden && panelOf(tab("Background tasks")).hidden, "another panel beside the graph");

    // 12. A delegate starts while another side is open: only a count, then a badge.
    tab("Todo").click();
    await waitFor("the todo tab once more", () => tab("Todo").getAttribute("aria-selected") === "true");
    replaceMessage("t3", (message) => settle(message, "completed"));
    replaceMessage("t5", (message) => settle(message, "completed"));
    await waitFor("the tab goes idle", () => !tab("Subagents").querySelector(".dock-live"));
    setMessages((messages) => messages.concat([task("t6", "auditor", { delegationId: "d-6" })]));
    await waitFor("a live count on the tab", () => (tab("Subagents").querySelector(".dock-live") || {}).textContent === "1");
    check(tab("Todo").getAttribute("aria-selected") === "true", "a delegate took over the open dock",
      tabs().map((item) => item.getAttribute("aria-selected")));
    check(panelOf(tab("Subagents")).hidden, "the graph covered the checklist");
    replaceMessage("t6", (message) => settle(message, "completed"));
    const badge = await waitFor("the badge", () => tab("Subagents").querySelector(".dock-tab-badge"));
    check(badge.textContent === "1" && badge.getAttribute("aria-label") === "1 new subagents", "badge",
      [badge.textContent, badge.getAttribute("aria-label")]);
    tab("Subagents").click();
    await waitFor("the badge clears", () => tab("Subagents").getAttribute("aria-selected") === "true"
      && !tab("Subagents").querySelector(".dock-tab-badge"));
    await waitFor("the final graph", () => same(dockGraph(),
      ["explorer:completed", "scout:completed", "tester:completed", "auditor:completed", "reviewer:stopped"]));
    parityCounts.push(parity(["t3", "t4", "t5", "t6"]));

    // 13. A search result opens on an early message while a delegate runs: the
    // graph keeps reading the live session, so the running delegate stays.
    const firstUser = useAppStore.getState().messages.find((message) => message.role === "user");
    flushSync(() => useAppStore.setState({ transcriptViews: { s1: { messages: [firstUser], messageStart: 0,
      hasMoreBefore: false, hasMoreAfter: true, focus: { messageId: firstUser.id, query: "map" }, loading: null } } }));
    setMessages((messages) => messages.concat([task("t7", "watcher", { delegationId: "d-7" })]));
    const reading = ["watcher:running", "explorer:completed", "scout:completed", "tester:completed",
      "auditor:completed", "reviewer:stopped"];
    await waitFor("the running delegate while reading history", () => same(dockGraph(), reading));
    check((tab("Subagents").querySelector(".dock-live") || {}).textContent === "1",
      "tab live count while reading history", tab("Subagents").textContent);
    flushSync(() => useAppStore.setState({ transcriptViews: {} }));
    await sleep(50);
    check(same(dockGraph(), reading), "the graph changed when reading returned to the live tail", dockGraph());

    const status = transcript().querySelector('.subagent-topology-node [role="status"]');
    metrics.transcriptStatusWidth = status ? Math.round(status.getBoundingClientRect().width) : null;
    return { passed: true, errors, metrics, parity: parityCounts, channels: [...new Set(calls.map((call) => call.channel))] };
  } catch (error) {
    const element = document.querySelector("#dock-host .dock");
    return { passed: false, error: String((error && error.stack) || error), errors, metrics, parity: parityCounts,
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
  '    const result = await win.webContents.executeJavaScript("new Promise((resolve) => { const tick = () => window.subagentDockProbe ? resolve(window.subagentDockProbe()) : setTimeout(tick, 20); tick(); })");',
  `    console.log(${JSON.stringify(PROBE)} + JSON.stringify(result));`,
  "    app.exit(0);",
  "  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }",
  "});",
].join("\n");

test("the composer dock shows the session's subagents as one graph a user can open, inspect and stop", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-subagent-dock-"));
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
    assert.ok(result.parity.every((count) => count > 0), `parity compared no nodes: ${JSON.stringify(result.parity)}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
