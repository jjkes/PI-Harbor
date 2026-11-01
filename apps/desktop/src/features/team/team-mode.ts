/**
 * The Team switch, shared by the composer's mode menu and the `toggleTeamMode`
 * shortcut. Switching Team on asks the composer dock to open on its Subagent
 * page. A draft has no session to switch yet, so the first Team choice creates
 * it. Host and seeding failures reach the caller's `onError`.
 */
import type { SessionTeamConfig } from "@pi-harbor/shared";
import { materializeDraftSession, useAppStore } from "../../stores/app-store";
import {
  clearDockReveal,
  requestDockReveal,
} from "../chat/background-tasks/dock-reveal";
import {
  isTeamSessionEligible,
  teamService,
  type TeamService,
  type TeamSessionTarget,
} from "./team-service";
import { teamStore, type TeamStore } from "./team-store";

/** What the Team switch needs to know about the conversation it acts on. */
export type TeamModeSnapshot = {
  /** `null` in a draft: the conversation has no session yet. */
  activeSessionId: string | null;
  /** The active session as the session list has it; absent while unlisted. */
  session: TeamSessionTarget | undefined;
  /** The open project lives on a remote host, so a draft there is remote too. */
  remoteProject: boolean;
  /** The open project's path. A draft is named by it: each project has one. */
  workspacePath: string | null;
  /** Every session the list holds now. A session a draft creates is never among them. */
  listedSessionIds: ReadonlySet<string>;
};

/** `hidden` for remote and Native Pi conversations: Team needs a local session. */
export type TeamAvailability = "hidden" | "available";

export function teamAvailability(
  snapshot: Pick<TeamModeSnapshot, "activeSessionId" | "session" | "remoteProject">,
): TeamAvailability {
  const { activeSessionId, session, remoteProject } = snapshot;
  if (session) return isTeamSessionEligible(session) ? "available" : "hidden";
  // A session that is not listed yet can only be judged by its id.
  if (activeSessionId) {
    return isTeamSessionEligible({ id: activeSessionId }) ? "available" : "hidden";
  }
  return remoteProject ? "hidden" : "available";
}

export function readTeamModeSnapshot(): TeamModeSnapshot {
  const state = useAppStore.getState();
  const activeSessionId = state.activeSessionId ?? null;
  return {
    activeSessionId,
    session: activeSessionId
      ? state.sessions.find((candidate) => candidate.id === activeSessionId)
      : undefined,
    remoteProject: Boolean(state.workspace?.remote),
    workspacePath: state.workspace?.path ?? null,
    listedSessionIds: new Set(state.sessions.map((candidate) => candidate.id)),
  };
}

function findListedSession(sessionId: string): TeamSessionTarget | undefined {
  return useAppStore.getState().sessions.find((candidate) => candidate.id === sessionId);
}

export type TeamModeDependencies = {
  service?: Pick<TeamService, "toggle" | "setEnabled">;
  configStore?: TeamStore;
  snapshot?: () => TeamModeSnapshot;
  /** Creates the session behind a draft; `null` when the user moved on meanwhile. */
  materializeDraft?: () => Promise<string | null>;
  /** The listed summary of a session that was just created. */
  findSession?: (sessionId: string) => TeamSessionTarget | undefined;
};

/**
 * Switches Team for one session. The dock is asked to open before the host
 * answers, so the optimistic config shows the Subagent page at once; switching
 * Team off, or a failure, withdraws the request.
 */
async function switchSessionTeam(
  session: TeamSessionTarget,
  target: "toggle" | "on",
  onError: (error: unknown) => void,
  dependencies: TeamModeDependencies,
): Promise<SessionTeamConfig | null> {
  const service = dependencies.service ?? teamService;
  const configStore = dependencies.configStore ?? teamStore;
  const wasEnabled =
    configStore.getState().sessions[session.id]?.config?.enabled === true;
  if (target === "on" || !wasEnabled) requestDockReveal(session.id);
  else clearDockReveal(session.id);
  try {
    const config = await (target === "on"
      ? service.setEnabled(session, true)
      : service.toggle(session));
    if (!config.enabled) clearDockReveal(session.id);
    return config;
  } catch (error) {
    clearDockReveal(session.id);
    onError(error);
    return null;
  }
}

/** Toggles Team on a known session. Ineligible sessions are a no-op. */
export function toggleTeamSessionMode(
  session: TeamSessionTarget | null | undefined,
  onError: (error: unknown) => void,
  dependencies: TeamModeDependencies = {},
): Promise<SessionTeamConfig | null> {
  if (!session || !isTeamSessionEligible(session)) return Promise.resolve(null);
  return switchSessionTeam(session, "toggle", onError, dependencies);
}

/** One creation per draft. A draft is named by its project, as each project has one. */
const draftStarts = new Map<string, Promise<SessionTeamConfig | null>>();

async function startTeamInDraft(
  origin: TeamModeSnapshot,
  onError: (error: unknown) => void,
  dependencies: TeamModeDependencies,
): Promise<SessionTeamConfig | null> {
  let sessionId: string | null;
  try {
    sessionId = await (dependencies.materializeDraft ?? (() => materializeDraftSession()))();
  } catch (error) {
    onError(error);
    return null;
  }
  // `null`: the user moved to another conversation while the host created it.
  if (!sessionId) return null;
  // A creation already under way ends by handing back whichever session is on
  // screen. One the list held at the click is a conversation the user moved to
  // meanwhile, not the session this draft became: Team is not this click's to
  // switch on there.
  if (origin.listedSessionIds.has(sessionId)) return null;
  const session = (dependencies.findSession ?? findListedSession)(sessionId) ?? { id: sessionId };
  if (!isTeamSessionEligible(session)) return null;
  // A failed Team write leaves the new session empty and Team off.
  return switchSessionTeam(session, "on", onError, dependencies);
}

/**
 * Toggles Team for the conversation on screen. In a draft this creates the
 * session and turns Team on. A project has one draft and so one creation at a
 * time: a second call for it joins that creation instead of switching Team off
 * again on a session that does not exist yet, while the draft of another
 * project starts its own.
 */
export function toggleActiveTeamMode(
  onError: (error: unknown) => void,
  dependencies: TeamModeDependencies = {},
): Promise<SessionTeamConfig | null> {
  const snapshot = (dependencies.snapshot ?? readTeamModeSnapshot)();
  if (teamAvailability(snapshot) === "hidden") return Promise.resolve(null);
  if (snapshot.activeSessionId) {
    return toggleTeamSessionMode(
      snapshot.session ?? { id: snapshot.activeSessionId },
      onError,
      dependencies,
    );
  }
  const draft = snapshot.workspacePath ?? "";
  const joined = draftStarts.get(draft);
  if (joined) return joined;
  const start: Promise<SessionTeamConfig | null> = startTeamInDraft(snapshot, onError, dependencies)
    .finally(() => {
      if (draftStarts.get(draft) === start) draftStarts.delete(draft);
    });
  draftStarts.set(draft, start);
  return start;
}
