import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SessionDelegations } from "../../../lib/session-delegations";
import { SubagentTopology } from "../transcript/SubagentDetail";
import { SubagentStopButton } from "../transcript/SubagentStopButton";
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
 */
export function SubagentDockPanel({
  listId,
  delegations,
  interactive,
  team,
  members,
}: {
  listId: string;
  delegations: SessionDelegations;
  /** False while the container is collapsed or another tab is on screen. */
  interactive: boolean;
  /** Team is on: an empty graph still shows the main agent and what to do next. */
  team: boolean;
  members?: ReactNode;
}) {
  const { t } = useTranslation();
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
            <SubagentStopButton running={delegations.summary.running > 0} />
          </div>
          <SubagentTopology
            items={delegations.items}
            delegationStatuses={delegations.statuses}
            delegationTimings={delegations.timings}
            childrenByNode={delegations.children}
            deepNodeIds={delegations.deepNodeIds}
            {...(team ? { emptyHint: t("team.dockEmptyHint") } : {})}
          />
        </>
      ) : null}
    </div>
  );
}
