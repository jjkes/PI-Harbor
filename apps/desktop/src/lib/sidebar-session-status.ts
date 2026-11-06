export type SidebarSessionStatus =
  | "running"
  | "selected"
  | "completed"
  | "failed"
  | "permission"
  | "input";
export type SidebarSessionOutcome = Extract<
  SidebarSessionStatus,
  "completed" | "failed"
>;

export { latestSessionOutcomes } from "@pi-harbor/shared";

/** Catalog key for each indicator's accessible name and tooltip. */
export const SIDEBAR_SESSION_STATUS_LABEL_KEYS = {
  running: "nav.sessionRunning",
  selected: "nav.sessionSelected",
  completed: "nav.sessionCompleted",
  failed: "nav.sessionFailed",
  permission: "nav.sessionPermission",
  input: "nav.sessionInput",
} as const satisfies Record<SidebarSessionStatus, string>;

/**
 * The one status a conversation row shows. A session that needs the user
 * outranks everything else: tool approval first, then a question to answer or
 * a plan to review. Then come work in progress, the selected row, and the
 * latest unread outcome.
 */
export function sidebarSessionStatus({
  running,
  selected,
  outcome,
  hasPendingPermission,
  awaitingInput,
}: {
  running: boolean;
  selected: boolean;
  outcome?: "completed" | "failed";
  hasPendingPermission?: boolean;
  awaitingInput?: boolean;
}): SidebarSessionStatus | null {
  if (hasPendingPermission) return "permission";
  if (awaitingInput) return "input";
  if (running) return "running";
  if (selected) return "selected";
  return outcome ?? null;
}
