import {
  PROGRESS_MAX_CONSECUTIVE_FAILURES,
  PROGRESS_REPORTS_PAGE_SIZE,
  type ProgressCollectRequest,
  type ProgressCollectResult,
  type ProgressModelRef,
  type ProgressReport,
  type ProgressReportPage,
  type ProgressSettings,
  type ProgressLocale,
  type ProgressSettingsPatch,
  type ProgressTrigger,
} from "@pi-harbor/shared";
import type { StoreApi } from "zustand/vanilla";
import {
  progressSessionOf,
  withProgressSession,
  type ProgressState,
} from "./progress-types";

/**
 * Every renderer-side side effect of progress reports (design § 8.6).
 *
 * I/O stays behind this port so the popover and the scheduler are testable
 * without Electron, and so nothing here can reach a session: the only methods
 * are collect, cancel, history, and settings.
 */

export type ProgressApiPort = {
  collect(request: ProgressCollectRequest): Promise<ProgressCollectResult>;
  cancel(request: { runId: string }): Promise<{ aborted: boolean }>;
  list(request: { sessionId: string; before?: string; limit?: number }): Promise<ProgressReportPage>;
  settingsGet(request: { sessionId: string }): Promise<ProgressSettings>;
  settingsSet(request: { sessionId: string; patch: ProgressSettingsPatch }): Promise<ProgressSettings>;
};

export type ProgressServiceDependencies = {
  api: ProgressApiPort;
  /** The language the UI is showing, so the report body matches it. */
  locale: () => ProgressLocale;
  store: StoreApi<ProgressState>;
  now: () => number;
  newRunId: () => string;
  warn: (message: string) => void;
};

export type ProgressService = {
  /** Read the stored settings and newest report once per session. */
  load(sessionId: string): Promise<void>;
  collect(sessionId: string, trigger: ProgressTrigger): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  toggleHistory(sessionId: string): Promise<void>;
  loadMore(sessionId: string): Promise<void>;
  setAutoEnabled(sessionId: string, enabled: boolean): Promise<void>;
  setIntervalMinutes(sessionId: string, minutes: number): Promise<void>;
  setModel(sessionId: string, model: ProgressModelRef): Promise<void>;
  setModelViewOpen(sessionId: string, open: boolean): void;
  markSeen(sessionId: string): void;
  dismissError(sessionId: string): void;
};

export function createProgressService({
  api,
  locale,
  store,
  now,
  newRunId,
  warn,
}: ProgressServiceDependencies): ProgressService {
  const patch = (sessionId: string, next: Parameters<typeof withProgressSession>[2]) => {
    store.setState((state) => withProgressSession(state, sessionId, next));
  };
  const sessionOf = (sessionId: string) => progressSessionOf(store.getState(), sessionId);

  async function applySettings(
    sessionId: string,
    request: ProgressSettingsPatch,
  ): Promise<void> {
    try {
      const settings = await api.settingsSet({ sessionId, patch: request });
      patch(sessionId, { settings });
    } catch (error) {
      warn(`progress settings update failed: ${String(error)}`);
    }
  }

  async function collect(sessionId: string, trigger: ProgressTrigger): Promise<void> {
    if (sessionOf(sessionId).run) return;
    const runId = newRunId();
    const model = sessionOf(sessionId).settings.model;
    patch(sessionId, {
      run: { runId, trigger, startedAt: now() },
      lastError: null,
    });
    try {
      const result = await api.collect({ sessionId, runId, trigger, model, locale: locale() });
      if (result.kind === "ok") {
        const collectedAt = now();
        const settings = sessionOf(sessionId).settings;
        patch(sessionId, {
          latest: result.report,
          unseen: true,
          lastError: null,
          lastSkippedAt: null,
          settings: {
            ...settings,
            lastCollectedAt: collectedAt,
            consecutiveFailures: 0,
          },
        });
        // The durable rows are the truth for the footer count and the timeline.
        void refreshHistoryHead(sessionId);
        return;
      }
      if (result.kind === "skipped") {
        patch(sessionId, { lastSkippedAt: now(), lastError: null });
        return;
      }
      recordFailure(sessionId, result.code, result.message);
    } catch (error) {
      recordFailure(sessionId, "PROGRESS_PROVIDER_ERROR", messageOf(error));
    } finally {
      patch(sessionId, { run: null });
    }
  }

  function recordFailure(sessionId: string, code: string, message: string): void {
    const settings = sessionOf(sessionId).settings;
    const failures = Math.min(settings.consecutiveFailures + 1, PROGRESS_MAX_CONSECUTIVE_FAILURES);
    patch(sessionId, {
      lastError: { code, message, at: now() },
      settings: { ...settings, consecutiveFailures: failures },
    });
    // A cancellation is not a failure the user needs to see twice.
    if (code === "PROGRESS_CANCELLED") patch(sessionId, { lastError: null });
  }

  async function refreshHistoryHead(sessionId: string): Promise<void> {
    try {
      const page = await api.list({ sessionId, limit: PROGRESS_REPORTS_PAGE_SIZE });
      patch(sessionId, {
        history: {
          ...sessionOf(sessionId).history,
          reports: page.reports,
          cursor: page.nextCursor,
        },
      });
    } catch (error) {
      warn(`progress history refresh failed: ${String(error)}`);
    }
  }

  return {
    async load(sessionId) {
      if (sessionOf(sessionId).loaded) return;
      try {
        const [settings, page] = await Promise.all([
          api.settingsGet({ sessionId }),
          api.list({ sessionId, limit: PROGRESS_REPORTS_PAGE_SIZE }),
        ]);
        patch(sessionId, {
          loaded: true,
          settings,
          latest: page.reports[0] ?? null,
          history: {
            ...sessionOf(sessionId).history,
            reports: page.reports,
            cursor: page.nextCursor,
          },
        });
      } catch (error) {
        // A session with no rows is not an error; only a real failure is logged.
        if (!String(error).includes("NOT_FOUND")) {
          warn(`progress load failed: ${String(error)}`);
        }
        patch(sessionId, { loaded: true });
      }
    },
    collect,
    async cancel(sessionId) {
      const run = sessionOf(sessionId).run;
      if (!run) return;
      try {
        await api.cancel({ runId: run.runId });
      } catch (error) {
        warn(`progress cancel failed: ${String(error)}`);
      }
    },
    async toggleHistory(sessionId) {
      const history = sessionOf(sessionId).history;
      patch(sessionId, { history: { ...history, open: !history.open } });
      if (!history.open) await refreshHistoryHead(sessionId);
    },
    async loadMore(sessionId) {
      const history = sessionOf(sessionId).history;
      if (history.loading || history.cursor === null) return;
      patch(sessionId, { history: { ...history, loading: true } });
      try {
        const page = await api.list({
          sessionId,
          limit: PROGRESS_REPORTS_PAGE_SIZE,
          before: history.cursor,
        });
        const current = sessionOf(sessionId).history;
        patch(sessionId, {
          history: {
            reports: [...current.reports, ...page.reports],
            cursor: page.nextCursor,
            loading: false,
            open: current.open,
          },
        });
      } catch (error) {
        warn(`progress history page failed: ${String(error)}`);
        const current = sessionOf(sessionId).history;
        patch(sessionId, { history: { ...current, loading: false } });
      }
    },
    async setAutoEnabled(sessionId, enabled) {
      await applySettings(sessionId, {
        autoEnabled: enabled,
        consecutiveFailures: enabled ? 0 : sessionOf(sessionId).settings.consecutiveFailures,
      });
    },
    async setIntervalMinutes(sessionId, minutes) {
      await applySettings(sessionId, { intervalMinutes: minutes });
    },
    async setModel(sessionId, model) {
      await applySettings(sessionId, { model });
    },
    setModelViewOpen(sessionId, open) {
      patch(sessionId, { modelViewOpen: open });
    },
    markSeen(sessionId) {
      if (!sessionOf(sessionId).unseen) return;
      patch(sessionId, { unseen: false });
    },
    dismissError(sessionId) {
      patch(sessionId, { lastError: null });
    },
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "the collection failed";
}

/** Reports are plain data: a renderer never parses them as Markdown or HTML. */
export function progressReportSections(report: ProgressReport) {
  return {
    completed: report.body?.completed ?? [],
    inProgress: report.body?.inProgress ?? [],
    next: report.body?.next ?? [],
  };
}
