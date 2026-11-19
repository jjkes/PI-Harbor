import i18n from "i18next";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { normalizeProgressLocale } from "@pi-harbor/shared";
import { api } from "../../../lib/api";
import { useAppStore, type AppState } from "../../../stores/app-store";
import {
  createProgressScheduler,
  type ProgressScheduler,
  type ProgressTickInput,
} from "./progress-scheduler";
import { createProgressService } from "./progress-service";
import {
  emptyProgressState,
  progressSessionOf,
  type ProgressSessionState,
  type ProgressState,
} from "./progress-types";

/**
 * Runtime wiring for progress reports (ADR 0350).
 *
 * The reports live in their own store, not in `app-store`, for the reason the
 * BTW threads do: `app-store` is an architecture hotspot and this state is
 * owned by one feature. Only this renderer starts collections, so only this
 * renderer schedules them.
 */

export const progressStore = createStore<ProgressState>()(() => emptyProgressState());

export function useProgressStore<T>(selector: (state: ProgressState) => T): T {
  return useStore(progressStore, selector);
}

export const progressService = createProgressService({
  api: {
    collect: (request) => api.progressCollect(request),
    cancel: (request) => api.progressCancel(request),
    list: (request) => api.progressReportsList(request),
    settingsGet: (request) => api.progressSettingsGet(request),
    settingsSet: (request) => api.progressSettingsSet(request),
  },
  store: progressStore,
  locale: () => normalizeProgressLocale(i18n.language),
  now: () => Date.now(),
  newRunId: () => crypto.randomUUID(),
  warn: (message) => console.warn(message),
});

/** Newest durable message id of a session, read from the renderer transcript. */
export function progressNewestMessageId(state: AppState, sessionId: string): string | null {
  const messages =
    state.activeSessionId === sessionId ? state.messages : (state.retainedTranscripts[sessionId] ?? []);
  const newest = messages[messages.length - 1];
  return newest?.id ?? null;
}

function schedulerSessions(): Omit<ProgressTickInput, "now"> {
  const progress = progressStore.getState();
  const app = useAppStore.getState();
  const sessions = Object.entries(progress.sessions)
    .filter(([, session]) => session.settings.autoEnabled)
    .map(([sessionId, session]) => ({
      sessionId,
      settings: session.settings,
      latest: session.latest,
      running: session.run !== null,
    }));
  const newestMessageIds: Record<string, string | null> = {};
  for (const session of sessions) {
    newestMessageIds[session.sessionId] = progressNewestMessageId(app, session.sessionId);
  }
  return {
    sessions,
    newestMessageIds,
    autoRunsInFlight: sessions.filter((session) => session.running).length,
    windowHidden: typeof document !== "undefined" && document.visibilityState === "hidden",
  };
}

export const progressScheduler: ProgressScheduler = createProgressScheduler({
  now: () => Date.now(),
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
  input: schedulerSessions,
  collect: (sessionId) => {
    void progressService.collect(sessionId, "auto");
  },
});

/** Start the timer once, the first time a session turns auto-collect on. */
export function ensureProgressScheduler(): void {
  if (!progressScheduler.running()) progressScheduler.start();
}

/** Stand-in id for the "no session yet" state; also memoized by `progressSessionOf`. */
const NO_SESSION_ID = "";

/**
 * Per-session selector used by the trigger and the popover.
 *
 * `progressSessionOf` returns the stored object, or the memoized empty one, so
 * the snapshot identity is stable between renders.
 */
export function useProgressSession(sessionId: string | undefined): ProgressSessionState {
  return useProgressStore((state) =>
    progressSessionOf(state, sessionId ?? NO_SESSION_ID),
  );
}



// A renderer unload must stop the timer; Main aborts the in-flight runs.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => progressScheduler.stop());
}
