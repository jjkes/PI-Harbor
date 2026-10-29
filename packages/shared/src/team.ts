import Type from "typebox";

import {
  MAX_SUBAGENT_DEFINITIONS,
  normalizeSubagentName,
  type SubagentModelPin,
} from "./subagent-definition.js";

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

export type SessionTeamMember = {
  /** Definition name; the host normalizes it with `normalizeSubagentName`. */
  agent: string;
  /** Optional card-level model lock, which takes precedence over the definition. */
  model?: SubagentModelPin;
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

export const SessionTeamMemberSchema = Type.Object(
  {
    agent: Type.String({
      minLength: 1,
      maxLength: MAX_AGENT_NAME_LENGTH,
      pattern: NON_WHITESPACE_PATTERN,
    }),
    model: Type.Optional(TeamModelPinSchema),
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
