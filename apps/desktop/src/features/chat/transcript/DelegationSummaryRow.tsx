import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronRight, IconWorkflow } from "../../../components/icons";
import type { AssistantActivityItem } from "../../../lib/assistant-turns";
import {
  delegationTimingBounds,
  summarizeSubagentActivity,
  type DelegationActivityItem,
  type SubagentOutcome,
  type SubagentTiming,
} from "../../../lib/subagent-topology";
import { formatToolDuration } from "../../../lib/tool-display";
import { activityTimingInputs } from "../../../lib/transcript-activity-summary";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { useAppStore } from "../../../stores/app-store";
import { requestDockReveal } from "../background-tasks/dock-reveal";
import { SubagentStopButton } from "./SubagentStopButton";

type DelegationSummaryRowProps = {
  /** Every row of the owning activity part; supplies the fallback timing. */
  groupItems: readonly AssistantActivityItem[];
  delegateItems: readonly DelegationActivityItem[];
  delegationStatuses: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings: ReadonlyMap<string, SubagentTiming>;
  /** The owning activity part is the turn's live tail. */
  groupActive: boolean;
  /** End of the owning activity part, once it has settled. */
  endedAt?: string;
};

/**
 * The transcript's only trace of a delegation: one line that says how many
 * subagents ran, how many finished and for how long. The call graph is drawn
 * once, in the composer dock, so a click asks the dock to open on it.
 */
export function DelegationSummaryRow({
  groupItems,
  delegateItems,
  delegationStatuses,
  delegationTimings,
  groupActive,
  endedAt,
}: DelegationSummaryRowProps) {
  const { t } = useTranslation();
  const paneSessionId = useSlotSessionId();
  const sessionId = useAppStore((state) => paneSessionId || state.activeSessionId);
  const summary = useMemo(
    () => summarizeSubagentActivity(delegateItems, delegationStatuses),
    [delegateItems, delegationStatuses],
  );
  // Parent tools after a Task fan-out live in a later activity part, so this
  // part is not the turn's live tail while its delegates are still running.
  const running = summary.running > 0;
  const live = groupActive || running;

  const [now, setNow] = useState(Date.now);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const wasLiveRef = useRef(live);
  const timingInputs = useMemo(() => activityTimingInputs(groupItems), [groupItems]);
  const bounds = useMemo(
    () => delegationTimingBounds(delegateItems, delegationTimings),
    [delegateItems, delegationTimings],
  );
  const startedAt = bounds.startedAt ?? (timingInputs.startedAt || now);
  const fallbackEnd = Math.max(
    startedAt,
    timingInputs.recordedEnd,
    startedAt + timingInputs.missingStartDuration,
  );
  const completedAt =
    bounds.completedAt ??
    (Date.parse(endedAt || "") || finishedAt || (wasLiveRef.current ? now : fallbackEnd));
  const elapsed = formatToolDuration(
    Math.max(0, Math.floor(((live ? now : completedAt) - startedAt) / 1000)),
  );

  useEffect(() => {
    if (wasLiveRef.current && !live) setFinishedAt(Date.now());
    wasLiveRef.current = live;
    if (!live) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  const label = t(
    live
      ? "chat.subagentsWorking"
      : summary.issues > 0
        ? "chat.subagentsFinishedWithIssues"
        : summary.warnings > 0
          ? "chat.subagentsFinishedWithWarnings"
          : "chat.subagentsFinished",
    // A lone delegation is summarised too, so the line has to be able to say
    // "Subagent working" and not only the plural.
    { count: summary.total },
  );

  // The dock may be collapsed when the work ends, so the aggregate outcome is
  // announced from here. It speaks on a change of state only: a new delegate
  // joining, a tick of the clock or a remount of a settled row stays silent.
  const outcome = live
    ? "working"
    : summary.issues > 0
      ? "issues"
      : summary.warnings > 0
        ? "warnings"
        : "finished";
  const announcedOutcome = useRef(outcome);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (announcedOutcome.current === outcome) return;
    announcedOutcome.current = outcome;
    setAnnouncement(label);
  }, [outcome, label]);

  return (
    <div
      className={`delegation-summary${live ? " active" : ""}`}
      data-message-id={delegateItems[0]?.message.id}
      data-search-message-ids={delegateItems.map((item) => item.message.id).join(" ")}
    >
      <button
        type="button"
        className="tool-activity-header"
        title={t("chat.subagentOpenDock")}
        onClick={() => {
          if (sessionId) requestDockReveal(sessionId);
        }}
      >
        <span className="tool-activity-icon" aria-hidden>
          <IconWorkflow size={15} />
        </span>
        <span className={`tool-activity-label ${live ? "running" : ""}`}>{label}</span>
        {live ? <span className="activity-marker" aria-hidden /> : null}
        <span className="delegation-summary-metrics">
          {t("chat.subagentCount", { count: summary.total })}
          <span aria-hidden> · </span>
          {t("chat.subagentFinishedCount", {
            finished: summary.finished,
            total: summary.total,
          })}
          <span aria-hidden> · </span>
          {elapsed}
        </span>
        <span className="tool-activity-caret" aria-hidden>
          <IconChevronRight size={12} />
        </span>
      </button>
      <SubagentStopButton running={running} />
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
