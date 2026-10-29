import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { SessionTeamConfig } from "@pi-harbor/shared";

/** Renderer-only state for one session's Team configuration. */
export type TeamSessionState = {
  config: SessionTeamConfig | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  errorCode: string | null;
};

export type TeamState = {
  /** Configurations remain cached independently when the visible session changes. */
  sessions: Record<string, TeamSessionState>;
};

export type TeamStore = StoreApi<TeamState>;

/** Stable empty value for selectors; service updates always copy this state. */
export const EMPTY_TEAM_SESSION_STATE: TeamSessionState = {
  config: null,
  loading: false,
  saving: false,
  error: null,
  errorCode: null,
};

export function createTeamStore(): TeamStore {
  return createStore<TeamState>()(() => ({ sessions: {} }));
}

export const teamStore = createTeamStore();

/** React binding kept separate from the vanilla store for focused service tests. */
export function useTeamStore<T>(selector: (state: TeamState) => T): T {
  return useStore(teamStore, selector);
}

export function selectTeamSession(sessionId: string | undefined) {
  return (state: TeamState): TeamSessionState =>
    (sessionId ? state.sessions[sessionId] : undefined) ?? EMPTY_TEAM_SESSION_STATE;
}
