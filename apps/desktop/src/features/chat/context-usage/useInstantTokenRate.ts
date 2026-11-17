import { useEffect, useRef, useState } from "react";
import {
  appendTokenSample,
  instantTokenRate,
  type TokenSample,
} from "../../../lib/instant-token-rate";

/**
 * How often a live reading is republished. The stream updates far more often
 * than a human can read a rate, and re-publishing on every delta would re-render
 * the bar per chunk; one second keeps the window sliding without the churn.
 */
export const INSTANT_RATE_SAMPLE_MS = 1_000;

/**
 * Live generation speed for a stream that only exposes visible text.
 *
 * `tokens` is the estimate the caller already derived (characters ÷ 4); this
 * hook records it as it grows and republishes the windowed rate every second.
 * Callers pass `active: false` once the response settles, which drops the series
 * and returns `undefined` so the authoritative provider average takes over.
 */
export function useInstantTokenRate(
  tokens: number,
  active: boolean,
): number | undefined {
  const samplesRef = useRef<TokenSample[]>([]);
  const tokensRef = useRef(tokens);
  const [rate, setRate] = useState<number | undefined>();

  // A delta only records; it never publishes, so the reading's cadence is the
  // ticker's, not the stream's.
  useEffect(() => {
    tokensRef.current = tokens;
    if (!active) {
      samplesRef.current = [];
      setRate(undefined);
      return;
    }
    samplesRef.current = appendTokenSample(samplesRef.current, {
      at: Date.now(),
      tokens,
    });
    if (samplesRef.current.length === 1) {
      // Nothing to measure yet; a stale reading would belong to the last run.
      setRate(undefined);
    }
  }, [active, tokens]);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      samplesRef.current = appendTokenSample(samplesRef.current, {
        at: Date.now(),
        tokens: tokensRef.current,
      });
      setRate(instantTokenRate(samplesRef.current));
    }, INSTANT_RATE_SAMPLE_MS);
    return () => window.clearInterval(id);
  }, [active]);

  return active ? rate : undefined;
}
