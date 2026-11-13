/**
 * Where a session's folded rounds live between renders and reloads.
 *
 * The transcript and the host are the record; this only remembers which rounds
 * the user put away, per session, in renderer storage. It follows the same
 * shape as `plan-debate-store`: a versioned key, a validated snapshot on read,
 * and a store that never throws when storage is blocked or full — a session
 * with no storage simply starts unfolded.
 */
import { useSyncExternalStore } from "react";
import {
  NO_RETIRED_ROUNDS,
  fromRetiredRoundsSnapshot,
  toRetiredRoundsSnapshot,
  type RetiredRounds,
} from "../../../lib/subagent-rounds";

/** Versioned key: a future shape change reads a new key instead of old data. */
const KEY_PREFIX = "pi.desktop.subagentRounds.v1.";

/** Session id to its folded rounds, so `useSyncExternalStore` stays stable. */
const cache = new Map<string, RetiredRounds>();
const listeners = new Map<string, Set<() => void>>();

function key(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A locked-down or blocked storage still leaves the action working.
    return null;
  }
}

/** The session's folded rounds, read once and then kept in memory. */
export function readRetiredRounds(sessionId: string): RetiredRounds {
  const cached = cache.get(sessionId);
  if (cached) return cached;
  const store = storage();
  let read: RetiredRounds = NO_RETIRED_ROUNDS;
  if (store) {
    try {
      const raw = store.getItem(key(sessionId));
      if (raw) read = fromRetiredRoundsSnapshot(JSON.parse(raw));
    } catch {
      // Corrupt JSON is not a crash: the session starts unfolded.
    }
  }
  cache.set(sessionId, read);
  return read;
}

/** Store a new set for the session and tell everyone who draws it. */
export function writeRetiredRounds(sessionId: string, next: RetiredRounds): void {
  if (readRetiredRounds(sessionId) === next) return;
  cache.set(sessionId, next);
  const store = storage();
  if (store) {
    try {
      store.setItem(key(sessionId), JSON.stringify(toRetiredRoundsSnapshot(next)));
    } catch {
      // A full or read-only store must not break the session in progress.
    }
  }
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

export function subscribeRetiredRounds(
  sessionId: string,
  listener: () => void,
): () => void {
  const set = listeners.get(sessionId) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(sessionId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(sessionId);
  };
}

/** The session's folded rounds as a component reads them. */
export function useRetiredRounds(sessionId: string | undefined): RetiredRounds {
  return useSyncExternalStore(
    (listener) =>
      sessionId ? subscribeRetiredRounds(sessionId, listener) : () => {},
    () => (sessionId ? readRetiredRounds(sessionId) : NO_RETIRED_ROUNDS),
    () => NO_RETIRED_ROUNDS,
  );
}
