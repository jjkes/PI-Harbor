/**
 * Turning the debate surface on and off.
 *
 * It is a renderer preference, so it keeps the Composer's established shape:
 * the chip changes on the press and persistence is bookkeeping that must never
 * make the control look dead. A rejected settings write is reported with the
 * host's message, and the next launch reads whatever the host kept.
 */
import type { AppSettings } from "@pi-harbor/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { isDebateMode, releasedDebateSettings } from "./debate-mode";

export async function setDebateMode(next: boolean): Promise<void> {
  const current = useAppStore.getState().settings;
  if (!current || isDebateMode(current) === next) return;
  const updated: AppSettings = {
    ...current,
    debateMode: next ? "debate" : "agent",
  };
  useAppStore.setState({ settings: updated });
  try {
    await api.setSettings(updated);
  } catch (error) {
    useAppStore.getState().showToast(
      error instanceof Error ? error.message : String(error),
      { variant: "error" },
    );
  }
}

/**
 * Hand the composer back to plain Agent development.
 *
 * Used by the two transitions that end a debate by themselves — approving the
 * plan the host executes, and handing a debated plan to team mode — so neither
 * leaves the chip claiming a round the session has already left.
 */
export async function releaseDebateMode(): Promise<void> {
  const current = useAppStore.getState().settings;
  const released = current ? releasedDebateSettings(current) : null;
  if (!released) return;
  useAppStore.setState({ settings: released });
  try {
    await api.setSettings(released);
  } catch (error) {
    useAppStore.getState().showToast(
      error instanceof Error ? error.message : String(error),
      { variant: "error" },
    );
  }
}
