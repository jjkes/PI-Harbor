/**
 * Pure form logic of the "New workspace" dialog: source-branch preselection
 * and the Create enable rule
 * (`apps/desktop/src/features/project-workspace/project-workspace-create-form.ts`).
 *
 * Both run on every render of the dialog and decide what the user can submit,
 * so they are pinned here instead of through the component tree.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { pickProjectWorkspaceSourceBranch, projectWorkspaceCreateFormState } =
  await import("../src/features/project-workspace/project-workspace-create-form.ts");

/** A branch list as `getProjectWorkspaceBranches` returns it. */
const branchList = (overrides = {}) => ({
  remote: "origin",
  branches: ["main", "develop", "feature/one"],
  defaultBranch: "main",
  lastUsedBranch: null,
  warning: null,
  ...overrides,
});

test("the branch the host remembers wins the preselection", () => {
  const list = branchList({ lastUsedBranch: "feature/one" });
  assert.equal(pickProjectWorkspaceSourceBranch("", list), "feature/one");
});

test("the remote default branch is preselected when none was used before", () => {
  assert.equal(pickProjectWorkspaceSourceBranch("", branchList()), "main");
});

test("a last-used branch that is no longer listed is ignored", () => {
  // The remembered branch is gone from the remote, so it must not be
  // preselected. The current rule then falls through to the first listed
  // branch rather than back to the default.
  const list = branchList({ lastUsedBranch: "deleted/branch" });
  assert.equal(pickProjectWorkspaceSourceBranch("", list), "main");
  const reordered = branchList({
    branches: ["develop", "main"],
    lastUsedBranch: "deleted/branch",
  });
  assert.equal(pickProjectWorkspaceSourceBranch("", reordered), "develop");
});

test("a branch the user already picked survives a refresh", () => {
  const list = branchList({ lastUsedBranch: "feature/one" });
  assert.equal(pickProjectWorkspaceSourceBranch("develop", list), "develop");
  // Unless the refresh dropped it from the remote.
  assert.equal(pickProjectWorkspaceSourceBranch("gone", list), "feature/one");
});

test("the first listed branch is the last resort, and an empty list selects nothing", () => {
  const noDefault = branchList({ defaultBranch: null });
  assert.equal(pickProjectWorkspaceSourceBranch("", noDefault), "main");
  const unlistedDefault = branchList({
    branches: ["develop"],
    defaultBranch: "main",
  });
  assert.equal(pickProjectWorkspaceSourceBranch("", unlistedDefault), "develop");
  const empty = branchList({ branches: [], defaultBranch: null });
  assert.equal(pickProjectWorkspaceSourceBranch("", empty), "");
});

/** A form the dialog would let the user submit. */
const submittable = (overrides = {}) => ({
  name: "my-workspace",
  sourceBranch: "main",
  createBranch: false,
  newBranch: "",
  busy: false,
  ...overrides,
});

test("Create needs a usable name and a chosen source branch", () => {
  const ready = projectWorkspaceCreateFormState(submittable());
  assert.deepEqual(ready, {
    nameProblem: null,
    branchProblem: null,
    canSubmit: true,
  });

  const noName = projectWorkspaceCreateFormState(submittable({ name: "" }));
  assert.equal(noName.nameProblem, "required");
  assert.equal(noName.canSubmit, false);

  // A name only the host used to catch keeps Create disabled now.
  const forbidden = projectWorkspaceCreateFormState(submittable({ name: "a:b" }));
  assert.equal(forbidden.nameProblem, "forbidden");
  assert.equal(forbidden.canSubmit, false);

  // No branch list loaded yet, or an empty one.
  const noBranch = projectWorkspaceCreateFormState(submittable({ sourceBranch: "" }));
  assert.equal(noBranch.canSubmit, false);
});

test("the new-branch name is only validated while Create new branch is checked", () => {
  // Unchecked: whatever the field holds is unused, so it cannot block Create.
  const unchecked = projectWorkspaceCreateFormState(
    submittable({ newBranch: "not a branch" }),
  );
  assert.equal(unchecked.branchProblem, null);
  assert.equal(unchecked.canSubmit, true);

  const checkedEmpty = projectWorkspaceCreateFormState(
    submittable({ createBranch: true, newBranch: "" }),
  );
  assert.equal(checkedEmpty.branchProblem, "required");
  assert.equal(checkedEmpty.canSubmit, false);

  const checkedInvalid = projectWorkspaceCreateFormState(
    submittable({ createBranch: true, newBranch: "has space" }),
  );
  assert.equal(checkedInvalid.branchProblem, "invalid");
  assert.equal(checkedInvalid.canSubmit, false);

  const checkedValid = projectWorkspaceCreateFormState(
    submittable({ createBranch: true, newBranch: "feature/two" }),
  );
  assert.equal(checkedValid.branchProblem, null);
  assert.equal(checkedValid.canSubmit, true);
});

test("Create stays disabled while a request is in flight", () => {
  const busy = projectWorkspaceCreateFormState(submittable({ busy: true }));
  assert.equal(busy.nameProblem, null);
  assert.equal(busy.canSubmit, false);
});
