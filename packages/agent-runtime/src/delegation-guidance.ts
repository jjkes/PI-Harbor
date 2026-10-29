import { MAX_NESTED_DELEGATIONS_PER_DELEGATE } from "@pi-harbor/shared";

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
 * Main-agent steering with Team mode on (ADR 0339). It depends only on the
 * mode, never on the roster, so the system prompt prefix stays stable while
 * members change (ADR 0337); the roster lives in the Task description.
 */
export const TEAM_MODE_GUIDANCE = [
  "## Team mode",
  "Team mode is on for this session. Act as the coordinator: split the request into bounded tasks, delegate them with Task to the listed members, then integrate and verify their reports before you answer. Do work directly only where delegation does not fit: questions for the user, the brief lookups needed to write a brief, integrating reports, and final verification. If no listed member fits a sub-task, do it yourself.",
  "Call only the members listed in the Task tool; they are the members enabled for this session. Do not route work through any other agent-spawning tool.",
  "Match each task to the member's tools: a read-only member cannot change files. Each member's model, tools, and thinking level come from this session's Team configuration; Task has no model parameter.",
  `Delegation depth is fixed: you → member → sub-member, and a sub-member cannot delegate. A member may start at most ${MAX_NESTED_DELEGATIONS_PER_DELEGATE} sub-members per run, a read-only member may start only read-only members, and a member cannot finish while its sub-members are outstanding.`,
  "Members cannot see this conversation or ask the user, so every brief must be self-contained: the goal, relevant paths and facts, constraints, acceptance criteria, and the exact report you need.",
  "Start independent tasks in the same message so they run in parallel, then converge with TaskWait. Do not assign duplicate work, and never give two write-capable members the same files at the same time.",
  "Verify reports before relying on them. A member never accepts its own output; a different member or you verifies it. Allow at most one review pass unless the user asks for more, and no agent debates.",
  "Members stay within the requested scope. Out-of-scope changes and decisions that need the user come back to you, and you raise them with the user. Stop when the work is complete and relevant checks pass, or report a genuine blocker.",
].join("\n");

/** Pick the main agent's delegation section for the session's topology. */
export function delegationGuidance(teamMode: boolean): string {
  return teamMode ? TEAM_MODE_GUIDANCE : DEFAULT_DELEGATION_GUIDANCE;
}
