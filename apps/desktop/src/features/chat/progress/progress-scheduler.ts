import {
  PROGRESS_MAX_AUTO_RUNS,
  PROGRESS_MAX_CONSECUTIVE_FAILURES,
  type ProgressReport,
  type ProgressSettings,
} from "@pi-harbor/shared";

/**
 * The automatic-collection decision table (design § 7.6).
 *
 * Pure on purpose: the renderer owns the timer, and the rule that decides
 * "collect now, wait, or skip" is the part worth testing without a clock.
 */

/** Automatic collection pauses itself after repeated failures (design § 7.6). */
export function progressAutoPaused(settings: ProgressSettings): boolean {
  return settings.autoEnabled && settings.consecutiveFailures >= PROGRESS_MAX_CONSECUTIVE_FAILURES;
}

/** When the next automatic check is due, or null when auto is off. */
export function progressNextCheckAt(settings: ProgressSettings): number | null {
  if (!settings.autoEnabled || progressAutoPaused(settings)) return null;
  const base = settings.lastCollectedAt;
  if (base === null) return null;
  return base + settings.intervalMinutes * 60_000;
}

export type ProgressSchedulerSession = {
  sessionId: string;
  settings: ProgressSettings;
  latest: ProgressReport | null;
  /** A collection is already running for this session. */
  running: boolean;
};

export type ProgressTickInput = {
  now: number;
  sessions: readonly ProgressSchedulerSession[];
  /** Newest durable message id per session, from the renderer's transcript. */
  newestMessageIds: Record<string, string | null | undefined>;
  /** Automatic runs already in flight across all sessions. */
  autoRunsInFlight: number;
  /** A hidden window never starts an automatic run (cost guard). */
  windowHidden: boolean;
};

export type ProgressTickDecision =
  | { kind: "collect"; sessionId: string }
  | { kind: "skip"; sessionId: string; reason: ProgressSkipReason };

export type ProgressSkipReason =
  | "auto-off"
  | "paused"
  | "no-baseline"
  | "running"
  | "cap"
  | "not-due"
  | "unchanged"
  | "hidden";

/** One decision per session that has auto-collect on. */
export function decideProgressTick(input: ProgressTickInput): ProgressTickDecision[] {
  const decisions: ProgressTickDecision[] = [];
  let inFlight = input.autoRunsInFlight;
  for (const session of input.sessions) {
    const { sessionId, settings, latest, running } = session;
    if (!settings.autoEnabled) continue;
    const skip = (reason: ProgressSkipReason): void => {
      decisions.push({ kind: "skip", sessionId, reason });
    };
    if (progressAutoPaused(settings)) {
      skip("paused");
      continue;
    }
    if (running) {
      skip("running");
      continue;
    }
    if (inFlight >= PROGRESS_MAX_AUTO_RUNS) {
      skip("cap");
      continue;
    }
    const due = progressNextCheckAt(settings);
    // Without a stored report there is no fingerprint baseline, so the first
    // automatic run waits until a manual collection or an enabled session.
    if (due === null) {
      skip("no-baseline");
      continue;
    }
    if (input.now < due) {
      skip("not-due");
      continue;
    }
    if (input.windowHidden) {
      skip("hidden");
      continue;
    }
    const newest = input.newestMessageIds[sessionId] ?? null;
    if (latest?.lastMessageId !== null && latest?.lastMessageId === newest) {
      // Nothing the session produced changed; Main would skip it anyway.
      skip("unchanged");
      continue;
    }
    inFlight += 1;
    decisions.push({ kind: "collect", sessionId });
  }
  return decisions;
}

export type ProgressSchedulerDependencies = {
  now: () => number;
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Snapshot of everything the decision table needs. */
  input: () => Omit<ProgressTickInput, "now">;
  collect: (sessionId: string) => void;
  onSkip?: (sessionId: string, reason: ProgressSkipReason) => void;
  /** How often to wake up; each tick reschedules itself. */
  tickMs?: number;
};

export type ProgressScheduler = {
  start(): void;
  stop(): void;
  /** Run one tick immediately; tests use this instead of waiting. */
  tick(): void;
  running(): boolean;
};

const DEFAULT_TICK_MS = 30_000;

/**
 * One self-rescheduling timer for every enabled session. The next tick is
 * scheduled after the current one completes, so a slow collection cannot pile
 * up, and the timer stops with the renderer.
 */
export function createProgressScheduler(deps: ProgressSchedulerDependencies): ProgressScheduler {
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  let handle: unknown = null;
  let active = false;

  const tick = (): void => {
    const decisions = decideProgressTick({ now: deps.now(), ...deps.input() });
    for (const decision of decisions) {
      if (decision.kind === "collect") deps.collect(decision.sessionId);
      else deps.onSkip?.(decision.sessionId, decision.reason);
    }
  };

  const schedule = (): void => {
    if (!active) return;
    handle = deps.setTimeout(() => {
      handle = null;
      if (!active) return;
      try {
        tick();
      } finally {
        schedule();
      }
    }, tickMs);
  };

  return {
    start() {
      if (active) return;
      active = true;
      schedule();
    },
    stop() {
      active = false;
      if (handle !== null) {
        deps.clearTimeout(handle);
        handle = null;
      }
    },
    tick,
    running: () => active,
  };
}
