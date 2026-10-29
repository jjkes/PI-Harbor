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
import { countNestedDelegations } from "../../../lib/subagent-transcript";

/**
 * A truthful one-level graph of one transcript owner's delegates. Nested Task
 * rows stay in their owning delegate's transcript; the root only reports their
 * count instead of drawing a second level or attributing them to the main agent.
 */
export function SubagentTopology({
  items,
  coordinatorName,
  delegationStatuses,
  delegationTimings,
  onUserInteraction,
  announce = true,
}: {
  items: DelegationActivityItem[];
  /** The owning delegate's name when this card lives in its transcript. */
  coordinatorName?: string;
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
  const nestedCount = countNestedDelegations(items);

  return (
    <section className="subagent-topology" aria-labelledby={labelId}>
      <div className="subagent-topology-root">
        <span className="subagent-topology-root-icon" aria-hidden>
          <IconTarget size={16} />
        </span>
        <span className="subagent-topology-root-copy">
          <strong id={labelId}>{coordinatorName || t("chat.subagentCoordinator")}</strong>
          <span>
            {t("chat.subagentCoordinating", { count: summary.total })}
            {nestedCount > 0
              ? ` · ${t("chat.subagentNestedCount", { count: nestedCount })}`
              : ""}
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
