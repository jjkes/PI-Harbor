/**
 * Display wording shared by the Team member card and the member sheet.
 *
 * These are pure label helpers: the model select, the card, and the sheet all
 * name a pin, a reasoning level, or a role's tools the same way, so the
 * wording lives in one place instead of drifting between surfaces.
 */
import type { TFunction } from "i18next";
import type { SubagentDefinition, SubagentModelPin } from "@pi-harbor/shared";
import {
  subagentModelDisplay,
  subagentModelPinParts,
} from "../../components/settings/subagent-models";
import { useAppStore } from "../../stores/app-store";

export type TeamProviders = ReturnType<typeof useAppStore.getState>["providers"];

/** The stored `provider/model` spelling of a session model lock. */
export function teamPinText(pin: SubagentModelPin): string {
  return `${pin.providerId}/${pin.modelId}`;
}

/** The model id a pin resolves to, for labels. */
export function teamPinModelId(pin: SubagentModelPin, providers: TeamProviders): string {
  const text = teamPinText(pin);
  return (
    subagentModelDisplay(text, providers)?.modelId ??
    subagentModelPinParts(text)?.modelId ??
    text
  );
}

/** Whether no configured provider can serve the pinned model. */
export function teamPinUnavailable(
  pin: SubagentModelPin | undefined,
  providers: TeamProviders,
): boolean {
  if (!pin) return false;
  const display = subagentModelDisplay(teamPinText(pin), providers);
  return !display || display.status !== "available";
}

/** A reasoning level as the Settings editor names it. */
export function teamThinkingText(
  t: TFunction,
  level: SubagentDefinition["thinkingLevel"],
): string {
  if (!level) return t("extensions.subagents.thinkingInherit");
  if (level === "omit") return t("extensions.subagents.thinkingOmit");
  return level;
}

/** A role's own tools, as the names the role declares. */
export function teamRoleToolNames(
  t: TFunction,
  definition: Pick<SubagentDefinition, "tools" | "inheritTools">,
): string[] {
  return [
    ...(definition.inheritTools ? [t("extensions.subagents.toolsInherit")] : []),
    ...definition.tools,
  ];
}
