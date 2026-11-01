/**
 * Pure form logic of the "New workspace" dialog (design §4.8): which source
 * branch is preselected once a branch list arrives, and whether Create may be
 * pressed.
 *
 * Kept out of the component so both rules can be unit-tested without a DOM;
 * the dialog only owns the state and maps the returned problems to catalog
 * keys.
 */

import type { ProjectWorkspaceBranches } from "@pi-harbor/shared";
import {
  type ProjectWorkspaceBranchProblem,
  type ProjectWorkspaceNameProblem,
  projectWorkspaceBranchProblem,
  projectWorkspaceNameProblem,
} from "./project-workspace-names";

/**
 * The source branch to show after a branch list loads.
 *
 * A branch the user already picked is kept whenever it is still listed, so a
 * refresh never moves the selection under them. Otherwise the host's
 * remembered branch for this project wins, then the remote's default branch,
 * and the first listed branch is the last resort.
 *
 * `lastUsedBranch` is consulted *instead of* `defaultBranch`, not before it:
 * when the host remembers a branch that the remote no longer lists, the
 * selection falls through to the first branch rather than to the default.
 */
export function pickProjectWorkspaceSourceBranch(
  current: string,
  list: Pick<
    ProjectWorkspaceBranches,
    "branches" | "defaultBranch" | "lastUsedBranch"
  >,
): string {
  if (current && list.branches.includes(current)) return current;
  const preferred = list.lastUsedBranch ?? list.defaultBranch;
  if (preferred && list.branches.includes(preferred)) return preferred;
  return list.branches[0] ?? "";
}

/** What the user has typed into the create dialog. */
export type ProjectWorkspaceCreateForm = {
  name: string;
  /** Source branch chosen in the picker; empty while none is selected. */
  sourceBranch: string;
  createBranch: boolean;
  newBranch: string;
  /** A create request is already in flight. */
  busy: boolean;
};

/** Inline problems of the typed values, and whether Create may be pressed. */
export type ProjectWorkspaceCreateFormState = {
  nameProblem: ProjectWorkspaceNameProblem | null;
  /** `null` while "Create new branch" is unchecked: the field is unused. */
  branchProblem: ProjectWorkspaceBranchProblem | null;
  canSubmit: boolean;
};

/**
 * Create needs a usable name, a chosen source branch, a valid new branch name
 * when one is being created, and no request already in flight.
 */
export function projectWorkspaceCreateFormState(
  form: ProjectWorkspaceCreateForm,
): ProjectWorkspaceCreateFormState {
  const nameProblem = projectWorkspaceNameProblem(form.name);
  const branchProblem = form.createBranch
    ? projectWorkspaceBranchProblem(form.newBranch)
    : null;
  return {
    nameProblem,
    branchProblem,
    canSubmit:
      !form.busy &&
      !nameProblem &&
      !branchProblem &&
      form.sourceBranch.length > 0,
  };
}
