import type { PlanProposal } from "@pi-harbor/shared";
import type { AskQueues } from "./pending-asks";
import type { PermissionQueues } from "./pending-permissions";

/** A decision a session is blocked on until the user answers it. */
export type InputRequestKind = "ask" | "permission" | "plan";

/** The renderer queues that hold every open decision, keyed by session. */
export type InputRequestQueues = {
  pendingAsks: AskQueues;
  pendingPermissions: PermissionQueues;
  pendingPlans: Readonly<Record<string, PlanProposal>>;
};

/**
 * Whether `sessionId` still has an open request of `kind`. Ask and permission
 * queues drop a session's key once they are empty; a plan counts only while
 * its proposal is still `pending`, the same test the approval bar uses.
 */
export function hasPendingInputRequest(
  queues: InputRequestQueues,
  sessionId: string,
  kind: InputRequestKind,
): boolean {
  switch (kind) {
    case "ask":
      return (queues.pendingAsks[sessionId]?.length ?? 0) > 0;
    case "permission":
      return (queues.pendingPermissions[sessionId]?.length ?? 0) > 0;
    case "plan":
      return queues.pendingPlans[sessionId]?.status === "pending";
  }
}

/**
 * Whether the session waits on the user's own input: a question to answer or a
 * plan to review. Tool approval has its own sidebar state.
 */
export function sessionAwaitsInput(
  queues: InputRequestQueues,
  sessionId: string,
): boolean {
  return (
    hasPendingInputRequest(queues, sessionId, "ask") ||
    hasPendingInputRequest(queues, sessionId, "plan")
  );
}

/**
 * The conversation the user is looking at, or `null` off the chat page. Its own
 * request cards are already on screen, so it needs no extra reminder. Main
 * receives the same value to decide native banners.
 */
export function viewedSessionId(state: {
  page: string;
  activeSessionId?: string;
}): string | null {
  return state.page === "chat" ? (state.activeSessionId ?? null) : null;
}
