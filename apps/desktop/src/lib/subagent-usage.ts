/**
 * Token totals and throughput for one delegate, as a topology node reports them.
 *
 * Two sources exist and they are not interchangeable. The runtime publishes the
 * delegate's authoritative run total on its `Task` details once the run settles,
 * so a finished node never re-derives a number the runtime already knows. While
 * the run is still going, the only usage on this side is the delegate's own
 * assistant rows, which the session stream carries as they arrive. The
 * published total therefore wins whenever it is present.
 */
import { addUsage, type MessageUsage } from "@pi-harbor/shared";
import type { SubagentRunItem } from "./assistant-turns";

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

/**
 * Tokens a request set used. Providers report `totalTokens` directly; a row that
 * carries only the input and output buckets is summed, because a missing total
 * is not a zero.
 */
export function usageTokens(usage: MessageUsage | undefined): number {
  if (!usage) return 0;
  const total = positive(usage.totalTokens);
  if (total > 0) return total;
  return positive(usage.inputTokens) + positive(usage.outputTokens);
}

/** Sum the usage of a delegate's own assistant rows, deduplicated by operation. */
export function delegateRowUsage(
  items: readonly SubagentRunItem[],
): MessageUsage | undefined {
  let total: MessageUsage | undefined;
  for (const item of items) {
    const message = item.message;
    if (message.role !== "assistant" || !message.usage) continue;
    total = addUsage(total, message.usage);
  }
  return total;
}

/**
 * The runtime-reported total from a `Task` row's details, when the run already
 * settled. Anything else in that payload is not usage, so a malformed or
 * partial block reads as absent rather than as zero tokens.
 */
export function publishedDelegationUsage(payload: unknown): MessageUsage | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  const totalTokens = positive(record.totalTokens);
  const inputTokens = positive(record.inputTokens);
  const outputTokens = positive(record.outputTokens);
  if (totalTokens === 0 && inputTokens === 0 && outputTokens === 0) return undefined;
  return { inputTokens, outputTokens, totalTokens: totalTokens || inputTokens + outputTokens };
}

/**
 * Tokens per second of wall-clock runtime. A span that is missing or has not
 * produced a full second yet has no rate: dividing by a rounding artifact would
 * print a throughput the node never reached.
 */
export function tokensPerSecond(
  tokens: number,
  durationMs: number | undefined,
): number | undefined {
  if (tokens <= 0 || durationMs === undefined || durationMs < 1000) return undefined;
  return Math.max(0, Math.round(tokens / (durationMs / 1000)));
}

/**
 * What one topology node shows. Absent when neither source knows anything, so a
 * node that has not started reporting usage stays free of a `0` that reads as a
 * measurement.
 */
export function subagentNodeUsage({
  payload,
  items,
  durationMs,
}: {
  payload?: unknown;
  items?: readonly SubagentRunItem[];
  durationMs?: number;
}): { tokens: number; ratePerSecond?: number } | undefined {
  const usage = publishedDelegationUsage(payload) ?? (items ? delegateRowUsage(items) : undefined);
  const tokens = usageTokens(usage);
  if (tokens === 0) return undefined;
  const ratePerSecond = tokensPerSecond(tokens, durationMs);
  return ratePerSecond === undefined ? { tokens } : { tokens, ratePerSecond };
}
