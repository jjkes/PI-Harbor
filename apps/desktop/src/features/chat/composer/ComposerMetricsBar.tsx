import { useTranslation } from "react-i18next";
import { formatCompactTokenCount, type UiMessage } from "@pi-harbor/shared";
import { useAppStore } from "../../../stores/app-store";
import { composerMetricReadings } from "../../../lib/composer-metrics";
import {
  estimateTextTokens,
  resolveSpeedReading,
} from "../../../lib/instant-token-rate";
import type { LatestTurnContextInspector } from "../../../lib/latest-turn-context";
import type { SessionTokenUsage } from "../../../lib/session-token-usage";
import { useInstantTokenRate } from "../context-usage/useInstantTokenRate";

/**
 * Estimated output tokens of the main session's in-flight reply.
 *
 * Delegates stream on the same session stream, but their rows carry
 * `parentToolCallId`; they belong to a node, not to the composer's reading. The
 * newest main-session assistant row decides: while it is still streaming its
 * visible text is the live figure, and once it settles there is nothing live to
 * measure.
 */
export function streamingOutputTokens(
  messages: readonly UiMessage[],
): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || message.parentToolCallId) continue;
    if (message.status !== "streaming") return undefined;
    const visible = `${message.thinking ?? ""}${message.content ?? ""}`;
    return estimateTextTokens(visible);
  }
  return undefined;
}

function selectStreamingOutputTokens(state: {
  messages: UiMessage[];
}): number | undefined {
  return streamingOutputTokens(state.messages);
}

function percentText(rate: number | undefined, unavailable: string): string {
  return rate === undefined ? unavailable : `${rate}%`;
}

/**
 * The speed cell owns its own subscription: only it re-renders as text streams,
 * and the hook republishes at one-second granularity so the bar's numbers stay
 * readable instead of flickering per chunk.
 */
function SpeedCell({
  averageRate,
}: {
  /** Provider average of the newest settled reply, if there is one. */
  averageRate: number | undefined;
}) {
  const { t } = useTranslation();
  const streamingTokens = useAppStore(selectStreamingOutputTokens);
  const streaming = streamingTokens !== undefined;
  const instantRate = useInstantTokenRate(streamingTokens ?? 0, streaming);
  const reading = resolveSpeedReading(streaming, instantRate, averageRate);
  const value =
    reading.tokensPerSecond === undefined
      ? t("chat.metricsUnavailable")
      : t(
          reading.estimated
            ? "chat.usageThroughputEstimated"
            : "chat.usageThroughput",
          { count: formatCompactTokenCount(reading.tokensPerSecond) },
        );

  return (
    <span className="composer-metrics-cell" title={t("chat.metricsSpeedHelp")}>
      <span className="composer-metrics-label">{t("chat.metricsSpeedLabel")}</span>
      <strong className="composer-metrics-value">{value}</strong>
    </span>
  );
}

/**
 * Always-present token metrics under the composer input: live speed, the newest
 * request's prompt cache hit rate, the session-wide one, and the team's own.
 *
 * The figures are derived from data the composer already holds — the newest
 * turn inspector and the session token aggregate — so the bar costs no IPC round
 * trip, and an unreported figure reads as a dash instead of a zero.
 */
export function ComposerMetricsBar({
  contextUsage,
  sessionUsage,
}: {
  contextUsage: LatestTurnContextInspector | null;
  sessionUsage: SessionTokenUsage | null;
}) {
  const { t } = useTranslation();

  const { averageRate, latestCacheRate, sessionCacheRate, teamCacheRate, showTeam } =
    composerMetricReadings(contextUsage, sessionUsage);
  const unavailable = t("chat.metricsUnavailable");

  return (
    <div
      className="composer-metrics"
      role="group"
      aria-label={t("chat.metricsLabel")}
    >
      <SpeedCell averageRate={averageRate} />
      <span
        className="composer-metrics-cell"
        title={t("chat.metricsCacheLatestHelp")}
      >
        <span className="composer-metrics-label">
          {t("chat.metricsCacheLatestLabel")}
        </span>
        <strong className="composer-metrics-value">
          {percentText(latestCacheRate, unavailable)}
        </strong>
      </span>
      <span
        className="composer-metrics-cell"
        title={t("chat.metricsCacheSessionHelp")}
      >
        <span className="composer-metrics-label">
          {t("chat.metricsCacheSessionLabel")}
        </span>
        <strong className="composer-metrics-value">
          {percentText(sessionCacheRate, unavailable)}
        </strong>
      </span>
      {showTeam ? (
        <span
          className="composer-metrics-cell"
          title={t("chat.metricsCacheTeamHelp")}
        >
          <span className="composer-metrics-label">
            {t("chat.metricsCacheTeamLabel")}
          </span>
          <strong className="composer-metrics-value">
            {percentText(teamCacheRate, unavailable)}
          </strong>
        </span>
      ) : null}
    </div>
  );
}
