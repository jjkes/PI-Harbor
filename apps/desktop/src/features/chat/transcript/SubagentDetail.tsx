import { useId } from "react";
import { useTranslation } from "react-i18next";
import { IconCircleAlert, IconTarget } from "../../../components/icons";
import { cx } from "../../../components/ui";
import { delegationNodeId } from "../../../lib/session-delegations";
import {
  summarizeSubagentActivity,
  type DelegationActivityItem,
  type SubagentOutcome,
  type SubagentTiming,
} from "../../../lib/subagent-topology";
import { countNestedDelegations } from "../../../lib/subagent-transcript";
import { delegateAgentName } from "./model";
import { ToolRow } from "./ToolRow";

const NO_CHILDREN: readonly DelegationActivityItem[] = [];

/**
 * A truthful graph of one owner's delegates.
 *
 * Plain mode (the work panel) draws one level. Nested Task rows stay in their
 * owning delegate's transcript; the root only reports their count instead of
 * drawing a second level or attributing them to the main agent.
 *
 * Tree mode (`childrenByNode`, the composer dock) draws two levels. Each node is
 * followed, on its right, by the delegates it started, so a nested delegate is
 * always attached to the node whose run started it.
 */
export function SubagentTopology({
  items,
  coordinatorName,
  delegationStatuses,
  delegationTimings,
  onUserInteraction,
  announce = true,
  childrenByNode,
  deepNodeIds,
  emptyHint,
}: {
  items: DelegationActivityItem[];
  /** The owning delegate's name when this card lives in its transcript. */
  coordinatorName?: string;
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
  onUserInteraction?: () => void;
  /** Announce node status changes to assistive technology. */
  announce?: boolean;
  /**
   * Tree mode: the delegates each node started, keyed by `delegationNodeId`.
   * An empty map still selects the tree layout, with one level.
   */
  childrenByNode?: ReadonlyMap<string, readonly DelegationActivityItem[]>;
  /** Tree mode: nested nodes whose own run starts a delegation (a third level). */
  deepNodeIds?: ReadonlySet<string>;
  /** Tree mode: what the main agent says while there is no delegate yet. */
  emptyHint?: string;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const summary = summarizeSubagentActivity(items, delegationStatuses);
  const tree = childrenByNode !== undefined;
  const hasNested =
    childrenByNode !== undefined &&
    items.some((item) => (childrenByNode.get(delegationNodeId(item))?.length ?? 0) > 0);
  const empty = items.length === 0 && emptyHint !== undefined;
  // A drawn nested node needs no count beside the root.
  const nestedCount = hasNested ? 0 : countNestedDelegations(items);
  const rootCopy = empty
    ? (emptyHint ?? "")
    : `${t("chat.subagentCoordinating", { count: summary.total })}${
        nestedCount > 0 ? ` · ${t("chat.subagentNestedCount", { count: nestedCount })}` : ""
      }`;

  const renderNode = (item: DelegationActivityItem, wrapped: boolean) => (
    <ToolRow
      key={item.message.id}
      message={item.message}
      {...(item.delegate ? { delegate: item.delegate } : {})}
      variant="topology"
      wrapped={wrapped}
      onUserInteraction={onUserInteraction}
      {...(delegationStatuses ? { delegationStatuses } : {})}
      {...(delegationTimings ? { delegationTimings } : {})}
      announce={announce}
    />
  );

  const renderBranch = (item: DelegationActivityItem) => {
    const kids = childrenByNode?.get(delegationNodeId(item)) ?? NO_CHILDREN;
    const name = delegateAgentName(item.message, item.delegate) || t("chat.subagentUnnamed");
    return (
      <div
        key={item.message.id}
        className={cx("subagent-topology-branch", kids.length > 0 && "has-children")}
        role="listitem"
      >
        {renderNode(item, true)}
        {kids.length > 0 ? (
          <div
            className="subagent-topology-children"
            role="list"
            aria-label={t("chat.subagentNestedTopology", { name })}
          >
            {kids.map((child) => (
              <div key={child.message.id} className="subagent-topology-child" role="listitem">
                {renderNode(child, true)}
                {deepNodeIds?.has(delegationNodeId(child)) ? (
                  <p className="subagent-topology-deep-note" role="note">
                    <span aria-hidden>
                      <IconCircleAlert size={11} />
                    </span>
                    <span>{t("team.deepDescription")}</span>
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <section
      className={cx(
        "subagent-topology",
        tree && "is-tree",
        hasNested && "has-nested",
        empty && "is-empty",
      )}
      aria-labelledby={labelId}
    >
      <div className="subagent-topology-root">
        <span className="subagent-topology-root-icon" aria-hidden>
          <IconTarget size={16} />
        </span>
        <span className="subagent-topology-root-copy">
          <strong id={labelId}>{coordinatorName || t("chat.subagentCoordinator")}</strong>
          <span title={tree ? rootCopy : undefined}>{rootCopy}</span>
        </span>
      </div>
      {empty ? null : (
        <>
          <span className="subagent-topology-connector" aria-hidden />
          <div
            className="subagent-topology-agents"
            role="list"
            aria-label={t("chat.subagentTopology")}
          >
            {tree ? items.map(renderBranch) : items.map((item) => renderNode(item, false))}
          </div>
        </>
      )}
    </section>
  );
}
