/**
 * One-shot requests to open a session's subagent graph in the composer dock.
 *
 * Turning Team on and clicking the transcript's delegation summary both want
 * the same thing: expand the dock and show its Subagent page. The caller is not
 * the dock, and the dock may not be mounted yet (a draft turns into a session
 * first), so the request waits here until the dock of that session takes it.
 * A request nobody takes within `REVEAL_TTL_MS` is dropped, so a stale one
 * cannot expand the dock long after the action that asked for it.
 *
 * Renderer memory only, like the dock's own view state.
 */
const REVEAL_TTL_MS = 10_000;

const pending = new Map<string, number>();
const listeners = new Set<() => void>();

/** Ask the dock of `sessionId` to open its Subagent page. */
export function requestDockReveal(sessionId: string, now: number = Date.now()): void {
  // A request whose dock never mounted is never taken; drop it with the next one
  // so it does not stay for the life of the app.
  for (const [id, requestedAt] of pending) {
    if (now - requestedAt > REVEAL_TTL_MS) pending.delete(id);
  }
  pending.set(sessionId, now);
  for (const listener of [...listeners]) listener();
}

/** Withdraw a request, for example because the action that asked for it failed. */
export function clearDockReveal(sessionId: string): void {
  pending.delete(sessionId);
}

/** Consume the request of `sessionId`: true once, and only while it is fresh. */
export function takeDockReveal(sessionId: string, now: number = Date.now()): boolean {
  const requestedAt = pending.get(sessionId);
  if (requestedAt === undefined) return false;
  pending.delete(sessionId);
  return now - requestedAt <= REVEAL_TTL_MS;
}

/** Be told when a request arrives. Returns the unsubscribe function. */
export function subscribeDockReveal(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
