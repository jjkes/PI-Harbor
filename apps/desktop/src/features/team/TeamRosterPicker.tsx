import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  isTeamGateOn,
  type SubagentCategory,
  type SubagentModelPin,
  type TeamGateKind,
} from "@pi-harbor/shared";
import type { SessionDelegations } from "../../lib/session-delegations";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import { IconChevronDown } from "../../components/icons";
import { Button, Input, SettingsToggle } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { ProjectNormsEditor } from "./ProjectNormsEditor";
import { TeamMemberCard } from "./TeamMemberCard";
import { TeamMemberSheet } from "./TeamMemberSheet";
import { TeamModelSelect } from "./TeamModelSelect";
import {
  filterTeamRosterCards,
  filterTeamRosterCardsByCategory,
  groupByCategory,
  membersToModel,
  membersToToggle,
  teamGateStates,
  teamRosterCategoryChips,
  type TeamRosterCard,
} from "./team-roster-model";
import { teamService, type TeamSessionTarget } from "./team-service";
import { selectTeamSession, useTeamStore } from "./team-store";
import { useTeamRoster } from "./useTeamRoster";
import "./team-roster-picker.css";

/** Switch label of each quality gate, as the i18n catalog names it. */
const GATE_LABEL_KEYS: Record<TeamGateKind, "team.reviewGate" | "team.qaGate"> = {
  review: "team.reviewGate",
  qa: "team.qaGate",
};

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
  // A roster-wide switch reports how many members it moved, so one click has a
  // visible outcome even while the search is hiding the cards underneath.
  const [appliedCount, setAppliedCount] = useState(0);
  // The roster search is presentation only: the cards below it are filtered,
  // but every action still runs against the whole roster.
  const [query, setQuery] = useState("");
  // The category chip is a second filter on the same presentation-only terms:
  // it narrows the cards and leaves both the roster and the typed query alone.
  const [category, setCategory] = useState<SubagentCategory | null>(null);
  const membersButtonRef = useRef<HTMLButtonElement | null>(null);
  const {
    cards,
    counts,
    runningTotal,
    loading,
    gatesReady,
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
  const team = useTeamStore(selectTeamSession(session.id));
  const showToast = useAppStore((state) => state.showToast);
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
  const applyModelToAll = useCallback((pin: SubagentModelPin | null) => {
    setBatchModel(pin);
    // Counted with the same pure selection the write path uses, so the
    // confirmation can never claim a member the service skipped.
    setAppliedCount(membersToModel(cards, pin).length);
    void setAllModels(pin);
  }, [cards, setAllModels]);
  // Search first, then category, then group: what is drawn is the roster
  // narrowed by both filters, and the section counts describe that list.
  const searched = filterTeamRosterCards(cards, query);
  const visibleCards = filterTeamRosterCardsByCategory(searched, category);
  const groups = groupByCategory(visibleCards);
  // Chips count the searched cards, before the category filter: a chip keeps
  // saying how many members it would show while the query stays in effect.
  const categoryChips = teamRosterCategoryChips(searched, category);
  const categoryLabel = (value: SubagentCategory | null) =>
    value === null
      ? t("extensions.subagents.categoryAll")
      : t(`extensions.subagents.category.${value}`);
  const searching = query.trim().length > 0;
  // Gates run a role from the roster that actually launches, and that roster
  // is the members switched on. Resolving against the whole catalog would
  // offer a switch the runtime cannot honour, so a gate whose role is off or
  // absent is switched off here, not hidden.
  const gates = teamGateStates(cards.filter((card) => card.on));
  const gateOn = (gate: TeamGateKind) => isTeamGateOn(team.config ?? undefined, gate);
  const setGate = useCallback(async (gate: TeamGateKind, on: boolean) => {
    try {
      await teamService.setGate(session, gate, on);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  }, [session, showToast]);

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
          {/*
            One click pins every member this session would launch, without
            opening a card. The per-member choosers below stay the way to set a
            single role on its own.
          */}
          {cards.length > 0 ? (
            <div className="team-roster-picker-head-model">
              <label
                className="team-roster-picker-batch-label"
                htmlFor="team-roster-batch-model"
              >
                {t("team.batchModelAll")}
              </label>
              <TeamModelSelect
                id="team-roster-batch-model"
                className="team-roster-picker-batch-select"
                pin={batchModel ?? undefined}
                disabled={saving || !anyMemberOn}
                ariaLabel={t("team.batchModelAll")}
                onChange={applyModelToAll}
              />
            </div>
          ) : null}
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
        {/*
          Quality gates: the checks a delegated round must pass before it can
          close. They sit with the enable/disable-all controls because they
          shape what the roster does, not who is in it.
        */}
        {gates.map((gate) => (
          <div className="team-roster-picker-batch" key={gate.gate}>
            <span className="team-roster-picker-batch-label">{t(GATE_LABEL_KEYS[gate.gate])}</span>
            <SettingsToggle
              checked={gateOn(gate.gate)}
              label={t(GATE_LABEL_KEYS[gate.gate])}
              /*
               * A gate write is queued and re-read by the service, so it only
               * reports progress: blocking the switch on the shared roster
               * `saving` flag is what made one member edit freeze both gates.
               */
              pending={saving}
              disabled={!gatesReady}
              onChange={() => void setGate(gate.gate, !gateOn(gate.gate))}
            />
            {!loading && !gate.available ? (
              <span className="team-roster-picker-batch-hint">
                {t("team.gateRoleMissing", { name: gate.role })}
              </span>
            ) : null}
          </div>
        ))}
        {!loading && gates.every((gate) => gate.available) ? (
          <div className="team-roster-picker-batch">
            <span className="team-roster-picker-batch-hint">{t("team.gateHint")}</span>
          </div>
        ) : null}
        {cards.length > 0 ? (
          <div className="team-roster-picker-batch">
            <span className="team-roster-picker-batch-hint">{t("team.batchModelHint")}</span>
            {/*
              The bulk switch confirms inline: a short live line says how many
              members moved, or that the roster already held that pin.
            */}
            <span className="team-roster-picker-batch-applied" role="status">
              {appliedCount > 0
                ? t("team.batchModelApplied", { count: appliedCount })
                : batchModel
                  ? t("team.batchModelUnchanged")
                  : ""}
            </span>
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
        {cards.length > 0 ? (
          <div className="team-roster-picker-search">
            <Input
              type="search"
              className="team-roster-picker-search-input"
              value={query}
              placeholder={t("extensions.subagents.searchPlaceholder")}
              aria-label={t("extensions.subagents.searchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        ) : null}
        {/*
          Category chips: the coarse role filter. They wrap under the search
          field and stay pressable at every count, so an empty section is a
          visible "0" instead of a chip that vanishes under the pointer.
        */}
        {cards.length > 0 ? (
          <div
            className="team-roster-picker-filters"
            role="group"
            aria-label={t("team.filterCategoryLabel")}
          >
            {categoryChips.map((chip) => (
              <button
                key={chip.category ?? "all"}
                type="button"
                className={`team-roster-picker-chip${chip.active ? " is-active" : ""}`}
                data-team-category={chip.category ?? "all"}
                aria-pressed={chip.active}
                onClick={() => setCategory(chip.category)}
              >
                <span>{categoryLabel(chip.category)}</span>
                <span className="team-roster-picker-chip-count">{chip.count}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="team-roster-picker-body" aria-busy={loading || saving}>
          {loading && !errorText ? (
            <p className="team-roster-picker-empty">{t("common.loading")}</p>
          ) : cards.length === 0 ? (
            <p className="team-roster-picker-empty">{t("team.noDefinitions")}</p>
          ) : visibleCards.length === 0 ? (
            <p className="team-roster-picker-empty">{t("team.noMatch")}</p>
          ) : (
            groups.map((group) => (
              <section
                key={group.category}
                className="team-roster-picker-group"
                aria-label={t(`extensions.subagents.category.${group.category}`)}
              >
                {/* One compact header per big role, with how many members it
                    holds under the current search and category. */}
                <h3 className="team-roster-picker-group-head">
                  <span>{t(`extensions.subagents.category.${group.category}`)}</span>
                  <span className="team-roster-picker-group-count">{group.cards.length}</span>
                </h3>
                <ul className="team-roster-picker-list" role="list">
                  {group.cards.map((card) => (
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
              </section>
            ))
          )}
        </div>
        <ProjectNormsEditor sessionId={session.id} />
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
