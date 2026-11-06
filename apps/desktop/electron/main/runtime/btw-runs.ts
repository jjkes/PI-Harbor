import { ErrorCodes, type BtwEventEnvelope } from "@pi-harbor/shared";

/**
 * Main's registry of active BTW side-question runs (ADR 0344).
 *
 * Main validates, routes, and cleans up; the run itself lives in the agent
 * sidecar. Events are forwarded only for runs Main started, in order, until
 * their terminal event. A run whose renderer reloads, crashes, or closes is
 * aborted, and every run ends with `BTW_RUNTIME_EXITED` when the sidecar exits.
 */
export type BtwRunRegistryDependencies = {
  send: (envelope: BtwEventEnvelope) => void;
  abort: (runId: string) => void;
};

type TrackedRun = {
  sessionId: string;
  /** The webContents that asked, when the call came over Electron IPC. */
  senderId?: number;
  lastSeq: number;
};

export class BtwRunRegistry {
  private readonly deps: BtwRunRegistryDependencies;
  private readonly runs = new Map<string, TrackedRun>();

  constructor(deps: BtwRunRegistryDependencies) {
    this.deps = deps;
  }

  /** Start forwarding a run's events. Call before the sidecar sees the run. */
  track(runId: string, sessionId: string, senderId?: number): void {
    this.runs.set(runId, { sessionId, senderId, lastSeq: -1 });
  }

  /** Forget a run the sidecar never accepted. */
  untrack(runId: string): void {
    this.runs.delete(runId);
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** Forward one sidecar `btw.event`. Malformed, unknown, and stale envelopes are dropped. */
  forward(value: unknown): void {
    if (!isBtwEventEnvelope(value)) return;
    const run = this.runs.get(value.runId);
    if (!run || run.sessionId !== value.sessionId || value.seq <= run.lastSeq) return;
    run.lastSeq = value.seq;
    if (value.event.type === "done" || value.event.type === "error") {
      this.runs.delete(value.runId);
    }
    this.deps.send(value);
  }

  /** The renderer that asked reloaded, crashed, or closed: stop its runs. */
  abortSender(senderId: number): void {
    for (const [runId, run] of this.runs) {
      if (run.senderId !== senderId) continue;
      this.runs.delete(runId);
      this.deps.abort(runId);
    }
  }

  /** The main session was deleted: stop its runs. Their terminal events still route. */
  abortSession(sessionId: string): void {
    for (const [runId, run] of this.runs) {
      if (run.sessionId === sessionId) this.deps.abort(runId);
    }
  }

  /** The sidecar exited, so no active run can finish. */
  failAll(): void {
    const runs = [...this.runs];
    this.runs.clear();
    for (const [runId, run] of runs) {
      this.deps.send({
        runId,
        sessionId: run.sessionId,
        seq: run.lastSeq + 1,
        event: {
          type: "error",
          error: {
            code: ErrorCodes.BTW_RUNTIME_EXITED,
            message: "The agent runtime exited during the side question.",
            retriable: true,
          },
        },
      });
    }
  }
}

function isBtwEventEnvelope(value: unknown): value is BtwEventEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const event = candidate.event;
  return (
    typeof candidate.runId === "string" &&
    typeof candidate.sessionId === "string" &&
    Number.isInteger(candidate.seq) &&
    typeof event === "object" &&
    event !== null &&
    typeof (event as Record<string, unknown>).type === "string"
  );
}
