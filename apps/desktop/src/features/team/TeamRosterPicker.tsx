import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SubagentModelPin } from "@pi-harbor/shared";
import type { SessionDelegations } from "../../lib/session-delegations";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import { IconChevronDown } from "../../components/icons";
import { Button } from "../../components/ui";
import { TeamMemberCard } from "./TeamMemberCard";
import { TeamMemberSheet } from "./TeamMemberSheet";
import { TeamModelSelect } from "./TeamModelSelect";
import { membersToToggle, type TeamRosterCard } from "./team-roster-model";
import type { TeamSessionTarget } from "./team-service";
import { useTeamRoster } from "./useTeamRoster";
import "./team-roster-picker.css";

/** Team member selection anchored above the composer dock's Subagent toolbar. */
export function TeamRosterPicker({
  session,
  delegations,
}: {
  session: TeamSessionTarget;
  delegations: SessionDelegations;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // The roster-wide model stays on screen after it is applied, so the header
  // keeps saying what the last bulk choice was instead of snapping back.
  const [batchModel, setBatchModel] = useState<SubagentModelPin | null>(null);
  const membersButtonRef = useRef<HTMLButtonElement | null>(null);
  const {
    cards,
    counts,
    runningTotal,
    loading,
    saving,
    errorText,
    selectedCard,
    openMember,
    closeMember,
    editRole,
    updateMember,
    setAll,
    setAllModels,
    retry,
  } = useTeamRoster(session, delegations);
  const close = useCallback(() => setOpen(false), []);
  const manageRoles = useCallback(() => {
    setOpen(false);
    editRole();
  }, [editRole]);
  const showMember = useCallback((card: TeamRosterCard) => {
    // Close the anchored layer first and give the portaled sheet a stable focus
    // return target: the card itself is about to leave the document.
    setOpen(false);
    membersButtonRef.current?.focus();
    openMember(card.handle);
  }, [openMember]);
  // A roster-wide model needs a member that is on. Applying the same lock twice
  // is a no-op the service already skips, so the control stays usable.
  const anyMemberOn = cards.some((card) => card.on);

  return (
    <>
      <AnchoredMenu
        className="team-roster-picker"
        open={open}
        onClose={close}
        menuClassName="team-roster-picker-menu"
        label={t("team.rosterListLabel")}
        role="dialog"
        side="top"
        trigger={(ref) => (
          <Button
            ref={(node) => {
              ref.current = node;
              membersButtonRef.current = node;
            }}
            type="button"
            size="sm"
            variant="secondary"
            className="team-roster-picker-trigger"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <span>
              {loading
                ? t("team.rosterListLabel")
                : t("team.membersButton", counts)}
            </span>
            <IconChevronDown size={12} aria-hidden="true" />
          </Button>
        )}
      >
        <div className="team-roster-picker-head">
          <div className="team-roster-picker-summary">
            <h2>{t("team.rosterHeading", counts)}</h2>
            {runningTotal > 0 ? (
              <span>{t("team.runningCount", { count: runningTotal })}</span>
            ) : null}
          </div>
          <div className="team-roster-picker-actions">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving || membersToToggle(cards, true).length === 0}
              onClick={() => void setAll(true)}
            >
              {t("team.enableAll")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving || membersToToggle(cards, false).length === 0}
              onClick={() => void setAll(false)}
            >
              {t("team.disableAll")}
            </Button>
          </div>
        </div>
        {cards.length > 0 ? (
          <div className="team-roster-picker-batch">
            <label className="team-roster-picker-batch-label" htmlFor="team-roster-batch-model">
              {t("team.batchModel")}
            </label>
            <TeamModelSelect
              id="team-roster-batch-model"
              className="team-roster-picker-batch-select"
              pin={batchModel ?? undefined}
              disabled={saving || !anyMemberOn}
              ariaLabel={t("team.batchModel")}
              onChange={(pin) => {
                setBatchModel(pin);
                void setAllModels(pin);
              }}
            />
            <span className="team-roster-picker-batch-hint">{t("team.batchModelHint")}</span>
          </div>
        ) : null}
        {errorText ? (
          <div className="team-roster-picker-error" role="alert">
            <span>{errorText}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => void retry()}
            >
              {t("team.retry")}
            </Button>
          </div>
        ) : null}
        <div className="team-roster-picker-body" aria-busy={loading || saving}>
          {loading && !errorText ? (
            <p className="team-roster-picker-empty">{t("common.loading")}</p>
          ) : cards.length === 0 ? (
            <p className="team-roster-picker-empty">{t("team.noDefinitions")}</p>
          ) : (
            <ul className="team-roster-picker-list" role="list" aria-label={t("team.rosterListLabel")}>
              {cards.map((card) => (
                <li key={card.handle}>
                  <TeamMemberCard
                    card={card}
                    saving={saving}
                    onToggle={(on) => void updateMember(card.handle, { enabled: on })}
                    onModelChange={(model) => void updateMember(card.handle, { model })}
                    onOpen={() => showMember(card)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="team-roster-picker-footer">
          <Button type="button" size="sm" variant="ghost" onClick={manageRoles}>
            {t("team.manageRolesInSettings")}
          </Button>
        </div>
      </AnchoredMenu>
      {selectedCard ? (
        <TeamMemberSheet
          key={`${session.id}:${selectedCard.handle}`}
          card={selectedCard}
          saving={saving}
          onUpdate={(patch) => updateMember(selectedCard.handle, patch)}
          onEditRole={manageRoles}
          onClose={closeMember}
        />
      ) : null}
    </>
  );
}
