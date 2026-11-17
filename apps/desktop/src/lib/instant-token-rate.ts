/**
 * Instantaneous generation speed, shared by the composer metric bar and the
 * subagent topology nodes.
 *
 * A provider reports usage only when a response settles, so a live figure has
 * to be derived from the visible stream itself. The runtime already prices text
 * at four characters per token (`estimateResponseOutputTokens`,
 * `estimateToolTokenUsage`), so the same heuristic feeds a sliding window: a
 * rate is what the newest sample added on top of the window's baseline sample,
 * divided by that span in seconds.
 *
 * When a response settles the provider's own average takes over. This module
 * decides which of the two readings a surface prints, so the bar and the
 * topology nodes cannot drift apart.
 */

/** How much recent output one rate reading covers. */
export const INSTANT_RATE_WINDOW_MS = 3_000;

/**
 * Shortest span a reading is allowed to divide by. A window that has only just
 * opened would divide by a rounding artifact and print a speed the model never
 * reached.
 */
export const INSTANT_RATE_MIN_SPAN_MS = 1_000;

/** The runtime's own estimate heuristic, reused so both figures agree. */
export const CHARS_PER_TOKEN = 4;

export type TokenSample = {
  /** Epoch milliseconds of the observation. */
  at: number;
  /** Estimated output tokens visible at `at`. */
  tokens: number;
};

/**
 * Estimated tokens of visible text. Counts code points rather than UTF-16
 * units so CJK output is not charged twice.
 */
export function estimateTextTokens(text: string | undefined): number {
  if (!text) return 0;
  return Math.ceil(Array.from(text).length / CHARS_PER_TOKEN);
}

function positiveWindow(windowMs: number): number {
  return Number.isFinite(windowMs) && windowMs > 0
    ? windowMs
    : INSTANT_RATE_WINDOW_MS;
}

/**
 * Append one observation, keeping the series short and monotonic.
 *
 * Three cases reset the series instead of extending it: a clock that moved
 * backwards (a new sampling run), a token counter that went down (a new
 * response started), and an observation at the same instant as the newest one
 * (the last write for that instant wins). Only the entries a reading needs are
 * kept: everything after the baseline sample that precedes the window.
 */
export function appendTokenSample(
  samples: readonly TokenSample[],
  sample: TokenSample,
  windowMs: number = INSTANT_RATE_WINDOW_MS,
): TokenSample[] {
  const window = positiveWindow(windowMs);
  const last = samples.at(-1);
  if (!last) return [{ at: sample.at, tokens: sample.tokens }];
  if (sample.at < last.at) return [{ at: sample.at, tokens: sample.tokens }];
  if (sample.tokens < last.tokens) {
    return [{ at: sample.at, tokens: sample.tokens }];
  }

  const next =
    sample.at === last.at
      ? [...samples.slice(0, -1), { at: sample.at, tokens: sample.tokens }]
      : [...samples, { at: sample.at, tokens: sample.tokens }];

  const newest = next[next.length - 1];
  const cutoff = newest.at - window;
  let firstInside = next.length - 1;
  while (firstInside > 0 && next[firstInside - 1].at > cutoff) {
    firstInside -= 1;
  }
  // The sample just before the window is the baseline the rate divides from.
  return next.slice(Math.max(0, firstInside - 1));
}

/**
 * Tokens per second across the newest window, or `undefined` when the stream
 * has shown no growth to measure (stalled, restarted, or too fresh).
 */
export function instantTokenRate(
  samples: readonly TokenSample[],
  windowMs: number = INSTANT_RATE_WINDOW_MS,
): number | undefined {
  if (samples.length < 2) return undefined;
  const window = positiveWindow(windowMs);
  const newest = samples[samples.length - 1];

  let baseline = samples[0];
  for (const sample of samples) {
    if (sample.at > newest.at - window) break;
    baseline = sample;
  }

  const span = newest.at - baseline.at;
  if (span < INSTANT_RATE_MIN_SPAN_MS) return undefined;

  const delta = newest.tokens - baseline.tokens;
  if (delta <= 0) return undefined;

  return Math.round(delta / (span / 1000));
}

export type SpeedReading = {
  /** Tokens per second, absent when neither source can measure one. */
  tokensPerSecond?: number;
  /** The figure is a stream-derived estimate, not the provider's own average. */
  estimated: boolean;
};

/**
 * Which speed a surface prints: the estimate while the response is still
 * streaming, the provider's average once it settles. A settled response with no
 * measurable span stays unmeasured rather than borrowing the estimate.
 */
export function resolveSpeedReading(
  streaming: boolean,
  instantRate: number | undefined,
  averageRate: number | undefined,
): SpeedReading {
  if (streaming) {
    return instantRate === undefined
      ? { estimated: true }
      : { tokensPerSecond: instantRate, estimated: true };
  }
  return averageRate === undefined
    ? { estimated: false }
    : { tokensPerSecond: averageRate, estimated: false };
}
