import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

/*
 * User-path check for the two transcript additions: a tool row whose call is
 * still being written, and the compaction divider that opens its summary.
 * Everything renders through the real components and the real English catalog
 * in Chromium; only the store contents and the envelope stream are fixtures.
 */
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs } from "@pi-harbor/i18n";
import { IPC } from "@pi-harbor/shared";
import { ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import { CompactionRow } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { TranscriptDisclosureProvider } from "../../apps/desktop/src/features/chat/transcript/disclosure";
import { SlotSessionProvider } from "../../apps/desktop/src/plugins/renderer-slots/use-slots";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({ lng: "en", resources: { en: { translation: catalogs.en } } });
window.piDesktop = { platform: "darwin", channels: IPC,
  invoke: async () => ({ ok: true, data: undefined }), on: () => () => {} };
useAppStore.setState({
  activeSessionId: "session-a", sessions: [{ id: "session-a" }],
  workspace: { path: "/project" }, workPanelTabs: [], activeWorkPanelTabId: null,
});
const view = createRoot(document.getElementById("root"));

const draftingWrite = {
  id: "write-1", role: "tool", content: "", createdAt: "2026-11-17T00:00:00Z",
  toolName: "Write", toolCallId: "write-1", toolStatus: "running", status: "streaming",
  toolArgs: { path: "src/app.ts", content: "line one\nline two\nline three\n" },
  toolDraft: { phase: "streaming", messageId: "m1" },
};
const readyWrite = {
  ...draftingWrite, id: "write-2", toolCallId: "write-2",
  toolDraft: { phase: "complete", messageId: "m1" },
};
const runningWrite = { ...draftingWrite, id: "write-3", toolCallId: "write-3", toolDraft: undefined };
const summarized = {
  id: "cp-1", throughMessageId: "m1", generation: 2, summaryTokens: 512,
  summarized: true, summary: "## Goal\nKeep the streamed preview.\n\n- one\n- two",
};
const fallback = {
  id: "cp-2", throughMessageId: "m1", generation: 3, summaryTokens: 40,
  summarized: true, fallback: "retained_tail", summary: "carried notice",
};
const noSummary = {
  id: "cp-3", throughMessageId: "m1", generation: 4, summaryTokens: 0, summarized: false,
};

const render = () => flushSync(() => view.render(
  <SlotSessionProvider sessionId="session-a">
    <TranscriptDisclosureProvider sessionId="session-a">
      <div data-testid="drafting"><ToolRow message={draftingWrite} /></div>
      <div data-testid="ready"><ToolRow message={readyWrite} /></div>
      <div data-testid="running"><ToolRow message={runningWrite} /></div>
      <div data-testid="summarized"><CompactionRow mark={summarized} /></div>
      <div data-testid="fallback"><CompactionRow mark={fallback} /></div>
      <div data-testid="no-summary"><CompactionRow mark={noSummary} /></div>
    </TranscriptDisclosureProvider>
  </SlotSessionProvider>));
const settle = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
function check(condition, message) { if (!condition) throw new Error(message); }
const byTestId = (id) => document.querySelector('[data-testid="' + id + '"]');

window.probe = async (stage) => {
  if (stage === "rows") {
    render(); await settle();
    const drafting = byTestId("drafting");
    check(drafting.textContent.includes("Writing"), "A streaming Write must read as writing, got: " + drafting.textContent);
    check(drafting.textContent.includes("src/app.ts"), "The draft shows its target path");
    check(drafting.textContent.includes("3 lines"), "The draft shows its live line count, got: " + drafting.textContent);
    check(drafting.querySelector(".tool-row-draft-size"), "The live size chip is present");
    const ready = byTestId("ready");
    check(ready.textContent.includes("Ready to run"), "A written call waits to run, got: " + ready.textContent);
    check(!byTestId("running").textContent.includes("Ready to run"), "An executing call is not a draft");
    // Expanding the draft shows the content written so far.
    const header = drafting.querySelector(".tool-row-header");
    check(header, "The draft row has a disclosure header");
    flushSync(() => header.click()); await settle();
    const body = drafting.querySelector(".tool-row-body");
    check(body && body.textContent.includes("line two"), "The expanded draft shows its streamed content");
    return { passed: true, stage };
  }
  if (stage === "dialog") {
    render(); await settle();
    const trigger = byTestId("summarized").querySelector("button.transcript-compaction-row");
    check(trigger, "A summarized compaction row is a button");
    check(trigger.getAttribute("aria-haspopup") === "dialog", "The trigger advertises its dialog");
    check(byTestId("fallback").querySelector("button") === null, "A fallback row stays inert");
    check(byTestId("no-summary").querySelector("button") === null, "A no-summary row stays inert");
    trigger.focus();
    flushSync(() => trigger.click()); await settle();
    const dialog = document.querySelector('[role="dialog"]');
    check(dialog, "Clicking the divider opens the dialog");
    check(dialog.textContent.includes("Context compaction #2"), "The dialog names the checkpoint");
    check(dialog.textContent.includes("Keep the streamed preview"), "The dialog renders the summary");
    check(dialog.textContent.includes("one") && dialog.textContent.includes("two"), "The summary list renders");
    check(dialog.parentElement === document.body || dialog.closest("body"), "The dialog is portaled to body");
    const close = dialog.querySelector(".session-context-dialog-close");
    check(document.activeElement === close, "Focus starts on the close button");
    // Copy reports success or failure through the same label as the viewer.
    const copyBtn = dialog.querySelector(".session-context-copy");
    check(copyBtn, "The dialog has a copy action");
    const copyLabelBefore = copyBtn.getAttribute("aria-label");
    flushSync(() => copyBtn.click()); await settle();
    const copyLabelAfter = copyBtn.getAttribute("aria-label");
    check(copyLabelAfter === "Copied" || copyLabelAfter === "Couldn't copy to the clipboard",
      "Copy reports an outcome, got: " + copyLabelAfter + " (was " + copyLabelBefore + ")");
    // Close via the close button (not Escape) returns focus to the divider.
    flushSync(() => close.click()); await settle();
    check(!document.querySelector('[role="dialog"]'), "The close button closes the dialog");
    check(document.activeElement === byTestId("summarized").querySelector("button.transcript-compaction-row"),
      "Focus returns to the divider after close");
    // Reopen and dismiss with a real backdrop click.
    flushSync(() => byTestId("summarized").querySelector("button.transcript-compaction-row").click()); await settle();
    check(document.querySelector('[role="dialog"]'), "The dialog reopens");
    const backdrop = document.querySelector(".session-context-dialog-overlay");
    check(backdrop, "The backdrop is present");
    backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, pointerId: 1 }));
    backdrop.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, isPrimary: true, pointerId: 1 }));
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    check(!document.querySelector('[role="dialog"]'), "A backdrop press closes the dialog");
    return { passed: true, stage };
  }
  if (stage === "escape") {
    // The dialog stage closed it; reopen before testing Escape.
    flushSync(() => byTestId("summarized").querySelector("button.transcript-compaction-row").click());
    await settle();
    const dialog = document.querySelector('[role="dialog"]');
    check(dialog, "The dialog is open before Escape");
    // The keydown listener is on window; a real Escape key event reaches it.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    check(!document.querySelector('[role="dialog"]'), "Escape closes the dialog");
    const trigger = byTestId("summarized").querySelector("button.transcript-compaction-row");
    check(document.activeElement === trigger, "Focus returns to the divider");
    return { passed: true, stage };
  }
  flushSync(() => view.unmount());
  return { passed: true, stage };
};
`;

test("streaming tool drafts and the compaction summary dialog render and interact in Chromium", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-tool-draft-ui-"));
  try {
    const styles = await Promise.all(["tokens", "base", "ui-kit", "messages"].map((name) =>
      readFile(join(root, `apps/desktop/src/styles/${name}.css`), "utf8")));
    await writeFile(join(temp, "style.css"), styles.join("\n"));
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"DEV":false,"MODE":"production"}' },
      loader: { ".css": "empty" },
      alias: {
        "@pi-harbor/i18n": join(root, "packages/i18n/src"),
        "@pi-harbor/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>Tool draft + compaction summary</title><link rel="stylesheet" href="style.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 850,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    for (const stage of ["rows", "dialog", "escape"]) {
      console.log("PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.probe(" + JSON.stringify(stage) + ")")));
    }
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    const code = await new Promise((resolve) => child.on("exit", resolve));
    clearTimeout(timeout);
    assert.equal(code, 0, `Electron fixture failed:\n${output}`);
    const probes = [...output.matchAll(/PROBE (\{.*\})/g)].map((m) => JSON.parse(m[1]));
    assert.equal(probes.length, 3, `Expected three probe stages:\n${output}`);
    assert.ok(probes.every((p) => p.passed), output);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
