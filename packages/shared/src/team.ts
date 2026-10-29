import Type from "typebox";

import {
  MAX_SUBAGENT_DEFINITIONS,
  SUBAGENT_ASSIGNABLE_TOOLS,
  SUBAGENT_INHERIT_TOKEN,
  normalizeSubagentName,
  type SubagentAssignableTool,
  type SubagentDefinition,
  type SubagentModelPin,
} from "./subagent-definition.js";
import {
  SUBAGENT_THINKING_LEVELS,
  type SubagentThinkingLevel,
} from "./types.js";

/** Maximum owner depth: the main agent (L0) may reach L1 and L2 in Team mode. */
export const MAX_TEAM_DELEGATION_DEPTH = 2;
/** The existing topology allows the main agent (L0) to reach L1 only. */
export const MAX_DEFAULT_DELEGATION_DEPTH = 1;
/** Successful nested starts allowed to one L1 delegate during one run. */
export const MAX_NESTED_DELEGATIONS_PER_DELEGATE = 4;
export const MAX_TEAM_MEMBERS = MAX_SUBAGENT_DEFINITIONS;

const MAX_SESSION_ID_LENGTH = 256;
const MAX_AGENT_NAME_LENGTH = 40;
const MAX_PROVIDER_ID_LENGTH = 128;
const MAX_MODEL_ID_LENGTH = 256;
const NON_WHITESPACE_PATTERN = "\\S";

/** Resolve the fixed delegation ceiling without consulting launch or model input. */
export function maxDelegationDepth(teamMode: boolean): 1 | 2 {
  return teamMode
    ? MAX_TEAM_DELEGATION_DEPTH
    : MAX_DEFAULT_DELEGATION_DEPTH;
}

/**
 * Whether an agent loop at `depth` may hold delegation tools. Team mode permits
 * L0 and L1 only; without Team mode, only L0 can delegate. L2 never qualifies.
 */
export function canDelegate(depth: number, teamMode: boolean): boolean {
  return (
    Number.isInteger(depth) &&
    depth >= 0 &&
    depth + 1 <= maxDelegationDepth(teamMode)
  );
}

/** One entry of a session-only tool override: an assignable tool or `inherit`. */
export type TeamMemberToolGrant =
  | SubagentAssignableTool
  | typeof SUBAGENT_INHERIT_TOKEN;

/** Distinct entries a tool override may hold: every assignable tool plus `inherit`. */
export const MAX_TEAM_MEMBER_TOOLS = SUBAGENT_ASSIGNABLE_TOOLS.length + 1;

export type SessionTeamMember = {
  /** Definition name; the host normalizes it with `normalizeSubagentName`. */
  agent: string;
  /**
   * Whether the member may be scheduled in this session. Omitted means
   * enabled, which is how every roster v1 member reads, and the host stores
   * `true` as an omitted flag. A disabled member keeps its session settings.
   */
  enabled?: boolean;
  /** Optional card-level model lock, which takes precedence over the definition. */
  model?: SubagentModelPin;
  /**
   * Session-only tool grant that replaces the definition's tools for this
   * session. The role definition itself is never rewritten.
   */
  tools?: TeamMemberToolGrant[];
  /** Session-only reasoning level that replaces the definition's level. */
  thinkingLevel?: SubagentThinkingLevel;
};

export type SessionTeamConfig = {
  sessionId: string;
  enabled: boolean;
  members: SessionTeamMember[];
  /** Host-owned revision used for optimistic concurrency on the next update. */
  revision: number;
};

export type SessionTeamUpdate = {
  sessionId: string;
  /**
   * Revision previously returned by the host. The host rejects a stale value
   * without applying any part of the update.
   */
  expectedRevision: number;
  enabled?: boolean;
  members?: SessionTeamMember[];
};

const SessionIdSchema = Type.String({
  minLength: 1,
  maxLength: MAX_SESSION_ID_LENGTH,
  pattern: NON_WHITESPACE_PATTERN,
});

const TeamModelPinSchema = Type.Object(
  {
    providerId: Type.String({
      minLength: 1,
      maxLength: MAX_PROVIDER_ID_LENGTH,
      pattern: NON_WHITESPACE_PATTERN,
    }),
    modelId: Type.String({
      minLength: 1,
      maxLength: MAX_MODEL_ID_LENGTH,
      pattern: NON_WHITESPACE_PATTERN,
    }),
  },
  { additionalProperties: false },
);

const TeamMemberToolGrantSchema = Type.Union([
  ...SUBAGENT_ASSIGNABLE_TOOLS.map((tool) => Type.Literal(tool)),
  Type.Literal(SUBAGENT_INHERIT_TOKEN),
]);

function hasUniqueEntries(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const TeamMemberToolsSchema = Type.Refine(
  Type.Array(TeamMemberToolGrantSchema, {
    minItems: 1,
    maxItems: MAX_TEAM_MEMBER_TOOLS,
  }),
  hasUniqueEntries,
);

const TeamMemberThinkingLevelSchema = Type.Union(
  SUBAGENT_THINKING_LEVELS.map((level) => Type.Literal(level)),
);

export const SessionTeamMemberSchema = Type.Object(
  {
    agent: Type.String({
      minLength: 1,
      maxLength: MAX_AGENT_NAME_LENGTH,
      pattern: NON_WHITESPACE_PATTERN,
    }),
    enabled: Type.Optional(Type.Boolean()),
    model: Type.Optional(TeamModelPinSchema),
    tools: Type.Optional(TeamMemberToolsSchema),
    thinkingLevel: Type.Optional(TeamMemberThinkingLevelSchema),
  },
  { additionalProperties: false },
);

function hasUniqueNormalizedAgentNames(
  members: readonly SessionTeamMember[],
): boolean {
  const names = new Set<string>();
  for (const member of members) {
    const name = normalizeSubagentName(member.agent);
    if (!name || names.has(name)) return false;
    names.add(name);
  }
  return true;
}

const SessionTeamMembersSchema = Type.Refine(
  Type.Array(SessionTeamMemberSchema, { maxItems: MAX_TEAM_MEMBERS }),
  hasUniqueNormalizedAgentNames,
);

export const SessionTeamConfigSchema = Type.Object(
  {
    sessionId: SessionIdSchema,
    enabled: Type.Boolean(),
    members: SessionTeamMembersSchema,
    revision: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SessionTeamUpdateSchema = Type.Object(
  {
    sessionId: SessionIdSchema,
    expectedRevision: Type.Integer({ minimum: 0 }),
    enabled: Type.Optional(Type.Boolean()),
    members: Type.Optional(SessionTeamMembersSchema),
  },
  { additionalProperties: false },
);

/** A member is enabled unless it is explicitly turned off; v1 members omit the flag. */
export function isTeamMemberEnabled(
  member: Pick<SessionTeamMember, "enabled">,
): boolean {
  return member.enabled !== false;
}

/** Whether a member carries any session-only setting that overrides its role. */
export function teamMemberHasSessionSettings(
  member: Pick<SessionTeamMember, "model" | "tools" | "thinkingLevel">,
): boolean {
  return Boolean(
    member.model ||
      (member.tools && member.tools.length > 0) ||
      member.thinkingLevel,
  );
}

/**
 * Split a session tool override into definition fields. Entries this build
 * does not know are dropped; `null` means nothing usable remains, so the
 * role's own tools apply.
 */
export function teamMemberToolGrant(
  tools: readonly string[],
): Pick<SubagentDefinition, "tools" | "inheritTools"> | null {
  const inheritTools = tools.includes(SUBAGENT_INHERIT_TOKEN);
  const declared = SUBAGENT_ASSIGNABLE_TOOLS.filter((tool) => tools.includes(tool));
  if (!inheritTools && declared.length === 0) return null;
  return { tools: [...declared], inheritTools };
}

/**
 * Apply a member's session settings to a copy of its role definition. The
 * source definition is never modified, and a locked model clears the
 * definition's fallbacks so a user-chosen model never silently degrades.
 */
export function applyTeamMemberSettings(
  definition: SubagentDefinition,
  member: Pick<SessionTeamMember, "model" | "tools" | "thinkingLevel">,
): SubagentDefinition {
  const grant = member.tools ? teamMemberToolGrant(member.tools) : null;
  if (!member.model && !grant && !member.thinkingLevel) return definition;
  return {
    ...definition,
    ...(member.model ? { model: { ...member.model }, fallbackModels: [] } : {}),
    ...(grant ?? {}),
    ...(member.thinkingLevel ? { thinkingLevel: member.thinkingLevel } : {}),
  };
}
