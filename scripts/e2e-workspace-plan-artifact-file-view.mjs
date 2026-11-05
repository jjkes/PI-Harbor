#!/usr/bin/env node
// E2E-WORKSPACE-PLAN-artifact-file-view: a workspace session's plan file opens
// in the bundled File Manager, in a page of the workspace's own.
//
// A fixture git project gets a project workspace on another branch. The File
// Manager opens in a session of the parent checkout first. The workspace
// session then submits a plan through the Plan UI probe (the Host's real
// `plans.submit`) and opens its artifact from the approval bar, as a user does.
// The artifact must resolve inside the workspace, never against the parent
// tree or with "The workspace changed", and the parent's page must keep its
// root and in-page state. Offline: no model, no credentials.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTargets } from "./e2e/cdp-client.mjs";
import { check, runScenario, shortText } from "./e2e/desktop-app.mjs";

const NOTES = "Parent checkout notes marker";
const PLAN = {
  title: "Workspace plan artifact",
  markdown: "# Workspace plan artifact marker\n\n- Resolve the plan file inside the workspace.\n",
  question: "Approve the workspace plan?",
};
const PLAN_MARKER = "Workspace plan artifact marker";
const FILE_MANAGER_VIEW = /pi\.file-manager.*\/views\/index\.html/;
const LAUNCHER_ITEM = '[data-work-panel-launcher-item="pi.file-manager/manager"]';
const WORKSPACE_CHANGED = /The workspace changed|工作区已切换/;

// Neither the fixture's git nor the Host's may read the user's configuration.
const absentConfig = join(tmpdir(), "pi-e2e-gitconfig-absent");
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: absentConfig, GIT_CONFIG_SYSTEM: absentConfig, GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "E2E", GIT_AUTHOR_EMAIL: "e2e@example.invalid",
  GIT_COMMITTER_NAME: "E2E", GIT_COMMITTER_EMAIL: "e2e@example.invalid",
});
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const state = {};
const WORKSPACE_NOTES = "Workspace notes marker";

/** A project on `main`, and a pushed `feature/one` branch with a file of its own. */
function buildProject(root) {
  const origin = join(root, "origin.git");
  state.project = join(root, "project");
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "clone", origin, state.project);
  writeFileSync(join(state.project, "README.md"), "# fixture\n");
  writeFileSync(join(state.project, "notes.txt"), `${NOTES}\n`);
  git(state.project, "add", "README.md", "notes.txt");
  git(state.project, "commit", "-m", "initial commit");
  git(state.project, "push", "-u", "origin", "main");
  git(state.project, "checkout", "-q", "-b", "feature/one");
  writeFileSync(join(state.project, "feature.txt"), "feature\n");
  // The workspace's notes differ, so a read showing NOTES came from the parent checkout.
  writeFileSync(join(state.project, "notes.txt"), `${WORKSPACE_NOTES}\n`);
  git(state.project, "add", "feature.txt", "notes.txt");
  git(state.project, "commit", "-m", "feature commit");
  git(state.project, "push", "-u", "origin", "feature/one");
  git(state.project, "checkout", "-q", "main");
}

async function seed(host, app) {
  buildProject(app.tempRoot);
  await host.call("settings.set", { language: "en" });
  await host.call("workspace.set", { path: state.project });
  const { workspace } = await host.call("projectWorkspace.create", {
    projectPath: state.project, name: "ws-one", remote: "origin", sourceBranch: "feature/one",
  });
  state.workspacePath = workspace.path ?? join(state.project, ".pi", "worktree", "ws-one");
  check(existsSync(join(state.workspacePath, "feature.txt")), `workspace checkout: ${shortText(workspace)}`);
  const create = async (title, extra = {}) => {
    const result = await host.call("session.create", { title, mode: "plan", projectPath: state.project, ...extra });
    return result?.session?.id ?? result?.id;
  };
  state.parentId = await create("Parent checkout");
  state.workspaceSessionId = await create("Workspace plan", { workspaceId: workspace.id });
  check(state.parentId && state.workspaceSessionId, "session.create returned no ids");
}

const attached = new Map();

/** Every File Manager page: what it shows and the marker the test left in it. */
async function fileManagerPages(app) {
  const targets = (await listTargets(app.cdpPort))
    .filter((target) => target.webSocketDebuggerUrl && FILE_MANAGER_VIEW.test(target.url));
  const pages = [];
  for (const target of targets) {
    if (!attached.has(target.id)) attached.set(target.id, await app.attach(target));
    const client = attached.get(target.id);
    const view = await client.evaluate(`({
      text: document.body?.innerText ?? "",
      marker: window.__e2eRoot ?? null,
      rows: [...document.querySelectorAll(".tree-row")].map((row) => row.textContent.trim()),
    })`).catch(() => ({ text: "", marker: null, rows: [] }));
    pages.push({ id: target.id, client, ...view });
  }
  return pages;
}
const lists = (page, name) => page.rows.some((row) => row.includes(name));
/** The root a File Manager page shows: the first word of its header. */
const rootLabel = (page) => page.text.trim().split(/\s+/, 1)[0] ?? "";
/** A page without its CDP client, for a failure message. */
const summary = (page) => page && { marker: page.marker, root: rootLabel(page), rows: page.rows, text: page.text.slice(0, 300) };

/** What a File Manager page shows, for a failure message. */
function describePage(page) {
  return page.client.evaluate(`({
    marker: window.__e2eRoot ?? null,
    width: window.innerWidth,
    text: (document.body?.innerText ?? "").replace(/\\s+/g, " ").slice(0, 500),
    classes: [...new Set([...document.querySelectorAll("[class]")].flatMap((node) => [...node.classList]))]
      .filter((name) => /tree|pane|split|preview|crumb|path|root/i.test(name)).slice(0, 30),
  })`).catch((error) => ({ error: String(error) }));
}

/** Wait on the File Manager pages; a timeout describes each page and target. */
async function waitForPages(app, predicate, label) {
  return app.waitFor(async () => predicate(await fileManagerPages(app)), label).catch(async (error) => {
    const pages = await Promise.all((await fileManagerPages(app)).map(describePage));
    const targets = (await listTargets(app.cdpPort)).map((target) => `${target.type} ${target.url}`);
    throw new Error(`${error.message}; File Manager pages ${shortText(pages, 2_000)}; targets ${shortText(targets, 1_000)}`);
  });
}

/** Open the File Manager from the work panel's new-tab launcher. */
async function openFileManager(app) {
  const visible = (selector) => app.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    return node instanceof HTMLElement && node.getClientRects().length > 0;
  })()`);
  if (!(await visible(".work-panel-new-tab"))) {
    await app.click(".app-work-panel-toggle", { label: "the work panel toggle" });
    await app.waitFor(() => visible(".work-panel-new-tab"), "the work panel");
  }
  if (!(await visible(LAUNCHER_ITEM))) await app.click(".work-panel-new-tab", { label: "the new-tab button" });
  await app.click(LAUNCHER_ITEM, { label: "the File Manager launcher item" });
}

const parentPage = {
  id: "E2E-WORKSPACE-PLAN-artifact-file-view:parent-page",
  run: async (app) => {
    await app.selectSession(state.parentId);
    await openFileManager(app);
    const [page] = await waitForPages(app, (pages) =>
      pages.length === 1 && lists(pages[0], "notes.txt") ? pages : null, "the parent session's File Manager page");
    check(rootLabel(page) === "project" && !lists(page, "feature.txt"),
      `the parent page's root: ${shortText(summary(page))}`);
    // In-page state the parent's page must still hold after the workspace opens its plan.
    await page.client.evaluate(`window.__e2eRoot = "parent"`);
    state.parentPage = page.id;
    return `${page.rows.length} entries at the parent root`;
  },
};

const workspaceArtifact = {
  id: "E2E-WORKSPACE-PLAN-artifact-file-view:workspace-artifact",
  run: async (app) => {
    await app.selectSession(state.workspaceSessionId);
    const submitted = await app.planProbe({
      operation: "submit", workspace: state.project, sessionId: state.workspaceSessionId, revision: "first", ...PLAN,
    });
    const artifact = submitted.proposal?.artifact?.relativePath;
    check(artifact && existsSync(join(state.workspacePath, ...artifact.split("/"))),
      `the plan artifact is not inside the workspace: ${shortText(submitted)}`);
    await app.click('[data-testid="plan-open-artifact"]', { label: "the approval bar's plan file button" });
    const pages = await waitForPages(app, (pages) => {
      const workspace = pages.find((page) => page.id !== state.parentPage);
      return pages.length === 2 && workspace?.text.includes(PLAN_MARKER) ? pages : null;
    }, "a second File Manager page showing the plan file");
    const workspace = pages.find((page) => page.id !== state.parentPage);
    const parent = pages.find((page) => page.id === state.parentPage);
    // The narrow panel shows an open file without the tree; the header names the page's root.
    check(rootLabel(workspace) === "ws-one" && !WORKSPACE_CHANGED.test(workspace.text),
      `the workspace page: ${shortText(summary(workspace))}`);
    check(parent?.marker === "parent" && rootLabel(parent) === "project" && lists(parent, "notes.txt")
      && !lists(parent, "feature.txt") && !parent.text.includes(PLAN_MARKER),
      `the parent page changed: ${shortText(summary(parent))}`);
    return artifact;
  },
};

const parentAgain = {
  id: "E2E-WORKSPACE-PLAN-artifact-file-view:parent-again",
  run: async (app) => {
    await app.selectSession(state.parentId);
    const [parent] = await waitForPages(app, (pages) => {
      const page = pages.find((candidate) => candidate.id === state.parentPage);
      return page?.marker === "parent" ? [page] : null;
    }, "the parent page after switching back");
    check(!parent.text.includes(NOTES), "notes.txt was shown before it was opened");
    const clicked = await parent.client.evaluate(`(() => {
      const row = [...document.querySelectorAll(".tree-row")].find((node) => node.textContent.includes("notes.txt"));
      row?.click();
      return Boolean(row);
    })()`);
    check(clicked, `no notes.txt row: ${shortText(parent.rows)}`);
    const pages = await waitForPages(app, (pages) =>
      pages.find((page) => page.id === state.parentPage)?.text.includes(NOTES) ? pages : null,
    "notes.txt open in the parent page");
    const page = pages.find((candidate) => candidate.id === state.parentPage);
    check(pages.length === 2, `File Manager pages after switching back: ${pages.length}`);
    check(page.marker === "parent" && rootLabel(page) === "project" && !WORKSPACE_CHANGED.test(page.text)
      && !page.text.includes(WORKSPACE_NOTES), `the parent page: ${shortText(summary(page))}`);
  },
};

await runScenario("workspace-plan-artifact-file-view", { seed, probe: true }, [parentPage, workspaceArtifact, parentAgain]);
