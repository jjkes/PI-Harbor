import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { delegationNodeId, type SessionDelegations } from "../../../lib/session-delegations";
import {
  currentSettledRound,
  retireCurrentRound,
  retireDelegation,
} from "../../../lib/subagent-rounds";
import { Button } from "../../../components/ui";
import { SubagentTopology } from "../transcript/SubagentDetail";
import { SubagentStopButton } from "../transcript/SubagentStopButton";
import { useRetiredRounds, writeRetiredRounds } from "./retired-rounds-store";
import "./subagent-dock.css";

/**
 * The session's subagents as one live tree, in the composer's shared container.
 *
 * It is the transcript topology graph in tree mode, fed every delegate of the
 * session: each node opens the delegate's tab and carries its own stop, and a
 * delegate started by another sits to the right of the node that started it.
 * "Stop all" is the toolbar's control; `members` is the Team member picker and
 * is only passed for Team sessions. The graph mounts only while it is on screen,
 * so a collapsed container runs none of its node clocks. It is the only copy of
 * the graph in the conversation, so its nodes announce their own status changes.
 *
 * "End round" is the batch control: once nothing is running it folds the
 * settled delegates of the current dispatch out of the live view, which is what
 * keeps a long session from growing a graph of finished work. The reading is
 * `delegations`, already reduced to the rounds still live — folding again then
 * targets the next round back, exactly as the button's own enablement says.
 *
 * Each settled node also carries its own close: the user can put one finished
 * delegation away without touching the siblings it was dispatched with, so a
 * running sibling keeps its place and "End round" stays the batch case. Both
 * actions write the same per-session set, so one delegate folded alone still
 * counts in the round's folded line.
 */
export function SubagentDockPanel({
  listId,
  sessionId,
  delegations,
  interactive,
  team,
  members,
}: {
  listId: string;
  sessionId: string;
  delegations: SessionDelegations;
  /** False while the container is collapsed or another tab is on screen. */
  interactive: boolean;
  /** Team is on: an empty graph still shows the main agent and what to do next. */
  team: boolean;
  members?: ReactNode;
}) {
  const { t } = useTranslation();
  const retired = useRetiredRounds(sessionId);
  // A running delegate is never folded, so the control waits for the round to
  // settle; and with nothing settled there is no round to end.
  const endable = currentSettledRound(delegations);
  const running = delegations.summary.running > 0;
  // Nothing running and nothing settled is a pristine dock: the toolbar stays
  // empty and collapses, so this control never adds a row of its own until
  // there is a round to end.
  const showEndRound = running || endable !== null;
  const endRound = () => {
    const next = retireCurrentRound(delegations, retired);
    if (next !== retired) writeRetiredRounds(sessionId, next);
  };
  // The nodes one close can actually fold: a settled delegate the reading keys
  // to a round. A running or queued node is never in it, so it is never offered
  // the control at all — the same rule "End round" keeps, one node wide.
  const closable = useMemo(() => {
    const ids = new Set<string>();
    for (const item of delegations.items) {
      const id = delegationNodeId(item);
      if (retireDelegation(delegations, retired, id) !== retired) ids.add(id);
    }
    return ids;
  }, [delegations, retired]);
  const closeNode = (nodeId: string) => {
    const next = retireDelegation(delegations, retired, nodeId);
    if (next !== retired) writeRetiredRounds(sessionId, next);
  };
  return (
    <div
      id={listId}
      className="dock-panel subagent-dock-panel"
      role="tabpanel"
      aria-labelledby={`${listId}-tab`}
      hidden={!interactive}
    >
      {interactive ? (
        <>
          <div className="subagent-dock-toolbar">
            {members}
            {showEndRound ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="subagent-dock-end-round"
                disabled={running || !endable}
                title={t("chat.endRound")}
                onClick={endRound}
              >
                {t("chat.endRound")}
              </Button>
            ) : null}
            <SubagentStopButton running={running} />
          </div>
          <SubagentTopology
            items={delegations.items}
            delegationStatuses={delegations.statuses}
            delegationTimings={delegations.timings}
            childrenByNode={delegations.children}
            deepNodeIds={delegations.deepNodeIds}
            onCloseNode={closeNode}
            closableNodeIds={closable}
            {...(team ? { emptyHint: t("team.dockEmptyHint") } : {})}
          />
        </>
      ) : null}
    </div>
  );
}
