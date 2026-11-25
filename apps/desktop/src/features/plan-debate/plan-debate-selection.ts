/**
 * The plan a user picked in a round, shared by the two surfaces that draw it.
 *
 * The work-panel tab owns the choice and the conversation card reports it, so
 * the choice cannot live in either component: one store, keyed by session, read
 * through `useSyncExternalStore` by both. It is renderer memory only — the
 * durable record stays the transcript plus the handoff marker, and a reload
 * starts with nothing chosen, which is the same rule the panel applies when a
 * new round begins.
 *
 * One entry per session rather than one entry overall: the card and the tab
 * draw the same session, but a session switch (or a second tab left mounted)
 * must not clear a choice the user just made in another one.
 */
import type { PlanDebateSelection } from "./plan-debate-machine";

const selections = new Map<string, PlanDebateSelection>();
const listeners = new Set<() => void>();

/** The choice made in this session, or null when nothing is chosen. */
export function planDebateSelectionOf(sessionId: string): PlanDebateSelection | null {
  return selections.get(sessionId) ?? null;
}

/** Record the choice; every other session keeps its own. */
export function setPlanDebateSelection(
  sessionId: string,
  selection: PlanDebateSelection | null,
): void {
  if (selection === null) {
    if (!selections.delete(sessionId)) return;
  } else {
    selections.set(sessionId, selection);
  }
  for (const listener of listeners) listener();
}

/** Drop a session's choice when the session itself goes away. */
export function clearPlanDebateSelection(sessionId: string): void {
  setPlanDebateSelection(sessionId, null);
}
/** The `useSyncExternalStore` change signal. */
export function subscribePlanDebateSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
