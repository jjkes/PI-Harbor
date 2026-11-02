import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { SubagentModelPin } from "@pi-harbor/shared";
import { Badge, SettingsToggle, cx } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { TeamModelSelect } from "./TeamModelSelect";
import { teamPinUnavailable } from "./team-labels";
import {
  teamCardStatus,
  type TeamCardStatus,
  type TeamRosterCard,
} from "./team-roster-model";
import "./team-roster-picker.css";

/** One wording for a member's state, shared by the card and the member sheet. */
export function teamStatusLabel(
  t: TFunction,
  status: TeamCardStatus,
  running: number,
): string {
  switch (status) {
    case "running":
      return t("team.runningStatus", { count: running });
    case "settings-disabled":
      return t("team.disabledInSettings");
    case "model-unavailable":
      return t("team.modelUnavailable");
    case "on":
      return t("team.ready");
    case "off":
      return t("team.memberOff");
  }
}

/** A member's state, including whether the model it launches with is reachable. */
export function useTeamCardStatus(card: TeamRosterCard): TeamCardStatus {
  const providers = useAppStore((state) => state.providers);
  return teamCardStatus(card, teamPinUnavailable(card.effective.model, providers));
}

/**
 * One member card: what the role is, the model this session launches it with,
 * its reasoning level and write capability, and the session switch. The card
 * surface itself opens the settings sheet, so the row needs no second button;
 * the switch and the model chooser sit above that entry point and keep their
 * own presses.
 */
export function TeamMemberCard({
  card,
  saving,
  onToggle,
  onModelChange,
  onOpen,
}: {
  card: TeamRosterCard;
  saving: boolean;
  onToggle: (on: boolean) => void;
  onModelChange: (pin: SubagentModelPin | null) => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const status = useTeamCardStatus(card);
  const description = card.entry.definition.description?.trim() ?? "";
  const thinking = card.effective.thinkingLevel;
  const openLabel = t("team.openMemberSettings", { name: card.handle });

  return (
    <div
      className={cx(
        "team-member-tile",
        card.running > 0 && "is-running",
        !card.settingsEnabled && "is-settings-disabled",
        status === "model-unavailable" && "is-model-unavailable",
      )}
    >
      <button
        type="button"
        className="team-member-open-sheet"
        aria-haspopup="dialog"
        aria-label={openLabel}
        title={openLabel}
        onClick={onOpen}
      />
      <div className="team-member-head">
        <span className={cx("team-member-dot", `is-${status}`)} aria-hidden="true" />
        <span className="team-member-name">{card.handle}</span>
        {card.running > 0 ? (
          <Badge tone="success" className="team-member-running">
            {t("team.runningStatus", { count: card.running })}
          </Badge>
        ) : null}
      </div>
      {description ? <p className="team-member-description">{description}</p> : null}
      <div className="team-member-meta">
        <span className={cx("team-member-access", card.canMutate && "is-write")}>
          {card.canMutate ? t("team.writeAccess") : t("team.readOnly")}
        </span>
        {thinking ? (
          <span className="team-member-thinking">
            {t("extensions.subagents.thinking")}: {thinking}
          </span>
        ) : null}
        {card.hasSettings ? (
          <Badge className="team-member-modified">{t("team.modified")}</Badge>
        ) : null}
        {!card.settingsEnabled ? (
          <span className="team-member-disabled">{t("team.disabledInSettings")}</span>
        ) : null}
      </div>
      <div className="team-member-model">
        <TeamModelSelect
          className="team-member-model-select"
          pin={card.member?.model}
          roleModel={card.entry.definition.model}
          disabled={saving || !card.settingsEnabled}
          ariaLabel={t("team.memberModel", { name: card.handle })}
          onChange={onModelChange}
        />
      </div>
      <SettingsToggle
        className="team-member-switch"
        checked={card.on}
        label={t("team.useMember", { name: card.handle })}
        disabled={saving || !card.settingsEnabled}
        onChange={() => onToggle(!card.on)}
      />
      <span className="sr-only">{teamStatusLabel(t, status, card.running)}</span>
    </div>
  );
}
