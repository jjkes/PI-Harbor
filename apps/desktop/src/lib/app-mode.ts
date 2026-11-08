/**
 * Which surface the app is on.
 *
 * This is a renderer preference, not a session mode: `settings.appMode` never
 * reaches a session, a launch, or a prompt. Reading it through one function
 * keeps a value this build does not recognize from ever leaving the window in a
 * surface it cannot draw — an unknown or missing value is agent mode.
 */
import type { AppMode, AppSettings } from "@pi-harbor/shared";

export const APP_MODES: readonly AppMode[] = ["agent", "images"];

export function appModeOf(
  settings: Pick<AppSettings, "appMode"> | null | undefined,
): AppMode {
  return settings?.appMode === "images" ? "images" : "agent";
}

/** Whether the image workbench is the surface the user asked for. */
export function isImagesMode(
  settings: Pick<AppSettings, "appMode"> | null | undefined,
): boolean {
  return appModeOf(settings) === "images";
}
