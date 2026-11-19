import {
  PROGRESS_DEFAULT_INTERVAL,
  type ProgressReport,
  type ProgressSettings,
  type ProgressTrigger,
} from "@pi-harbor/shared";

/**
 * Renderer state for read-only progress reports (ADR 0350).
 *
 * Everything here is derived from the host's stored rows plus one in-flight
 * run. Nothing in this state can reach the session: it holds reports and
 * settings only.
 */

export type ProgressRunView = {
  runId: string;
  trigger: ProgressTrigger;
  startedAt: number;
};

export type ProgressHistoryView = {
  reports: ProgressReport[];
  /** Cursor for the next older page; null when the end is reached. */
  cursor: string | null;
  loading: boolean;
  /** The footer button toggles between the current report and the timeline. */
  open: boolean;
};

export type ProgressErrorView = { code: string; message: string; at: number };

export type ProgressSessionState = {
  /** True once settings and the newest report have been read. */
  loaded: boolean;
  settings: ProgressSettings;
  latest: ProgressReport | null;
  history: ProgressHistoryView;
  run: ProgressRunView | null;
  modelViewOpen: boolean;
  /** A report arrived while the popover was closed. */
  unseen: boolean;
  lastError: ProgressErrorView | null;
  lastSkippedAt: number | null;
};

export type ProgressState = {
  sessions: Record<string, ProgressSessionState>;
};

export function emptyProgressState(): ProgressState {
  return { sessions: {} };
}

/** Settings a session has before its row is read, matching the host defaults. */
export function defaultProgressSettings(sessionId: string): ProgressSettings {
  return {
    sessionId,
    model: { followSession: true },
    autoEnabled: false,
    intervalMinutes: PROGRESS_DEFAULT_INTERVAL,
    lastCollectedAt: null,
    consecutiveFailures: 0,
    updatedAt: 0,
  };
}

export function emptyProgressSession(sessionId: string): ProgressSessionState {
  return {
    loaded: false,
    settings: defaultProgressSettings(sessionId),
    latest: null,
    history: { reports: [], cursor: null, loading: false, open: false },
    run: null,
    modelViewOpen: false,
    unseen: false,
    lastError: null,
    lastSkippedAt: null,
  };
}

/**
 * Empty state for a session that has never loaded.
 *
 * The instance is memoized per session id because a store selector must return a
 * stable reference: a fresh object on every read makes `useStore` see a changed
 * snapshot on each render, which React reports as "Maximum update depth
 * exceeded". The entry is dropped as soon as the session has real state.
 */
const EMPTY_SESSIONS = new Map<string, ProgressSessionState>();

export function progressSessionOf(state: ProgressState, sessionId: string): ProgressSessionState {
  const stored = state.sessions[sessionId];
  if (stored) return stored;
  let empty = EMPTY_SESSIONS.get(sessionId);
  if (!empty) {
    empty = emptyProgressSession(sessionId);
    EMPTY_SESSIONS.set(sessionId, empty);
  }
  return empty;
}

export function withProgressSession(
  state: ProgressState,
  sessionId: string,
  patch: Partial<ProgressSessionState>,
): ProgressState {
  const current = progressSessionOf(state, sessionId);
  return { sessions: { ...state.sessions, [sessionId]: { ...current, ...patch } } };
}

/**
 * A report is stale when the session has produced a newer durable message than
 * the one recorded with it. That is a store comparison, so it costs no IPC.
 */
export function isProgressStale(report: ProgressReport | null, newestMessageId: string | null): boolean {
  if (!report) return false;
  if (report.lastMessageId === null) return newestMessageId !== null;
  return report.lastMessageId !== newestMessageId;
}

export type ProgressTriggerVisual = "idle" | "collecting" | "unseen" | "auto";

/** The unseen dot wins over the auto dot, which wins over idle (design § 6.1). */
export function progressTriggerVisual(
  session: ProgressSessionState,
): ProgressTriggerVisual {
  if (session.run) return "collecting";
  if (session.unseen) return "unseen";
  if (session.settings.autoEnabled) return "auto";
  return "idle";
}

/** The lowest remaining estimate of a report, for the collapsed history row. */
export function progressRemainingOf(report: ProgressReport): {
  steps: number | null;
  minutes: number | null;
} {
  return {
    steps: report.body?.remainingSteps ?? null,
    minutes: report.body?.remainingMinutes ?? null,
  };
}

/** The first in-progress bullet, which is the collapsed row's summary line. */
export function progressHeadlineOf(report: ProgressReport): string | null {
  return report.body?.inProgress[0] ?? report.body?.completed[0] ?? null;
}
