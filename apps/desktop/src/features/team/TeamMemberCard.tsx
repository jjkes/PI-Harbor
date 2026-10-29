import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  subagentCanMutate,
  type SessionTeamMember,
  type SubagentDefinition,
  type SubagentModelPin,
} from "@pi-harbor/shared";
import { IconBot, IconTrash } from "../../components/icons";
import { Badge, Panel, Select, TooltipButton, cx } from "../../components/ui";
import {
  groupSubagentModelChoices,
  subagentModelChoices,
  subagentModelDisplay,
  subagentModelOrphanPin,
  subagentModelPinParts,
  subagentModelSelectValue,
} from "../../components/settings/subagent-models";
import { useAppStore } from "../../stores/app-store";
import { teamService, type TeamSessionTarget } from "./team-service";

export type TeamDefinitionEntry = {
  handle: string;
  definition: SubagentDefinition;
  enabled: boolean;
};

function pinText(pin: SubagentModelPin): string {
  return `${pin.providerId}/${pin.modelId}`;
}

function modelIdFromPin(
  pin: string,
  providers: ReturnType<typeof useAppStore.getState>["providers"],
): string {
  return (
    subagentModelDisplay(pin, providers)?.modelId ??
    subagentModelPinParts(pin)?.modelId ??
    pin
  );
}

/** Provider-bounded card pin editor shared by the roster and manager. */
export function TeamModelSelect({
  member,
  entry,
  disabled,
  onChange,
}: {
  member: SessionTeamMember;
  entry: TeamDefinitionEntry;
  disabled: boolean;
  onChange: (model: SubagentModelPin | undefined) => void;
}) {
  const { t } = useTranslation();
  const providers = useAppStore((state) => state.providers);
  const choices = useMemo(() => subagentModelChoices(providers), [providers]);
  const groups = useMemo(() => groupSubagentModelChoices(choices), [choices]);
  const currentPin = member.model ? pinText(member.model) : "";
  const value = subagentModelSelectValue(currentPin, choices);
  const orphanPin = subagentModelOrphanPin(currentPin, choices);
  const defaultPin = entry.definition.model ? pinText(entry.definition.model) : "";
  const defaultLabel = defaultPin
    ? t("team.definitionDefaultWithModel", {
        model: modelIdFromPin(defaultPin, providers),
      })
    : t("team.definitionDefault");

  return (
    <Select
      className="team-member-model-select"
      aria-label={t("team.memberModel", { name: entry.handle })}
      title={defaultLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const next = event.target.value;
        if (!next) {
          onChange(undefined);
          return;
        }
        const choice = choices.find((candidate) => candidate.value === next);
        if (choice) onChange({ providerId: choice.providerId, modelId: choice.modelId });
      }}
    >
      <option value="">{defaultLabel}</option>
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

export function TeamMemberCard({
  session,
  member,
  entry,
  runningCount,
  saving,
  onError,
}: {
  session: TeamSessionTarget;
  member: SessionTeamMember;
  entry?: TeamDefinitionEntry;
  runningCount: number;
  saving: boolean;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const providers = useAppStore((state) => state.providers);
  const definition = entry?.definition;
  const effectivePin = member.model ?? definition?.model;
  const effectivePinText = effectivePin ? pinText(effectivePin) : "";
  const modelDisplay = effectivePinText
    ? subagentModelDisplay(effectivePinText, providers)
    : null;
  const modelUnavailable = Boolean(
    effectivePinText && (!modelDisplay || modelDisplay.status !== "available"),
  );
  const unavailable = !entry?.enabled;
  const status = runningCount > 0
    ? t("team.runningStatus", { count: runningCount })
    : unavailable
      ? t("team.unavailable")
      : modelUnavailable
        ? t("team.modelUnavailable")
        : t("team.ready");
  const canMutate = definition ? subagentCanMutate(definition) : false;

  return (
    <Panel
      className={cx(
        "team-member-card",
        runningCount > 0 && "is-running",
        unavailable && "is-unavailable",
      )}
    >
      <div className="team-member-card-head" title={definition?.description || member.agent}>
        <span className="team-member-avatar" aria-hidden>
          <IconBot size={15} />
        </span>
        <div className="team-member-card-copy">
          <strong>{entry?.handle ?? member.agent}</strong>
          <span className="team-member-status">{status}</span>
        </div>
        <TooltipButton
          type="button"
          className="team-member-remove"
          tooltip={t("team.removeMember", { name: member.agent })}
          ariaLabel={t("team.removeMember", { name: member.agent })}
          disabled={saving}
          onClick={() => {
            void teamService.removeMember(session, member.agent).catch(onError);
          }}
        >
          <IconTrash size={13} />
        </TooltipButton>
      </div>
      <div className="team-member-card-meta">
        <Badge
          className="team-member-badge"
          tone={canMutate ? "warning" : unavailable ? "error" : "neutral"}
        >
          {definition
            ? canMutate
              ? t("team.writeAccess")
              : t("team.readOnly")
            : t("team.unavailable")}
        </Badge>
      </div>
      {entry ? (
        <TeamModelSelect
          member={member}
          entry={entry}
          disabled={saving}
          onChange={(model) => {
            void teamService.setMemberModel(session, member.agent, model).catch(onError);
          }}
        />
      ) : null}
    </Panel>
  );
}
