/**
 * Protocol-level repair for tool-call adjacency.
 *
 * Both wire APIs require every assistant tool call to be answered *immediately*:
 * Chat Completions demands one `role: "tool"` message right after the assistant
 * turn that holds the `tool_calls`, and the Responses adapter emits one
 * `function_call_output` per `call_id`. Two failure modes break that:
 *
 * - A turn interrupted between the model's call and the tool writing its result
 *   leaves the call unanswered.
 * - Any item the adapter interleaves between a call and its output (an assistant
 *   `message`, a replayed item) splits the pair when the gateway folds the flat
 *   input into chat messages.
 *
 * Measured against CCH's upstream, "output right after its call" is accepted and
 * everything else above is rejected, so the repair makes the order canonical:
 * each call is emitted with its output attached, and an unanswered call is
 * answered with an explicit unavailable marker. Deleting the call instead would
 * rewrite the prefix the provider already cached and would hide from the model
 * that the tool never ran.
 *
 * A payload that is already canonical is returned unchanged (same object), so the
 * normal path costs one scan and keeps the adapter's own reference.
 */
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

/** What an unanswered call is answered with. Fixed text keeps it cache-stable. */
export const ORPHAN_TOOL_OUTPUT =
  "Tool result unavailable: the call did not finish before the next request.";

type Record_ = Record<string, unknown>;
/**
 * A `message` item whose every text part is exactly empty. The gateway rejects
 * one with "text content is empty" (a single space passes), and an assistant
 * turn can carry such a part after a signed-but-empty replay block survived
 * older builds. Dropping the whole item is what makes the request acceptable
 * again; there is no text to preserve.
 */
function isEmptyAssistantMessage(item: unknown): boolean {
  const record = asRecord(item);
  if (record?.type !== "message" || record.role !== "assistant") return false;
  const content = record.content;
  if (typeof content === "string") return content.length === 0;
  if (!Array.isArray(content)) return false;
  return content.every((part) => {
    const entry = asRecord(part);
    if (!entry) return true;
    if (typeof entry.text === "string") return entry.text.length === 0;
    // Images and other non-text parts are content, never emptiness.
    return false;
  });
}

/** Narrow an unknown value to a plain record, leaving arrays and nulls alone. */
function asRecord(value: unknown): Record_ | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : undefined;
}

function sameOrder(candidate: readonly unknown[], original: readonly unknown[]): boolean {
  return candidate.length === original.length && candidate.every((item, index) => item === original[index]);
}

/**
 * Responses: every `function_call` gets its `function_call_output` immediately
 * after it, and a call with no output gets a synthetic one.
 */
function normalizeResponsesToolOrder(input: readonly unknown[]): unknown[] | undefined {
  // An empty assistant message is a hard 400 upstream; drop it before ordering.
  const cleaned = input.filter((item) => !isEmptyAssistantMessage(item));
  const callIds = new Set<string>();
  const outputs = new Map<string, unknown>();
  for (const item of cleaned) {
    const record = asRecord(item);
    if (record?.type === "function_call" && typeof record.call_id === "string") {
      callIds.add(record.call_id);
    } else if (
      record?.type === "function_call_output" &&
      typeof record.call_id === "string" &&
      !outputs.has(record.call_id)
    ) {
      outputs.set(record.call_id, item);
    }
  }
  const emitted = new Set<string>();
  const repaired: unknown[] = [];
  for (const item of cleaned) {
    const record = asRecord(item);
    // A late output for a call we already answered is dropped here: it is
    // re-emitted directly after that call below.
    if (record?.type === "function_call_output" && typeof record.call_id === "string" && callIds.has(record.call_id)) {
      continue;
    }
    repaired.push(item);
    if (record?.type !== "function_call" || typeof record.call_id !== "string") continue;
    if (emitted.has(record.call_id)) continue;
    emitted.add(record.call_id);
    repaired.push(outputs.get(record.call_id) ?? {
      type: "function_call_output",
      call_id: record.call_id,
      output: ORPHAN_TOOL_OUTPUT,
    });
  }
  return sameOrder(repaired, input) ? undefined : repaired;
}

/** Completions: every assistant `tool_calls` id gets its `tool` message right after it. */
function normalizeCompletionToolOrder(messages: readonly unknown[]): unknown[] | undefined {
  const callIds = new Set<string>();
  const results = new Map<string, unknown>();
  for (const message of messages) {
    const record = asRecord(message);
    if (record?.role === "assistant" && Array.isArray(record.tool_calls)) {
      for (const call of record.tool_calls) {
        const id = asRecord(call)?.id;
        if (typeof id === "string") callIds.add(id);
      }
    } else if (record?.role === "tool" && typeof record.tool_call_id === "string" && !results.has(record.tool_call_id)) {
      results.set(record.tool_call_id, message);
    }
  }
  const emitted = new Set<string>();
  const repaired: unknown[] = [];
  for (const message of messages) {
    const record = asRecord(message);
    if (record?.role === "tool" && typeof record.tool_call_id === "string" && callIds.has(record.tool_call_id)) {
      continue;
    }
    repaired.push(message);
    if (record?.role !== "assistant" || !Array.isArray(record.tool_calls)) continue;
    for (const call of record.tool_calls) {
      const id = asRecord(call)?.id;
      if (typeof id !== "string" || emitted.has(id)) continue;
      emitted.add(id);
      repaired.push(results.get(id) ?? { role: "tool", tool_call_id: id, content: ORPHAN_TOOL_OUTPUT });
    }
  }
  return sameOrder(repaired, messages) ? undefined : repaired;
}

/**
 * Make every tool call and its result adjacent, and answer calls left without a
 * result. Returns the payload itself when it is already canonical.
 */
export function repairOrphanToolCalls(payload: unknown): unknown {
  const body = asRecord(payload);
  if (!body) return payload;
  if (Array.isArray(body.input)) {
    const input = normalizeResponsesToolOrder(body.input);
    return input ? { ...body, input } : payload;
  }
  if (Array.isArray(body.messages)) {
    const messages = normalizeCompletionToolOrder(body.messages);
    return messages ? { ...body, messages } : payload;
  }
  return payload;
}

/**
 * Wrap `onPayload` so the repair runs after every other hook, including a
 * caller-provided extension that replaces the whole payload.
 */
export function withToolPairingOptions(options: SimpleStreamOptions): SimpleStreamOptions {
  const previous = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      const replacement = await previous?.(payload, model);
      const base = replacement === undefined ? payload : replacement;
      return repairOrphanToolCalls(base);
    },
  };
}
