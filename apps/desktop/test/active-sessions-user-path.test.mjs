import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * The Active sessions page, driven the way a user meets it: the sidebar footer
 * counts the sessions that are working or waiting for approval and opens the
 * grid; each pane loads its session's recent transcript once and follows a
 * reply that streams in the background without selecting that session; Open
 * moves to the conversation and Back returns to the grid; a session whose run
 * ends leaves the grid; and a second press on the footer entry goes Back. Only
 * the preload bridge is stubbed. The store, the transcript projection, and the
 * agent event routing are the real ones.
 */

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const PROBE = "ACTIVE_SESSIONS_PROBE ";

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-harbor/i18n";
import { IPC } from "@pi-harbor/shared";
import { ActiveSessionsNavButton } from "../../apps/desktop/src/features/active-sessions/ActiveSessionsNavButton";
import { ActiveSessionsPage } from "../../apps/desktop/src/pages/ActiveSessionsPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });

const at = (minute) => "2026-10-01T09:" + String(minute).padStart(2, "0") + ":00.000Z";
const summary = (id, title, minute, overrides = {}) => ({
  id, title, messageCount: 1, mode: "agent", thinkingLevel: "medium", permissionMode: "inherit",
  providerId: "fixture", modelId: "fixture-model", createdAt: at(minute), updatedAt: at(minute),
  ...overrides,
});
const sessions = [
  summary("review", "Review the migration", 20),
  summary("idle", "Idle notes", 5),
  summary("build", "Draft release notes", 10, { projectPath: "/fixture/harbor" }),
  summary("nightly", "Nightly report", 1, { scheduledRun: true }),
];
const prompts = {
  build: "Draft the release notes for 0.22",
  review: "Review the database migration",
};
const reads = [];
const unexpected = [];
window.piDesktop = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, request) {
    if (channel === IPC.invoke.sessionGet) {
      reads.push({ id: request.id, messageLimit: request.messageLimit });
      return { ok: true, data: { session: {
        ...sessions.find((item) => item.id === request.id),
        messages: [{ id: request.id + "-prompt", role: "user", content: prompts[request.id], createdAt: at(30) }],
        messageStart: 0,
        hasMoreBefore: false,
      } } };
    }
    unexpected.push(channel);
    return { ok: false, error: { code: "FIXTURE_UNSTUBBED", message: "Unstubbed IPC " + channel } };
  },
};
useAppStore.setState({
  sessions,
  workspace: null,
  runningSessions: { review: true, build: true, nightly: true, idle: false },
  pendingPermissions: {
    review: [{ requestId: "review-request", sessionId: "review", toolCallId: "review-call",
      toolName: "bash", argsPreview: { command: "psql -f migrate.sql" }, risk: "high",
      reason: "Runs a database migration" }],
  },
});

function Surface() {
  const page = useAppStore((state) => state.page);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "footer-actions" },
      React.createElement(ActiveSessionsNavButton)),
    page === "activeSessions"
      ? React.createElement(ActiveSessionsPage)
      : React.createElement("main", { "data-page": page, "data-session": activeSessionId ?? "" },
        "Conversation"));
}
const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(React.createElement(Surface)));

const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }
async function until(predicate, message) {
  for (let n = 0; n < 120; n += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(message + " body=" + document.body.textContent + " unstubbed=" + unexpected.join(","));
}
const store = () => useAppStore.getState();
const nav = () => document.querySelector('[data-nav="active-sessions"]');
const badge = () => nav()?.querySelector(".active-sessions-nav-badge")?.textContent ?? "";
const panes = () => JSON.stringify([...document.querySelectorAll(".active-sessions-item")]
  .map((item) => item.dataset.sessionId));
const pane = (id) => document.querySelector('.active-sessions-item[data-session-id="' + id + '"]');
const click = (element) => flushSync(() => element.click());

window.activeSessionsProbe = async () => {
  await settle();
  // The footer counts what is working or waiting for approval; idle and
  // automation sessions do not count.
  check(nav(), "footer entry did not render");
  check(nav().getAttribute("aria-label") === "Active sessions (2)",
    "footer label: " + nav().getAttribute("aria-label"));
  check(badge() === "2", "footer badge: " + badge());
  check(nav().getAttribute("aria-pressed") === "false", "footer entry pressed outside its page");

  click(nav());
  await settle();
  check(store().page === "activeSessions", "footer entry did not open the page");
  check(nav().getAttribute("aria-pressed") === "true", "footer entry did not report its page");
  check(panes() === '["build","review"]', "panes: " + panes());
  // A pending permission outranks running and names the tool it waits for.
  check(pane("review").textContent.includes("Waiting for approval"), "waiting badge missing");
  check(pane("review").textContent.includes("Needs your approval to run bash"), "waiting tool missing");
  check(pane("build").textContent.includes("Working"), "working badge missing");
  check((pane("build").querySelector(".active-session-pane-crumb")?.textContent ?? "").includes("harbor"),
    "project crumb missing");

  // Neither session was read yet, so each pane loads its recent tail once.
  await until(() => pane("build").textContent.includes(prompts.build)
    && pane("review").textContent.includes(prompts.review), "previews did not load");
  check(reads.length === 2 && reads.every((read) => read.messageLimit === 100),
    "preview reads: " + JSON.stringify(reads));

  // A reply streaming in the background reaches its pane without selecting it.
  store().handleAgentEvent({ sessionId: "build", ts: Date.parse(at(31)), event: {
    type: "message_start",
    message: { id: "build-reply", role: "assistant", content: "Drafting the highlights",
      createdAt: at(31), status: "streaming" },
  } });
  await until(() => pane("build").textContent.includes("Drafting the highlights"),
    "streamed reply did not reach its pane");
  check(store().activeSessionId === undefined, "watching a pane selected its session");
  check(store().page === "activeSessions", "streaming left the page");

  // Open moves to the conversation; Back returns to the grid.
  const open = [...pane("review").querySelectorAll("button")]
    .find((button) => button.textContent.trim() === "Open");
  check(open, "Open button missing");
  check(open.getAttribute("aria-label") === "Open Review the migration",
    "Open label: " + open.getAttribute("aria-label"));
  click(open);
  await until(() => store().activeSessionId === "review" && store().selectingSessionId === undefined,
    "Open did not select the session");
  check(store().page === "chat", "Open did not show the conversation");
  check(document.querySelector("main[data-page]")?.dataset.session === "review",
    "the conversation is not the opened session");
  check(nav().getAttribute("aria-pressed") === "false", "footer entry stayed pressed in the conversation");

  flushSync(() => store().navBack());
  await settle();
  check(store().page === "activeSessions", "Back did not return to the grid");
  check(panes() === '["build","review"]', "grid after Back: " + panes());
  check(pane("build").textContent.includes("Drafting the highlights"), "a pane lost its streamed reply");

  // A session whose run ends leaves the grid and the count.
  store().handleAgentEvent({ sessionId: "build", ts: Date.parse(at(32)), event: { type: "agent_end", messages: [] } });
  await until(() => !pane("build"), "finished session stayed on the grid");
  check(panes() === '["review"]', "grid after the run ended: " + panes());
  check(badge() === "1", "footer badge after the run ended: " + badge());
  check(nav().getAttribute("aria-label") === "Active sessions (1)", "footer label after the run ended");

  // A second press on the footer entry goes Back to where the user came from.
  click(nav());
  await settle();
  check(store().page === "chat", "second press did not go Back");
  check(nav().getAttribute("aria-pressed") === "false", "footer entry stayed pressed after Back");

  flushSync(() => rootNode.unmount());
  return { passed: true };
};
`;

test("Active sessions footer entry, live panes, Open, Back, and run end", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-active-sessions-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
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
    await writeFile(join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log(${JSON.stringify(PROBE)} + JSON.stringify(await win.webContents.executeJavaScript("window.activeSessionsProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith(PROBE));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice(PROBE.length)), { passed: true });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
