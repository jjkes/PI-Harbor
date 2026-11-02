import { isAutomationSession } from "./session-origin";
import { normalizeProjectPath } from "./sidebar-session-groups";

/** A renderer-only destination for the next local session. */
export type NewSessionScope = {
  projectPath: string;
  workspaceId: string;
};

/** The project/workspace pair sent to `session.create`. */
export type ResolvedNewSessionScope = {
  projectPath: string | null;
  workspaceId: string | null;
};

export type NewSessionScopeState = {
  workspace?: { path?: string | null } | null;
  activeSessionId?: string | null;
  sessions?: readonly {
    id: string;
    projectPath?: string | null;
    workspaceId?: string | null;
  }[];
  newSessionScope?: NewSessionScope | null;
};

export type NewSessionScopeOptions = {
  projectPath?: string | null;
  workspaceId?: string | null;
  isolated?: boolean;
};

/**
 * The durable binding of a session, or `null` for a project-root/temporary
 * session. A scope is only meaningful when it has both halves.
 */
export function sessionNewSessionScope(
  session:
    | { projectPath?: string | null; workspaceId?: string | null }
    | null
    | undefined,
): NewSessionScope | null {
  const projectPath = session?.projectPath?.trim();
  const workspaceId = session?.workspaceId?.trim();
  return projectPath && workspaceId ? { projectPath, workspaceId } : null;
}

/**
 * Resolve where a new local session belongs. An explicit `projectPath` means
 * the project root unless an explicit `workspaceId` accompanies it. With no
 * explicit request, the visible draft scope wins; selecting a session keeps
 * that scope synchronized with the session's durable binding. The active
 * session remains the fallback for callers that have no draft scope yet.
 *
 * A scope from another project is ignored, and temporary/isolated requests
 * never inherit a workspace binding.
 */
export function resolveNewSessionScope(
  state: NewSessionScopeState,
  options: NewSessionScopeOptions = {},
): ResolvedNewSessionScope {
  const hasProjectPath = Object.prototype.hasOwnProperty.call(options, "projectPath");
  const projectPath = hasProjectPath
    ? options.projectPath ?? null
    : state.workspace?.path ?? null;
  const root = { projectPath, workspaceId: null };
  if (options.isolated === true || !normalizeProjectPath(projectPath)) return root;

  if (Object.prototype.hasOwnProperty.call(options, "workspaceId")) {
    return { projectPath, workspaceId: options.workspaceId?.trim() || null };
  }
  if (hasProjectPath) return root;

  const scope = state.newSessionScope;
  if (
    scope?.workspaceId &&
    normalizeProjectPath(scope.projectPath) === normalizeProjectPath(projectPath)
  ) {
    return { projectPath, workspaceId: scope.workspaceId };
  }

  const active = state.sessions?.find((session) => session.id === state.activeSessionId);
  const activeScope = sessionNewSessionScope(active);
  if (
    activeScope &&
    normalizeProjectPath(activeScope.projectPath) === normalizeProjectPath(projectPath)
  ) {
    return { projectPath, workspaceId: activeScope.workspaceId };
  }
  return root;
}

/**
 * New Task empty-slot reuse (ADR 0113) and first-frame empty reveal (ADR 0154).
 *
 * Host `messageCount` is the durable empty predicate, but the renderer may
 * already know the latest session is no longer empty: a prompt can be
 * streaming, live in the transcript cache, or sitting in the submitted-draft
 * map before `session.list` refreshes. Those in-memory signals replace a
 * blocking list round-trip on New Task.
 */

export const EMPTY_SESSION_WINDOW = {
  messageStart: 0,
  hasMoreBefore: false,
} as const;

export function sessionIsReusableEmpty(
  session: {
    messageCount: number;
    worktree?: unknown;
    workspaceId?: string | null;
    scheduledRun?: boolean;
  },
  options: {
    running?: boolean;
    liveMessageCount?: number;
    submitted?: boolean;
    /** The request asks for an isolated session (ADR 0329). */
    isolated?: boolean;
    /**
     * Project workspace the request is bound to; `null`/absent asks for the
     * project root.
     */
    workspaceId?: string | null;
  } = {},
): boolean {
  // An isolated request always gets its own worktree, and an empty isolated
  // session is never handed out for an ordinary request (ADR 0329).
  if (options.isolated === true || session.worktree) return false;
  // The same rule for project workspaces (design §4.8): an empty session of
  // the project root must not answer a workspace request, and an empty
  // workspace session must not answer a project (or other workspace) request.
  if ((session.workspaceId ?? null) !== (options.workspaceId ?? null)) return false;
  // Automation transcripts (scheduled runs) are entered only from their
  // task view and must never be reused as an interactive empty slot (#1684).
  if (isAutomationSession(session)) return false;
  if (session.messageCount > 0) return false;
  if (options.running === true) return false;
  if ((options.liveMessageCount ?? 0) > 0) return false;
  if (options.submitted === true) return false;
  return true;
}
