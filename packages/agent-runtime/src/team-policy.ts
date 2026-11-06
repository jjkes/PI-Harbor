import {
  MAX_NESTED_DELEGATIONS_PER_DELEGATE,
  canDelegate,
  maxDelegationDepth,
  subagentAccessLevel,
  subagentCanMutate,
  subagentToolsLabel,
  type SubagentDefinition,
  type SubagentModelPin,
} from "@pi-harbor/shared";

import {
  TEAM_ACCESS_LABELS,
  teamTaskChildNoun,
  teamTaskSentences,
} from "./team-prompts.js";

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
    `A delegate may successfully start at most ${MAX_NESTED_DELEGATIONS_PER_DELEGATE} sub-members per run (current count: ${nestedStarts}). Finish the remaining work yourself instead of starting another one.`,
  );
}

/** One ordered Team catalog row and its optional card-level model pin. */
export type TeamTaskCatalogEntry = {
  definition: SubagentDefinition;
  cardModel?: SubagentModelPin;
};

/**
 * Format the Team Task catalog. Each row states the member's access level so
 * the coordinator can match a task to it without inferring capability from
 * tool names, and the level is derived from the same classification the
 * runtime applies when the member launches.
 *
 * The model is named by its model id alone: Team Task has no `model`
 * argument, so the provider id would be noise the caller cannot act on. A
 * card pin wins over a definition pin; an unpinned member inherits the
 * session model.
 */
export function teamTaskCatalog(
  entries: readonly TeamTaskCatalogEntry[],
): string {
  return entries
    .map(({ definition, cardModel }) => {
      const model = cardModel ?? definition.model;
      const modelLabel = model
        ? model.modelId
        : "inherits the session model";
      const access = TEAM_ACCESS_LABELS[subagentAccessLevel(definition)];
      return `- ${definition.name} (${access}; tools: ${subagentToolsLabel(definition)}): ${definition.description} Model: ${modelLabel}.`;
    })
    .join("\n");
}

/**
 * Assemble the Team `Task` description: the level's tool prose from
 * `team-prompts.ts`, then the roster this module formats. The roster reaches
 * the model here and nowhere else (ADR 0337).
 */
export function teamTaskDescription(
  scopeDepth: 0 | 1,
  entries: readonly TeamTaskCatalogEntry[],
): string {
  return [
    ...teamTaskSentences(scopeDepth),
    `Available ${teamTaskChildNoun(scopeDepth)}s:\n${teamTaskCatalog(entries)}`,
  ].join("\n\n");
}

/** Exact exposed identity of the Session Orchestrator's registry bypass. */
export const SESSION_ORCHESTRATOR_TASK_TOOL_NAME =
  "plugin_pi_session_orchestrator_SessionTask";

/** Deny known agent spawners by exact tool identity, never description text. */
export function isNonRegistryAgentSpawner(toolName: string): boolean {
  return toolName === SESSION_ORCHESTRATOR_TASK_TOOL_NAME;
}
