import {
  MAX_NESTED_DELEGATIONS_PER_DELEGATE,
  canDelegate,
  maxDelegationDepth,
  subagentCanMutate,
  subagentModelKey,
  subagentToolsLabel,
  type SubagentDefinition,
  type SubagentModelPin,
} from "@pi-harbor/shared";

export type TeamPolicyErrorCode =
  | "delegation_depth_exceeded"
  | "nested_delegation_limit_exceeded";

/** A policy denial whose message is safe to return through the Task tool. */
export class TeamPolicyError extends Error {
  readonly code: TeamPolicyErrorCode;

  constructor(code: TeamPolicyErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "TeamPolicyError";
    this.code = code;
  }
}

/**
 * Check the owner-derived depth immediately before a spawn and return the
 * child depth. Neither launch parameters nor model output participate.
 */
export function assertCanDelegate(
  scopeDepth: number,
  teamMode: boolean,
): 1 | 2 {
  if (!canDelegate(scopeDepth, teamMode)) {
    throw new TeamPolicyError(
      "delegation_depth_exceeded",
      `Agent scope L${scopeDepth} cannot start L${scopeDepth + 1}; the ${teamMode ? "Team" : "default"} delegation depth limit is ${maxDelegationDepth(teamMode)}. No subagent was started.`,
    );
  }
  return (scopeDepth + 1) as 1 | 2;
}

/**
 * Filter a Team roster for an L1 owner. A read-only owner may start only
 * candidates whose declarations are also read-only; roster order is stable.
 */
export function nestedCatalogFor(
  ownerDefinition: SubagentDefinition,
  ownerResolvedToolNames: readonly string[],
  rosterDefinitions: readonly SubagentDefinition[],
): SubagentDefinition[] {
  if (subagentCanMutate(ownerDefinition, ownerResolvedToolNames)) {
    return [...rosterDefinitions];
  }
  return rosterDefinitions.filter(
    (candidate) => !subagentCanMutate(candidate),
  );
}

/**
 * Allow another nested start while the successful-start count is below four.
 * The caller increments that count only after a start actually succeeds.
 */
export function assertNestedStartAllowed(nestedStarts: number): void {
  if (
    Number.isInteger(nestedStarts) &&
    nestedStarts >= 0 &&
    nestedStarts < MAX_NESTED_DELEGATIONS_PER_DELEGATE
  ) {
    return;
  }
  throw new TeamPolicyError(
    "nested_delegation_limit_exceeded",
    `A delegate may successfully start at most ${MAX_NESTED_DELEGATIONS_PER_DELEGATE} subagents per run (current count: ${nestedStarts}). Finish the remaining work yourself instead of starting another subagent.`,
  );
}

/** One ordered Team catalog row and its optional card-level model pin. */
export type TeamTaskCatalogEntry = {
  definition: SubagentDefinition;
  cardModel?: SubagentModelPin;
};

/**
 * Format the Team Task catalog without model-override instructions. A card pin
 * wins over a definition pin; an unpinned member inherits the session model.
 */
export function teamTaskCatalog(
  entries: readonly TeamTaskCatalogEntry[],
): string {
  return entries
    .map(({ definition, cardModel }) => {
      const model = cardModel ?? definition.model;
      const modelLabel = model
        ? subagentModelKey(model)
        : "inherits the session model";
      return `- ${definition.name} (tools: ${subagentToolsLabel(definition)}): ${definition.description} Model: ${modelLabel}.`;
    })
    .join("\n");
}

const TASK_START =
  "Start one Team member in the background and return immediately; you keep working while it runs, then converge with TaskWait when you need its report.";
const ROOT_DELEGATION =
  "In Team mode, delegation is the default: give every bounded piece of exploration, implementation, testing or review to the member whose tools fit it, and keep for yourself only what cannot be delegated: questions for the user, the brief lookups needed to write a brief, integrating reports, and final verification.";
const ROOT_NO_USER =
  "Do not delegate anything that needs the user — a member cannot ask a question or propose a plan on your behalf.";
const NESTED_DELEGATION =
  "You own the result of your task. Delegate only clearly separable, substantial parts to the listed members and do the rest yourself.";
const NESTED_NO_USER =
  "Do not delegate what you can finish in a couple of tool calls, and do not delegate anything that needs the user — a subagent cannot ask a question or propose a plan on your behalf.";
const TEAM_MEMBER_SETTINGS_GUIDANCE =
  "Each member's model, tools and thinking level come from this session's Team configuration.";
const TASK_BRIEF =
  "`task` is the delegate's only instruction. It cannot see this conversation, and you cannot correct it while it runs, so state the goal, the paths and facts it cannot infer, and exactly what to report back.";
const TASK_CONCURRENCY =
  "To run delegates concurrently, emit several Task calls in one assistant message. A message that mixes Task with any other tool runs one call at a time. You may keep working or talk to the user while they run; the runtime delivers their reports when they finish. Call TaskStop only to cancel.";
const ROOT_RESUME_GUIDANCE =
  "To continue a previous subagent, pass its `resume` id (the `delegationId` returned by Task). Saying \"reuse\" in prose is not enough.";
const NESTED_SCOPE_GUIDANCE =
  "Your own checks do not accept your work: report what you verified and what you did not. Do not expand the task's scope; put out-of-scope findings and decisions that need the user into your report.";

/**
 * Build the Team-mode Task description for L0 or L1. L0 delegates by
 * default (ADR 0339); L1 owns its result, states its nesting bounds and has
 * no resume/model guidance. The roster appears only in this description,
 * never in a system prompt (ADR 0337).
 */
export function teamTaskDescription(
  scopeDepth: 0 | 1,
  entries: readonly TeamTaskCatalogEntry[],
): string {
  const nestedGuidance = `You are a subagent. Any subagents you start cannot delegate further. You may start at most ${MAX_NESTED_DELEGATIONS_PER_DELEGATE} subagents during this run, and you cannot finish until you have converged with TaskWait on every one of them.`;
  return [
    TASK_START,
    ...(scopeDepth === 0
      ? [ROOT_DELEGATION, ROOT_NO_USER]
      : [NESTED_DELEGATION, NESTED_NO_USER]),
    TEAM_MEMBER_SETTINGS_GUIDANCE,
    TASK_BRIEF,
    TASK_CONCURRENCY,
    ...(scopeDepth === 0
      ? [ROOT_RESUME_GUIDANCE]
      : [nestedGuidance, NESTED_SCOPE_GUIDANCE]),
    `Available subagents:\n${teamTaskCatalog(entries)}`,
  ].join("\n\n");
}

/** Exact exposed identity of the Session Orchestrator's registry bypass. */
export const SESSION_ORCHESTRATOR_TASK_TOOL_NAME =
  "plugin_pi_session_orchestrator_SessionTask";

/** Deny known agent spawners by exact tool identity, never description text. */
export function isNonRegistryAgentSpawner(toolName: string): boolean {
  return toolName === SESSION_ORCHESTRATOR_TASK_TOOL_NAME;
}
