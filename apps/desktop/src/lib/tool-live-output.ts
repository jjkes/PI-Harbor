import type { UiMessage } from "@pi-harbor/shared";
import { formatToolValue } from "./tool-display";

/*
 * The body a running tool call shows while it works (D682).
 *
 * A `tool_update` frame carries a producer-shaped partial result: the runtime
 * wraps the accumulated text as `{ content: [...], details: { output } }`, pi's
 * own native session forwards whatever the tool passed to `onUpdate`, and an
 * extension may send plain text. Presentation only needs the text, so this
 * module is the one place that unwraps it, and the one place that bounds it.
 *
 * Nothing here is durable: the settled row keeps the text for the session it
 * was watched in, and a reloaded transcript renders the stored result instead.
 */

/**
 * Same 64Ki UTF-16 budget the runtime applies to command progress. A producer
 * that bypasses the runtime (a native pi session, RACP) still cannot push an
 * unbounded string into a rendered row.
 */
export const MAX_LIVE_TOOL_OUTPUT_CHARS = 64 * 1024;

export const LIVE_TOOL_OUTPUT_TRUNCATION_MARKER =
  "\n\n[live output truncated]\n\n";

/** Share of the budget kept from the head; the tail is what a reader watches. */
const HEAD_SHARE = 0.6;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (record && typeof record.text === "string") texts.push(record.text);
  }
  return texts.length > 0 ? texts.join("") : null;
}

/**
 * Display text of one progress frame.
 *
 * Ordered by how specific the shape is: a bare string is already the text, the
 * runtime's `details.output` is the accumulated command output, a content list
 * is pi's own block shape, and anything else falls back to the generic
 * formatter so an unexpected producer still shows something.
 */
export function toolProgressText(partialResult: unknown): string {
  if (typeof partialResult === "string") return partialResult;
  const envelope = asRecord(partialResult);
  if (!envelope) return formatToolValue(partialResult);
  const details = asRecord(envelope.details);
  if (details && typeof details.output === "string") return details.output;
  const text = contentText(envelope.content);
  if (text !== null) return text;
  return formatToolValue(partialResult);
}

/**
 * Bound one live body. A cut keeps both ends — the first lines say what the
 * call started doing and the tail is what it is doing now — and a marker sits
 * between them so the row never pretends the middle is only scrolled away.
 */
export function clipLiveToolOutputWithFlag(text: string): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= MAX_LIVE_TOOL_OUTPUT_CHARS) {
    return { text, truncated: false };
  }
  const budget =
    MAX_LIVE_TOOL_OUTPUT_CHARS - LIVE_TOOL_OUTPUT_TRUNCATION_MARKER.length;
  const head = text.slice(0, Math.floor(budget * HEAD_SHARE));
  const tail = text.slice(text.length - (budget - head.length));
  // A cut inside a surrogate pair would render as a replacement glyph.
  const trimmedHead = /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
  const trimmedTail = /^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail;
  return {
    text: `${trimmedHead}${LIVE_TOOL_OUTPUT_TRUNCATION_MARKER}${trimmedTail}`,
    truncated: true,
  };
}

/** The clipped text alone, for callers that do not surface the flag. */
export function clipLiveToolOutput(text: string): string {
  return clipLiveToolOutputWithFlag(text).text;
}

/** The bodied live text of a row, or `null` when the call never streamed. */
export function liveToolOutput(
  message: Pick<UiMessage, "toolLiveOutput">,
): string | null {
  const text = message.toolLiveOutput;
  return typeof text === "string" && text !== "" ? text : null;
}

/**
 * Whether a row paints the live terminal surface (D683).
 *
 * Only while the call is running and has produced something: a settled row is
 * history and keeps the unframed body (D227), and a running call with no output
 * yet has nothing to put inside a terminal. The preview itself is still live in
 * both cases, so nothing here changes what the body says.
 */
export function isLiveTerminalActive(
  message: Pick<UiMessage, "toolStatus" | "toolLiveOutput">,
): boolean {
  return message.toolStatus === "running" && liveToolOutput(message) !== null;
}

/**
 * Whether a tool row opens itself (D682).
 *
 * A call that produced output derives open, because the reader is watching a
 * live body rather than waiting for a payload. The disclosure's explicit choice
 * still wins: collapsing the row mid-run keeps it collapsed, and a call that
 * never streamed stays closed exactly as before.
 */
export function toolRowOpensWithLiveOutput(
  message: Pick<UiMessage, "toolLiveOutput">,
): boolean {
  return liveToolOutput(message) !== null;
}
