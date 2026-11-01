import type { PlanProposal } from "@pi-harbor/shared";
import { planCheckpointStatus } from "../../../lib/plan-mode-state";

/** Where an approved Goal's execution stands while the dock names it. */
export type DockGoalPhase = "queued" | "running";

/** The session's current Goal, as the composer dock names it. */
export type DockGoal = {
  /** The contract's title; empty when the agent submitted none. */
  title: string;
  phase: DockGoalPhase;
  /** Workspace-relative path of the approved contract, when the host wrote one. */
  artifactPath: string | undefined;
};

/**
 * The Goal the composer dock names, or `null`.
 *
 * Only an approved Goal whose execution is queued or running counts: a pending
 * approval belongs to the approval bar, and a completed or interrupted run to
 * the transcript card and its final report. A Plan execution never takes the
 * line, which names the outcome Goal mode works toward.
 */
export function dockGoalFor(proposal: PlanProposal | null | undefined): DockGoal | null {
  if (!proposal || proposal.kind !== "goal") return null;
  const status = planCheckpointStatus(proposal);
  if (status !== "queued" && status !== "running") return null;
  return {
    title: proposal.title,
    phase: status,
    artifactPath: proposal.artifact?.relativePath,
  };
}
