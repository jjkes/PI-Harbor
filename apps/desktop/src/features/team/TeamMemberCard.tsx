import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { IconEye, IconPencil } from "../../components/icons";
import { Badge, SettingsToggle, TooltipButton, cx } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { teamPinUnavailable } from "./TeamMemberOverrides";
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
 * A compact member row. The shared switch covers the row so any non-pencil
 * press toggles the member; the pencil remains a separate settings-sheet button.
 */
export function TeamMemberCard({
  card,
  saving,
  onToggle,
  onOpen,
}: {
  card: TeamRosterCard;
  saving: boolean;
  onToggle: (on: boolean) => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const status = useTeamCardStatus(card);
  const AccessIcon = card.canMutate ? IconPencil : IconEye;
  const details = [
    teamStatusLabel(t, status, card.running),
    card.canMutate ? t("team.writeAccess") : t("team.readOnly"),
    ...(card.hasSettings ? [t("team.modifiedForSession")] : []),
  ];
  const openLabel = t("team.openMemberSettings", { name: card.handle });

  return (
    <div
      className={cx(
        "team-member-tile",
        card.running > 0 && "is-running",
        !card.settingsEnabled && "is-settings-disabled",
      )}
      title={details.join(" · ")}
    >
      <SettingsToggle
        className="team-member-open"
        checked={card.on}
        label={t("team.useMember", { name: card.handle })}
        disabled={saving || !card.settingsEnabled}
        onChange={() => onToggle(!card.on)}
      />
      <div className="team-member-row-content">
        <span className={cx("team-member-dot", `is-${status}`)} aria-hidden="true" />
        <span className="team-member-name">{card.handle}</span>
        {card.running > 0 ? (
          <Badge tone="success" className="team-member-running">
            {t("team.runningCount", { count: card.running })}
          </Badge>
        ) : null}
        {!card.settingsEnabled ? (
          <span className="team-member-disabled">{t("team.disabledInSettings")}</span>
        ) : null}
        <AccessIcon
          size={12}
          aria-hidden="true"
          className={cx("team-member-access", card.canMutate && "is-write")}
        />
        <span className="sr-only">
          {card.canMutate ? t("team.writeAccess") : t("team.readOnly")}
        </span>
        {card.hasSettings ? (
          <span className="team-member-modified" title={t("team.modifiedForSession")}>
            <span className="team-member-modified-dot" aria-hidden="true" />
            <span className="sr-only">{t("team.modifiedForSession")}</span>
          </span>
        ) : null}
      </div>
      <TooltipButton
        type="button"
        className="team-member-edit"
        tooltip={openLabel}
        ariaLabel={openLabel}
        aria-haspopup="dialog"
        onClick={onOpen}
      >
        <IconPencil size={13} aria-hidden="true" />
      </TooltipButton>
    </div>
  );
}
