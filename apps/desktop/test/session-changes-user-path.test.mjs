import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * The conversation's changed files, driven the way a user meets them: the
 * composer bar counts the files the session's Write/Edit evidence still
 * affects, opens onto one row per file in first-change order, and a row opens
 * that file's read-only diff in the work panel. The diff tab asks the host for
 * the file's whole snapshot chain, numbers the hunk against the baseline, and
 * says so when the file drifted, when nothing is left to review, and when the
 * host cannot answer. Only the IPC boundary is stubbed; the bar, the tab, the
 * store and the work-panel tab state are the production ones.
 */

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const PROBE = "SESSION_CHANGES_PROBE ";

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-harbor/i18n";
import { IPC } from "@pi-harbor/shared";
import { SessionChangesBar } from "../../apps/desktop/src/features/chat/session-changes/SessionChangesBar";
import { FileDiffTab } from "../../apps/desktop/src/components/workpanel/FileDiffTab";
import { sessionAllows } from "../../apps/desktop/src/lib/remote-session-safety";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import "../../apps/desktop/src/styles/tokens.css";
import "../../apps/desktop/src/styles/ui-kit.css";
import "../../apps/desktop/src/styles/composer.css";
import "../../apps/desktop/src/styles/work-panel.css";
import "../../apps/desktop/src/styles/session-changes.css";

const errors = [];
const reportError = console.error.bind(console);
console.error = (...args) => {
  errors.push(args.map((item) => (item && item.stack) || String(item)).join(" "));
  reportError(...args);
};
window.addEventListener("error", (event) => errors.push("error: " + ((event.error && event.error.stack) || event.message)));
window.addEventListener("unhandledrejection", (event) =>
  errors.push("rejection: " + ((event.reason && event.reason.stack) || String(event.reason))));

const HUNK = { header: "@@ -1,3 +1,3 @@", lines: [
  { type: "context", text: "one" }, { type: "del", text: "two" },
  { type: "add", text: "2" }, { type: "context", text: "three" }] };
const modifiedDiff = (overrides) => Object.assign({ status: "modified", additions: 1, deletions: 1,
  hunks: [HUNK], binary: false, truncated: false, drifted: false }, overrides || {});

// Only the preload bridge is stubbed: api.ts reaches the host through it.
const calls = [];
const listeners = new Map();
let diffReply = { ok: true, data: modifiedDiff() };
window.piDesktop = {
  platform: "darwin",
  channels: IPC,
  on(channel, callback) {
    const set = listeners.get(channel) || new Set();
    set.add(callback);
    listeners.set(channel, set);
    return () => set.delete(callback);
  },
  async invoke(channel, ...args) {
    calls.push({ channel, args });
    if (channel === IPC.invoke.workspaceReviewFileDiff) return diffReply;
    return { ok: false, error: { code: "UNSTUBBED", message: "Unstubbed IPC " + channel } };
  },
};

/* A successful workspace Write/Edit row carrying the host's review evidence,
   the shape reviewChangeFromMessage accepts. */
let sequence = 0;
function toolRow(toolName, path, status, state, snapshotId) {
  sequence += 1;
  const id = "tool-" + sequence;
  return { id, role: "tool", toolName, toolStatus: "success", content: "",
    toolResult: { details: { root: "workspace", review: { version: 1, snapshotId, messageId: id, path,
      operation: toolName === "Write" ? "write" : "edit", status, state,
      additions: 1, deletions: status === "added" ? 0 : 1, hunks: [], reversible: true } } } };
}

function Surface() {
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const sessions = useAppStore((state) => state.sessions);
  const workPanelOpen = useAppStore((state) => state.workPanelOpen);
  const tabs = useAppStore((state) => state.workPanelTabs);
  const activeTabId = useAppStore((state) => state.activeWorkPanelTabId);
  // Composer's gate and WorkPanel's diff branch, as the app wires them.
  const localToolsAllowed = sessionAllows(
    sessions.find((session) => session.id === activeSessionId), "canUseLocalTools");
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  return React.createElement("div", null,
    React.createElement("div", { id: "composer-host", style: { width: "520px" } },
      activeSessionId && localToolsAllowed
        ? React.createElement(SessionChangesBar, { key: activeSessionId })
        : null),
    React.createElement("div", { id: "panel-host", style: { width: "640px", height: "420px" } },
      workPanelOpen && activeTab && activeTab.kind === "diff"
        ? React.createElement("div", { key: activeTab.id, className: "work-panel-tabpane", role: "tabpanel" },
            React.createElement(FileDiffTab, { path: activeTab.resource || "" }))
        : null));
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

const bar = () => document.querySelector("#composer-host .session-changes");
const barHeader = () => bar().querySelector(".dock-header-main");
const headerText = () => (bar().querySelector(".dock-header-text") || {}).textContent;
const rows = () => (bar() ? [...bar().querySelectorAll(".session-change-row")] : []);
const rowName = (row) => (row.querySelector(".session-change-name") || {}).textContent;
const rowDir = (row) => (row.querySelector(".session-change-dir") || {}).textContent || "";
const rowMark = (row) => (row.querySelector(".session-change-mark") || {}).textContent;
const rowOf = (name) => rows().find((row) => rowName(row) === name);

const pane = () => document.querySelector("#panel-host .file-diff-tab");
const paneText = (selector) => {
  const element = pane() && pane().querySelector(selector);
  return element ? element.textContent : null;
};
const diffLines = () => (pane() ? [...pane().querySelectorAll(".diff-line:not(.hunk)")] : []);
const gutter = (line, index) => line.querySelectorAll(".diff-line-number")[index].textContent;
const lineText = (line) => line.querySelector(".diff-line-text").textContent;
const note = () => (pane() ? pane().querySelector(".review-change-note") : null);
const diffCalls = () => calls.filter((call) => call.channel === IPC.invoke.workspaceReviewFileDiff);
const tabsOf = (state) => state.workPanelTabs.filter((tab) => tab.kind === "diff");
const copy = (key) => i18n.t(key);

/* Close the diff tab the way its tab-strip close control does, so the next
   open remounts the tab and reloads the file from the host. */
const closeDiffTab = (id) => flushSync(() => useAppStore.getState().closeWorkPanelTab(id));

window.sessionChangesProbe = async () => {
  const seen = {};
  try {
    await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
      resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
    const quiet = document.createElement("style");
    quiet.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
    document.head.appendChild(quiet);

    // 1. A local session whose transcript records four changes to three files,
    //    one of them already rolled back, plus an ordinary user turn.
    const messages = [
      { id: "u1", role: "user", content: "Change the app." },
      toolRow("Edit", "src/app.ts", "modified", "active", "snap-1"),
      toolRow("Write", "docs/notes.md", "added", "active", "snap-2"),
      toolRow("Edit", "src/app.ts", "modified", "active", "snap-3"),
      toolRow("Edit", "src/undone.ts", "modified", "rolledBack", "snap-4"),
    ];
    useAppStore.setState({
      activeSessionId: "s1",
      sessions: [{ id: "s1", title: "Local work", messageCount: messages.length, source: "desktop",
        projectPath: "/tmp/project", mode: "agent", thinkingLevel: "omit", permissionMode: "inherit",
        capabilities: { canPrompt: true, canUseLocalTools: true, canReadWorkspace: true } }],
      messages,
      workPanelOpen: false, workPanelTabs: [], activeWorkPanelTabId: null,
      workPanelContexts: {}, workPanelFileRequest: null,
    });
    const rootNode = createRoot(document.getElementById("root"));
    flushSync(() => rootNode.render(React.createElement(Surface)));

    // 2. The bar counts the files still affected, and stays collapsed.
    await waitFor("the changed-files bar", () => bar());
    seen.header = headerText();
    check(headerText() === "2 files changed", "collapsed header", headerText());
    check(rows().length === 0, "a collapsed bar mounts its file rows", rows().length);
    check(barHeader().getAttribute("aria-expanded") === "false", "collapsed aria-expanded",
      barHeader().getAttribute("aria-expanded"));
    check(!pane(), "the diff tab opened on its own");
    check(diffCalls().length === 0, "a collapsed bar asked the host for a diff", diffCalls().length);

    // 3. Opening the bar lists each file once, in first-change order.
    barHeader().click();
    await waitFor("the file rows", () => rows().length === 2);
    seen.rows = rows().map((row) => rowMark(row) + " " + rowName(row) + " " + rowDir(row));
    check(same(seen.rows, ["M app.ts src", "A notes.md docs"]), "file rows", seen.rows);
    check(rows()[0].getAttribute("aria-label") === "Show changes in src/app.ts (Modified)",
      "the modified row's accessible name", rows()[0].getAttribute("aria-label"));
    check(rows()[1].getAttribute("aria-label") === "Show changes in docs/notes.md (Added)",
      "the added row's accessible name", rows()[1].getAttribute("aria-label"));
    check(!rowOf("undone.ts"), "a rolled-back-only file is still listed", seen.rows);
    check(rows().every((row) => row.getBoundingClientRect().height > 0),
      "an expanded row has no height", rows().map((row) => row.getBoundingClientRect().height));

    // 4. A row opens that file's diff tab, and opening it twice reuses the tab.
    rowOf("app.ts").click();
    await waitFor("the diff tab opens", () => {
      const state = useAppStore.getState();
      return state.workPanelOpen && state.activeWorkPanelTabId === "diff:src/app.ts";
    });
    check(tabsOf(useAppStore.getState()).length === 1, "one diff tab",
      useAppStore.getState().workPanelTabs);
    await waitFor("the host is asked once", () => diffCalls().length === 1);
    rowOf("app.ts").click();
    await sleep(80);
    const reopened = useAppStore.getState();
    check(tabsOf(reopened).length === 1 && reopened.activeWorkPanelTabId === "diff:src/app.ts",
      "reopening the same file added a tab", reopened.workPanelTabs);
    check(diffCalls().length === 1, "reopening the same file reloaded the diff", diffCalls().length);

    // 5. The tab asks for the file's whole snapshot chain and numbers the hunk.
    check(same(diffCalls()[0].args[0], { sessionId: "s1", snapshotIds: ["snap-1", "snap-3"] }),
      "file diff request", diffCalls()[0].args);
    await waitFor("the diff renders", () => diffLines().length === 4);
    check(paneText(".badge") === copy("panel.review.readOnly"), "read-only badge", paneText(".badge"));
    check(paneText(".file-diff-baseline") === copy("panel.review.diffBaseline"), "baseline note",
      paneText(".file-diff-baseline"));
    check(paneText(".file-diff-path") === "src/app.ts", "diff path", paneText(".file-diff-path"));
    check(paneText(".session-change-mark [aria-hidden]") === "M", "diff status mark",
      paneText(".session-change-mark [aria-hidden]"));
    check(paneText(".session-change-mark .sr-only") === copy("panel.review.status.modified"),
      "diff status name", paneText(".session-change-mark .sr-only"));
    check(paneText(".diff-count-add") === "+1" && /1$/.test(paneText(".diff-count-del")),
      "diff counts", [paneText(".diff-count-add"), paneText(".diff-count-del")]);
    check(paneText(".diff-line.hunk .diff-line-text") === HUNK.header, "hunk header",
      paneText(".diff-line.hunk .diff-line-text"));
    seen.lines = diffLines().map((line) =>
      [line.classList.contains("add") ? "add" : line.classList.contains("del") ? "del" : "context",
        lineText(line), gutter(line, 0), gutter(line, 1)].join("|"));
    check(same(seen.lines, ["context|one|1|1", "del|two|2|", "add|2||2", "context|three|3|3"]),
      "diff lines and gutter numbers", seen.lines);
    check(!pane().querySelector(".file-diff-drift"), "a drift note with no drift");
    check(!note(), "a note beside a rendered diff", note() && note().textContent);

    // 6a. A later recorded change to the same file reloads it; the host reports
    //     the file drifted on disk, and the tab says so above the diff.
    diffReply = { ok: true, data: modifiedDiff({ drifted: true }) };
    flushSync(() => useAppStore.setState((state) => ({
      messages: state.messages.concat([toolRow("Edit", "src/app.ts", "modified", "active", "snap-5")]),
    })));
    await waitFor("the reload", () => diffCalls().length === 2);
    check(same(diffCalls()[1].args[0], { sessionId: "s1", snapshotIds: ["snap-1", "snap-3", "snap-5"] }),
      "reload request", diffCalls()[1].args);
    await waitFor("the drift note", () => pane().querySelector(".file-diff-drift"));
    check(paneText(".file-diff-drift") === copy("panel.review.diffDrifted"), "drift note",
      paneText(".file-diff-drift"));
    check(diffLines().length === 4, "the drift note replaced the diff", diffLines().length);
    check(headerText() === "2 files changed", "the bar's count moved", headerText());
    check(same(rows().map(rowName), ["app.ts", "notes.md"]), "the bar's rows moved", rows().map(rowName));

    // 6b. Nothing left to review: closing and reopening the tab reloads, and
    //     the host reports the file back to its pre-session state.
    diffReply = { ok: true, data: { status: "unchanged", additions: 0, deletions: 0, hunks: [],
      binary: false, truncated: false, drifted: false } };
    closeDiffTab("diff:src/app.ts");
    await waitFor("the tab closes", () => !pane());
    rowOf("app.ts").click();
    await waitFor("the reopened load", () => diffCalls().length === 3);
    check(same(diffCalls()[2].args[0], { sessionId: "s1", snapshotIds: ["snap-1", "snap-3", "snap-5"] }),
      "reopened request", diffCalls()[2].args);
    await waitFor("the no-net-changes note", () => note() && note().textContent === copy("panel.review.diffUnchanged"));
    check(diffLines().length === 0, "diff lines beside the no-net-changes note", diffLines().length);
    check(!pane().querySelector(".file-diff-drift"), "a drift note on an unchanged file");
    check(!pane().querySelector(".session-change-mark"), "a net-change mark on an unchanged file");

    // 6c. The host cannot answer: the tab reports it as an alert.
    diffReply = { ok: false, error: { code: "HOST_UNAVAILABLE", message: "host is unavailable" } };
    closeDiffTab("diff:src/app.ts");
    await waitFor("the tab closes again", () => !pane());
    rowOf("app.ts").click();
    await waitFor("the failing load", () => diffCalls().length === 4);
    const alert = await waitFor("the error note", () => pane().querySelector('[role="alert"]'));
    check(alert.textContent === copy("panel.review.diffError"), "error note", alert.textContent);
    check(diffLines().length === 0, "diff lines beside the error note", diffLines().length);
    check(paneText(".file-diff-baseline") === copy("panel.review.diffBaseline"),
      "the error note dropped the baseline note", paneText(".file-diff-baseline"));
    check(tabsOf(useAppStore.getState()).length === 1, "the retries piled up tabs",
      useAppStore.getState().workPanelTabs);

    return { passed: true, errors, seen, channels: [...new Set(calls.map((call) => call.channel))],
      requests: diffCalls().map((call) => call.args[0]) };
  } catch (error) {
    return { passed: false, error: String((error && error.stack) || error), errors, seen,
      channels: [...new Set(calls.map((call) => call.channel))],
      requests: diffCalls().map((call) => call.args[0]),
      bar: bar() ? bar().outerHTML.slice(0, 3000) : null,
      pane: pane() ? pane().outerHTML.slice(0, 3000) : null };
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
  '    const result = await win.webContents.executeJavaScript("new Promise((resolve) => { const tick = () => window.sessionChangesProbe ? resolve(window.sessionChangesProbe()) : setTimeout(tick, 20); tick(); })");',
  `    console.log(${JSON.stringify(PROBE)} + JSON.stringify(result));`,
  "    app.exit(0);",
  "  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }",
  "});",
].join("\n");

test("the composer's changed files open one file's read-only diff in the work panel", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-session-changes-"));
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
    t.diagnostic(`file diff requests ${JSON.stringify(result.requests)}`);
    assert.equal(result.passed, true, JSON.stringify(result, null, 2).slice(0, 8000));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.channels, ["pi-harbor/workspace/review/fileDiff"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
