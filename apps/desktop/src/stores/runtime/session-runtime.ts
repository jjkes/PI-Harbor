import type {
  AgentEventEnvelope,
  SessionSummary,
  UiMessage,
} from "@pi-harbor/shared";
import { applyMessageUpdate } from "@pi-harbor/shared";
import { api } from "../../lib/api";
import { createNavigationIntentController } from "../../lib/navigation-intent";
import {
  dedupeSessionMessages,
  durableCoversLiveSessionMessages,
  mergeLiveSessionMessages,
  projectMessageEnd,
  removeLiveSessionMessage,
  upsertLiveSessionMessage,
} from "../../lib/session-transcript";
import { getSessionMessageSnapshot, getSessionToolMessagePositions } from "../../lib/session-transcript-updates";
import { sessionReadLooksEmpty } from "../../lib/session-transcript-read";
import { isAutomationSession } from "../../lib/session-origin";
import { sessionIsArchived, type SessionMeta } from "../../lib/sidebar-preferences";
import {
  normalizeProjectPath,
  sessionMatchesProjectWorkspace,
} from "../../lib/sidebar-session-groups";
import type { ComposerDraftSnapshot } from "../../lib/composer-smart-stop";
import { formatToolValue } from "../../lib/tool-display";
import { recordPaneTranscript } from "../../lib/session-panes";
import type { AppState, SessionHistoryWindow } from "../app-state";
import type { StoreAccess } from "../slices/types";


/**
 * What a "new session" request is scoped to: the project, the project
 * workspace it is bound to, and whether it asks for an isolated worktree.
 *
 * All three take part in the scope key and in the empty-slot lookup, so a
 * workspace request never reuses an empty project session and vice versa
 * (design §4.8).
 */
export type NewSessionScope = {
  projectPath?: string | null;
  /** `.pi/worktree/<name>` binding; absent means the project root. */
  workspaceId?: string | null;
  /** Isolated session in its own git worktree (ADR 0329). */
  isolated?: boolean;
};
export const SESSION_TRANSCRIPT_CACHE_LIMIT = 20;
export const SESSION_TRANSCRIPT_PAGE_SIZE = 100;
export const SESSION_TRANSCRIPT_CONTENT_LIMIT = 64 * 1024;

export type SubmittedComposerDraft = {
  messageCountBeforeSend: number;
  draft: ComposerDraftSnapshot;
  abortResolution?: Promise<boolean>;
  resolveAbort?: (restored: boolean) => void;
};

export type SessionConfiguration = Pick<
  SessionSummary,
  "mode" | "providerId" | "modelId" | "thinkingLevel"
> &
  Partial<Pick<SessionSummary, "permissionMode">>;

export type SessionSelection = { id: string; intent: number };

export type SessionRuntime = {
  readonly pendingNewSessionRequests: Map<string, Promise<void>>;
  readonly sessionTranscriptCache: Map<string, UiMessage[]>;
  readonly liveSessionTranscripts: Set<string>;
  readonly sessionHistoryCache: Map<string, SessionHistoryWindow>;
  readonly submittedComposerDrafts: Map<string, SubmittedComposerDraft>;
  readonly pendingSessionConfigurations: Map<string, SessionConfiguration>;
  readonly sessionConfigurationFlushes: Map<string, Promise<void>>;
  beginNavigationIntent: () => number;
  navigationIntentIsCurrent: (intent: number) => boolean;
  newSessionScopeKey: (scope: NewSessionScope) => string;
  latestSessionInScope: (
    sessions: SessionSummary[],
    scope: NewSessionScope,
    sessionMeta: Record<string, SessionMeta>,
  ) => SessionSummary | undefined;
  liveMessageCountForSession: (
    id: string,
    state: Pick<AppState, "activeSessionId" | "messages" | "retainedTranscripts">,
  ) => number;
  cacheSessionTranscript: (
    id: string,
    messages: UiMessage[],
    window?: SessionHistoryWindow,
  ) => void;
  syncTranscriptProjection: (state: AppState, previous: AppState) => void;
  loadSessionDetail: (
    id: string,
    options?: {
      messageBefore?: number;
      messageLimit?: number;
      contentLimit?: number;
    },
  ) => ReturnType<typeof api.getSession>;
  loadFullSessionMessages: (id: string, cache?: boolean) => Promise<UiMessage[] | null>;
  insertOptimisticUserMessage: (sessionId: string, message: UiMessage) => void;
  retractOptimisticUserMessage: (sessionId: string, message: UiMessage) => void;
  cacheBackgroundTranscriptEvent: (envelope: AgentEventEnvelope) => void;
  /**
   * Subscribe to writes of one session's transcript projection. An observed
   * projection stays resident in the cache, so background events keep
   * projecting into it for as long as something renders it.
   */
  observeTranscript: (id: string, listener: () => void) => () => void;
  /** One session's current transcript projection, without loading or selecting it. */
  peekTranscript: (
    id: string,
    state: Pick<AppState, "activeSessionId" | "messages" | "retainedTranscripts">,
  ) => UiMessage[] | undefined;
  mergeSessionConfiguration: (
    current: SessionConfiguration | undefined,
    next: SessionConfiguration,
  ) => SessionConfiguration;
  queueWorkspaceAlignment: <T>(task: () => Promise<T>) => Promise<T>;
  beginSessionSelection: (id: string, intent: number) => SessionSelection;
  isCurrentSessionSelection: (selection: SessionSelection) => boolean;
  isSessionSelectionPending: (sessionId: string) => boolean;
  clearSessionSelection: (selection: SessionSelection) => void;
  isSessionSelectionForIntent: (intent: number) => boolean;
  recordToolStart: (
    toolCallId: string,
    value: {
      toolName: string;
      args: unknown;
      createdAt: string;
      parentToolCallId?: string;
      nestedParentToolCallId?: string;
      agentName?: string;
    },
  ) => void;
  getToolStart: (toolCallId: string) => {
    toolName: string;
    args: unknown;
    createdAt: string;
    parentToolCallId?: string;
    nestedParentToolCallId?: string;
    agentName?: string;
  } | undefined;
  removeToolStart: (toolCallId: string) => void;
  nextPlanSyncGeneration: (sessionId: string) => number;
  planSyncGeneration: (sessionId: string) => number;
};

type ToolStart = NonNullable<ReturnType<SessionRuntime["getToolStart"]>>;

export function createSessionRuntime({ get, set }: StoreAccess): SessionRuntime {
  const navigationIntents = createNavigationIntentController();
  let pendingSessionSelection: SessionSelection | null = null;
  let sessionWorkspaceQueue: Promise<unknown> = Promise.resolve();

  const pendingNewSessionRequests = new Map<string, Promise<void>>();
  const sessionTranscriptCache = new Map<string, UiMessage[]>();
  const liveSessionTranscripts = new Set<string>();
  const sessionHistoryCache = new Map<string, SessionHistoryWindow>();
  const submittedComposerDrafts = new Map<string, SubmittedComposerDraft>();
  const pendingSessionConfigurations = new Map<string, SessionConfiguration>();
  const sessionConfigurationFlushes = new Map<string, Promise<void>>();
  const sessionDetailLoads = new Map<string, ReturnType<typeof api.getSession>>();
  const toolStartsByCallId = new Map<string, ToolStart>();
  const planSyncGenerations = new Map<string, number>();
  const transcriptObservers = new Map<string, Set<() => void>>();

  function notifyTranscriptObservers(id: string): void {
    const observers = transcriptObservers.get(id);
    if (!observers) return;
    for (const observer of [...observers]) observer();
  }

  function cacheSessionTranscript(
    id: string,
    messages: UiMessage[],
    window?: SessionHistoryWindow,
  ): void {
    const normalized = dedupeSessionMessages(messages);
    sessionTranscriptCache.delete(id);
    sessionTranscriptCache.set(id, normalized);
    if (window) sessionHistoryCache.set(id, window);
    // Evict the least recently written projections, never an observed one:
    // background events only project into a cached transcript, so evicting a
    // rendered projection would silently stop it from updating.
    let excess = sessionTranscriptCache.size - SESSION_TRANSCRIPT_CACHE_LIMIT;
    for (const candidate of sessionTranscriptCache.keys()) {
      if (excess <= 0) break;
      if (candidate === id || transcriptObservers.has(candidate)) continue;
      sessionTranscriptCache.delete(candidate);
      sessionHistoryCache.delete(candidate);
      liveSessionTranscripts.delete(candidate);
      excess -= 1;
    }
    notifyTranscriptObservers(id);
  }

  function observeTranscript(id: string, listener: () => void): () => void {
    // Each subscription owns its entry, so one callback subscribed twice needs
    // two unsubscribes.
    const observer = () => listener();
    const observers = transcriptObservers.get(id) ?? new Set<() => void>();
    observers.add(observer);
    transcriptObservers.set(id, observers);
    return () => {
      observers.delete(observer);
      if (observers.size === 0 && transcriptObservers.get(id) === observers) {
        transcriptObservers.delete(id);
      }
    };
  }

  function peekTranscript(
    id: string,
    state: Pick<AppState, "activeSessionId" | "messages" | "retainedTranscripts">,
  ): UiMessage[] | undefined {
    // The active transcript is canonical; a background session reads the cache
    // its events project into, then the pane it last painted.
    return state.activeSessionId === id
      ? state.messages
      : sessionTranscriptCache.get(id) ?? state.retainedTranscripts[id];
  }

  function loadSessionDetail(
    id: string,
    options?: {
      messageBefore?: number;
      messageLimit?: number;
      contentLimit?: number;
    },
  ) {
    const active = sessionDetailLoads.get(id);
    if (active && options?.messageBefore === undefined) return active;
    const request = api.getSession(id, options).then((detail) => {
      if (detail.session && options?.messageBefore === undefined) {
        const state = get();
        const liveMessages =
          sessionTranscriptCache.get(id) ?? state.retainedTranscripts[id];
        const messages =
          (liveSessionTranscripts.has(id) || state.runningSessions[id]) &&
          liveMessages
            ? mergeLiveSessionMessages(detail.session.messages ?? [], liveMessages)
            : detail.session.messages ?? [];
        // Never cache a suspiciously empty window (issue #795): hover prefetch
        // would then re-serve that emptiness on every later open, and the
        // session could not recover without a restart.
        if (messages.length > 0 || !sessionReadLooksEmpty(detail.session)) {
          cacheSessionTranscript(id, messages, {
            messageStart: detail.session.messageStart ?? 0,
            hasMoreBefore: detail.session.hasMoreBefore === true,
            contentLimited: options?.contentLimit !== undefined,
          });
        }
      }
      return detail;
    });
    if (options?.messageBefore === undefined) sessionDetailLoads.set(id, request);
    const clear = () => {
      if (
        options?.messageBefore === undefined &&
        sessionDetailLoads.get(id) === request
      ) {
        sessionDetailLoads.delete(id);
      }
    };
    void request.then(clear, clear);
    return request;
  }

  /** Every canonical writer (streaming, edits, retries) shares this cache boundary. */
  function syncTranscriptProjection(state: AppState, previous: AppState) {
    if (state.messages === previous.messages && state.activeSessionId === previous.activeSessionId) return;
    const id = state.activeSessionId;
    if (!id) return;
    if (state.runningSessions[id] || previous.runningSessions[id]) liveSessionTranscripts.add(id);
    cacheSessionTranscript(id, state.messages, state.sessionHistory[id]);
    if (state.retainedTranscripts[id] === state.messages) return;
    set((current) => current.activeSessionId === id
      ? recordPaneTranscript(current, id, current.messages) : {});
  }

  async function loadFullSessionMessages(id: string, cache = true): Promise<UiMessage[] | null> {
    const detail = await api.getSession(id);
    if (!detail.session) return null;
    const messages = detail.session.messages ?? [];
    if (cache) cacheSessionTranscript(id, messages, {
        messageStart: 0,
        hasMoreBefore: false,
      });
    return messages;
  }

  function insertOptimisticUserMessage(sessionId: string, message: UiMessage): void {
    const state = get();
    if (state.activeSessionId === sessionId) {
      set((current) => ({
        messages: upsertLiveSessionMessage(current.messages, message),
      }));
      return;
    }
    const cached = sessionTranscriptCache.get(sessionId);
    if (cached) {
      sessionTranscriptCache.set(
        sessionId,
        upsertLiveSessionMessage(cached, message),
      );
      notifyTranscriptObservers(sessionId);
    }
  }

  function retractOptimisticUserMessage(sessionId: string, message: UiMessage): void {
    const state = get();
    if (state.activeSessionId === sessionId) {
      set((current) =>
        current.messages.includes(message)
          ? { messages: removeLiveSessionMessage(current.messages, message.id) }
          : current,
      );
      return;
    }
    const cached = sessionTranscriptCache.get(sessionId);
    if (cached?.includes(message)) {
      sessionTranscriptCache.set(
        sessionId,
        removeLiveSessionMessage(cached, message.id),
      );
      notifyTranscriptObservers(sessionId);
    }
  }

  function projectTranscriptEvent(current: UiMessage[], envelope: AgentEventEnvelope): UiMessage[] {
    const { event } = envelope;
    let next = current;
    switch (event.type) {
      case "message_start":
        next = upsertLiveSessionMessage(current, event.message);
        break;
      case "message_update": {
        const normalized = dedupeSessionMessages(current);
        const index = getSessionMessageSnapshot(normalized).positions.get(event.message.id);
        const previous = index === undefined ? undefined : normalized[index];
        next = upsertLiveSessionMessage(normalized, applyMessageUpdate(previous, event));
        break;
      }
      case "message_end": {
        next = projectMessageEnd(current, event);
        break;
      }
      case "tool_start":
        next = upsertLiveSessionMessage(current, {
          id: event.toolCallId,
          role: "tool",
          content: "",
          createdAt: new Date(envelope.ts).toISOString(),
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolArgs: event.args,
          toolStatus: "running",
          status: "streaming",
          ...(envelope.parentToolCallId
            ? { parentToolCallId: envelope.parentToolCallId }
            : {}),
          ...(envelope.nestedParentToolCallId ? { nestedParentToolCallId: envelope.nestedParentToolCallId } : {}),
          ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
        });
        break;
      case "tool_update": {
        if (event.partialResult === undefined) return current;
        const index = getSessionToolMessagePositions(current, event.toolCallId)
          .find((position) => current[position].toolStatus === "running");
        if (index === undefined) return current;
        const existing = current[index];
        next = upsertLiveSessionMessage(current, {
          ...existing,
          content:
            typeof event.partialResult === "string"
              ? event.partialResult
              : formatToolValue(event.partialResult),
          toolResult: event.partialResult,
        });
        break;
      }
      case "tool_end": {
        const toolStart = toolStartsByCallId.get(event.toolCallId);
        const completedAt = new Date(envelope.ts).toISOString();
        const completed: UiMessage = {
          id: event.toolCallId,
          role: "tool",
          content:
            typeof event.result === "string"
              ? event.result
              : JSON.stringify(event.result, null, 2),
          createdAt: toolStart?.createdAt ?? completedAt,
          toolCallId: event.toolCallId,
          ...(toolStart?.toolName ? { toolName: toolStart.toolName } : {}),
          ...(toolStart ? { toolArgs: toolStart.args } : {}),
          toolCompletedAt: completedAt,
          toolDurationMs: toolStart
            ? Math.max(0, envelope.ts - Date.parse(toolStart.createdAt))
            : 0,
          toolStatus: event.isError ? "error" : "success",
          toolResult: event.result,
          ...(event.toolUsage ? { toolUsage: event.toolUsage } : {}),
          status: "complete",
          isError: event.isError,
        };
        const existing = current.find(
          (message) => message.toolCallId === event.toolCallId,
        );
        next = existing
          ? upsertLiveSessionMessage(current, {
              ...existing,
              ...completed,
              toolName: existing.toolName ?? completed.toolName,
              toolArgs: existing.toolArgs ?? completed.toolArgs,
              createdAt: existing.createdAt || completed.createdAt,
            })
          : upsertLiveSessionMessage(current, completed);
        break;
      }
      default:
        return current;
    }

    return next;
  }

  function cacheBackgroundTranscriptEvent(envelope: AgentEventEnvelope): void {
    const { sessionId } = envelope;
    const state = get();
    const current =
      sessionTranscriptCache.get(sessionId) ?? state.retainedTranscripts[sessionId];
    if (!current) return;

    const next = projectTranscriptEvent(current, envelope);
    if (next === current) return;
    liveSessionTranscripts.add(sessionId);
    cacheSessionTranscript(
      sessionId,
      next,
      sessionHistoryCache.get(sessionId) ?? state.sessionHistory[sessionId],
    );
  }

  function queueWorkspaceAlignment<T>(task: () => Promise<T>): Promise<T> {
    const next = sessionWorkspaceQueue.then(task, task);
    sessionWorkspaceQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function recordToolStart(toolCallId: string, value: ToolStart): void {
    if (toolStartsByCallId.size >= 512) {
      const oldest = toolStartsByCallId.keys().next().value;
      if (oldest !== undefined) toolStartsByCallId.delete(oldest);
    }
    toolStartsByCallId.set(toolCallId, value);
  }

  return {
    pendingNewSessionRequests,
    sessionTranscriptCache,
    liveSessionTranscripts,
    sessionHistoryCache,
    syncTranscriptProjection,
    submittedComposerDrafts,
    pendingSessionConfigurations,
    sessionConfigurationFlushes,
    beginNavigationIntent: () => navigationIntents.begin(),
    navigationIntentIsCurrent: (intent) => navigationIntents.isCurrent(intent),
    newSessionScopeKey: (scope) => {
      const base = normalizeProjectPath(scope.projectPath) ?? "<temporary>";
      const workspace = scope.workspaceId ? `\u0000workspace:${scope.workspaceId}` : "";
      return `${base}${workspace}${scope.isolated ? "\u0000isolated" : ""}`;
    },
    latestSessionInScope: (sessions, scope, sessionMeta) =>
      sessions
        .filter(
          (session) =>
            !isAutomationSession(session) &&
            sessionMatchesProjectWorkspace(
              session,
              scope.projectPath,
              scope.workspaceId,
            ),
        )
        .sort((a, b) => {
          const aUpdated = Date.parse(a.updatedAt);
          const bUpdated = Date.parse(b.updatedAt);
          const aTime = Number.isFinite(aUpdated) ? aUpdated : 0;
          const bTime = Number.isFinite(bUpdated) ? bUpdated : 0;
          return bTime - aTime || b.id.localeCompare(a.id);
        })
        .find((session) => !sessionIsArchived(session.id, sessionMeta)),
    liveMessageCountForSession: (id, state) => peekTranscript(id, state)?.length ?? 0,
    cacheSessionTranscript,
    loadSessionDetail,
    loadFullSessionMessages,
    insertOptimisticUserMessage,
    retractOptimisticUserMessage,
    cacheBackgroundTranscriptEvent,
    observeTranscript,
    peekTranscript,
    mergeSessionConfiguration: (current, next) => {
      if (!current) return next;
      const merged: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(next)) {
        if (value !== undefined) merged[key] = value;
      }
      return merged as SessionConfiguration;
    },
    queueWorkspaceAlignment,
    beginSessionSelection: (id, intent) => {
      const selection = { id, intent };
      pendingSessionSelection = selection;
      return selection;
    },
    isCurrentSessionSelection: (selection) =>
      pendingSessionSelection === selection,
    isSessionSelectionPending: (sessionId) =>
      pendingSessionSelection?.id === sessionId,
    clearSessionSelection: (selection) => {
      if (pendingSessionSelection === selection) pendingSessionSelection = null;
    },
    isSessionSelectionForIntent: (intent) =>
      pendingSessionSelection?.intent === intent,
    recordToolStart,
    getToolStart: (toolCallId) => toolStartsByCallId.get(toolCallId),
    removeToolStart: (toolCallId) => toolStartsByCallId.delete(toolCallId),
    nextPlanSyncGeneration: (sessionId) => {
      const next = (planSyncGenerations.get(sessionId) ?? 0) + 1;
      planSyncGenerations.set(sessionId, next);
      return next;
    },
    planSyncGeneration: (sessionId) => planSyncGenerations.get(sessionId) ?? 0,
  };
}

export function sessionMessagesCoverLiveTail(
  durable: UiMessage[],
  live: UiMessage[] | undefined,
): boolean {
  return durableCoversLiveSessionMessages(durable, live);
}
