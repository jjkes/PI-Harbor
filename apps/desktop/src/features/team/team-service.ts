import {
  normalizeSubagentName,
  type SessionSummary,
  type SessionTeamConfig,
  type SessionTeamMember,
  type SessionTeamUpdate,
  type SubagentModelPin,
} from "@pi-harbor/shared";
import {
  fetchSubagentPageData,
  type SubagentPageData,
} from "../../components/settings/subagent-settings";
import { api } from "../../lib/api";
import { isRemoteSession } from "../../lib/remote-session-safety";
import {
  EMPTY_TEAM_SESSION_STATE,
  teamStore,
  type TeamSessionState,
  type TeamStore,
} from "./team-store";

export type TeamSessionTarget = Pick<SessionSummary, "id" | "source">;
export const TEAM_SESSION_INELIGIBLE = "TEAM_SESSION_INELIGIBLE";

type TeamApi = Pick<typeof api, "getSessionTeam" | "updateSessionTeam">;
type TeamChange = Partial<Pick<SessionTeamUpdate, "enabled" | "members">>;

export type TeamServiceDependencies = {
  api?: TeamApi;
  store?: TeamStore;
  loadSubagentPage?: () => Promise<SubagentPageData>;
};

function codedError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { code?: unknown; errorCode?: unknown };
  const code = typeof value.code === "string" ? value.code : value.errorCode;
  return typeof code === "string" ? code : null;
}

function errorState(error: unknown | null): Pick<TeamSessionState, "error" | "errorCode"> {
  if (error === null) return { error: null, errorCode: null };
  return {
    error: error instanceof Error ? error.message : String(error),
    errorCode: errorCode(error),
  };
}

/** Revision failures are recoverable by replacing the optimistic card state. */
function isRevisionConflict(error: unknown): boolean {
  const code = errorCode(error)?.toUpperCase();
  if (
    code === "CONFLICT" ||
    code === "STALE_REVISION" ||
    ((code?.includes("TEAM") || code?.includes("REVISION")) &&
      (code.includes("CONFLICT") || code.includes("STALE")))
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /revision/i.test(message) && /stale|conflict|expected/i.test(message);
}

export function isTeamSessionEligible(session: TeamSessionTarget): boolean {
  return (
    !isRemoteSession(session) &&
    session.source !== "pi-native" &&
    !session.id.startsWith("native-pi:")
  );
}

function patchSession(
  store: TeamStore,
  sessionId: string,
  patch: Partial<TeamSessionState>,
): void {
  store.setState((state) => ({
    sessions: {
      ...state.sessions,
      [sessionId]: {
        ...(state.sessions[sessionId] ?? EMPTY_TEAM_SESSION_STATE),
        ...patch,
      },
    },
  }));
}

export function createTeamService(dependencies: TeamServiceDependencies = {}) {
  const client = dependencies.api ?? api;
  const store = dependencies.store ?? teamStore;
  const loadSubagentPage = dependencies.loadSubagentPage ?? fetchSubagentPageData;
  /** One serial queue per session prevents two edits sharing an expected revision. */
  const queues = new Map<string, Promise<void>>();

  function assertEligible(session: TeamSessionTarget): void {
    if (!isTeamSessionEligible(session)) throw codedError(TEAM_SESSION_INELIGIBLE);
  }

  function enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(sessionId, tail);
    void tail.then(() => {
      if (queues.get(sessionId) === tail) queues.delete(sessionId);
    });
    return result;
  }

  /** Read through the current queue; an optional conflict remains visible after reload. */
  async function readConfig(
    sessionId: string,
    retainedError: unknown | null = null,
  ): Promise<SessionTeamConfig> {
    patchSession(store, sessionId, { loading: true, ...errorState(retainedError) });
    try {
      const config = await client.getSessionTeam(sessionId);
      patchSession(store, sessionId, {
        config,
        loading: false,
        saving: false,
        ...errorState(retainedError),
      });
      return config;
    } catch (error) {
      patchSession(store, sessionId, {
        loading: false,
        saving: false,
        ...errorState(error),
      });
      throw error;
    }
  }

  async function load(session: TeamSessionTarget, force: boolean): Promise<SessionTeamConfig> {
    assertEligible(session);
    const cached = store.getState().sessions[session.id]?.config;
    if (!force && cached) return Promise.resolve(cached);
    return enqueue(session.id, async () => {
      const current = store.getState().sessions[session.id]?.config;
      return !force && current ? current : readConfig(session.id);
    });
  }

  async function seedMembers(): Promise<SessionTeamMember[]> {
    // This is the same enabled-definition source used by AgentSubagentsPage.
    const page = await loadSubagentPage();
    const names = [
      ...page.owned.filter((definition) => definition.enabled).map((definition) => definition.id),
      ...page.builtins
        .filter((definition) => definition.enabled)
        .map((definition) => definition.name),
    ];
    const seen = new Set<string>();
    const members: SessionTeamMember[] = [];
    for (const name of names) {
      const agent = normalizeSubagentName(name);
      if (!agent || seen.has(agent)) continue;
      seen.add(agent);
      // Deliberately omit model: a seed uses the definition default, not a card pin.
      members.push({ agent });
    }
    return members;
  }

  async function enabledChange(
    config: SessionTeamConfig,
    enabled: boolean,
  ): Promise<TeamChange | null> {
    if (config.enabled === enabled) return null;
    // Revision zero with no roster is the untouched host default. Later empty
    // rosters are intentional and must not be re-seeded on subsequent enables.
    if (enabled && config.revision === 0 && config.members.length === 0) {
      return { enabled, members: await seedMembers() };
    }
    return { enabled };
  }

  async function mutate(
    session: TeamSessionTarget,
    change: (config: SessionTeamConfig) => TeamChange | null | Promise<TeamChange | null>,
  ): Promise<SessionTeamConfig> {
    assertEligible(session);
    return enqueue(session.id, async () => {
      const before =
        store.getState().sessions[session.id]?.config ?? (await readConfig(session.id));
      patchSession(store, session.id, { saving: true, ...errorState(null) });
      let optimistic = false;
      try {
        const update = await change(before);
        if (!update) {
          patchSession(store, session.id, { saving: false });
          return before;
        }
        patchSession(store, session.id, { config: { ...before, ...update } });
        optimistic = true;
        const saved = await client.updateSessionTeam({
          sessionId: session.id,
          expectedRevision: before.revision,
          ...update,
        });
        patchSession(store, session.id, {
          config: saved,
          saving: false,
          ...errorState(null),
        });
        return saved;
      } catch (error) {
        if (optimistic && isRevisionConflict(error)) {
          // Discard the local edit before replacing it with the host's revision.
          patchSession(store, session.id, {
            config: before,
            saving: true,
            ...errorState(error),
          });
          await readConfig(session.id, error);
        } else {
          patchSession(store, session.id, {
            config: before,
            loading: false,
            saving: false,
            ...errorState(error),
          });
        }
        throw error;
      }
    });
  }

  function memberIndex(config: SessionTeamConfig, agent: string): number {
    return config.members.findIndex(
      (member) => normalizeSubagentName(member.agent) === agent,
    );
  }

  return {
    load: (session: TeamSessionTarget) => load(session, false),
    reload: (session: TeamSessionTarget) => load(session, true),
    setEnabled: (session: TeamSessionTarget, enabled: boolean) =>
      mutate(session, (config) => enabledChange(config, enabled)),
    toggle: (session: TeamSessionTarget) =>
      mutate(session, (config) => enabledChange(config, !config.enabled)),
    addMember: (session: TeamSessionTarget, agentName: string) =>
      mutate(session, (config) => {
        const agent = normalizeSubagentName(agentName);
        if (!agent) throw codedError("TEAM_INVALID_MEMBER");
        if (memberIndex(config, agent) >= 0) throw codedError("TEAM_MEMBER_EXISTS");
        return { members: [...config.members, { agent }] };
      }),
    removeMember: (session: TeamSessionTarget, agentName: string) =>
      mutate(session, (config) => {
        const agent = normalizeSubagentName(agentName);
        const index = memberIndex(config, agent);
        if (index < 0) throw codedError("TEAM_MEMBER_NOT_FOUND");
        return { members: config.members.filter((_, memberIndex) => memberIndex !== index) };
      }),
    setMemberModel: (
      session: TeamSessionTarget,
      agentName: string,
      model: SubagentModelPin | undefined,
    ) =>
      mutate(session, (config) => {
        const agent = normalizeSubagentName(agentName);
        const index = memberIndex(config, agent);
        if (index < 0) throw codedError("TEAM_MEMBER_NOT_FOUND");
        const members = config.members.map((member, memberIndex) => {
          if (memberIndex !== index) return member;
          const next: SessionTeamMember = { agent: member.agent };
          if (model) next.model = { ...model };
          return next;
        });
        return { members };
      }),
  };
}

export type TeamService = ReturnType<typeof createTeamService>;

/** Narrow renderer entry point for TeamPanel and ConversationTopbar. */
export const teamService = createTeamService();
