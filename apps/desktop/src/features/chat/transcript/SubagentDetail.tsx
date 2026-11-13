import { useId } from "react";
import { useTranslation } from "react-i18next";
import { IconCircleAlert, IconTarget, IconX } from "../../../components/icons";
import { cx } from "../../../components/ui";
import { delegationNodeId } from "../../../lib/session-delegations";
import {
  delegationChildRounds,
  delegationRoundOrdinals,
  subagentOutcome,
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
 *
 * The dock also hands each node its own close (`onCloseNode`), so one settled
 * delegate can be put away without touching its siblings. Every other caller
 * passes nothing, and the graph is exactly the two-level reading above.
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
  onCloseNode,
  closableNodeIds,
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
  /**
   * Dock only: put one settled delegate away on its own, apart from the round
   * action. A graph that passes nothing draws no per-node control, so the
   * transcript and the work panel keep the markup they had.
   */
  onCloseNode?: (nodeId: string) => void;
  /** Dock only: the node ids the caller can fold one at a time. */
  closableNodeIds?: ReadonlySet<string>;
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

  const finishedCount = (kids: readonly DelegationActivityItem[]) =>
    kids.filter((child) => {
      const outcome = subagentOutcome(child.message, delegationStatuses);
      return outcome !== "running" && outcome !== "queued";
    }).length;

  /**
   * The round ordinal a child carries when its handle repeats across this
   * parent's rounds, so two rounds of the same role stay distinguishable.
   */
  const roundLabelOf = (ordinals: ReadonlyMap<string, number>) =>
    (child: DelegationActivityItem): string | undefined => {
      const ordinal = ordinals.get(delegationNodeId(child));
      return ordinal === undefined
        ? undefined
        : t("chat.subagentRoundOrdinal", { round: ordinal });
    };

  /**
   * One node's close. It is drawn only where the caller can actually fold the
   * node: a running or queued delegate has nothing to put away yet, so it gets
   * no control at all rather than a disabled one, and a graph that passes no
   * `onCloseNode` — the transcript, the work panel — draws nothing new.
   */
  const closeNodeAction = (item: DelegationActivityItem) => {
    const close = onCloseNode;
    const nodeId = delegationNodeId(item);
    if (!close || !closableNodeIds?.has(nodeId)) return null;
    const outcome = subagentOutcome(item.message, delegationStatuses);
    if (outcome === "running" || outcome === "queued") return null;
    const label = t("chat.closeDelegation");
    return (
      <button
        type="button"
        className="subagent-topology-node-close"
        aria-label={label}
        title={label}
        onClick={() => close(nodeId)}
      >
        <IconX size={11} />
      </button>
    );
  };

  const renderNode = (item: DelegationActivityItem, wrapped: boolean, roundLabel?: string) => (
    <ToolRow
      key={item.message.id}
      message={item.message}
      {...(item.delegate ? { delegate: item.delegate } : {})}
      variant="topology"
      wrapped={wrapped}
      onUserInteraction={onUserInteraction}
      {...(delegationStatuses ? { delegationStatuses } : {})}
      {...(delegationTimings ? { delegationTimings } : {})}
      {...(roundLabel ? { roundLabel } : {})}
      announce={announce}
    />
  );

  const renderChild = (child: DelegationActivityItem, roundLabel?: string) => (
    <div key={child.message.id} className="subagent-topology-child" role="listitem">
      {renderNode(child, true, roundLabel)}
      {closeNodeAction(child)}
      {deepNodeIds?.has(delegationNodeId(child)) ? (
        <p className="subagent-topology-deep-note" role="note">
          <span aria-hidden>
            <IconCircleAlert size={11} />
          </span>
          <span>{t("team.deepDescription")}</span>
        </p>
      ) : null}
    </div>
  );

  const renderBranch = (item: DelegationActivityItem) => {
    const nodeId = delegationNodeId(item);
    const kids = childrenByNode?.get(nodeId) ?? NO_CHILDREN;
    const name = delegateAgentName(item.message, item.delegate) || t("chat.subagentUnnamed");
    // A parent that started another round keeps the earlier one's children in
    // the same run, so the call that dispatched each child — not the node it is
    // drawn under — decides whether it is this round's work or history.
    const rounds = delegationChildRounds(kids, nodeId);
    const roundLabelOfChild = roundLabelOf(
      delegationRoundOrdinals(
        [...rounds.previous, { key: nodeId, items: rounds.current }],
        (child) => delegateAgentName(child.message, child.delegate),
      ),
    );
    return (
      <div
        key={item.message.id}
        className={cx("subagent-topology-branch", kids.length > 0 && "has-children")}
        role="listitem"
      >
        {renderNode(item, true)}
        {closeNodeAction(item)}
        {kids.length > 0 ? (
          <div
            className="subagent-topology-children"
            role="list"
            aria-label={t("chat.subagentNestedTopology", { name })}
          >
            {rounds.previous.map((round) => {
              const label = t("chat.subagentPrevRound", { count: round.items.length });
              return (
                <div key={round.key} className="subagent-topology-prev-round" role="listitem">
                  <details className="subagent-topology-prev-round-details">
                    <summary className="subagent-topology-prev-round-summary">
                      <span className="subagent-topology-prev-round-label">{label}</span>
                      <span className="subagent-topology-prev-round-tally">
                        {t("chat.subagentFinishedCount", {
                          finished: finishedCount(round.items),
                          total: round.items.length,
                        })}
                      </span>
                    </summary>
                    <div
                      className="subagent-topology-prev-round-nodes"
                      role="list"
                      aria-label={label}
                    >
                      {round.items.map((child) => renderChild(child, roundLabelOfChild(child)))}
                    </div>
                  </details>
                </div>
              );
            })}
            {rounds.current.map((child) => renderChild(child, roundLabelOfChild(child)))}
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
