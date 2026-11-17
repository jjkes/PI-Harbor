/**
 * Coalesce high-frequency assistant `message_update` events and streaming
 * `tool_draft` frames before they cross a process boundary. Semantic events
 * flush immediately so ordering is preserved: pending deltas emit before
 * `tool_start`, `message_end`, abort, error, retry snapshots, and a draft's
 * own `complete` / `discarded` frame.
 */

import type { AgentEventEnvelope } from "@pi-harbor/shared";
import {
  STREAM_COALESCE_INTERVAL_MS,
  hasMessageUpdateDeltas,
  mergeMessageUpdates,
  mergeToolDraftEvents,
  toWireMessageUpdate,
  toolDraftPayloadChars,
  type MessageUpdateEvent,
  type ToolDraftAgentEvent,
} from "@pi-harbor/shared";

export type StreamCoalescerStats = {
  accepted: number;
  emitted: number;
  coalesced: number;
  emittedPayloadChars: number;
};

export type StreamCoalescer = {
  push(envelope: AgentEventEnvelope): void;
  flush(): void;
  dispose(): void;
  stats(): StreamCoalescerStats;
};

export type StreamCoalescerOptions = {
  intervalMs?: number;
  schedule?: (flush: () => void, delayMs: number) => () => void;
};

/** One coalescing slot: an assistant row's text, or one call's draft. */
type Pending =
  | { envelope: AgentEventEnvelope; event: MessageUpdateEvent }
  | { envelope: AgentEventEnvelope; event: ToolDraftAgentEvent };

function defaultSchedule(flush: () => void, delayMs: number): () => void {
  const timer = setTimeout(flush, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function pendingKey(envelope: AgentEventEnvelope, event: MessageUpdateEvent): string {
  return `${envelope.sessionId}\0${envelope.parentToolCallId ?? ""}\0${event.message.id}`;
}

function draftKey(envelope: AgentEventEnvelope, event: ToolDraftAgentEvent): string {
  return `${envelope.sessionId}\0${envelope.parentToolCallId ?? ""}\0tool\0${event.toolCallId}`;
}

function payloadChars(envelope: AgentEventEnvelope): number {
  const event = envelope.event;
  if (event.type === "tool_draft") return toolDraftPayloadChars(event);
  if (event.type !== "message_update") return 0;
  if (event.stream === "delta") {
    return (event.deltaText?.length ?? 0) + (event.deltaThinking?.length ?? 0);
  }
  return (event.message.content?.length ?? 0) + (event.message.thinking?.length ?? 0);
}

export function createStreamCoalescer(
  emit: (envelope: AgentEventEnvelope) => void,
  options: StreamCoalescerOptions = {},
): StreamCoalescer {
  const intervalMs = options.intervalMs ?? STREAM_COALESCE_INTERVAL_MS;
  const schedule = options.schedule ?? defaultSchedule;
  const pending = new Map<string, Pending>();
  let cancelTimer: (() => void) | undefined;
  const stats: StreamCoalescerStats = {
    accepted: 0,
    emitted: 0,
    coalesced: 0,
    emittedPayloadChars: 0,
  };

  const emitOne = (envelope: AgentEventEnvelope) => {
    stats.emitted += 1;
    stats.emittedPayloadChars += payloadChars(envelope);
    emit(envelope);
  };

  const flushPending = () => {
    cancelTimer?.();
    cancelTimer = undefined;
    if (pending.size === 0) return;
    const items = [...pending.values()];
    pending.clear();
    for (const item of items) {
      emitOne({
        ...item.envelope,
        event: item.event.type === "message_update"
          ? toWireMessageUpdate(item.event)
          : item.event,
      });
    }
  };

  const scheduleFlush = () => {
    if (cancelTimer) return;
    if (intervalMs <= 0) {
      flushPending();
      return;
    }
    cancelTimer = schedule(flushPending, intervalMs);
  };

  return {
    push(envelope) {
      stats.accepted += 1;
      const event = envelope.event;
      if (event.type === "tool_draft" && event.phase === "streaming") {
        const key = draftKey(envelope, event);
        const existing = pending.get(key);
        const merged = existing?.event.type === "tool_draft"
          ? mergeToolDraftEvents(existing.event, event)
          : undefined;
        if (merged) {
          stats.coalesced += 1;
          pending.set(key, { envelope, event: merged });
        } else {
          if (existing) flushPending();
          pending.set(key, { envelope, event });
          scheduleFlush();
        }
        if (intervalMs <= 0) flushPending();
        return;
      }
      if (event.type !== "message_update" || !hasMessageUpdateDeltas(event)) {
        flushPending();
        emitOne(envelope);
        return;
      }
      const key = pendingKey(envelope, event);
      const existing = pending.get(key);
      if (existing?.event.type === "message_update") {
        stats.coalesced += 1;
        pending.set(key, {
          envelope,
          event: mergeMessageUpdates(existing.event, event),
        });
      } else {
        pending.set(key, { envelope, event });
        scheduleFlush();
      }
      if (intervalMs <= 0) flushPending();
    },
    flush: flushPending,
    dispose() {
      flushPending();
    },
    stats: () => ({ ...stats }),
  };
}
