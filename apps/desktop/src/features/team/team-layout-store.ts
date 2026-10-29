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
export const TEAM_ROSTER_COLLAPSED_STORAGE_KEY = "pi.desktop.teamRosterCollapsed";

type TeamLayoutStorage = Pick<Storage, "getItem" | "setItem">;

type TeamPresentation = {
  sessionId: string;
  presentation: TeamLayoutPresentation;
};

export type TeamLayoutState = {
  /** App-wide user preference; collapsed/clamped presentation never writes it. */
  preferredWidth: number;
  /** App-wide preference: the member cards fold to their heading row. */
  rosterCollapsed: boolean;
  overlaySessionId: string | null;
  presentation: TeamPresentation | null;
  /**
   * Session whose Team view is shown once its layout is measured. Switching
   * Team on sets it, so a narrow window opens the drawer instead of leaving
   * the view behind a rail.
   */
  revealSessionId: string | null;
  setPreferredWidth: (width: number) => void;
  setRosterCollapsed: (collapsed: boolean) => void;
  openOverlay: (sessionId: string) => void;
  closeOverlay: (sessionId?: string) => void;
  setPresentation: (
    sessionId: string,
    presentation: TeamLayoutPresentation,
  ) => void;
  requestReveal: (sessionId: string) => void;
  clearReveal: (sessionId?: string) => void;
  /** Settle a pending reveal: inline shows the view, narrower layouts open the drawer. */
  consumeReveal: (
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

/** Best-effort JSON preference; a missing or unreadable value is `null`. */
function readPreference(storage: TeamLayoutStorage | null, key: string): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writePreference(
  storage: TeamLayoutStorage | null,
  key: string,
  value: unknown,
): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
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
    preferredWidth: normalizePreferredWidth(
      readPreference(storage, TEAM_PANEL_WIDTH_STORAGE_KEY),
    ),
    rosterCollapsed:
      readPreference(storage, TEAM_ROSTER_COLLAPSED_STORAGE_KEY) === true,
    overlaySessionId: null,
    presentation: null,
    revealSessionId: null,
    setPreferredWidth: (width) => {
      const preferredWidth = normalizePreferredWidth(width);
      writePreference(storage, TEAM_PANEL_WIDTH_STORAGE_KEY, preferredWidth);
      if (get().preferredWidth !== preferredWidth) set({ preferredWidth });
    },
    setRosterCollapsed: (collapsed) => {
      writePreference(storage, TEAM_ROSTER_COLLAPSED_STORAGE_KEY, collapsed);
      if (get().rosterCollapsed !== collapsed) set({ rosterCollapsed: collapsed });
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
    requestReveal: (sessionId) => {
      if (sessionId && get().revealSessionId !== sessionId) {
        set({ revealSessionId: sessionId });
      }
    },
    clearReveal: (sessionId) => {
      const pending = get().revealSessionId;
      if (pending === null || (sessionId && pending !== sessionId)) return;
      set({ revealSessionId: null });
    },
    consumeReveal: (sessionId, presentation) => {
      if (get().revealSessionId !== sessionId) return;
      set(
        presentation === "inline"
          ? { revealSessionId: null }
          : { revealSessionId: null, overlaySessionId: sessionId },
      );
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
 * Shared composer/keyboard action. Ineligible sessions are a no-op; host and
 * seeding failures follow the same toast path regardless of the entry point.
 * Switching Team on asks for its view to be revealed once measured; switching
 * it off, or a failure, withdraws that request.
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
  if (wasEnabled) {
    // Disabling removes TeamLayout immediately through its optimistic config;
    // close the shared overlay now as well, including if the host later rolls
    // it back. The drawer button only changes visibility and never calls this.
    layoutStore.getState().closeOverlay(session.id);
    layoutStore.getState().clearReveal(session.id);
  } else {
    // Requested before the optimistic config mounts TeamLayout, which settles
    // it against its first measured presentation.
    layoutStore.getState().requestReveal(session.id);
  }
  try {
    const config = await (dependencies.service ?? teamService).toggle(session);
    if (!config.enabled) {
      layoutStore.getState().closeOverlay(session.id);
      layoutStore.getState().clearReveal(session.id);
    }
    return config;
  } catch (error) {
    layoutStore.getState().clearReveal(session.id);
    onError(error);
    return null;
  }
}
