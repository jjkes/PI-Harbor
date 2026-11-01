#!/usr/bin/env node
/**
 * Protocol-level E2E for project workspaces (named git worktrees at
 * `<project>/.pi/worktree/<name>` that own their own sessions).
 *
 * A real host-core, a throwaway git repository with a local bare "remote", and
 * a throwaway data directory. No model, no network, no inference: every
 * assertion is about host-owned git state, the `projectWorkspace.*` contract,
 * and where a session's tools resolve their root.
 *
 * Nothing outside the temporary directory is touched: `HOME`, `GIT_CONFIG_*`,
 * and the data directory are all redirected into it.
 *
 * Build host-core first (`cargo build -p host-core`) or set PI_HARBOR_HOST_BIN.
 * Optional: PI_HARBOR_KEEP_TEMP=1 keeps the scratch directory for inspection.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { assert, errorCodeOf, errorText, shortJson } from "./e2e/assert.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const scratch = mkdtempSync(join(tmpdir(), "pi-project-workspace-e2e-"));
const home = join(scratch, "home");
const dataDir = join(scratch, "data");
const originPath = join(scratch, "origin.git");
const projectPath = join(scratch, "project");
mkdirSync(home, { recursive: true });
mkdirSync(dataDir, { recursive: true });

/** Git with the user's own configuration and prompts kept out of the run. */
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

const results = [];
let failed = 0;
async function step(name, run) {
  try {
    await run();
    results.push(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    results.push(`  FAIL  ${name}: ${errorText(error)}`);
  }
}

/** A `projectWorkspace.*` call that must fail with one of `codes`. */
async function expectCode(call, codes, label) {
  let value;
  try {
    value = await call();
  } catch (error) {
    const code = errorCodeOf(error);
    assert(codes.includes(code), `${label}: expected ${codes.join("/")}, got ${errorText(error)}`);
    return;
  }
  throw new Error(`${label}: expected ${codes.join("/")}, call succeeded with ${shortJson(value)}`);
}

// ---- fixture repository ----------------------------------------------------
// A bare repository stands in for `origin`, so remote-tracking refs, `fetch`,
// and `origin/HEAD` all behave like a real clone without touching the network.
git(scratch, ["init", "--bare", "-b", "main", originPath]);
git(scratch, ["clone", originPath, projectPath]);
git(projectPath, ["config", "user.name", "E2E"]);
git(projectPath, ["config", "user.email", "e2e@example.invalid"]);
writeFileSync(join(projectPath, "README.md"), "# fixture\n");
// `.worktreeinclude` selects local files that git already ignores, so both rule
// files are committed and `.env` stays untracked and ignored.
writeFileSync(join(projectPath, ".gitignore"), ".env\n");
writeFileSync(join(projectPath, ".worktreeinclude"), ".env\n");
git(projectPath, ["add", "README.md", ".gitignore", ".worktreeinclude"]);
git(projectPath, ["commit", "-m", "initial commit"]);
git(projectPath, ["push", "-u", "origin", "main"]);
writeFileSync(join(projectPath, ".env"), "TOKEN=1\n");
// A second remote branch to create a workspace from.
git(projectPath, ["checkout", "-q", "-b", "feature/one"]);
writeFileSync(join(projectPath, "feature.txt"), "feature\n");
git(projectPath, ["add", "feature.txt"]);
git(projectPath, ["commit", "-m", "feature commit"]);
git(projectPath, ["push", "-u", "origin", "feature/one"]);
// A third remote branch used for the "local branch already exists" case.
git(projectPath, ["checkout", "-q", "-b", "feature/taken"]);
git(projectPath, ["commit", "--allow-empty", "-m", "taken commit"]);
git(projectPath, ["push", "-u", "origin", "feature/taken"]);
git(projectPath, ["checkout", "-q", "main"]);
git(projectPath, ["remote", "set-head", "origin", "-a"]);
// `feature/taken` stays as a local branch; `feature/one` does not.
git(projectPath, ["branch", "-D", "feature/one"]);

const host = new Host(resolveHostBinary(), dataDir, { quiet: true });
let exitCode = 1;
try {
  await host.start(PROTOCOL_VERSION);
  await host.call("workspace.set", { path: projectPath });

  // ---- probe and branch enumeration ---------------------------------------
  await step("probe reports the project can host workspaces", async () => {
    const probe = await host.call("projectWorkspace.probe", { projectPath });
    assert(probe.available === true, `probe not available: ${shortJson(probe)}`);
    assert(Array.isArray(probe.remotes) && probe.remotes.includes("origin"), shortJson(probe));
    assert(probe.defaultRemote === "origin", shortJson(probe));
  });

  await step("branches lists remote branches without origin/HEAD", async () => {
    const listed = await host.call("projectWorkspace.branches", { projectPath });
    assert(listed.remote === "origin", shortJson(listed));
    for (const expected of ["main", "feature/one", "feature/taken"]) {
      assert(listed.branches.includes(expected), `missing ${expected}: ${shortJson(listed)}`);
    }
    assert(!listed.branches.includes("HEAD"), `origin/HEAD leaked: ${shortJson(listed)}`);
    assert(listed.defaultBranch === "main", shortJson(listed));
  });

  await step("branches with refresh fetches without failing offline", async () => {
    const refreshed = await host.call("projectWorkspace.branches", { projectPath, refresh: true });
    assert(refreshed.branches.includes("feature/one"), shortJson(refreshed));
    assert(refreshed.stale !== true, `fetch against a local remote must not be stale: ${shortJson(refreshed)}`);
  });

  // ---- create from an existing remote branch ------------------------------
  let reviewWorkspace;
  await step("create materializes .pi/worktree/<name> on the source branch", async () => {
    const created = await host.call("projectWorkspace.create", {
      projectPath,
      name: "review",
      remote: "origin",
      sourceBranch: "feature/one",
    });
    reviewWorkspace = created.workspace;
    assert(reviewWorkspace?.id, `no workspace returned: ${shortJson(created)}`);
    assert(reviewWorkspace.name === "review", shortJson(reviewWorkspace));
    assert(reviewWorkspace.relativePath === ".pi/worktree/review", shortJson(reviewWorkspace));
    assert(reviewWorkspace.branch === "feature/one", shortJson(reviewWorkspace));
    assert(reviewWorkspace.createdBranch === false, shortJson(reviewWorkspace));
    assert(reviewWorkspace.status === "active", shortJson(reviewWorkspace));
    const root = join(projectPath, ".pi", "worktree", "review");
    assert(existsSync(join(root, "feature.txt")), "the source branch content is missing");
    assert(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) === "feature/one", "wrong branch checked out");
  });

  await step("the parent checkout stays clean and the exclude block is managed", async () => {
    assert(git(projectPath, ["status", "--porcelain"]) === "", "the workspace polluted git status");
    assert(git(projectPath, ["ls-files", "-o", "--exclude-standard"]) === "", "the workspace is an untracked file");
    const exclude = readFileSync(join(projectPath, ".git", "info", "exclude"), "utf8");
    assert(exclude.includes("/.pi/worktree/"), `info/exclude has no managed rule: ${exclude}`);
  });

  await step("the workspace worktree is locked against prune", async () => {
    const listed = git(projectPath, ["worktree", "list", "--porcelain"]);
    const block = listed.split("\n\n").find((entry) => entry.includes(join(".pi", "worktree", "review")));
    assert(block, `the workspace is not a registered worktree: ${listed}`);
    assert(block.includes("locked"), `the workspace worktree is not locked: ${block}`);
  });

  // ---- create a new branch -----------------------------------------------
  let draftWorkspace;
  await step("create with createBranch starts a new branch with no upstream", async () => {
    const created = await host.call("projectWorkspace.create", {
      projectPath,
      name: "draft",
      remote: "origin",
      sourceBranch: "main",
      createBranch: true,
      newBranch: "feat/draft",
    });
    draftWorkspace = created.workspace;
    assert(draftWorkspace.branch === "feat/draft", shortJson(draftWorkspace));
    assert(draftWorkspace.createdBranch === true, shortJson(draftWorkspace));
    const root = join(projectPath, ".pi", "worktree", "draft");
    assert(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) === "feat/draft", "wrong branch checked out");
    // `--no-track`: a default-tracking branch would make `git push` fail with
    // an upstream-name mismatch.
    let upstream = "";
    try {
      upstream = git(root, ["rev-parse", "--abbrev-ref", "feat/draft@{upstream}"]);
    } catch {
      upstream = "";
    }
    assert(upstream === "", `the new branch must have no upstream, got ${upstream}`);
  });

  // ---- validation and conflict codes -------------------------------------
  await step("a duplicate name is refused", () =>
    expectCode(
      // On a new branch, so the name is the only conflict left: `main` itself
      // is checked out by the project and would be refused first.
      () => host.call("projectWorkspace.create", {
        projectPath, name: "review", remote: "origin", sourceBranch: "main",
        createBranch: true, newBranch: "review-again",
      }),
      ["WORKSPACE_NAME_EXISTS", "WORKSPACE_PATH_EXISTS"],
      "duplicate name",
    ));

  await step("an unsafe name is refused", async () => {
    for (const name of ["../escape", "a/b", ".hidden", "", "x".repeat(65)]) {
      await expectCode(
        () => host.call("projectWorkspace.create", { projectPath, name, remote: "origin", sourceBranch: "main" }),
        ["WORKSPACE_NAME_INVALID"],
        `name ${JSON.stringify(name)}`,
      );
    }
  });

  await step("an invalid new branch name is refused", () =>
    expectCode(
      () => host.call("projectWorkspace.create", {
        projectPath, name: "badbranch", remote: "origin", sourceBranch: "main",
        createBranch: true, newBranch: "bad branch..name",
      }),
      ["WORKSPACE_BRANCH_INVALID"],
      "invalid branch name",
    ));

  await step("a branch already checked out elsewhere is refused", () =>
    expectCode(
      () => host.call("projectWorkspace.create", { projectPath, name: "mainagain", remote: "origin", sourceBranch: "main" }),
      ["WORKSPACE_BRANCH_IN_USE"],
      "branch in use by the project checkout",
    ));

  await step("createBranch onto an existing local branch is refused", () =>
    expectCode(
      () => host.call("projectWorkspace.create", {
        projectPath, name: "exists", remote: "origin", sourceBranch: "main",
        createBranch: true, newBranch: "feature/taken",
      }),
      ["WORKSPACE_BRANCH_EXISTS"],
      "new branch already exists",
    ));

  await step("an unknown source branch is refused", () =>
    expectCode(
      () => host.call("projectWorkspace.create", { projectPath, name: "nosuch", remote: "origin", sourceBranch: "no/such/branch" }),
      ["WORKSPACE_SOURCE_NOT_FOUND"],
      "unknown source branch",
    ));

  await step("no directory is left behind by a refused create", () => {
    for (const name of ["mainagain", "exists", "nosuch", "badbranch"]) {
      assert(!existsSync(join(projectPath, ".pi", "worktree", name)), `${name} was left on disk`);
    }
  });

  // ---- list ---------------------------------------------------------------
  await step("list returns both workspaces for the project", async () => {
    const listed = await host.call("projectWorkspace.list", { projectPath });
    const names = listed.workspaces.map((entry) => entry.name).sort();
    assert(names.join(",") === "draft,review", shortJson(listed));
  });

  // `tools.execute` runs Bash only when the caller names the shell it expects,
  // so a settings change between planning and running cannot swap it.
  const runBash = async (sessionId, turnId, toolCallId) => {
    const { effective: shell } = await host.call("commandShells.list");
    assert(shell?.id, `no effective command shell: ${shortJson(shell)}`);
    return host.call("tools.execute", {
      sessionId,
      turnId,
      toolCallId,
      toolName: "Bash",
      // `cd` prints the working directory in cmd; `pwd` does in every other shell.
      args: { command: shell.dialect === "cmd" ? "cd" : "pwd" },
      mode: "agent",
      timeoutMs: 30_000,
      expectedCommandShellId: shell.id,
      expectedCommandShellDialect: shell.dialect,
    });
  };

  // ---- session binding ----------------------------------------------------
  await step("a workspace session runs in the workspace, a project session in the project", async () => {
    const inWorkspace = await host.call("session.create", {
      title: "Workspace session",
      mode: "agent",
      projectPath,
      workspaceId: reviewWorkspace.id,
    });
    const workspaceSession = inWorkspace.session ?? inWorkspace;
    assert(workspaceSession.workspaceId === reviewWorkspace.id, shortJson(workspaceSession));

    const inProject = await host.call("session.create", {
      title: "Project session",
      mode: "agent",
      projectPath,
    });
    const projectSession = inProject.session ?? inProject;
    assert(!projectSession.workspaceId, `a project session must not be bound: ${shortJson(projectSession)}`);

    // The tool root is derived by the host from the binding, never sent by a
    // client. `Bash` reports where it actually ran.
    const cwdOf = async (sessionId, toolCallId) => {
      // `session.create` takes no permission mode (only `session.configure`
      // does); Bash runs unattended once the session is in `auto`.
      await host.call("session.configure", { id: sessionId, mode: "agent", permissionMode: "auto" });
      const turn = await host.call("session.beginTurn", { sessionId });
      try {
        const result = await runBash(sessionId, turn.turnId, toolCallId);
        assert(result.ok, `Bash failed: ${shortJson(result)}`);
        const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
        return text;
      } finally {
        await host.call("session.endTurn", { turnId: turn.turnId, status: "completed", createNotification: false });
      }
    };

    const workspaceCwd = await cwdOf(workspaceSession.id, "ws-pwd");
    assert(
      workspaceCwd.includes(join(".pi", "worktree", "review")),
      `the workspace session ran outside its workspace: ${workspaceCwd}`,
    );
    const projectCwd = await cwdOf(projectSession.id, "proj-pwd");
    assert(
      !projectCwd.includes(join(".pi", "worktree")),
      `the project session ran inside a workspace: ${projectCwd}`,
    );

    await host.call("session.delete", { id: workspaceSession.id });
    await host.call("session.delete", { id: projectSession.id });
  });

  await step("a session cannot be both workspace-bound and isolated", () =>
    expectCode(
      () => host.call("session.create", {
        title: "Both", mode: "agent", projectPath,
        workspaceId: reviewWorkspace.id, isolated: true,
      }),
      ["WORKSPACE_ISOLATED_CONFLICT"],
      "workspaceId + isolated",
    ));

  await step("an unknown workspace id is refused", () =>
    expectCode(
      () => host.call("session.create", {
        title: "Ghost", mode: "agent", projectPath, workspaceId: "does-not-exist",
      }),
      ["WORKSPACE_NOT_FOUND"],
      "unknown workspaceId",
    ));

  // ---- restart reconciliation --------------------------------------------
  await step("a restart keeps both workspaces usable", async () => {
    await host.restart(PROTOCOL_VERSION);
    await host.call("workspace.set", { path: projectPath });
    const listed = await host.call("projectWorkspace.list", { projectPath });
    assert(listed.workspaces.length === 2, shortJson(listed));
    for (const entry of listed.workspaces) {
      assert(entry.status === "active", `${entry.name} is ${entry.status}: ${shortJson(entry)}`);
    }
  });

  // ---- missing folder and repair -----------------------------------------
  await step("a removed folder becomes missing and refuses to run sessions", async () => {
    rmSync(join(projectPath, ".pi", "worktree", "draft"), { recursive: true, force: true });
    await host.restart(PROTOCOL_VERSION);
    await host.call("workspace.set", { path: projectPath });
    const listed = await host.call("projectWorkspace.list", { projectPath });
    const draft = listed.workspaces.find((entry) => entry.name === "draft");
    assert(draft?.status === "missing", `draft is not missing: ${shortJson(listed)}`);

    const created = await host.call("session.create", {
      title: "Missing workspace session", mode: "agent", projectPath,
      workspaceId: draft.id, permissionMode: "auto",
    });
    const session = created.session ?? created;
    const turn = await host.call("session.beginTurn", { sessionId: session.id });
    try {
      await expectCode(
        () => runBash(session.id, turn.turnId, "missing-pwd"),
        ["WORKSPACE_MISSING"],
        "tools in a missing workspace",
      );
    } finally {
      await host.call("session.endTurn", { turnId: turn.turnId, status: "completed", createNotification: false });
      await host.call("session.delete", { id: session.id });
    }
  });

  await step("repair re-creates the checkout from the recorded branch", async () => {
    const listed = await host.call("projectWorkspace.list", { projectPath });
    const draft = listed.workspaces.find((entry) => entry.name === "draft");
    const repaired = await host.call("projectWorkspace.repair", { workspaceId: draft.id });
    const workspace = repaired.workspace ?? repaired;
    assert(workspace.status === "active", shortJson(workspace));
    const root = join(projectPath, ".pi", "worktree", "draft");
    assert(existsSync(root), "repair did not re-create the directory");
    assert(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) === "feat/draft", "repair checked out the wrong branch");
    // The files `.worktreeinclude` selects are copied again, as on create.
    const restored = join(root, ".env");
    assert(
      existsSync(restored) && readFileSync(restored, "utf8") === "TOKEN=1\n",
      "repair did not restore the .worktreeinclude files",
    );
  });

  // ---- delete -------------------------------------------------------------
  await step("delete removes the checkout and keeps the branch by default", async () => {
    const listed = await host.call("projectWorkspace.list", { projectPath });
    const draft = listed.workspaces.find((entry) => entry.name === "draft");
    const pending = await host.call("projectWorkspace.pendingWork", { workspaceId: draft.id });
    assert(typeof pending.sessions === "number", shortJson(pending));
    await host.call("projectWorkspace.delete", { workspaceId: draft.id });
    assert(!existsSync(join(projectPath, ".pi", "worktree", "draft")), "the directory survived the delete");
    const branches = git(projectPath, ["branch", "--list", "feat/draft"]);
    assert(branches.trim() !== "", "the branch must survive a default delete");
    const after = await host.call("projectWorkspace.list", { projectPath });
    assert(!after.workspaces.some((entry) => entry.name === "draft"), shortJson(after));
    assert(git(projectPath, ["status", "--porcelain"]) === "", "delete left the parent dirty");
  });

  await step("delete with keepFolder leaves the directory on disk", async () => {
    const created = await host.call("projectWorkspace.create", {
      projectPath, name: "keeper", remote: "origin", sourceBranch: "feature/taken",
    });
    const keeper = created.workspace;
    const root = join(projectPath, ".pi", "worktree", "keeper");
    await host.call("projectWorkspace.delete", { workspaceId: keeper.id, keepFolder: true });
    assert(existsSync(root), "keepFolder deleted the directory anyway");
    const listed = await host.call("projectWorkspace.list", { projectPath });
    assert(!listed.workspaces.some((entry) => entry.name === "keeper"), shortJson(listed));
    // The managed exclude rule still hides the kept checkout from the parent.
    assert(git(projectPath, ["status", "--porcelain"]) === "", "the kept folder dirtied the parent");
  });

  await step("re-adding the project re-adopts its registered workspaces", async () => {
    await host.call("projects.remove", { path: projectPath });
    await host.call("workspace.set", { path: projectPath });
    const listed = await host.call("projectWorkspace.list", { projectPath });
    const names = listed.workspaces.map((entry) => entry.name);
    assert(names.includes("review"), `the registered workspace was not re-adopted: ${shortJson(listed)}`);
    // "Remove from list" also unregistered the checkout from git, so it stays
    // removed even though its files are still on disk.
    assert(!names.includes("keeper"), `a removed workspace came back: ${shortJson(listed)}`);
    assert(existsSync(join(projectPath, ".pi", "worktree", "keeper")), "the kept folder vanished");
  });

  await step("delete with deleteBranch removes the branch the workspace created", async () => {
    const created = await host.call("projectWorkspace.create", {
      projectPath, name: "scratch", remote: "origin", sourceBranch: "main",
      createBranch: true, newBranch: "feat/scratch",
    });
    assert(git(projectPath, ["branch", "--list", "feat/scratch"]).trim() !== "", "the new branch is missing");
    await host.call("projectWorkspace.delete", { workspaceId: created.workspace.id, deleteBranch: true });
    const branches = git(projectPath, ["branch", "--list", "feat/scratch"]);
    assert(branches.trim() === "", `the branch survived deleteBranch: ${branches}`);
    assert(!existsSync(join(projectPath, ".pi", "worktree", "scratch")), "the directory survived the delete");
  });

  await step("removing the last workspace prunes the managed exclude block", async () => {
    // The kept folder still holds a checkout, which keeps the rule alive.
    rmSync(join(projectPath, ".pi", "worktree", "keeper"), { recursive: true, force: true });
    const listed = await host.call("projectWorkspace.list", { projectPath });
    for (const entry of listed.workspaces) {
      await host.call("projectWorkspace.delete", { workspaceId: entry.id });
    }
    const exclude = readFileSync(join(projectPath, ".git", "info", "exclude"), "utf8");
    assert(!exclude.includes("/.pi/worktree/"), `the managed rule was not pruned: ${exclude}`);
    assert(git(projectPath, ["status", "--porcelain"]) === "", "the project is dirty after cleanup");
  });

  exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  failed += 1;
  results.push(`  FAIL  harness: ${errorText(error)}`);
  exitCode = 1;
} finally {
  await host.stop().catch(() => {});
  console.log("project workspaces E2E");
  for (const line of results) console.log(line);
  const passed = results.filter((line) => line.startsWith("  PASS")).length;
  console.log(`${passed} passed, ${failed} failed`);
  if (process.env.PI_HARBOR_KEEP_TEMP) console.log(`scratch kept at ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}

process.exit(exitCode);
