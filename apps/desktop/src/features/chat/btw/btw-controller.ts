import i18n from "i18next";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { api } from "../../../lib/api";
import { btwWorkPanelTab } from "../../../lib/work-panel-tabs";
import { useAppStore, type AppState } from "../../../stores/app-store";
import { btwTabPresence, emptyBtwState } from "./btw-model";
import type { BtwMainRow, BtwMainView, BtwState } from "./btw-model";
import { createBtwController } from "./btw-service";

/**
 * Runtime wiring for BTW side questions (ADR 0344). The threads live in their
 * own store, not in app-store, and only in this renderer: they are gone after
 * a reload, and Main stops the runs this renderer started.
 */

export const btwStore = createStore<BtwState>()(() => emptyBtwState());

export function useBtwStore<T>(selector: (state: BtwState) => T): T {
  return useStore(btwStore, selector);
}

const NO_MESSAGES: readonly BtwMainRow[] = [];

/** The renderer's transcript of a main session; the tab and the baseline read the same rows. */
export function btwMainMessagesOf(state: AppState, sessionId: string): readonly BtwMainRow[] {
  return state.activeSessionId === sessionId
    ? state.messages
    : (state.retainedTranscripts[sessionId] ?? NO_MESSAGES);
}

export function btwCompactionCountOf(state: AppState, sessionId: string): number {
  return state.sessionCompactions[sessionId]?.length ?? 0;
}

export function btwMainRunningOf(state: AppState, sessionId: string): boolean {
  return state.runningSessions[sessionId] === true;
}

function btwMainViewOf(state: AppState, sessionId: string): BtwMainView {
  return {
    messages: btwMainMessagesOf(state, sessionId),
    compactionCount: btwCompactionCountOf(state, sessionId),
    running: btwMainRunningOf(state, sessionId),
  };
}

export const btwController = createBtwController({
  api: {
    ask: (request) => api.btwAsk(request),
    abort: (request) => api.btwAbort(request),
    onEvent: (listener) => api.onBtwEvent(listener),
  },
  host: {
    activeSessionId: () => useAppStore.getState().activeSessionId,
    session: (sessionId) =>
      useAppStore.getState().sessions.find((session) => session.id === sessionId),
    mainView: (sessionId) => btwMainViewOf(useAppStore.getState(), sessionId),
    openTab: (sessionId) =>
      useAppStore.getState().openWorkPanelTabForSession(sessionId, btwWorkPanelTab()),
    tabPresence: (sessionId) => {
      const state = useAppStore.getState();
      return btwTabPresence(
        state.workPanelContexts[sessionId]?.tabs,
        state.activeSessionId === sessionId ? state.workPanelTabs : undefined,
      );
    },
    subscribeTabs: (listener) =>
      useAppStore.subscribe((state, previous) => {
        if (
          state.workPanelContexts !== previous.workPanelContexts ||
          state.workPanelTabs !== previous.workPanelTabs
        ) {
          listener();
        }
      }),
    toast: (message, variant) => useAppStore.getState().showToast(message, { variant }),
  },
  store: btwStore,
  t: (key, options) => i18n.t(key, options),
  newRunId: () => crypto.randomUUID(),
  now: () => Date.now(),
  warn: (message) => console.warn(message),
});
