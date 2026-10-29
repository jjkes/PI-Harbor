import type { SessionDelegations } from "../../../lib/session-delegations";
import { SubagentTopology } from "../transcript/SubagentDetail";
import { SubagentStopButton } from "../transcript/SubagentStopButton";

/**
 * The session's subagents as one graph, in the composer's shared container.
 *
 * It is the transcript's own topology graph fed every delegate of the session,
 * so a node looks and behaves as it does on its transcript card: it opens the
 * delegate's tab and carries its own stop, and "stop all" is the card header's
 * control. The graph mounts only while it is on screen, so a collapsed
 * container runs none of its node clocks, and it leaves status announcements
 * to the transcript cards so a change is not read twice.
 */
export function SubagentDockPanel({
  listId,
  delegations,
  interactive,
}: {
  listId: string;
  delegations: SessionDelegations;
  /** False while the container is collapsed or another tab is on screen. */
  interactive: boolean;
}) {
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
            <SubagentStopButton running={delegations.summary.running > 0} />
          </div>
          <SubagentTopology
            items={delegations.items}
            delegationStatuses={delegations.statuses}
            delegationTimings={delegations.timings}
            announce={false}
          />
        </>
      ) : null}
    </div>
  );
}
