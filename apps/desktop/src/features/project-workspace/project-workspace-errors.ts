import {
  ProjectWorkspaceErrorCodes,
  WorktreeErrorCodes,
  type ProjectWorkspaceProbeResult,
} from "@pi-harbor/shared";
import type { TFunction } from "i18next";

/**
 * `WORKSPACE_*` and probe error codes mapped to catalog keys.
 *
 * Every code in the frozen contract has its own sentence, so the user is told
 * what to do instead of seeing a raw host message. Unknown codes fall back to
 * the host's own `message`, then to a generic sentence.
 */
const ERROR_KEYS: Record<string, string> = {
  [ProjectWorkspaceErrorCodes.NAME_INVALID]: "projectWorkspace.errors.nameInvalid",
  [ProjectWorkspaceErrorCodes.NAME_EXISTS]: "projectWorkspace.errors.nameExists",
  [ProjectWorkspaceErrorCodes.PATH_EXISTS]: "projectWorkspace.errors.pathExists",
  [ProjectWorkspaceErrorCodes.BRANCH_INVALID]: "projectWorkspace.errors.branchInvalid",
  [ProjectWorkspaceErrorCodes.BRANCH_IN_USE]: "projectWorkspace.errors.branchInUse",
  [ProjectWorkspaceErrorCodes.BRANCH_EXISTS]: "projectWorkspace.errors.branchExists",
  [ProjectWorkspaceErrorCodes.SOURCE_NOT_FOUND]: "projectWorkspace.errors.sourceNotFound",
  [ProjectWorkspaceErrorCodes.NO_REMOTE]: "projectWorkspace.errors.noRemote",
  [ProjectWorkspaceErrorCodes.FETCH_FAILED]: "projectWorkspace.errors.fetchFailed",
  [ProjectWorkspaceErrorCodes.NOT_FOUND]: "projectWorkspace.errors.notFound",
  [ProjectWorkspaceErrorCodes.NOT_READY]: "projectWorkspace.errors.notReady",
  [ProjectWorkspaceErrorCodes.MISSING]: "projectWorkspace.errors.missing",
  [ProjectWorkspaceErrorCodes.HAS_RUNNING_SESSIONS]:
    "projectWorkspace.errors.hasRunningSessions",
  [ProjectWorkspaceErrorCodes.ISOLATED_CONFLICT]:
    "projectWorkspace.errors.isolatedConflict",
  [ProjectWorkspaceErrorCodes.REMOTE_UNSUPPORTED]:
    "projectWorkspace.errors.remoteUnsupported",
  [ProjectWorkspaceErrorCodes.REPAIR_FAILED]: "projectWorkspace.errors.repairFailed",
};

/**
 * Probe refusals reuse the `WORKTREE_*` codes (the git requirements are the
 * same ones ADR 0329 probes for), but they get workspace wording.
 */
const PROBE_KEYS: Record<string, string> = {
  [WorktreeErrorCodes.NOT_GIT]: "projectWorkspace.probe.notGit",
  [WorktreeErrorCodes.NO_COMMITS]: "projectWorkspace.probe.noCommits",
  [WorktreeErrorCodes.DETACHED_HEAD]: "projectWorkspace.probe.detachedHead",
  [WorktreeErrorCodes.GIT_MISSING]: "projectWorkspace.probe.gitMissing",
  [WorktreeErrorCodes.GIT_TOO_OLD]: "projectWorkspace.probe.gitTooOld",
  [WorktreeErrorCodes.REMOTE_UNSUPPORTED]: "projectWorkspace.probe.remoteUnsupported",
  [ProjectWorkspaceErrorCodes.NO_REMOTE]: "projectWorkspace.probe.noRemote",
  [ProjectWorkspaceErrorCodes.REMOTE_UNSUPPORTED]:
    "projectWorkspace.probe.remoteUnsupported",
};

/** The machine-readable code of an API error; `invoke` stores it as `code`. */
export function projectWorkspaceErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; errorCode?: unknown };
  const code = typeof value.code === "string" ? value.code : value.errorCode;
  return typeof code === "string" ? code : undefined;
}

/** A localized sentence for a workspace failure. */
export function projectWorkspaceErrorMessage(error: unknown, t: TFunction): string {
  const key = ERROR_KEYS[projectWorkspaceErrorCode(error) ?? ""];
  if (key) return t(key);
  if (error instanceof Error && error.message.trim()) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.trim()
    ? message
    : t("projectWorkspace.errors.generic");
}

/** State of the create-entry probe: still running, answered, or failed. */
export type ProjectWorkspaceProbeState =
  | "checking"
  | "unknown"
  | ProjectWorkspaceProbeResult;

/**
 * Whether "New workspace…" is offered. Disabled while the probe runs and, with
 * the reason, for a non-git, commit-less, remote-only or remote-less project.
 * A failed probe leaves the item enabled: creating re-probes and reports why.
 */
export function projectWorkspaceAvailability(
  state: ProjectWorkspaceProbeState,
  t: TFunction,
): { disabled: boolean; reason?: string } {
  if (state === "checking") {
    return { disabled: true, reason: t("projectWorkspace.probe.checking") };
  }
  if (state === "unknown") return { disabled: false };
  if (state.available) {
    // A repository without a remote cannot source a workspace branch.
    return state.defaultRemote
      ? { disabled: false }
      : { disabled: true, reason: t("projectWorkspace.probe.noRemote") };
  }
  const key = PROBE_KEYS[state.errorCode];
  return {
    disabled: true,
    reason: key
      ? t(key)
      : state.message?.trim() || t("projectWorkspace.probe.unavailable"),
  };
}
