import { TEAM_MODE_GUIDANCE } from "./team-prompts.js";

/**
 * Main-agent delegation steering (ADR 0089). Sessions without Team mode keep
 * this text byte for byte.
 */
export const DEFAULT_DELEGATION_GUIDANCE = `## Delegation
Do the work yourself by default. Delegate only bounded, independent tasks with a clear benefit over direct execution.
No recursive delegation, duplicate work, or agent debates.
Allow at most one optional review pass unless the user requests more. Fix and retest concrete, in-scope defects without restarting broad reviews.
Do not invent objections or turn speculative risks into blockers. Stop when the requested work is complete and relevant checks pass, or report a genuine blocker.`;

/**
 * Pick the main agent's delegation section for the session's topology. The
 * Team-mode section lives in `team-prompts.ts` with the rest of the Team
 * steering (ADR 0344).
 */
export function delegationGuidance(teamMode: boolean): string {
  return teamMode ? TEAM_MODE_GUIDANCE : DEFAULT_DELEGATION_GUIDANCE;
}
