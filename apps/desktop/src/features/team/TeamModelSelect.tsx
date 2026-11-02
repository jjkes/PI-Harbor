/**
 * The provider-bounded model chooser for one Team member or the whole roster.
 *
 * The option list is the same one Settings offers for a subagent default, so a
 * session lock can never name a model the launch path cannot resolve. An empty
 * value means "follow the role", which is how a session setting is cleared
 * without rewriting the role definition.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SubagentModelPin } from "@pi-harbor/shared";
import {
  groupSubagentModelChoices,
  subagentModelChoices,
  subagentModelOrphanPin,
  subagentModelSelectValue,
} from "../../components/settings/subagent-models";
import { Select, cx } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { teamPinModelId, teamPinText } from "./team-labels";

export function TeamModelSelect({
  id,
  pin,
  roleModel,
  disabled,
  ariaLabel,
  className,
  onChange,
}: {
  id?: string;
  /** The session lock; absent means the role's own default applies. */
  pin?: SubagentModelPin;
  /** The role's default, named in the empty option so "follow the role" is concrete. */
  roleModel?: SubagentModelPin;
  disabled: boolean;
  ariaLabel: string;
  className?: string;
  onChange: (pin: SubagentModelPin | null) => void;
}) {
  const { t } = useTranslation();
  const providers = useAppStore((state) => state.providers);
  const choices = useMemo(() => subagentModelChoices(providers), [providers]);
  const groups = useMemo(() => groupSubagentModelChoices(choices), [choices]);
  const currentPin = pin ? teamPinText(pin) : "";
  const value = subagentModelSelectValue(currentPin, choices);
  const orphanPin = subagentModelOrphanPin(currentPin, choices);
  // A roster-wide selection has no single role to follow, so it names the
  // cleared state itself instead of a role default.
  const followLabel = roleModel
    ? t("team.roleDefaultWith", { value: teamPinModelId(roleModel, providers) })
    : t("team.followRole");

  return (
    <Select
      id={id}
      className={cx("team-member-select", className)}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      title={ariaLabel}
      onChange={(event) => {
        const next = event.target.value;
        if (!next) {
          onChange(null);
          return;
        }
        const choice = choices.find((candidate) => candidate.value === next);
        if (choice) onChange({ providerId: choice.providerId, modelId: choice.modelId });
      }}
    >
      <option value="">{followLabel}</option>
      {groups.map((group) => (
        <optgroup key={group.providerId} label={group.providerName}>
          {group.choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.modelId}
            </option>
          ))}
        </optgroup>
      ))}
      {orphanPin ? (
        <option value={orphanPin} disabled>
          {orphanPin} · {t("team.modelUnavailable")}
        </option>
      ) : null}
    </Select>
  );
}
