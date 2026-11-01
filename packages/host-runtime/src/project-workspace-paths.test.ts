import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { getWorkspaceFileIndex, searchWorkspaceFiles } from "./fs-index.js";
import { isProjectWorkspacePath, PROJECT_WORKSPACE_DIR_REL } from "./workspace-files.js";

/*
 * Project workspaces are other checkouts of the same repository, kept inside
 * the project at `.pi/worktree/<name>`. The app's own file index must not
 * descend into them from the project root. The skip is by path relative to
 * the root, so a user's own `worktree` directory elsewhere stays visible.
 */

const temps: string[] = [];
afterAll(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A project with its own files, a `.pi` artifact, and one workspace checkout. */
async function project(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temps.push(root);
  for (const path of [
    "src/app.ts",
    "tools/worktree/keep.ts",
    ".pi/plan/plan.md",
    ".pi/worktree/review/src/app.ts",
    ".pi/worktree/review/README.md",
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "x");
  }
  return root;
}

function inWorkspaceDir(path: string): boolean {
  return path === PROJECT_WORKSPACE_DIR_REL || path.startsWith(`${PROJECT_WORKSPACE_DIR_REL}/`);
}

it("matches the project's own .pi/worktree by path, not by directory name", () => {
  for (const path of [
    ".pi/worktree",
    ".pi/worktree/",
    ".pi/worktree/review",
    ".pi/worktree/review/src/app.ts",
    "./.pi/worktree/review",
    ".pi\\worktree\\review",
  ]) {
    expect(isProjectWorkspacePath(path), path).toBe(true);
  }
  for (const path of [
    "",
    ".pi",
    ".pi/plan/plan.md",
    ".pi/worktrees/review",
    "worktree",
    "tools/worktree/keep.ts",
  ]) {
    expect(isProjectWorkspacePath(path), path).toBe(false);
  }
});

it("the walked file index and search leave the workspace checkouts out", async () => {
  const root = await project("pi-ws-index-walk-");

  const paths = (await getWorkspaceFileIndex(root)).entries.map((entry) => entry.path);
  expect(paths).toContain("src/app.ts");
  expect(paths).toContain("tools/worktree/keep.ts");
  expect(paths.filter(inWorkspaceDir)).toEqual([]);

  const found = (await searchWorkspaceFiles(root, "app")).entries.map((entry) => entry.path);
  expect(found).toContain("src/app.ts");
  expect(found.filter(inWorkspaceDir)).toEqual([]);
});

it("a git repository's listing leaves them out without an exclude rule", async (ctx) => {
  if (spawnSync("git", ["--version"]).status !== 0) ctx.skip();
  const root = await project("pi-ws-index-git-");
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);

  const paths = (await getWorkspaceFileIndex(root)).entries.map((entry) => entry.path);
  expect(paths).toContain("src/app.ts");
  expect(paths).toContain(".pi/plan/plan.md");
  expect(paths.filter(inWorkspaceDir)).toEqual([]);
});
