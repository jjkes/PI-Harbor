import { useCallback, useEffect, useState } from "react";
import {
  KEYBOARD_SHORTCUTS,
  keybindingDisplayParts,
  resolveKeybinding,
  type ShortcutPlatform,
} from "@pi-harbor/shared";
import { useAppStore } from "../../stores/app-store";
import {
  teamAvailability,
  toggleActiveTeamMode,
  type TeamAvailability,
} from "./team-mode";
import { teamService } from "./team-service";
import { selectTeamSession, useTeamStore } from "./team-store";

export type ComposerTeamMode = {
  availability: TeamAvailability;
  /** Whether Team is on for the current session. */
  enabled: boolean;
  /** A Team change is being stored, or the draft's session is being created. */
  saving: boolean;
  /** Display label of the `toggleTeamMode` shortcut; empty when it is unbound. */
  shortcutLabel: string;
  toggle: () => void;
};

function teamModeShortcutLabel(
  keybindings: Parameters<typeof resolveKeybinding>[1],
  platform: ShortcutPlatform,
): string {
  const shortcut = KEYBOARD_SHORTCUTS.find((candidate) => candidate.id === "toggleTeamMode");
  const binding = shortcut ? resolveKeybinding(shortcut, keybindings, platform) : null;
  return keybindingDisplayParts(binding, platform).join(platform === "darwin" ? "" : "+");
}

/**
 * The composer's Team switch for the conversation on screen. It runs the same
 * action as the `toggleTeamMode` shortcut, including opening the composer dock
 * on its Subagent page, and it owns reading the session's Team configuration:
 * the dock and the member picker only read what is stored.
 */
export function useComposerTeamMode(): ComposerTeamMode {
  const activeSessionId = useAppStore((state) => state.activeSessionId ?? null);
  const session = useAppStore((state) =>
    state.activeSessionId
      ? state.sessions.find((candidate) => candidate.id === state.activeSessionId)
      : undefined,
  );
  const remoteProject = useAppStore((state) => Boolean(state.workspace?.remote));
  const keybindings = useAppStore((state) => state.settings?.keybindings);
  const showToast = useAppStore((state) => state.showToast);
  const availability = teamAvailability({ activeSessionId, session, remoteProject });
  const teamSessionId = availability === "available" ? (activeSessionId ?? undefined) : undefined;
  const source = session?.source;
  const team = useTeamStore(selectTeamSession(teamSessionId));
  const [starting, setStarting] = useState(false);
  const platform = (
    typeof window === "undefined" ? "darwin" : window.piDesktop?.platform ?? "darwin"
  ) as ShortcutPlatform;

  useEffect(() => {
    if (!teamSessionId) return;
    let current = true;
    void teamService
      .load({ id: teamSessionId, ...(source ? { source } : {}) })
      .catch((error: unknown) => {
        // The store keeps the failure for the member picker's retry. A failure
        // that arrives after the user has left the conversation is not theirs
        // to read, so only the conversation on screen gets the toast.
        if (!current || useAppStore.getState().activeSessionId !== teamSessionId) return;
        showToast(error instanceof Error ? error.message : String(error), {
          variant: "error",
        });
      });
    return () => {
      current = false;
    };
  }, [teamSessionId, source, showToast]);

  const toggle = useCallback(() => {
    const onError = (error: unknown) => {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    };
    if (activeSessionId) {
      void toggleActiveTeamMode(onError);
      return;
    }
    // The draft's first Team choice creates its session; show it as saving.
    setStarting(true);
    void toggleActiveTeamMode(onError).finally(() => setStarting(false));
  }, [activeSessionId, showToast]);

  return {
    availability,
    enabled: availability === "available" && team.config?.enabled === true,
    saving: availability === "available" && (starting || team.saving),
    shortcutLabel: teamModeShortcutLabel(keybindings, platform),
    toggle,
  };
}
