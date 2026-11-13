import {
  applyTeamMemberSettings,
  isTeamMemberEnabled,
  normalizeSubagentName,
  subagentModelKey,
  subagentPinnedProviders,
  teamMemberToolGrant,
  type SessionTeamConfig,
  type SubagentDefinition,
} from "@pi-harbor/shared";
import type {
  RuntimeProviderConfig,
  RuntimeTeamGates,
  RuntimeTeamState,
} from "@pi-harbor/agent-runtime";
import type { HostProcess } from "../host-process";

export type TeamLaunchResolution = {
  providers: Record<string, RuntimeProviderConfig>;
  diagnostics: string[];
};

export type ComposedTeamLaunch = TeamLaunchResolution & {
  definitions: SubagentDefinition[];
  team: RuntimeTeamState;
};

/** The only definition the review gate may run. */
const REVIEW_GATE_ROLE = "code-reviewer";
/** QA prefers a dedicated role and falls back to the general test runner. */
const QA_GATE_ROLE = "qa-test";
const QA_GATE_FALLBACK_ROLE = "test-runner";

/**
 * Resolve the two quality gates against the roster the run will actually
 * offer. A gate whose role is not in that roster is turned off for the run
 * with one diagnostic: a gate must never stall a round over a definition the
 * user does not have.
 */
function resolveTeamGates(
  team: SessionTeamConfig,
  definitions: readonly SubagentDefinition[],
): RuntimeTeamGates | undefined {
  if (team.reviewGate !== true && team.qaGate !== true) return undefined;
  const offered = new Set(
    definitions.map((definition) => normalizeSubagentName(definition.name)),
  );
  const wantedQa = offered.has(QA_GATE_ROLE) ? QA_GATE_ROLE : QA_GATE_FALLBACK_ROLE;
  const gates: RuntimeTeamGates = {
    review: false,
    qa: false,
    reviewRole: REVIEW_GATE_ROLE,
    qaRole: wantedQa,
  };
  if (team.reviewGate === true) {
    if (offered.has(REVIEW_GATE_ROLE)) {
      gates.review = true;
    } else {
      process.stderr.write(
        `[team-launch] team gate role missing (session=${team.sessionId} gate=review role=${REVIEW_GATE_ROLE}); gate disabled for this run\n`,
      );
    }
  }
  if (team.qaGate === true) {
    if (offered.has(wantedQa)) {
      gates.qa = true;
    } else {
      process.stderr.write(
        `[team-launch] team gate role missing (session=${team.sessionId} gate=qa role=${wantedQa}); gate disabled for this run\n`,
      );
    }
  }
  return gates.review || gates.qa ? gates : undefined;
}

/** Remote sessions never inherit a local session's team configuration. */
export async function readSessionTeamConfig(
  host: Pick<HostProcess, "call">,
  sessionId: string,
  remote: boolean,
): Promise<SessionTeamConfig | null> {
  if (remote) return null;
  return (await host.call<SessionTeamConfig | null>("session.team.get", {
    sessionId,
  })) ?? null;
}

/**
 * Build the launch-only team catalog. Disabled members are skipped, and card
 * model locks and session tool and thinking settings are applied to copies
 * before provider resolution, so every effective pin uses the existing
 * credential path. No source definition or Markdown document is mutated.
 */
export async function composeTeamLaunch(
  team: SessionTeamConfig | null | undefined,
  definitions: readonly SubagentDefinition[],
  resolveProviders: (
    definitions: readonly SubagentDefinition[],
  ) => Promise<TeamLaunchResolution>,
): Promise<ComposedTeamLaunch | null> {
  if (team?.enabled !== true) return null;

  const diagnostics: string[] = [];
  const definitionsByName = new Map(
    definitions.map((definition) => [normalizeSubagentName(definition.name), definition]),
  );
  const roster: SubagentDefinition[] = [];
  for (const member of team.members) {
    // A member switched off for this session is the user's choice, not a
    // launch problem, so it is left out without a diagnostic.
    if (!isTeamMemberEnabled(member)) continue;
    const definition = definitionsByName.get(normalizeSubagentName(member.agent));
    if (!definition) {
      diagnostics.push(
        `${member.agent}: definition is missing or disabled; excluded from team`,
      );
      continue;
    }
    if (member.tools && !teamMemberToolGrant(member.tools)) {
      diagnostics.push(
        `${definition.name}: session tool override has no usable tool; using the role's tools`,
      );
    }
    // A card-level model lock must not silently degrade to a definition pin,
    // so applying it also clears the copy's fallbacks.
    roster.push(applyTeamMemberSettings(definition, member));
  }

  // Match the existing resolver's first-eight-distinct-providers semantics,
  // but remove the whole member instead of leaving an unusable Task definition.
  const allowedProviders = new Set(subagentPinnedProviders(roster));
  const withinProviderCap = roster.filter((definition) => {
    const excludedPin = [definition.model, ...(definition.fallbackModels ?? [])].find(
      (pin) => pin && !allowedProviders.has(pin.providerId),
    );
    if (!excludedPin) return true;
    diagnostics.push(
      `${definition.name}: too many pinned providers; excluded "${subagentModelKey(excludedPin)}" from team`,
    );
    return false;
  });

  if (withinProviderCap.length === 0) {
    return {
      definitions: [],
      providers: {},
      diagnostics,
      team: { enabled: true as const, revision: team.revision },
    };
  }

  const resolved = await resolveProviders(withinProviderCap);
  const available = withinProviderCap.filter((definition) => {
    if (!definition.model) return true;
    const key = subagentModelKey(definition.model);
    if (resolved.providers[key]) return true;
    diagnostics.push(
      `${definition.name}: effective model "${key}" is unavailable; excluded from team`,
    );
    return false;
  });
  const requiredProviderKeys = new Set(
    available.flatMap((definition) =>
      [definition.model, ...(definition.fallbackModels ?? [])]
        .filter((pin) => pin !== undefined)
        .map(subagentModelKey),
    ),
  );
  const providers = Object.fromEntries(
    Object.entries(resolved.providers).filter(([key]) => requiredProviderKeys.has(key)),
  ) as Record<string, RuntimeProviderConfig>;

  const gates = resolveTeamGates(team, available);
  return {
    definitions: available,
    providers,
    diagnostics: [...diagnostics, ...resolved.diagnostics],
    team: {
      enabled: true as const,
      revision: team.revision,
      ...(gates ? { gates } : {}),
    },
  };
}
