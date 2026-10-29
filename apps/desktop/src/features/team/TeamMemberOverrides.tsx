import { useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  SUBAGENT_INHERIT_TOKEN,
  SUBAGENT_THINKING_LEVELS,
  type SubagentDefinition,
  type SubagentModelPin,
  type SubagentThinkingLevel,
  type TeamMemberToolGrant,
} from "@pi-harbor/shared";
import {
  groupSubagentModelChoices,
  subagentModelChoices,
  subagentModelDisplay,
  subagentModelOrphanPin,
  subagentModelPinParts,
  subagentModelSelectValue,
} from "../../components/settings/subagent-models";
import {
  Badge,
  Button,
  CheckboxGroup,
  SegmentedControl,
  Select,
} from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import {
  TEAM_MEMBER_RESET_PATCH,
  TEAM_TOOL_GRANTS,
  canonicalTeamTools,
  roleToolGrant,
  type TeamMemberPatch,
  type TeamRosterCard,
} from "./team-roster-model";

type Providers = ReturnType<typeof useAppStore.getState>["providers"];
type ToolMode = "role" | "custom";

export function teamPinText(pin: SubagentModelPin): string {
  return `${pin.providerId}/${pin.modelId}`;
}

/** The model id a pin resolves to, for labels. */
export function teamPinModelId(pin: SubagentModelPin, providers: Providers): string {
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
  providers: Providers,
): boolean {
  if (!pin) return false;
  const display = subagentModelDisplay(teamPinText(pin), providers);
  return !display || display.status !== "available";
}

/** A reasoning level as the Settings editor names it. */
export function teamThinkingText(
  t: TFunction,
  level: SubagentThinkingLevel | undefined,
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

/** Provider-bounded model lock for one member; empty follows the role. */
function TeamModelSelect({
  id,
  pin,
  role,
  disabled,
  onChange,
}: {
  id: string;
  pin: SubagentModelPin | undefined;
  role: SubagentDefinition;
  disabled: boolean;
  onChange: (pin: SubagentModelPin | null) => void;
}) {
  const { t } = useTranslation();
  const providers = useAppStore((state) => state.providers);
  const choices = useMemo(() => subagentModelChoices(providers), [providers]);
  const groups = useMemo(() => groupSubagentModelChoices(choices), [choices]);
  const currentPin = pin ? teamPinText(pin) : "";
  const value = subagentModelSelectValue(currentPin, choices);
  const orphanPin = subagentModelOrphanPin(currentPin, choices);
  const roleModel = role.model
    ? teamPinModelId(role.model, providers)
    : t("extensions.subagents.modelInherit");

  return (
    <Select
      id={id}
      className="team-member-select"
      value={value}
      disabled={disabled}
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
      <option value="">{t("team.roleDefaultWith", { value: roleModel })}</option>
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

function TeamThinkingSelect({
  id,
  level,
  role,
  disabled,
  onChange,
}: {
  id: string;
  level: SubagentThinkingLevel | undefined;
  role: SubagentDefinition;
  disabled: boolean;
  onChange: (level: SubagentThinkingLevel | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select
      id={id}
      className="team-member-select"
      value={level ?? ""}
      disabled={disabled}
      onChange={(event) => {
        const next = SUBAGENT_THINKING_LEVELS.find(
          (candidate) => candidate === event.target.value,
        );
        onChange(next ?? null);
      }}
    >
      <option value="">
        {t("team.roleDefaultWith", { value: teamThinkingText(t, role.thinkingLevel) })}
      </option>
      <option value="omit">{t("extensions.subagents.thinkingOmit")}</option>
      {SUBAGENT_THINKING_LEVELS.filter((candidate) => candidate !== "omit").map(
        (candidate) => (
          <option key={candidate} value={candidate}>
            {candidate}
          </option>
        ),
      )}
    </Select>
  );
}

function OverrideField({
  label,
  htmlFor,
  modified,
  children,
}: {
  label: string;
  htmlFor?: string;
  modified: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="team-member-field">
      <div className="team-member-field-head">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {modified ? (
          <Badge className="team-member-modified">{t("team.modified")}</Badge>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/**
 * Session-only model, reasoning, and tools for one member. Each change is
 * stored at once; the role definition itself is never edited here.
 */
export function TeamMemberOverrides({
  card,
  saving,
  onUpdate,
}: {
  card: TeamRosterCard;
  saving: boolean;
  /** Resolves true once the host stored the edit, false when it was rejected. */
  onUpdate: (patch: TeamMemberPatch) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const modelId = useId();
  const thinkingId = useId();
  const role = card.entry.definition;
  const member = card.member;
  const savedTools = canonicalTeamTools(member?.tools ?? []);
  // Choosing "Custom" starts from the role's tools; nothing is stored until a
  // tool changes, so an untouched custom selection stays local.
  const [draftTools, setDraftTools] = useState<TeamMemberToolGrant[] | null>(null);
  const selection = savedTools.length > 0 ? savedTools : draftTools;
  const toolMode: ToolMode = selection ? "custom" : "role";
  const toolModeOptions: readonly { value: ToolMode; label: string }[] = [
    { value: "role", label: t("team.followRole") },
    { value: "custom", label: t("team.customTools") },
  ];
  const toolOptions = TEAM_TOOL_GRANTS.map((tool) => ({
    value: tool,
    label: tool === SUBAGENT_INHERIT_TOKEN ? t("extensions.subagents.toolsInherit") : tool,
  }));

  const changeToolMode = (mode: ToolMode) => {
    if (mode === toolMode) return;
    if (mode === "custom") {
      setDraftTools(roleToolGrant(role));
      return;
    }
    setDraftTools(null);
    if (savedTools.length > 0) void onUpdate({ tools: null });
  };
  const changeTools = (values: readonly TeamMemberToolGrant[]) => {
    const next = canonicalTeamTools(values);
    if (next.length === 0) return;
    const previous = draftTools;
    // Keep the custom selection on screen until the host stores or rejects it.
    setDraftTools(next);
    void onUpdate({ tools: next }).then((stored) => setDraftTools(stored ? null : previous));
  };
  const reset = () => {
    setDraftTools(null);
    void onUpdate(TEAM_MEMBER_RESET_PATCH);
  };

  return (
    <section className="team-member-sheet-section" aria-labelledby={headingId}>
      <div className="team-member-section-head">
        <h3 id={headingId}>{t("team.sessionSettings")}</h3>
        {card.hasSettings ? (
          <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={reset}>
            {t("team.resetToRole")}
          </Button>
        ) : null}
      </div>
      <p className="team-member-note">{t("team.sessionSettingsNote")}</p>
      <OverrideField
        label={t("extensions.subagents.model")}
        htmlFor={modelId}
        modified={Boolean(member?.model)}
      >
        <TeamModelSelect
          id={modelId}
          pin={member?.model}
          role={role}
          disabled={saving}
          onChange={(model) => void onUpdate({ model })}
        />
      </OverrideField>
      <OverrideField
        label={t("extensions.subagents.thinking")}
        htmlFor={thinkingId}
        modified={Boolean(member?.thinkingLevel)}
      >
        <TeamThinkingSelect
          id={thinkingId}
          level={member?.thinkingLevel}
          role={role}
          disabled={saving}
          onChange={(thinkingLevel) => void onUpdate({ thinkingLevel })}
        />
      </OverrideField>
      <OverrideField label={t("extensions.subagents.tools")} modified={savedTools.length > 0}>
        <SegmentedControl
          className="team-member-tool-mode"
          label={t("team.memberTools", { name: card.handle })}
          value={toolMode}
          options={toolModeOptions}
          disabled={saving}
          onChange={changeToolMode}
        />
        {selection ? (
          <CheckboxGroup
            className="team-member-tools"
            label={t("team.customTools")}
            values={selection}
            options={toolOptions}
            minSelected={1}
            disabled={saving}
            onChange={changeTools}
          />
        ) : null}
        {card.canMutate && !card.roleCanMutate ? (
          <p className="team-member-warning">{t("extensions.subagents.mutatingHint")}</p>
        ) : null}
      </OverrideField>
    </section>
  );
}
