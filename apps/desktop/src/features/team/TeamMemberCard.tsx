import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { IconEye, IconPencil } from "../../components/icons";
import { SettingsToggle, cx } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { teamPinUnavailable } from "./TeamMemberOverrides";
import {
  teamCardStatus,
  type TeamCardStatus,
  type TeamRosterCard,
} from "./team-roster-model";

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
 * A compact member tile. The name opens the member sheet and the switch is the
 * card's only control. A role switched off in Settings stays listed, dimmed,
 * with its switch disabled.
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
  const detailsId = useId();
  const status = useTeamCardStatus(card);
  const details = [
    teamStatusLabel(t, status, card.running),
    card.canMutate ? t("team.writeAccess") : t("team.readOnly"),
    ...(card.hasSettings ? [t("team.modifiedForSession")] : []),
  ];
  const AccessIcon = card.canMutate ? IconPencil : IconEye;

  return (
    <div
      className={cx(
        "team-member-tile",
        card.running > 0 && "is-running",
        !card.settingsEnabled && "is-settings-disabled",
      )}
    >
      <button
        type="button"
        className="team-member-open"
        aria-haspopup="dialog"
        aria-describedby={detailsId}
        title={[card.handle, ...details].join(" · ")}
        onClick={onOpen}
      >
        <span className={cx("team-member-dot", `is-${status}`)} aria-hidden="true" />
        <span className="team-member-name">{card.handle}</span>
        {card.hasSettings ? (
          <span className="team-member-modified-dot" aria-hidden="true" />
        ) : null}
        <AccessIcon
          size={12}
          aria-hidden="true"
          className={cx("team-member-access", card.canMutate && "is-write")}
        />
      </button>
      <span id={detailsId} className="team-sr-only">
        {details.join(". ")}
      </span>
      <SettingsToggle
        className="team-member-switch"
        checked={card.on}
        label={t("team.useMember", { name: card.handle })}
        disabled={saving || !card.settingsEnabled}
        onChange={() => onToggle(!card.on)}
      />
    </div>
  );
}
