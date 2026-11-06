import { BTW_QUESTION_MAX_CHARS, boundedBtwHistory } from "@pi-harbor/shared";
import type {
  AppError,
  BtwEvent,
  BtwEventEnvelope,
  BtwHistoryTurn,
  MessageUsage,
} from "@pi-harbor/shared";
import { parseSlashSubmission } from "../composer/slash-dispatch";

/**
 * Renderer state for BTW side questions (ADR 0344).
 *
 * One thread per main session holds the questions asked in that session's
 * BTW tab. Threads live only in renderer memory. Everything in this module is
 * pure: the controller owns IPC and the app store, so these transitions can be
 * tested without either.
 */

/** Longest tool argument shown on a tool row. */
const TOOL_SUMMARY_MAX_CHARS = 120;

/** Argument keys that name what a read-only tool looked at, in display order. */
const TOOL_SUMMARY_KEYS = ["pattern", "path", "file_path", "glob", "query"] as const;

/** The slash name of `builtin.session.btw`. */
export const BTW_SLASH_NAME = "btw";

export type BtwToolState = "running" | "ok" | "failed" | "stopped";

export type BtwToolRow = {
  toolCallId: string;
  toolName: string;
  /** The path or pattern the call names, when its arguments have one. */
  summary?: string;
  state: BtwToolState;
  errorCode?: string;
};

export type BtwTurnStatus = "pending" | "streaming" | "done" | "aborted" | "error";

/** What the main conversation looked like when a question was sent. */
export type BtwBaseline = {
  /** Last settled main message; absent when the conversation was empty. */
  lastMessageId?: string;
  settledCount: number;
  compactionCount: number;
  mainRunning: boolean;
};

export type BtwUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type BtwTurn = {
  runId: string;
  question: string;
  answer: string;
  status: BtwTurnStatus;
  tools: BtwToolRow[];
  usage?: BtwUsageTotals;
  providerId?: string;
  modelId?: string;
  error?: AppError;
  baseline: BtwBaseline;
  /** Highest event sequence folded so far; -1 before the first event. */
  lastSeq: number;
  askedAt: number;
};

export type BtwThread = {
  turns: BtwTurn[];
  /** The run still in flight. A session has at most one at a time. */
  activeRunId: string | null;
  /** Unsent text in the BTW input. */
  draft: string;
};

export type BtwState = {
  threads: Record<string, BtwThread>;
  /** Session whose BTW input takes focus once its tab renders. */
  focusSessionId: string | null;
};

export const EMPTY_BTW_THREAD: BtwThread = { turns: [], activeRunId: null, draft: "" };

export function emptyBtwState(): BtwState {
  return { threads: {}, focusSessionId: null };
}

export function btwThreadOf(state: BtwState, sessionId: string): BtwThread {
  return state.threads[sessionId] ?? EMPTY_BTW_THREAD;
}

function withThread(state: BtwState, sessionId: string, thread: BtwThread): BtwState {
  return { ...state, threads: { ...state.threads, [sessionId]: thread } };
}

export function isTerminalBtwStatus(status: BtwTurnStatus): boolean {
  return status === "done" || status === "aborted" || status === "error";
}

/** Add the pending turn of a question that is about to be sent. */
export function beginBtwTurn(
  state: BtwState,
  sessionId: string,
  turn: { runId: string; question: string; baseline: BtwBaseline; askedAt: number },
): BtwState {
  const thread = btwThreadOf(state, sessionId);
  return withThread(state, sessionId, {
    ...thread,
    activeRunId: turn.runId,
    turns: [...thread.turns, { ...turn, answer: "", status: "pending", tools: [], lastSeq: -1 }],
  });
}

/** Drop one turn: a question the runtime never accepted, or a retried failure. */
export function removeBtwTurn(state: BtwState, sessionId: string, runId: string): BtwState {
  const thread = state.threads[sessionId];
  if (!thread || !thread.turns.some((turn) => turn.runId === runId)) return state;
  return withThread(state, sessionId, {
    ...thread,
    turns: thread.turns.filter((turn) => turn.runId !== runId),
    activeRunId: thread.activeRunId === runId ? null : thread.activeRunId,
  });
}

function updateTurn(
  state: BtwState,
  sessionId: string,
  runId: string,
  update: (turn: BtwTurn) => BtwTurn,
): BtwState {
  const thread = state.threads[sessionId];
  if (!thread) return state;
  const index = thread.turns.findIndex((turn) => turn.runId === runId);
  const current = index === -1 ? undefined : thread.turns[index];
  if (!current) return state;
  const next = update(current);
  if (next === current) return state;
  const turns = thread.turns.slice();
  turns[index] = next;
  const ended = isTerminalBtwStatus(next.status) && thread.activeRunId === runId;
  return withThread(state, sessionId, {
    ...thread,
    turns,
    activeRunId: ended ? null : thread.activeRunId,
  });
}

/**
 * Fold one event into its turn. Events of a run this renderer does not know,
 * replayed or out-of-order sequence numbers, and events after the turn ended
 * leave the state unchanged.
 */
export function applyBtwEnvelope(state: BtwState, envelope: BtwEventEnvelope): BtwState {
  return updateTurn(state, envelope.sessionId, envelope.runId, (turn) => {
    if (isTerminalBtwStatus(turn.status) || envelope.seq <= turn.lastSeq) return turn;
    return foldBtwEvent({ ...turn, lastSeq: envelope.seq }, envelope.event);
  });
}

/**
 * End a turn as stopped when the runtime no longer has its run, so no terminal
 * event will arrive. A turn that already ended keeps its outcome.
 */
export function settleBtwTurnAborted(state: BtwState, sessionId: string, runId: string): BtwState {
  return updateTurn(state, sessionId, runId, (turn) =>
    isTerminalBtwStatus(turn.status) ? turn : finishTurn(turn, "aborted"),
  );
}

function foldBtwEvent(turn: BtwTurn, event: BtwEvent): BtwTurn {
  switch (event.type) {
    case "started":
      return {
        ...turn,
        status: "streaming",
        providerId: event.providerId,
        modelId: event.modelId,
        // The runtime's snapshot decides what the answer could see.
        baseline: { ...turn.baseline, mainRunning: event.mainTurnRunning },
      };
    case "text_delta":
      return { ...turn, status: "streaming", answer: turn.answer + event.delta };
    case "tool_start": {
      if (turn.tools.some((tool) => tool.toolCallId === event.toolCallId)) return turn;
      const summary = btwToolSummary(event.args);
      const row: BtwToolRow = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(summary ? { summary } : {}),
        state: "running",
      };
      return { ...turn, status: "streaming", tools: [...turn.tools, row] };
    }
    case "tool_end":
      return {
        ...turn,
        tools: turn.tools.map((tool): BtwToolRow =>
          tool.toolCallId === event.toolCallId
            ? {
                ...tool,
                state: event.ok ? "ok" : "failed",
                ...(event.errorCode ? { errorCode: event.errorCode } : {}),
              }
            : tool,
        ),
      };
    case "usage":
      return { ...turn, usage: addBtwUsage(turn.usage, event.usage) };
    case "done":
      return finishTurn(turn, event.stopReason === "aborted" ? "aborted" : "done");
    case "error":
      return finishTurn(turn, "error", event.error);
  }
}

function finishTurn(
  turn: BtwTurn,
  status: "done" | "aborted" | "error",
  error?: AppError,
): BtwTurn {
  return {
    ...turn,
    status,
    tools: turn.tools.map((tool): BtwToolRow =>
      tool.state === "running" ? { ...tool, state: "stopped" } : tool,
    ),
    ...(error ? { error } : {}),
  };
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Sum the usage of every provider request one answer made. */
export function addBtwUsage(
  totals: BtwUsageTotals | undefined,
  usage: Pick<MessageUsage, "inputTokens" | "outputTokens" | "totalTokens">,
): BtwUsageTotals {
  const input = tokenCount(usage.inputTokens);
  const output = tokenCount(usage.outputTokens);
  const total = tokenCount(usage.totalTokens) || input + output;
  return {
    inputTokens: (totals?.inputTokens ?? 0) + input,
    outputTokens: (totals?.outputTokens ?? 0) + output,
    totalTokens: (totals?.totalTokens ?? 0) + total,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The path or pattern a tool call names, shortened for its row. */
export function btwToolSummary(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = args[key];
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text) continue;
    return text.length > TOOL_SUMMARY_MAX_CHARS
      ? `${text.slice(0, TOOL_SUMMARY_MAX_CHARS - 1)}…`
      : text;
  }
  return undefined;
}

function parseBtwEvent(value: unknown): BtwEvent | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case "started": {
      const { providerId, modelId, mainTurnRunning } = value;
      if (typeof providerId !== "string" || typeof modelId !== "string") return undefined;
      if (typeof mainTurnRunning !== "boolean") return undefined;
      return { type: "started", providerId, modelId, mainTurnRunning };
    }
    case "text_delta": {
      const { delta } = value;
      return typeof delta === "string" ? { type: "text_delta", delta } : undefined;
    }
    case "tool_start": {
      const { toolCallId, toolName, args } = value;
      if (typeof toolCallId !== "string" || typeof toolName !== "string") return undefined;
      return { type: "tool_start", toolCallId, toolName, args };
    }
    case "tool_end": {
      const { toolCallId, ok, errorCode } = value;
      if (typeof toolCallId !== "string" || typeof ok !== "boolean") return undefined;
      if (errorCode !== undefined && typeof errorCode !== "string") return undefined;
      return {
        type: "tool_end",
        toolCallId,
        ok,
        ...(errorCode !== undefined ? { errorCode } : {}),
      };
    }
    case "usage": {
      const { usage } = value;
      if (!isRecord(usage)) return undefined;
      return {
        type: "usage",
        usage: {
          inputTokens: tokenCount(usage.inputTokens),
          outputTokens: tokenCount(usage.outputTokens),
          totalTokens: tokenCount(usage.totalTokens),
        },
      };
    }
    case "done": {
      const { stopReason } = value;
      if (stopReason !== "stop" && stopReason !== "aborted") return undefined;
      return { type: "done", stopReason };
    }
    case "error": {
      const { error } = value;
      if (!isRecord(error)) return undefined;
      const { code, message, retriable } = error;
      if (typeof code !== "string" || typeof message !== "string") return undefined;
      return {
        type: "error",
        error: { code, message, ...(typeof retriable === "boolean" ? { retriable } : {}) },
      };
    }
    default:
      return undefined;
  }
}

/** Validate one `btwMessage` payload; the caller ignores anything else. */
export function parseBtwEventEnvelope(value: unknown): BtwEventEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  const { runId, sessionId, seq } = value;
  if (typeof runId !== "string" || typeof sessionId !== "string") return undefined;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return undefined;
  const event = parseBtwEvent(value.event);
  return event ? { runId, sessionId, seq, event } : undefined;
}

/** A main transcript row, as staleness reads it. */
export type BtwMainRow = { id: string; status?: string };

/** The main conversation as the BTW tab sees it. */
export type BtwMainView = {
  messages: readonly BtwMainRow[];
  compactionCount: number;
  running: boolean;
};

/** Rows that no longer change; a streaming reply is not part of a snapshot. */
function settledRows(messages: readonly BtwMainRow[]): readonly BtwMainRow[] {
  return messages.filter((message) => message.status !== "streaming");
}

export function btwBaselineFor(view: BtwMainView): BtwBaseline {
  const settled = settledRows(view.messages);
  const last = settled[settled.length - 1];
  return {
    ...(last ? { lastMessageId: last.id } : {}),
    settledCount: settled.length,
    compactionCount: view.compactionCount,
    mainRunning: view.running,
  };
}

export type BtwStaleness =
  | { kind: "current" }
  | { kind: "midTurn" }
  | { kind: "compacted" }
  | { kind: "newer"; count: number }
  | { kind: "changed" };

/**
 * How the main conversation moved on since an answer's question was sent.
 * Message ids decide first. When the baseline row is gone and nothing was
 * compacted, for example after an optimistic id was replaced, counts decide.
 */
export function btwStaleness(baseline: BtwBaseline, view: BtwMainView): BtwStaleness {
  if (view.compactionCount > baseline.compactionCount) return { kind: "compacted" };
  const settled = settledRows(view.messages);
  let newer: number;
  if (baseline.lastMessageId === undefined) {
    newer = settled.length;
  } else {
    const index = settled.findIndex((message) => message.id === baseline.lastMessageId);
    newer = index === -1 ? settled.length - baseline.settledCount : settled.length - index - 1;
  }
  if (newer < 0) return { kind: "changed" };
  if (newer > 0) return { kind: "newer", count: newer };
  return baseline.mainRunning && view.running ? { kind: "midTurn" } : { kind: "current" };
}

/** Earlier exchanges sent with a follow-up: answered turns only, newest that fit. */
export function btwHistoryFor(turns: readonly BtwTurn[]): BtwHistoryTurn[] {
  return boundedBtwHistory(
    turns
      .filter((turn) => turn.status === "done" && turn.answer.trim().length > 0)
      .map((turn) => ({ question: turn.question, answer: turn.answer })),
  );
}

/**
 * Recognize `/btw` and `/btw <question>` in a composer submission. Returns the
 * question (empty for a bare `/btw`), or null for any other text.
 */
export function parseBtwCommand(content: string): { question: string } | null {
  const submission = parseSlashSubmission(content);
  return submission?.name === BTW_SLASH_NAME ? { question: submission.body } : null;
}

export type BtwQuestionProblem = "empty" | "tooLong";

export function btwQuestionProblem(question: string): BtwQuestionProblem | null {
  const text = question.trim();
  if (!text) return "empty";
  return text.length > BTW_QUESTION_MAX_CHARS ? "tooLong" : null;
}

export type BtwTabPresence = "open" | "closed" | "gone";

/**
 * Whether a session's BTW tab is still open. `contextTabs` are the session's
 * retained panel tabs; `visibleTabs` are the tabs on screen when it is the
 * active session. A session with no panel state at all was removed: only
 * session deletion drops a panel context (project-slice
 * `clearLocalSessionState`), and asking always opens the tab first.
 */
export function btwTabPresence(
  contextTabs: readonly { kind: string }[] | undefined,
  visibleTabs: readonly { kind: string }[] | undefined,
): BtwTabPresence {
  const hasBtw = (tabs: readonly { kind: string }[] | undefined) =>
    tabs?.some((tab) => tab.kind === "btw") === true;
  if (hasBtw(contextTabs) || hasBtw(visibleTabs)) return "open";
  return contextTabs === undefined && !visibleTabs?.length ? "gone" : "closed";
}

/** Clear the answered turns. Refused while a run is active. */
export function clearBtwThread(state: BtwState, sessionId: string): BtwState {
  const thread = state.threads[sessionId];
  if (!thread || thread.activeRunId !== null || thread.turns.length === 0) return state;
  return withThread(state, sessionId, { ...thread, turns: [] });
}

/** Forget a removed session's thread. */
export function dropBtwThread(state: BtwState, sessionId: string): BtwState {
  if (state.threads[sessionId] === undefined) return state;
  const threads = { ...state.threads };
  delete threads[sessionId];
  return {
    threads,
    focusSessionId: state.focusSessionId === sessionId ? null : state.focusSessionId,
  };
}

export function setBtwDraft(state: BtwState, sessionId: string, draft: string): BtwState {
  const thread = btwThreadOf(state, sessionId);
  return thread.draft === draft ? state : withThread(state, sessionId, { ...thread, draft });
}

export function requestBtwFocus(state: BtwState, sessionId: string): BtwState {
  return state.focusSessionId === sessionId ? state : { ...state, focusSessionId: sessionId };
}

export function consumeBtwFocus(state: BtwState, sessionId: string): BtwState {
  return state.focusSessionId === sessionId ? { ...state, focusSessionId: null } : state;
}
