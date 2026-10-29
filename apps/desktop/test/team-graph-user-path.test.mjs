import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const PROBE = "TEAM_GRAPH_PROBE ";
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-harbor/i18n";
import { IPC } from "@pi-harbor/shared";
import { TeamGraph } from "../../apps/desktop/src/features/team/TeamGraph";
import { buildTeamGraph } from "../../apps/desktop/src/features/team/team-graph-model";
import { SlotSessionProvider } from "../../apps/desktop/src/plugins/renderer-slots/use-slots";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import "../../apps/desktop/src/styles/tokens.css";
import "../../apps/desktop/src/styles/ui-kit.css";
import "../../apps/desktop/src/styles/messages.css";
import "../../apps/desktop/src/features/team/team.css";

const errors = [];
const reportError = console.error.bind(console);
console.error = (...args) => {
  errors.push(args.map((item) => (item && item.stack) || String(item)).join(" "));
  reportError(...args);
};
window.addEventListener("error", (event) => errors.push("error: " + event.message));
window.addEventListener("unhandledrejection", (event) =>
  errors.push("rejection: " + String(event.reason)));
const calls = [];
window.piDesktop = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, ...args) {
    calls.push({ channel, args });
    if (channel === IPC.invoke.agentStopSubagents) return { ok: true, data: { pending: [] } };
    return { ok: false, error: { code: "UNSTUBBED", message: "Unstubbed IPC " + channel } };
  },
};
const at = "2026-10-29T08:00:00.000Z";
const task = (callId, delegationId, agent, parentToolCallId) => ({
  id: callId,
  role: "tool",
  content: "",
  createdAt: at,
  toolName: "Task",
  toolCallId: callId,
  toolStatus: "success",
  toolArgs: { agent, task: "Work for " + agent, description: agent + " task" },
  ...(parentToolCallId ? { parentToolCallId, agentName: "explorer" } : {}),
  toolResult: {
    content: [{ type: "text", text: "Started " + agent }],
    details: {
      delegationId,
      agent,
      modelId: agent + "-model",
      status: "running",
      startedAt: Date.parse(at),
    },
  },
});
const initialMessages = [
  { id: "u1", role: "user", content: "Run the team", createdAt: at },
  { id: "a1", role: "assistant", content: "Delegating", createdAt: at },
  task("root-call", "d-root", "explorer"),
  task("child-call", "d-child", "worker", "root-call"),
];
function Surface() {
  const messages = useAppStore((state) => state.messages);
  const graph = React.useMemo(() => buildTeamGraph(messages), [messages]);
  return React.createElement(SlotSessionProvider, { sessionId: "s1", value: "s1" },
    React.createElement(TeamGraph, {
      graph,
      messages,
      mainModelId: "main-model",
      isRunning: true,
      onError(error) { throw error; },
    }));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(label, predicate) {
  const deadline = Date.now() + 5000;
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
  throw new Error("timed out: " + label + (last instanceof Error ? " " + last.message : ""));
}
function check(condition, message, detail) {
  if (!condition) throw new Error(message + (detail === undefined ? "" : " " + JSON.stringify(detail)));
}
const node = (id) => document.querySelector('[data-team-node-id="' + id + '"]');
const key = (element, value) => element.dispatchEvent(new KeyboardEvent("keydown", {
  key: value, bubbles: true, cancelable: true,
}));
window.teamGraphProbe = async () => {
  try {
    await i18n.use(initReactI18next).init({
      lng: "en",
      keySeparator: false,
      resources: { en: { translation: flattenCatalog(catalogs.en) } },
      interpolation: { escapeValue: false },
    });
    useAppStore.setState({
      activeSessionId: "s1",
      sessions: [{ id: "s1", source: "desktop", title: "Team" }],
      messages: initialMessages,
      runningSessions: { s1: true },
    });
    const rootNode = createRoot(document.getElementById("root"));
    flushSync(() => rootNode.render(React.createElement(Surface)));
    await waitFor("the two-level tree", () => node("d-root") && node("d-child"));
    check(document.querySelector('[role="tree"]'), "the graph has no tree role");
    check(node("d-root").getAttribute("aria-level") === "2", "L1 level");
    check(node("d-child").getAttribute("aria-level") === "3", "L2 level");
    check(node("d-root").getAttribute("aria-expanded") === "true", "L1 is not expanded");

    const main = document.querySelector(".team-graph-main-item");
    main.focus();
    key(main, "ArrowDown");
    await waitFor("keyboard focus on L1", () => document.activeElement === node("d-root"));
    key(node("d-root"), "ArrowDown");
    await waitFor("keyboard focus on L2", () => document.activeElement === node("d-child"));
    node("d-child").click();
    await waitFor("the L2 work-panel tab", () => {
      const state = useAppStore.getState();
      return state.workPanelOpen && String(state.activeWorkPanelTabId || "").includes("d-child");
    });

    node("d-root").querySelector(".stop-btn").click();
    await waitFor("the L1 stop request", () => calls.some((call) =>
      call.channel === IPC.invoke.agentStopSubagents));
    const stop = calls.find((call) => call.channel === IPC.invoke.agentStopSubagents);
    check(JSON.stringify(stop.args[0]) === JSON.stringify({ sessionId: "s1", delegationIds: ["d-root"] }),
      "the L1 stop targeted the wrong subtree", stop.args);

    const stoppedMessages = initialMessages.map((message) => message.role === "tool" ? {
      ...message,
      toolResult: {
        ...message.toolResult,
        details: {
          ...message.toolResult.details,
          status: "stopped",
          completedAt: Date.parse(at) + 1000,
        },
      },
    } : message);
    flushSync(() => useAppStore.setState({ messages: stoppedMessages, runningSessions: { s1: false } }));
    await waitFor("stopped graph rendering", () =>
      document.querySelectorAll(".team-graph-node.outcome-stopped").length === 2);
    check(document.querySelectorAll(".stop-btn").length === 0, "stopped nodes kept stop controls");
    check(errors.length === 0, "browser errors", errors);
    return { passed: true, errors, stop: stop.args[0] };
  } catch (error) {
    return {
      passed: false,
      error: String((error && error.stack) || error),
      errors,
      html: document.getElementById("root").innerHTML.slice(0, 5000),
    };
  }
};
`;

const main = [
  'const { app, BrowserWindow } = require("electron");',
  'const path = require("node:path");',
  'app.setPath("userData", path.join(__dirname, "profile"));',
  "app.whenReady().then(async () => {",
  "  const win = new BrowserWindow({ show: false, width: 1100, height: 800,",
  "    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });",
  "  try {",
  '    await win.loadFile(path.join(__dirname, "index.html"));',
  '    const result = await win.webContents.executeJavaScript("new Promise((resolve) => { const tick = () => window.teamGraphProbe ? resolve(window.teamGraphProbe()) : setTimeout(tick, 20); tick(); })");',
  `    console.log(${JSON.stringify(PROBE)} + JSON.stringify(result));`,
  "    app.exit(0);",
  "  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }",
  "});",
].join("\n");

test("Team graph opens an L2 tab and stops its L1 owner through real Chromium interaction", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-team-graph-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
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
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><div id="root"></div><script type="module" src="renderer.js"></script>',
    );
    await writeFile(join(temp, "main.cjs"), main);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    const line = output.split(/\r?\n/).find((item) => item.startsWith(PROBE));
    assert.ok(line, output.slice(-7000));
    assert.equal(code, 0, output.slice(-7000));
    const result = JSON.parse(line.slice(PROBE.length));
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.deepEqual(result.errors, []);
    t.diagnostic(`Team graph stop payload ${JSON.stringify(result.stop)}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
