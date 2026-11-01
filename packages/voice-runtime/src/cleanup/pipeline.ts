import type { CleanupFallback, CleanupMode, CleanupOutcome } from "../types.js";
import { fillerRulesFor, removeFillers } from "./fillers.js";
import { acceptPolished, hasSelfCorrection } from "./guard.js";
import type { TranscriptPolisher } from "./llama-polisher.js";
import { maskProtectedSpans } from "./protect.js";

/** Shorter text leaves nothing for the model to tighten. */
const MIN_POLISH_CHARS = 6;
/** Longer text does not fit the model context next to its examples. */
export const MAX_POLISH_CHARS = 500;
/** Covers a cold model load plus generation. */
export const DEFAULT_POLISH_TIMEOUT_MS = 15_000;

export interface CleanTranscriptOptions {
  mode: CleanupMode;
  /** Languages the user dictates in. */
  languages: readonly string[];
  /** Language the recognizer reported, when known. */
  detectedLanguage?: string;
  polisher?: TranscriptPolisher | null;
  /** Caller cancellation; rethrown instead of falling back. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CleanedTranscript {
  text: string;
  cleanup: CleanupOutcome;
}

/**
 * Tidy recognizer output: deterministic filler removal, then (in `llm`
 * mode) a guarded local-model rewrite. Any model problem falls back to the
 * rule-based text, never to an error.
 */
export async function cleanTranscript(
  raw: string,
  options: CleanTranscriptOptions,
): Promise<CleanedTranscript> {
  const { mode } = options;
  if (mode === "off" || !raw.trim()) {
    return { text: raw, cleanup: { mode, applied: "off" } };
  }
  const ruled = removeFillers(raw, fillerRulesFor(options.languages, options.detectedLanguage));
  const rulesOnly = (fallback?: CleanupFallback): CleanedTranscript => ({
    text: ruled,
    cleanup: fallback ? { mode, applied: "rules", fallback } : { mode, applied: "rules" },
  });
  if (mode === "rules") return rulesOnly();
  if (!options.polisher) return rulesOnly("model-missing");
  if (ruled.length < MIN_POLISH_CHARS) return rulesOnly();
  if (ruled.length > MAX_POLISH_CHARS) return rulesOnly("too-long");
  const masked = maskProtectedSpans(ruled);
  if (!masked) return rulesOnly("rejected");

  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_POLISH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let output: string;
  try {
    output = await raceAbort(options.polisher.polish(masked.text, signal), signal);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return rulesOnly(timeout.aborted ? "timeout" : "failed");
  }
  const verdict = acceptPolished(output, masked, hasSelfCorrection(raw));
  if (!verdict.ok) return rulesOnly("rejected");
  return { text: verdict.text, cleanup: { mode, applied: "llm" } };
}

/** Settle on abort even if the polisher ignores its signal (e.g. a slow load). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
