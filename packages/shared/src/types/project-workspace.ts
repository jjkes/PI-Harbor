/**
 * Project workspaces: named git worktrees that live inside the project at
 * `.pi/worktree/<name>` and own their own sessions.
 *
 * Distinct from two neighbours that already use the word "workspace":
 * - `workspace.*` / `ProjectWorkspace` in `./workspace.js` is the *active
 *   project* of the window;
 * - `worktree.*` in `./worktree.js` is the per-session isolated worktree of
 *   ADR 0329, which is machine-named and stored outside the project.
 *
 * host-core owns every path and every git command. These shapes carry no
 * absolute path: `relativePath` is a display string rooted at the project.
 */

export type ProjectWorkspaceStatus = "creating" | "active" | "missing";

export type ProjectWorkspaceSetupStatus = "none" | "running" | "ok" | "failed";

/** A workspace node under a project in the sidebar. */
export type ProjectWorkspaceSummary = {
  id: string;
  /** Canonical path of the owning project. */
  projectPath: string;
  /** User-typed name; also the directory name under `.pi/worktree/`. */
  name: string;
  /** Project-relative location, for display only (`.pi/worktree/<name>`). */
  relativePath: string;
  /** Branch checked out in the workspace. */
  branch: string;
  /** Remote the workspace was created from (for example `origin`). */
  sourceRemote: string;
  /** Remote branch the workspace was created from. */
  sourceBranch: string;
  /** True when `branch` was created by this workspace rather than reused. */
  createdBranch: boolean;
  status: ProjectWorkspaceStatus;
  setupStatus?: ProjectWorkspaceSetupStatus | null;
  createdAt: string;
  updatedAt: string;
};

/** Machine-readable `errorCode` values of `projectWorkspace.*`. */
export const ProjectWorkspaceErrorCodes = {
  /** Name is not a single safe path segment (length, separators, reserved). */
  NAME_INVALID: "WORKSPACE_NAME_INVALID",
  /** Another workspace of this project already uses the name. */
  NAME_EXISTS: "WORKSPACE_NAME_EXISTS",
  /** `.pi/worktree/<name>` already exists on disk. */
  PATH_EXISTS: "WORKSPACE_PATH_EXISTS",
  /** Branch name rejected by `git check-ref-format --branch`. */
  BRANCH_INVALID: "WORKSPACE_BRANCH_INVALID",
  /** The branch is already checked out in another worktree or the project. */
  BRANCH_IN_USE: "WORKSPACE_BRANCH_IN_USE",
  /** `createBranch` was requested but a local branch of that name exists. */
  BRANCH_EXISTS: "WORKSPACE_BRANCH_EXISTS",
  /** The chosen remote branch does not exist locally as a tracking ref. */
  SOURCE_NOT_FOUND: "WORKSPACE_SOURCE_NOT_FOUND",
  /** The repository has no remote to create a workspace from. */
  NO_REMOTE: "WORKSPACE_NO_REMOTE",
  /** `git fetch` failed; the cached remote-tracking refs are still usable. */
  FETCH_FAILED: "WORKSPACE_FETCH_FAILED",
  /** No workspace row with that id. */
  NOT_FOUND: "WORKSPACE_NOT_FOUND",
  /** The workspace is still being created. */
  NOT_READY: "WORKSPACE_NOT_READY",
  /** The workspace folder no longer exists; sessions refuse to run. */
  MISSING: "WORKSPACE_MISSING",
  /** Delete refused while one of the workspace's sessions is running. */
  HAS_RUNNING_SESSIONS: "WORKSPACE_HAS_RUNNING_SESSIONS",
  /** A session cannot be both workspace-bound and isolated (ADR 0329). */
  ISOLATED_CONFLICT: "WORKSPACE_ISOLATED_CONFLICT",
  /** Remote-host projects run their tools elsewhere; no local checkout. */
  REMOTE_UNSUPPORTED: "WORKSPACE_REMOTE_UNSUPPORTED",
  /** Repair cannot re-create the checkout because its branch is gone. */
  REPAIR_FAILED: "WORKSPACE_REPAIR_FAILED",
} as const;

export type ProjectWorkspaceErrorCode =
  (typeof ProjectWorkspaceErrorCodes)[keyof typeof ProjectWorkspaceErrorCodes];

/**
 * `projectWorkspace.probe`: whether the project can host workspaces. The
 * unavailable arm reuses the `WORKTREE_*` probe codes, because the git
 * requirements (git >= 2.29, non-bare, has commits, not detached) are the
 * same ones ADR 0329 already probes for.
 */
export type ProjectWorkspaceProbeResult =
  | {
      available: true;
      /** Remote names, `origin` first when present. */
      remotes: string[];
      /** Preselected remote, or `null` when the repository has none. */
      defaultRemote: string | null;
    }
  | { available: false; errorCode: string; message: string };

/** `projectWorkspace.branches`: the source-branch picker's data. */
export type ProjectWorkspaceBranches = {
  remote: string;
  remotes: string[];
  /** Short branch names under `refs/remotes/<remote>`, `origin/HEAD` removed. */
  branches: string[];
  /** The remote's default branch, when `refs/remotes/<remote>/HEAD` is set. */
  defaultBranch: string | null;
  /** Last source branch the user picked for this project, when still listed. */
  lastUsedBranch: string | null;
  /** True when this call ran `git fetch`. */
  fetched: boolean;
  /** Epoch ms of the last successful fetch, when host-core recorded one. */
  lastFetchedAt: number | null;
  /** Set when a requested fetch failed and the cached list is shown instead. */
  warning: { errorCode: string; message: string } | null;
};

export type ProjectWorkspaceCreateInput = {
  projectPath: string;
  name: string;
  remote?: string;
  sourceBranch: string;
  /** Create `newBranch` from the source branch instead of checking it out. */
  createBranch?: boolean;
  newBranch?: string;
};

export type CreatedProjectWorkspace = {
  workspace: ProjectWorkspaceSummary;
  /** Files copied in from `.worktreeinclude`, as for isolated worktrees. */
  included: { copied: string[]; skippedLinks: string[] };
};

/** `projectWorkspace.pendingWork`: what deleting the workspace would lose. */
export type ProjectWorkspacePendingWork = {
  sessions: number;
  runningSessions: number;
  uncommittedChanges: boolean;
  /** Commits on the workspace branch that its upstream does not have. */
  unpushedCommits: number;
  /** False when the folder is missing, so git could not be consulted. */
  gitReadable: boolean;
};

export type ProjectWorkspaceDeleteInput = {
  workspaceId: string;
  /** Delete the local branch as well. Off by default. */
  deleteBranch?: boolean;
  /** Keep the checkout on disk and only drop it from the list. */
  keepFolder?: boolean;
};

export type ProjectWorkspaceDeleteOutcome = {
  removed: boolean;
  sessionsRemoved: number;
  /** True when the folder was left on disk (`keepFolder`, or already gone). */
  folderKept: boolean;
  branchDeleted: boolean;
};

export type ProjectWorkspaceSetupLog = {
  setupStatus: ProjectWorkspaceSetupStatus | null;
  log: string | null;
};
