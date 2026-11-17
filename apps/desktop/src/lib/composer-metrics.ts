/**
 * The readings behind the composer's token metric row.
 *
 * Every figure is derived from data the composer already holds — the newest turn
 * inspector and the session token aggregate — so the row costs no IPC round trip.
 * Three cache readings exist on purpose and are never mixed: the newest model
 * request, this session's own requests, and its delegate (team) requests each
 * answer a different question.
 */
import { calculateCacheRate, calculateTokenRate } from "./context-usage";
import type { LatestTurnContextInspector } from "./latest-turn-context";
import type { SessionTokenUsage } from "./session-token-usage";

export type ComposerMetricReadings = {
  /** Provider average of the newest settled reply, in output tokens per second. */
  averageRate?: number;
  /** Cache hit rate of the newest model request. */
  latestCacheRate?: number;
  /** Cache hit rate across this session's own (non-delegate) requests. */
  sessionCacheRate?: number;
  /** Cache hit rate across this session's delegate requests. */
  teamCacheRate?: number;
  /** Whether a delegate has reported any usage yet. */
  showTeam: boolean;
};

export function composerMetricReadings(
  contextUsage: LatestTurnContextInspector | null,
  sessionUsage: SessionTokenUsage | null,
): ComposerMetricReadings {
  return {
    ...(contextUsage
      ? {
          averageRate: calculateTokenRate(
            contextUsage.responseOutputTokens ??
              contextUsage.turnUsage.outputTokens,
            contextUsage.responseDurationMs,
          ),
          latestCacheRate: calculateCacheRate(
            contextUsage.usage.inputTokens,
            contextUsage.usage.cacheReadTokens,
          ),
        }
      : {}),
    ...(sessionUsage
      ? {
          sessionCacheRate: calculateCacheRate(
            sessionUsage.main.inputTokens,
            sessionUsage.main.cacheReadTokens,
          ),
          teamCacheRate: calculateCacheRate(
            sessionUsage.subagents.inputTokens,
            sessionUsage.subagents.cacheReadTokens,
          ),
        }
      : {}),
    // A session that never delegated has no team figure to show; a zero there
    // would read as a measurement of an idle team.
    showTeam: (sessionUsage?.subagents.totalTokens ?? 0) > 0,
  };
}
