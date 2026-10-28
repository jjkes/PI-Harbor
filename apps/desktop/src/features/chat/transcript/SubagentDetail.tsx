import { useId } from "react";
import { useTranslation } from "react-i18next";
import { IconTarget } from "../../../components/icons";
import {
  summarizeSubagentActivity,
  type DelegationActivityItem,
  type SubagentOutcome,
  type SubagentTiming,
} from "../../../lib/subagent-topology";
import { ToolRow } from "./ToolRow";

/**
 * A truthful one-level graph of the main agent's delegates (ADR 0062): the
 * transcript draws one per fan-out, the composer dock one for the session.
 *
 * The runtime has no delegate-to-delegate edges, so this deliberately stops at
 * main agent -> Task nodes instead of implying dependencies that do not exist.
 */
export function SubagentTopology({
  items,
  delegationStatuses,
  delegationTimings,
  onUserInteraction,
  announce = true,
}: {
  items: DelegationActivityItem[];
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
  onUserInteraction?: () => void;
  /**
   * Announce node status changes. The composer dock repeats nodes whose
   * transcript copies already announce, so it turns this off.
   */
  announce?: boolean;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const summary = summarizeSubagentActivity(items, delegationStatuses);

  return (
    <section className="subagent-topology" aria-labelledby={labelId}>
      <div className="subagent-topology-root">
        <span className="subagent-topology-root-icon" aria-hidden>
          <IconTarget size={16} />
        </span>
        <span className="subagent-topology-root-copy">
          <strong id={labelId}>{t("chat.subagentCoordinator")}</strong>
          <span>
            {t("chat.subagentCoordinating", { count: summary.total })}
          </span>
        </span>
      </div>
      <span className="subagent-topology-connector" aria-hidden />
      <div
        className="subagent-topology-agents"
        role="list"
        aria-label={t("chat.subagentTopology")}
      >
        {items.map((item) => (
          <ToolRow
            key={item.message.id}
            message={item.message}
            {...(item.delegate ? { delegate: item.delegate } : {})}
            variant="topology"
            onUserInteraction={onUserInteraction}
            {...(delegationStatuses ? { delegationStatuses } : {})}
            {...(delegationTimings ? { delegationTimings } : {})}
            announce={announce}
          />
        ))}
      </div>
    </section>
  );
}
