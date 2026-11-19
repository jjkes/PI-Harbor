/**
 * The Composer's debate surface, as one value.
 *
 * The mode chip names a committed state, and planning and the plan debate are
 * two different states: planning is a session mode with its own read-only
 * contract, while a debate is agent development that offers the debate action
 * and the round card. `settings.debateMode` says the user asked for the debate
 * surface; the session mode says what the running agent may do. Both must agree
 * before the surface is drawn, so a session the runtime switched to Plan (a
 * mode command, the EnterPlanMode tool, a remote `session/configure`) can never
 * leave a chip claiming a debate the session is no longer in.
 */
import type { AppSettings, Mode } from "@pi-harbor/shared";

/** One mode chip choice: the three session modes plus the debate surface. */
export type ComposerModeChoice = Mode | "debate";

/** Whether the user asked for the debate surface. An unknown value is off. */
export function isDebateMode(
  settings: Pick<AppSettings, "debateMode"> | null | undefined,
): boolean {
  return settings?.debateMode === "debate";
}
/**
 * The settings a released debate surface writes, or `null` when it is already
 * off.
 *
 * Approval is the one transition that ends the debate by itself: the host
 * writes `session.mode = 'agent'` when a plan is approved, so a switch left on
 * would keep the chip on Debate while the approved plan executes under the
 * ordinary Agent contract. The same release applies when a debated plan is
 * handed to team mode. Both write the preference through this one value, so no
 * caller invents its own off-state.
 */
export function releasedDebateSettings(settings: AppSettings): AppSettings | null {
  if (!isDebateMode(settings)) return null;
  return { ...settings, debateMode: "agent" };
}

/**
 * Whether the Composer draws the debate surface: the switch is on and the
 * session is still agent development, which is the mode a debate runs in.
 */
export function debateSurfaceOn(
  settings: Pick<AppSettings, "debateMode"> | null | undefined,
  mode: Mode,
): boolean {
  return mode === "agent" && isDebateMode(settings);
}

/**
 * The session mode a choice configures. The debate is not a session mode: it
 * is agent development with the debate surface on, so the runtime keeps the
 * normal Agent contract while the round runs.
 */
export function sessionModeForChoice(choice: ComposerModeChoice): Mode {
  return choice === "debate" ? "agent" : choice;
}
