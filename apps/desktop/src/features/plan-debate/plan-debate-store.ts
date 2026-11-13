/**
 * Where a session's debate lives between reloads.
 *
 * The plan artifact is the durable document; this is the timeline beside it —
 * which round ran, which role failed, what the user chose — kept per session in
 * renderer storage so a reload repaints the same rows. It is bounded by the
 * rounds a person actually ran, and every value that comes back is re-validated
 * because storage is shared with other builds and with the user.
 */
import {
  PLAN_DEBATE_SNAPSHOT_VERSION,
  fromPlanDebateSnapshot,
  toPlanDebateSnapshot,
  type PlanDebateHandoff,
  type PlanDebateState,
} from "./plan-debate-machine";

const KEY_PREFIX = "pi.desktop.planDebate.";

function key(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A locked-down or blocked storage still leaves a working debate in memory.
    return null;
  }
}

export function readPlanDebateState(sessionId: string): PlanDebateState | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(key(sessionId));
    if (!raw) return null;
    return fromPlanDebateSnapshot(JSON.parse(raw));
  } catch {
    // Corrupt JSON is not a crash: the panel starts an empty timeline.
    return null;
  }
}

export function writePlanDebateState(sessionId: string, state: PlanDebateState): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key(sessionId), JSON.stringify(toPlanDebateSnapshot(state)));
  } catch {
    // A full or read-only store must not break the round in progress.
  }
}

export function clearPlanDebateState(sessionId: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(key(sessionId));
  } catch {
    // Nothing to recover from: the next write overwrites the entry anyway.
  }
}

const HANDOFF_KEY_PREFIX = "pi.desktop.planDebateHandoff.";

/**
 * The round already carried into team mode, as the last session wrote it.
 *
 * The timeline itself is derived from the transcript (the plan-debate rows the
 * runtime publishes), so storage keeps only the one fact the transcript cannot
 * state: that the user already sent this round's plan to team mode.
 */
export function readPlanDebateHandoff(sessionId: string): PlanDebateHandoff | null {
  const store = storage();
  if (!store) return null;
  try {
    return parseHandoff(JSON.parse(store.getItem(`${HANDOFF_KEY_PREFIX}${sessionId}`) ?? "null"));
  } catch {
    return null;
  }
}

export function writePlanDebateHandoff(sessionId: string, handoff: PlanDebateHandoff): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(
      `${HANDOFF_KEY_PREFIX}${sessionId}`,
      JSON.stringify({ version: PLAN_DEBATE_SNAPSHOT_VERSION, round: handoff.round, at: handoff.at }),
    );
  } catch {
    // A lost marker only risks asking once more; it must not break the round.
  }
}

/** Stored handoffs are untrusted: both numbers must be real before use. */
function parseHandoff(value: unknown): PlanDebateHandoff | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as { version?: unknown; round?: unknown; at?: unknown };
  if (record.version !== PLAN_DEBATE_SNAPSHOT_VERSION) return null;
  if (typeof record.round !== "number" || typeof record.at !== "number") return null;
  return { round: record.round, at: record.at };
}

const DELETED_KEY_PREFIX = "pi.desktop.planDebateDeleted.";

/**
 * Rounds the user deleted, kept per session so the panel stops drawing them.
 * The transcript rows stay in the conversation history, but the debate panel
 * filters these rounds out of its view — deleting a record is a panel action,
 * not an edit of the session's message history.
 */
export function readDeletedRounds(sessionId: string): number[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(`${DELETED_KEY_PREFIX}${sessionId}`);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item >= 1);
  } catch {
    return [];
  }
}

export function markRoundDeleted(sessionId: string, round: number): void {
  const store = storage();
  if (!store) return;
  try {
    const existing = readDeletedRounds(sessionId);
    if (existing.includes(round)) return;
    store.setItem(`${DELETED_KEY_PREFIX}${sessionId}`, JSON.stringify([...existing, round]));
  } catch {
    // A lost marker only means the round reappears; it must not break deletion.
  }
}

/** Clear the deleted marker for one round (e.g. a re-debate reuses the number). */
export function clearRoundDeleted(sessionId: string, round: number): void {
  const store = storage();
  if (!store) return;
  try {
    const remaining = readDeletedRounds(sessionId).filter((item) => item !== round);
    store.setItem(`${DELETED_KEY_PREFIX}${sessionId}`, JSON.stringify(remaining));
  } catch {
    // Nothing to recover from.
  }
}
