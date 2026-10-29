import {
  MAX_TEAM_MEMBERS,
  SUBAGENT_ASSIGNABLE_TOOLS,
  SUBAGENT_INHERIT_TOKEN,
  applyTeamMemberSettings,
  isTeamMemberEnabled,
  normalizeSubagentName,
  subagentCanMutate,
  teamMemberHasSessionSettings,
  type SessionTeamMember,
  type SubagentDefinition,
  type SubagentModelPin,
  type SubagentThinkingLevel,
  type TeamMemberToolGrant,
} from "@pi-harbor/shared";

/** A role defined in Settings, as the Team view lists it. */
export type TeamDefinitionEntry = {
  /** Normalized Task handle; the roster keys members by it. */
  handle: string;
  definition: SubagentDefinition;
  /** Whether the role is enabled in Settings. */
  enabled: boolean;
};

/**
 * A session-only edit of one member. `null` clears a setting so the role's own
 * value applies again; an omitted field keeps the stored value.
 */
export type TeamMemberPatch = {
  enabled?: boolean;
  model?: SubagentModelPin | null;
  tools?: readonly TeamMemberToolGrant[] | null;
  thinkingLevel?: SubagentThinkingLevel | null;
};

/** Clears every session setting and leaves the member's switch as it is. */
export const TEAM_MEMBER_RESET_PATCH: TeamMemberPatch = {
  model: null,
  tools: null,
  thinkingLevel: null,
};

export const TEAM_ROSTER_FULL = "TEAM_ROSTER_FULL";
export const TEAM_INVALID_MEMBER = "TEAM_INVALID_MEMBER";

function rosterError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

/** Every tool choice, in the order the host stores grants: `inherit`, then the catalog. */
export const TEAM_TOOL_GRANTS: readonly TeamMemberToolGrant[] = [
  SUBAGENT_INHERIT_TOKEN,
  ...SUBAGENT_ASSIGNABLE_TOOLS,
];

/** Known grants in the host's canonical order, without duplicates. */
export function canonicalTeamTools(tools: readonly string[]): TeamMemberToolGrant[] {
  return TEAM_TOOL_GRANTS.filter((tool) => tools.includes(tool));
}

/** The role's own grant as tool choices: where a custom selection starts. */
export function roleToolGrant(
  definition: Pick<SubagentDefinition, "tools" | "inheritTools">,
): TeamMemberToolGrant[] {
  return canonicalTeamTools([
    ...(definition.inheritTools ? [SUBAGENT_INHERIT_TOKEN] : []),
    ...definition.tools,
  ]);
}

type MemberFields = {
  enabled: boolean;
  model?: SubagentModelPin;
  tools?: readonly TeamMemberToolGrant[];
  thinkingLevel?: SubagentThinkingLevel;
};

/** The stored shape: `enabled: true` and empty settings are omitted (roster v2). */
function canonicalMember(agent: string, fields: MemberFields): SessionTeamMember {
  const member: SessionTeamMember = { agent };
  if (!fields.enabled) member.enabled = false;
  if (fields.model) member.model = { ...fields.model };
  const tools = fields.tools ? canonicalTeamTools(fields.tools) : [];
  if (tools.length > 0) member.tools = tools;
  if (fields.thinkingLevel) member.thinkingLevel = fields.thinkingLevel;
  return member;
}

function patched<T>(value: T | null | undefined, current: T | undefined): T | undefined {
  return value === undefined ? current : (value ?? undefined);
}

/**
 * Keep a roster within the host's member limit. Only an over-limit roster
 * loses entries, and only those of roles that no longer exist, oldest first.
 * The edited member is never dropped.
 */
function withinCapacity(
  roster: SessionTeamMember[],
  edited: string,
  knownAgents: ReadonlySet<string> | undefined,
): SessionTeamMember[] {
  let excess = roster.length - MAX_TEAM_MEMBERS;
  if (excess <= 0) return roster;
  const kept: SessionTeamMember[] = [];
  for (const member of roster) {
    const handle = normalizeSubagentName(member.agent);
    const stale =
      knownAgents !== undefined && handle !== edited && !knownAgents.has(handle);
    if (excess > 0 && stale) {
      excess -= 1;
      continue;
    }
    kept.push(member);
  }
  if (excess > 0) throw rosterError(TEAM_ROSTER_FULL);
  return kept;
}

/**
 * Apply one member edit to a roster. A role without an entry is an off card,
 * so a first edit starts from a disabled member and is appended, which keeps
 * the Task catalog order stable. An entry that ends up off and without session
 * settings is removed, because absence already means off.
 */
export function applyTeamMemberPatch(
  members: readonly SessionTeamMember[],
  agentName: string,
  patch: TeamMemberPatch,
  options: { knownAgents?: ReadonlySet<string> } = {},
): SessionTeamMember[] {
  const agent = normalizeSubagentName(agentName);
  if (!agent) throw rosterError(TEAM_INVALID_MEMBER);
  const index = members.findIndex(
    (member) => normalizeSubagentName(member.agent) === agent,
  );
  const current = index >= 0 ? members[index] : undefined;
  const next = canonicalMember(agent, {
    enabled: patch.enabled ?? (current ? isTeamMemberEnabled(current) : false),
    model: patched(patch.model, current?.model),
    tools: patched(patch.tools, current?.tools),
    thinkingLevel: patched(patch.thinkingLevel, current?.thinkingLevel),
  });
  const keep = isTeamMemberEnabled(next) || teamMemberHasSessionSettings(next);
  let roster: SessionTeamMember[];
  if (index >= 0) {
    roster = keep
      ? members.map((member, position) => (position === index ? next : member))
      : members.filter((_, position) => position !== index);
  } else {
    roster = keep ? [...members, next] : [...members];
  }
  return withinCapacity(roster, agent, options.knownAgents);
}

function samePin(left?: SubagentModelPin, right?: SubagentModelPin): boolean {
  return left?.providerId === right?.providerId && left?.modelId === right?.modelId;
}

/** Whether two rosters store the same members, settings, and order. */
export function sameTeamMembers(
  left: readonly SessionTeamMember[],
  right: readonly SessionTeamMember[],
): boolean {
  return (
    left.length === right.length &&
    left.every((member, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        normalizeSubagentName(member.agent) === normalizeSubagentName(other.agent) &&
        isTeamMemberEnabled(member) === isTeamMemberEnabled(other) &&
        samePin(member.model, other.model) &&
        canonicalTeamTools(member.tools ?? []).join("\n") ===
          canonicalTeamTools(other.tools ?? []).join("\n") &&
        member.thinkingLevel === other.thinkingLevel
      );
    })
  );
}

/** One card per Settings role, with its session state resolved. */
export type TeamRosterCard = {
  handle: string;
  entry: TeamDefinitionEntry;
  /** Stored roster entry; absent means the card is off and has no settings. */
  member?: SessionTeamMember;
  /** Whether Task may schedule this member in the session. */
  on: boolean;
  /** Whether the role is enabled in Settings; a disabled role is never on. */
  settingsEnabled: boolean;
  /** Whether a session setting overrides the role. */
  hasSettings: boolean;
  /** The role as this session launches it: session settings on a copy. */
  effective: SubagentDefinition;
  /** Write capability after session settings: the card label and write lock. */
  canMutate: boolean;
  /** Write capability of the role itself, before session settings. */
  roleCanMutate: boolean;
  running: number;
};

export function teamRosterCards(
  definitions: readonly TeamDefinitionEntry[],
  members: readonly SessionTeamMember[],
  runningByAgent: ReadonlyMap<string, number>,
): TeamRosterCard[] {
  const byHandle = new Map<string, SessionTeamMember>();
  for (const member of members) {
    const handle = normalizeSubagentName(member.agent);
    if (handle && !byHandle.has(handle)) byHandle.set(handle, member);
  }
  const cards = definitions.map((entry): TeamRosterCard => {
    const member = byHandle.get(entry.handle);
    const effective = member
      ? applyTeamMemberSettings(entry.definition, member)
      : entry.definition;
    return {
      handle: entry.handle,
      entry,
      member,
      on: Boolean(member && isTeamMemberEnabled(member) && entry.enabled),
      settingsEnabled: entry.enabled,
      hasSettings: Boolean(member && teamMemberHasSessionSettings(member)),
      effective,
      canMutate: subagentCanMutate(effective),
      roleCanMutate: subagentCanMutate(entry.definition),
      running: runningByAgent.get(entry.handle) ?? 0,
    };
  });
  // Roles switched off in Settings follow the usable ones; order is otherwise kept.
  return [
    ...cards.filter((card) => card.settingsEnabled),
    ...cards.filter((card) => !card.settingsEnabled),
  ];
}

export type TeamCardStatus =
  | "running"
  | "settings-disabled"
  | "off"
  | "model-unavailable"
  | "on";

export function teamCardStatus(
  card: Pick<TeamRosterCard, "running" | "settingsEnabled" | "on">,
  modelUnavailable = false,
): TeamCardStatus {
  if (card.running > 0) return "running";
  if (!card.settingsEnabled) return "settings-disabled";
  if (!card.on) return "off";
  return modelUnavailable ? "model-unavailable" : "on";
}
