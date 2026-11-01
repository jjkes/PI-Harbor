import { isAutomationSession } from "./session-origin";

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
