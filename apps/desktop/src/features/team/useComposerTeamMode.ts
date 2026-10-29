import { useCallback } from "react";
import {
  KEYBOARD_SHORTCUTS,
  keybindingDisplayParts,
  resolveKeybinding,
  type SessionSummary,
  type ShortcutPlatform,
} from "@pi-harbor/shared";
import { useAppStore } from "../../stores/app-store";
import { toggleTeamSessionMode } from "./team-layout-store";
import { isTeamSessionEligible } from "./team-service";
import { selectTeamSession, useTeamStore } from "./team-store";

/**
 * How the composer's mode menu offers Team: `hidden` for remote and Native Pi
 * sessions, `draft` until the first message has created a session, and
 * `available` for a local session.
 */
export type ComposerTeamAvailability = "hidden" | "draft" | "available";

export type ComposerTeamMode = {
  availability: ComposerTeamAvailability;
  /** Whether Team is on for the current session. */
  enabled: boolean;
  /** A Team change for the current session is being stored. */
  saving: boolean;
  /** Display label of the `toggleTeamMode` shortcut; empty when it is unbound. */
  shortcutLabel: string;
  toggle: () => void;
};

export function composerTeamAvailability(
  activeSessionId: string | null | undefined,
  session: Pick<SessionSummary, "id" | "source"> | undefined,
): ComposerTeamAvailability {
  if (session) return isTeamSessionEligible(session) ? "available" : "hidden";
  if (!activeSessionId) return "draft";
  // A session that is not listed yet can only be judged by its id.
  return isTeamSessionEligible({ id: activeSessionId }) ? "draft" : "hidden";
}

function teamModeShortcutLabel(
  keybindings: Parameters<typeof resolveKeybinding>[1],
  platform: ShortcutPlatform,
): string {
  const shortcut = KEYBOARD_SHORTCUTS.find((candidate) => candidate.id === "toggleTeamMode");
  const binding = shortcut ? resolveKeybinding(shortcut, keybindings, platform) : null;
  return keybindingDisplayParts(binding, platform).join(platform === "darwin" ? "" : "+");
}

/**
 * The composer's Team switch for the active session. It runs the same action
 * as the `toggleTeamMode` shortcut, including the one-time reveal of the Team
 * view.
 */
export function useComposerTeamMode(): ComposerTeamMode {
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const session = useAppStore((state) =>
    state.activeSessionId
      ? state.sessions.find((candidate) => candidate.id === state.activeSessionId)
      : undefined,
  );
  const keybindings = useAppStore((state) => state.settings?.keybindings);
  const showToast = useAppStore((state) => state.showToast);
  const availability = composerTeamAvailability(activeSessionId, session);
  const team = useTeamStore(
    selectTeamSession(availability === "available" ? session?.id : undefined),
  );
  const platform = (
    typeof window === "undefined" ? "darwin" : window.piDesktop?.platform ?? "darwin"
  ) as ShortcutPlatform;

  const toggle = useCallback(() => {
    if (!session) return;
    void toggleTeamSessionMode(session, (error) => {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    });
  }, [session, showToast]);

  return {
    availability,
    enabled: availability === "available" && team.config?.enabled === true,
    saving: availability === "available" && team.saving,
    shortcutLabel: teamModeShortcutLabel(keybindings, platform),
    toggle,
  };
}
