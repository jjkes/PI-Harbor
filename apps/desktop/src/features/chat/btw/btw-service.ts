import { BTW_QUESTION_MAX_CHARS, btwAvailableFor, ErrorCodes } from "@pi-harbor/shared";
import type {
  AppError,
  BtwAbortRequest,
  BtwAskRequest,
  BtwAskResult,
  SessionSummary,
} from "@pi-harbor/shared";
import type { StoreApi } from "zustand/vanilla";
import {
  applyBtwEnvelope,
  beginBtwTurn,
  btwBaselineFor,
  btwHistoryFor,
  btwQuestionProblem,
  btwThreadOf,
  clearBtwThread,
  consumeBtwFocus,
  dropBtwThread,
  parseBtwEventEnvelope,
  removeBtwTurn,
  requestBtwFocus,
  setBtwDraft,
  settleBtwTurnAborted,
} from "./btw-model";
import type { BtwMainView, BtwState, BtwTabPresence } from "./btw-model";

/**
 * BTW side-question workflow (ADR 0344): opening the tab, asking, stopping,
 * and following the runtime's events. Its I/O arrives through ports, so the
 * whole flow runs in tests without Electron or the app store.
 */

export type BtwApiPort = {
  ask: (request: BtwAskRequest) => Promise<BtwAskResult>;
  abort: (request: BtwAbortRequest) => Promise<{ aborted: boolean }>;
  /** Subscribe to `btwMessage` payloads; returns the unsubscribe function. */
  onEvent: (listener: (payload: unknown) => void) => () => void;
};

export type BtwHostPort = {
  activeSessionId: () => string | undefined;
  session: (sessionId: string) => Pick<SessionSummary, "id" | "source"> | undefined;
  mainView: (sessionId: string) => BtwMainView;
  /** Open or focus the session's BTW tab and expand the panel. */
  openTab: (sessionId: string) => void;
  tabPresence: (sessionId: string) => BtwTabPresence;
  /** Call `listener` whenever any session's panel tabs may have changed. */
  subscribeTabs: (listener: () => void) => () => void;
  toast: (message: string, variant: "warning" | "error") => void;
};

export type BtwTranslate = (
  key: string,
  options?: { defaultValue?: string; max?: number },
) => string;

export type BtwServiceDependencies = {
  api: BtwApiPort;
  host: BtwHostPort;
  store: StoreApi<BtwState>;
  t: BtwTranslate;
  newRunId: () => string;
  now: () => number;
  warn: (message: string) => void;
};

export type BtwController = {
  /** Open or focus the active session's BTW tab. Returns its id, or null after a toast. */
  open: () => string | null;
  /**
   * Run `/btw [question]` from the main composer. Resolves true when the
   * composer may clear its draft: the tab opened and any question was accepted.
   */
  runCommand: (question: string) => Promise<boolean>;
  /** Ask one question in a session's thread. Resolves true once the runtime accepted it. */
  ask: (sessionId: string, question: string) => Promise<boolean>;
  /** Send the BTW input's draft; the draft is cleared after the question is accepted. */
  submitDraft: (sessionId: string) => Promise<boolean>;
  stop: (sessionId: string) => Promise<void>;
  /** Ask a failed question again; the failed turn is replaced once the retry is accepted. */
  retry: (sessionId: string, runId: string) => Promise<boolean>;
  clear: (sessionId: string) => void;
  setDraft: (sessionId: string, draft: string) => void;
  consumeFocus: (sessionId: string) => void;
  /** Detach the IPC and panel subscriptions. */
  dispose: () => void;
};

/** The first non-blank string: a catalog may be missing a key or not loaded yet. */
function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/** User-facing text for a rejected question or a failed answer. */
export function btwErrorText(t: BtwTranslate, error: Pick<AppError, "code" | "message">): string {
  const fallback = textOr(error.message, "");
  // A browser web access client has no handler for the BTW channels: they need
  // the desktop window's sender so Main can stop runs when it reloads.
  if (error.code === ErrorCodes.UNSUPPORTED) {
    return textOr(t("panel.btw.desktopOnly"), fallback);
  }
  const localized = error.code ? t(`errors.${error.code}`, { defaultValue: fallback }) : "";
  const text = textOr(localized, fallback);
  // A blank toast hides the failure, so the last resort is still something.
  return text || t("panel.btw.failed");
}

function failureOf(cause: unknown): Pick<AppError, "code" | "message"> {
  if (cause instanceof Error) {
    const code = "code" in cause && typeof cause.code === "string" ? cause.code : "";
    return { code, message: cause.message };
  }
  return { code: "", message: String(cause) };
}

export function createBtwController(deps: BtwServiceDependencies): BtwController {
  const { api, host, store, t } = deps;
  const aborting = new Set<string>();
  let unsubscribers: Array<() => void> = [];

  const update = (recipe: (state: BtwState) => BtwState) => {
    const current = store.getState();
    const next = recipe(current);
    if (next !== current) store.setState(next, true);
  };
  const threadOf = (sessionId: string) => btwThreadOf(store.getState(), sessionId);

  const abortRun = async (sessionId: string, runId: string): Promise<void> => {
    if (aborting.has(runId)) return;
    aborting.add(runId);
    try {
      const { aborted } = await api.abort({ runId });
      // `false` means the runtime has no such run: it already ended, and its
      // terminal event arrived before this reply, or the runtime restarted.
      // Settling leaves a turn that already ended unchanged.
      if (!aborted) update((state) => settleBtwTurnAborted(state, sessionId, runId));
    } catch (cause) {
      host.toast(btwErrorText(t, failureOf(cause)), "error");
    } finally {
      aborting.delete(runId);
    }
  };

  // Closing the tab stops its run and keeps the thread; removing the session
  // also forgets the thread.
  const reconcileTabs = () => {
    for (const [sessionId, thread] of Object.entries(store.getState().threads)) {
      const presence = host.tabPresence(sessionId);
      if (presence === "open") continue;
      if (thread.activeRunId) void abortRun(sessionId, thread.activeRunId);
      if (presence === "gone") update((state) => dropBtwThread(state, sessionId));
    }
  };

  const start = () => {
    if (unsubscribers.length > 0) return;
    unsubscribers = [
      api.onEvent((payload) => {
        const envelope = parseBtwEventEnvelope(payload);
        if (!envelope) {
          deps.warn("[btw] ignored a malformed side-question event");
          return;
        }
        update((state) => applyBtwEnvelope(state, envelope));
      }),
      host.subscribeTabs(reconcileTabs),
    ];
  };

  const open = (): string | null => {
    const sessionId = host.activeSessionId();
    if (!sessionId) {
      host.toast(t("errors.BTW_NO_SESSION"), "warning");
      return null;
    }
    if (!btwAvailableFor(host.session(sessionId) ?? { id: sessionId })) {
      host.toast(t("errors.BTW_UNAVAILABLE"), "warning");
      return null;
    }
    start();
    host.openTab(sessionId);
    update((state) => requestBtwFocus(state, sessionId));
    return sessionId;
  };

  const ask = async (sessionId: string, question: string): Promise<boolean> => {
    const text = question.trim();
    const problem = btwQuestionProblem(text);
    if (problem === "empty") return false;
    if (problem === "tooLong") {
      host.toast(t("panel.btw.questionTooLong", { max: BTW_QUESTION_MAX_CHARS }), "warning");
      return false;
    }
    const thread = threadOf(sessionId);
    if (thread.activeRunId) {
      host.toast(t("errors.BTW_BUSY"), "warning");
      return false;
    }
    start();
    const runId = deps.newRunId();
    // The turn exists before the request leaves, so events that race ahead of
    // the reply already have a turn to fold into.
    update((state) =>
      beginBtwTurn(state, sessionId, {
        runId,
        question: text,
        baseline: btwBaselineFor(host.mainView(sessionId)),
        askedAt: deps.now(),
      }),
    );
    try {
      await api.ask({ sessionId, runId, question: text, history: btwHistoryFor(thread.turns) });
      return true;
    } catch (cause) {
      update((state) => removeBtwTurn(state, sessionId, runId));
      host.toast(btwErrorText(t, failureOf(cause)), "error");
      return false;
    }
  };

  return {
    open,
    ask,
    runCommand: async (question) => {
      const sessionId = open();
      if (!sessionId) return false;
      return question.trim() ? ask(sessionId, question) : true;
    },
    submitDraft: async (sessionId) => {
      const draft = threadOf(sessionId).draft;
      if (!(await ask(sessionId, draft))) return false;
      // Keep anything typed while the question was on its way.
      update((state) =>
        btwThreadOf(state, sessionId).draft === draft ? setBtwDraft(state, sessionId, "") : state,
      );
      return true;
    },
    stop: async (sessionId) => {
      const runId = threadOf(sessionId).activeRunId;
      if (runId) await abortRun(sessionId, runId);
    },
    retry: async (sessionId, runId) => {
      const failed = threadOf(sessionId).turns.find((turn) => turn.runId === runId);
      if (!failed || failed.status !== "error") return false;
      if (!(await ask(sessionId, failed.question))) return false;
      update((state) => removeBtwTurn(state, sessionId, runId));
      return true;
    },
    clear: (sessionId) => update((state) => clearBtwThread(state, sessionId)),
    setDraft: (sessionId, draft) => update((state) => setBtwDraft(state, sessionId, draft)),
    consumeFocus: (sessionId) => update((state) => consumeBtwFocus(state, sessionId)),
    dispose: () => {
      for (const release of unsubscribers) release();
      unsubscribers = [];
    },
  };
}
