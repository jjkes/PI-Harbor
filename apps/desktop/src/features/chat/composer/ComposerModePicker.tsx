import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { Mode } from "@pi-harbor/shared";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { TooltipButton, cx } from "../../../components/ui";
import { IconCheck, IconChevronDown } from "../../../components/icons";
import type { ComposerTeamMode } from "../../team/useComposerTeamMode";
import type { ComposerModeChoice } from "../../plan-debate/debate-mode";
import { ModeIcon } from "./ComposerModeIcon";
import { MODE_CYCLE, MODE_LABEL_KEYS } from "./model";

const CHOICE_LABEL_KEYS: Record<ComposerModeChoice, string> = {
  ...MODE_LABEL_KEYS,
  debate: "planning.debateMode",
};

/**
 * Operating mode as a compact chip that opens one menu.
 *
 * The chip only ever names the committed mode, so the toolbar keeps the width
 * of a single label; the modes the menu offers are one click away instead of
 * one cycle-click away. Planning, Goal, and Agent are session modes; the debate
 * is the fourth choice and its own state — planning and the debate are
 * different contracts, so choosing one never claims the other. Team is a
 * separate switch below them: it combines with any choice, and the chip only
 * adds a small badge while it is on.
 */
export function ComposerModePicker({
  t,
  mode,
  debateMode,
  planningLive,
  open,
  setOpen,
  controlsBlocked,
  onCloseOtherMenus,
  onSelect,
  team,
}: {
  t: TFunction;
  mode: Mode;
  /** The debate surface is on: the session is still Agent, the chip says Debate. */
  debateMode: boolean;
  planningLive: boolean;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  controlsBlocked: boolean;
  onCloseOtherMenus: () => void;
  onSelect: (choice: ComposerModeChoice) => void | Promise<void>;
  /** Team switch for the current session; omitted or `hidden` shows no item. */
  team?: ComposerTeamMode;
}) {
  const choice: ComposerModeChoice = debateMode ? "debate" : mode;
  const label = t(CHOICE_LABEL_KEYS[choice]);
  const teamOn = team?.enabled === true;
  const modeName = teamOn ? t("team.modeWithTeam", { mode: label }) : label;
  const choose = async (candidate: ComposerModeChoice) => {
    setOpen(false);
    await onSelect(candidate);
  };
  return (
    <AnchoredMenu
      className="composer-mode"
      open={open}
      onClose={() => setOpen(false)}
      menuClassName="composer-mode-menu"
      label={t("settings.mode")}
      role="menu"
      align="start"
      side="top"
      trigger={(ref) => (
        <TooltipButton
          ref={ref}
          type="button"
          className={`icon-btn mode-chip composer-mode-chip ${open ? "active" : ""}`}
          data-mode={choice}
          data-planning={planningLive ? "true" : undefined}
          data-team={teamOn ? "true" : undefined}
          tooltip={planningLive ? t(`${mode}.planning`) : t("settings.mode")}
          ariaLabel={
            planningLive
              ? `${t("settings.mode")}: ${modeName}. ${t(`${mode}.planning`)}`
              : `${t("settings.mode")}: ${modeName}`
          }
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={controlsBlocked}
          onClick={() => {
            onCloseOtherMenus();
            setOpen((current) => !current);
          }}
        >
          <span className="composer-mode-chip-face" key={choice}>
            <ModeIcon mode={choice} />
            <span className="composer-mode-chip-label text-sm">{label}</span>
            {teamOn ? (
              <span className="composer-mode-chip-team" aria-hidden="true">
                {t("team.title")}
              </span>
            ) : null}
          </span>
          <IconChevronDown
            size={12}
            aria-hidden="true"
            className="composer-mode-chip-caret"
          />
        </TooltipButton>
      )}
    >
      {MODE_CYCLE.map((candidate) => (
        <ComposerModeItem
          key={candidate}
          t={t}
          checked={choice === candidate}
          disabled={controlsBlocked}
          labelKey={MODE_LABEL_KEYS[candidate]}
          onChoose={() => void choose(candidate)}
        />
      ))}
      {/* The debate is not a session mode, so it sits after a rule: the four
          entries share one menu, but only the first three configure the
          session, and the read-only planning contract never applies to it. */}
      <div className="composer-menu-separator" role="separator" />
      <ComposerModeItem
        t={t}
        checked={choice === "debate"}
        disabled={controlsBlocked}
        labelKey={CHOICE_LABEL_KEYS.debate}
        onChoose={() => void choose("debate")}
      />
      {team && team.availability !== "hidden" ? (
        <>
          <div className="composer-menu-separator" role="separator" />
          <ComposerTeamModeItem
            t={t}
            team={team}
            disabled={controlsBlocked}
            onDone={() => setOpen(false)}
          />
        </>
      ) : null}
    </AnchoredMenu>
  );
}

/** One choice in the mode menu: a radio, checked when it is the committed one. */
function ComposerModeItem({
  t,
  checked,
  disabled,
  labelKey,
  onChoose,
}: {
  t: TFunction;
  checked: boolean;
  disabled: boolean;
  labelKey: string;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      disabled={disabled}
      className={`composer-plus-item ${checked ? "active" : ""}`}
      onClick={onChoose}
    >
      <span className="flex-1 text-left">{t(labelKey)}</span>
      {checked ? <IconCheck size={13} /> : null}
    </button>
  );
}

/**
 * Team in the mode menu: a checkbox item next to the mode radios. In a draft
 * there is no session to switch yet, so choosing it creates the session first.
 */
export function ComposerTeamModeItem({
  t,
  team,
  disabled,
  onDone,
}: {
  t: TFunction;
  team: ComposerTeamMode;
  disabled: boolean;
  onDone: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={team.enabled}
      aria-label={t("team.title")}
      disabled={disabled || team.saving}
      className={cx("composer-plus-item composer-team-item", team.enabled && "active")}
      onClick={() => {
        onDone();
        team.toggle();
      }}
    >
      <span className="composer-team-item-copy">
        <span>{t("team.title")}</span>
      </span>
      {team.shortcutLabel ? (
        <kbd className="composer-team-item-shortcut">{team.shortcutLabel}</kbd>
      ) : null}
      {team.enabled ? <IconCheck size={13} /> : null}
    </button>
  );
}
