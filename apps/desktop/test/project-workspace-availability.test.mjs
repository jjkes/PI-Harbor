/**
 * Whether the project row offers "New workspace…", and which catalog sentence
 * explains a refusal (`apps/desktop/src/features/project-workspace/project-workspace-errors.ts`).
 *
 * The row is the only entry point of the feature, so this rule decides whether
 * the user can create a workspace at all. It used to disable the row while the
 * probe ran, which swallowed the click for as long as the probe took; the
 * "still probing" case below pins the fix.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { projectWorkspaceAvailability, projectWorkspaceErrorMessage } = await import(
  "../src/features/project-workspace/project-workspace-errors.ts"
);

/** Stand-in for `TFunction`: answers with the key, so assertions read as keys. */
const t = (key) => key;

test("the row stays clickable while the probe runs", () => {
  const result = projectWorkspaceAvailability("checking", t);
  assert.equal(result.disabled, false);
  // The hint is still offered, so a hover explains what is happening.
  assert.equal(result.reason, "projectWorkspace.probe.checking");
});

test("a failed probe leaves the row clickable", () => {
  assert.equal(projectWorkspaceAvailability("unknown", t).disabled, false);
});

test("an available project with a remote offers the row", () => {
  const result = projectWorkspaceAvailability(
    { available: true, defaultRemote: "origin", remotes: ["origin"] },
    t,
  );
  assert.equal(result.disabled, false);
  assert.equal(result.reason, undefined);
});

test("an available project without a remote is refused with the remote reason", () => {
  const result = projectWorkspaceAvailability(
    { available: true, defaultRemote: null, remotes: [] },
    t,
  );
  assert.equal(result.disabled, true);
  assert.equal(result.reason, "projectWorkspace.probe.noRemote");
});

test("a probe refusal is explained with its workspace wording", () => {
  const result = projectWorkspaceAvailability(
    { available: false, errorCode: "WORKTREE_NOT_GIT", message: "not a git repository" },
    t,
  );
  assert.equal(result.disabled, true);
  assert.equal(result.reason, "projectWorkspace.probe.notGit");
});

test("an unknown refusal code falls back to the host message", () => {
  const result = projectWorkspaceAvailability(
    { available: false, errorCode: "WORKTREE_SOMETHING_NEW", message: "host said why" },
    t,
  );
  assert.equal(result.disabled, true);
  assert.equal(result.reason, "host said why");
});

test("a failed fetch is reported with the cached-list sentence", () => {
  // `projectWorkspace.branches` answers `warning: { errorCode, message }`; the
  // dialog passes that object straight through, so the code has to win over
  // the host's English prose.
  assert.equal(
    projectWorkspaceErrorMessage({ errorCode: "WORKSPACE_FETCH_FAILED", message: "boom" }, t),
    "projectWorkspace.errors.fetchFailed",
  );
});
