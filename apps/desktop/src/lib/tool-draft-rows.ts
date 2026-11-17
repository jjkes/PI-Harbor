/**
 * Transcript rows for tool calls the model is still writing (`tool_draft`).
 *
 * A draft row is an ordinary `tool` row with a renderer-only `toolDraft` mark:
 * it appears when the call's first argument streams, grows as the arguments
 * arrive, and becomes the running row in place when `tool_start` arrives, so a
 * call never shows twice. Nothing here reaches Main, the Host, or execution.
 */

import {
  TOOL_DRAFT_GAP,
  applyToolDraftChanges,
  mergeToolDraftEvents,
  type AgentEventEnvelope,
  type ToolDraftAgentEvent,
  type UiMessage,
} from "@pi-harbor/shared";
import {
  dedupeSessionMessages,
  removeLiveSessionMessage,
  upsertLiveSessionMessage,
} from "./session-transcript";
import {
  getSessionMessageSnapshot,
  getSessionToolMessagePositions,
  registerSessionMessageRewrite,
} from "./session-transcript-updates";
import { getToolAction, type ToolAction } from "./tool-display";

function draftRow(envelope: AgentEventEnvelope, event: ToolDraftAgentEvent): UiMessage {
  return {
    id: event.toolCallId,
    role: "tool",
    content: "",
    createdAt: new Date(envelope.ts).toISOString(),
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    toolStatus: "running",
    status: "streaming",
    toolDraft: { phase: "streaming", messageId: event.messageId },
    ...(envelope.parentToolCallId ? { parentToolCallId: envelope.parentToolCallId } : {}),
    ...(envelope.nestedParentToolCallId
      ? { nestedParentToolCallId: envelope.nestedParentToolCallId }
      : {}),
    ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
  };
}

/**
 * Apply one `tool_draft` to a session transcript. A frame for a call that
 * already started (or a durable row with the same id) changes nothing.
 */
export function projectToolDraft(messages: UiMessage[], envelope: AgentEventEnvelope): UiMessage[] {
  const event = envelope.event;
  if (event.type !== "tool_draft") return messages;
  const normalized = dedupeSessionMessages(messages);
  const index = getSessionMessageSnapshot(normalized).positions.get(event.toolCallId);
  const existing = index === undefined ? undefined : normalized[index];
  if (event.phase === "discarded") {
    return existing?.toolDraft ? removeLiveSessionMessage(normalized, event.toolCallId) : normalized;
  }
  if (existing && !existing.toolDraft) return normalized;
  const base = existing ?? draftRow(envelope, event);
  let toolArgs = base.toolArgs;
  let gap = base.toolDraft?.gap === true;
  if (event.phase === "streaming" && !gap && event.changes?.length) {
    const next = applyToolDraftChanges(toolArgs, event.changes);
    if (next === TOOL_DRAFT_GAP) gap = true;
    else toolArgs = next;
  }
  // `complete` is final for the draft: a stray later frame cannot reopen it.
  const phase = event.phase === "complete" || base.toolDraft?.phase === "complete" ? "complete" : "streaming";
  if (existing && toolArgs === existing.toolArgs && phase === existing.toolDraft?.phase && gap === (existing.toolDraft?.gap === true)) {
    return normalized;
  }
  return upsertLiveSessionMessage(normalized, {
    ...base,
    ...(toolArgs !== undefined ? { toolArgs } : {}),
    toolDraft: { phase, messageId: base.toolDraft?.messageId ?? event.messageId, ...(gap ? { gap: true } : {}) },
  });
}

/**
 * The row `tool_start` should write: the draft row turned running in place
 * (same position, the final arguments, timed from the start like any call),
 * or `undefined` when there was no draft and the caller keeps its behaviour.
 */
export function startedFromDraft(messages: UiMessage[], started: UiMessage): UiMessage | undefined {
  const positions = getSessionToolMessagePositions(messages, started.toolCallId ?? started.id);
  const draft = positions.map((index) => messages[index]).find((row) => row?.toolDraft);
  if (!draft) return undefined;
  const { toolDraft: _draft, ...rest } = draft;
  return { ...rest, ...started, id: draft.id, createdAt: draft.createdAt || started.createdAt };
}

/** Remove the draft rows of the given calls; rows that already started stay. */
export function removeToolDraftRows(messages: UiMessage[], toolCallIds: readonly string[]): UiMessage[] {
  if (toolCallIds.length === 0) return messages;
  const doomed = new Set<number>();
  for (const toolCallId of toolCallIds) {
    for (const index of getSessionToolMessagePositions(messages, toolCallId)) {
      if (messages[index]?.toolDraft) doomed.add(index);
    }
  }
  if (doomed.size === 0) return messages;
  return registerSessionMessageRewrite(messages, messages.filter((_, index) => !doomed.has(index)));
}

/** Envelope merge for the renderer's per-frame batch of streaming drafts. */
export function mergeToolDraftEnvelopes(
  previous: AgentEventEnvelope,
  next: AgentEventEnvelope,
): AgentEventEnvelope {
  if (previous.event.type !== "tool_draft" || next.event.type !== "tool_draft") return next;
  const merged = mergeToolDraftEvents(previous.event, next.event);
  return merged ? { ...next, event: merged } : next;
}

type OpenDraft = { messageId: string; parentToolCallId?: string };

/**
 * Which calls of each session still have a draft row, so a sweep removes
 * exactly those rows instead of scanning the transcript.
 */
export class OpenToolDrafts {
  private readonly sessions = new Map<string, Map<string, OpenDraft>>();

  observe(envelope: AgentEventEnvelope): void {
    const event = envelope.event;
    if (event.type === "tool_start" || (event.type === "tool_draft" && event.phase === "discarded")) {
      this.forget(envelope.sessionId, [event.toolCallId]);
    } else if (event.type === "tool_draft") {
      let open = this.sessions.get(envelope.sessionId);
      if (!open) this.sessions.set(envelope.sessionId, (open = new Map()));
      if (!open.has(event.toolCallId)) {
        open.set(event.toolCallId, {
          messageId: event.messageId,
          ...(envelope.parentToolCallId ? { parentToolCallId: envelope.parentToolCallId } : {}),
        });
      }
    }
  }

  /**
   * Drafts that `envelope` ends without a `tool_start`: every draft of the
   * session on a run error, the drafts of the same agent on its turn or run
   * end, and the drafts of an assistant response that failed or was stopped.
   * The returned calls are forgotten; remove their rows.
   */
  sweep(envelope: AgentEventEnvelope): string[] {
    const open = this.sessions.get(envelope.sessionId);
    if (!open || open.size === 0) return [];
    const event = envelope.event;
    const parent = envelope.parentToolCallId;
    let matches: (draft: OpenDraft) => boolean;
    if (event.type === "error") matches = () => true;
    else if (event.type === "turn_end" || event.type === "agent_end") {
      matches = (draft) => draft.parentToolCallId === parent;
    } else if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      (event.message.status === "error" || event.message.status === "aborted")
    ) {
      const messageId = event.message.id;
      matches = (draft) => draft.messageId === messageId && draft.parentToolCallId === parent;
    } else {
      return [];
    }
    const ended = [...open].filter(([, draft]) => matches(draft)).map(([toolCallId]) => toolCallId);
    this.forget(envelope.sessionId, ended);
    return ended;
  }

  private forget(sessionId: string, toolCallIds: readonly string[]): void {
    const open = this.sessions.get(sessionId);
    if (!open) return;
    for (const toolCallId of toolCallIds) open.delete(toolCallId);
    if (open.size === 0) this.sessions.delete(sessionId);
  }
}

/** Argument that grows while each kind of call is written. */
const DRAFT_TEXT_KEYS: Partial<Record<ToolAction, readonly string[]>> = {
  write: ["content", "text"],
  edit: ["ops", "patch", "newText", "new_string"],
  run: ["command", "cmd"],
};

/**
 * Lines written so far into the call's growing argument, for the row's live
 * size; `undefined` when the draft has no such argument yet or lost a frame.
 */
export function toolDraftLines(message: UiMessage): number | undefined {
  if (!message.toolDraft || message.toolDraft.gap) return undefined;
  const args = message.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of DRAFT_TEXT_KEYS[getToolAction(message.toolName)] ?? []) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) continue;
    // A trailing newline ends the last line; it does not start an empty one.
    const lines = value.split("\n");
    return lines.at(-1) === "" ? lines.length - 1 : lines.length;
  }
  return undefined;
}
