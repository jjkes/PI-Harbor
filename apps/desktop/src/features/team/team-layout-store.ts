import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { SessionTeamConfig } from "@pi-harbor/shared";
import {
  TEAM_PANEL_DEFAULT_WIDTH,
  TEAM_PANEL_MIN_WIDTH,
  type TeamLayoutPresentation,
} from "./team-layout-model";
import {
  isTeamSessionEligible,
  teamService,
  type TeamService,
  type TeamSessionTarget,
} from "./team-service";
import { teamStore, type TeamStore } from "./team-store";

export const TEAM_PANEL_WIDTH_STORAGE_KEY = "pi.desktop.teamPanelWidth";

type TeamLayoutStorage = Pick<Storage, "getItem" | "setItem">;

type TeamPresentation = {
  sessionId: string;
  presentation: TeamLayoutPresentation;
};

export type TeamLayoutState = {
  /** App-wide user preference; collapsed/clamped presentation never writes it. */
  preferredWidth: number;
  overlaySessionId: string | null;
  presentation: TeamPresentation | null;
  setPreferredWidth: (width: number) => void;
  openOverlay: (sessionId: string) => void;
  closeOverlay: (sessionId?: string) => void;
  setPresentation: (
    sessionId: string,
    presentation: TeamLayoutPresentation,
  ) => void;
};

export type TeamLayoutStore = StoreApi<TeamLayoutState>;

function browserStorage(): TeamLayoutStorage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

function normalizePreferredWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(TEAM_PANEL_MIN_WIDTH, Math.round(value))
    : TEAM_PANEL_DEFAULT_WIDTH;
}

function readPreferredWidth(storage: TeamLayoutStorage | null): number {
  if (!storage) return TEAM_PANEL_DEFAULT_WIDTH;
  try {
    const raw = storage.getItem(TEAM_PANEL_WIDTH_STORAGE_KEY);
    return raw === null
      ? TEAM_PANEL_DEFAULT_WIDTH
      : normalizePreferredWidth(JSON.parse(raw));
  } catch {
    return TEAM_PANEL_DEFAULT_WIDTH;
  }
}

function writePreferredWidth(
  storage: TeamLayoutStorage | null,
  width: number,
): void {
  try {
    storage?.setItem(TEAM_PANEL_WIDTH_STORAGE_KEY, JSON.stringify(width));
  } catch {
    // A best-effort visual preference must not block resizing or the app.
  }
}

export function createTeamLayoutStore({
  storage = browserStorage(),
}: {
  storage?: TeamLayoutStorage | null;
} = {}): TeamLayoutStore {
  return createStore<TeamLayoutState>()((set, get) => ({
    preferredWidth: readPreferredWidth(storage),
    overlaySessionId: null,
    presentation: null,
    setPreferredWidth: (width) => {
      const preferredWidth = normalizePreferredWidth(width);
      writePreferredWidth(storage, preferredWidth);
      if (get().preferredWidth !== preferredWidth) set({ preferredWidth });
    },
    openOverlay: (sessionId) => {
      if (sessionId) set({ overlaySessionId: sessionId });
    },
    closeOverlay: (sessionId) => {
      if (sessionId && get().overlaySessionId !== sessionId) return;
      if (get().overlaySessionId !== null) set({ overlaySessionId: null });
    },
    setPresentation: (sessionId, presentation) => {
      set((state) => ({
        presentation: { sessionId, presentation },
        // A newly visible session or a newly inline layout dismisses a drawer
        // that belonged to the previous presentation.
        overlaySessionId:
          state.overlaySessionId === sessionId && presentation !== "inline"
            ? state.overlaySessionId
            : null,
      }));
    },
  }));
}

export const teamLayoutStore = createTeamLayoutStore();

export function useTeamLayoutStore<T>(
  selector: (state: TeamLayoutState) => T,
): T {
  return useStore(teamLayoutStore, selector);
}

export type TeamModeToggleDependencies = {
  service?: Pick<TeamService, "toggle">;
  configStore?: TeamStore;
  layoutStore?: TeamLayoutStore;
};

/**
 * Shared topbar/keyboard action. Ineligible sessions are a no-op; host and
 * seeding failures follow the same toast path regardless of the entry point.
 */
export async function toggleTeamSessionMode(
  session: TeamSessionTarget | null | undefined,
  onError: (error: unknown) => void,
  dependencies: TeamModeToggleDependencies = {},
): Promise<SessionTeamConfig | null> {
  if (!session || !isTeamSessionEligible(session)) return null;
  const configStore = dependencies.configStore ?? teamStore;
  const layoutStore = dependencies.layoutStore ?? teamLayoutStore;
  const wasEnabled =
    configStore.getState().sessions[session.id]?.config?.enabled === true;
  // Disabling removes TeamLayout immediately through its optimistic config;
  // close the shared overlay now as well, including if the host later rolls it
  // back. A reveal click is never routed through this action.
  if (wasEnabled) layoutStore.getState().closeOverlay(session.id);
  try {
    const config = await (dependencies.service ?? teamService).toggle(session);
    if (!config.enabled) layoutStore.getState().closeOverlay(session.id);
    return config;
  } catch (error) {
    onError(error);
    return null;
  }
}
