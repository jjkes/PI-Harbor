import { useId, type Dispatch, type SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { Mode } from "@pi-harbor/shared";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { TooltipButton, cx } from "../../../components/ui";
import { IconCheck, IconChevronDown } from "../../../components/icons";
import type { ComposerTeamMode } from "../../team/useComposerTeamMode";
import { ModeIcon } from "./ComposerModeIcon";
import { MODE_CYCLE, MODE_LABEL_KEYS } from "./model";

/**
 * Operating mode as a compact chip that opens one menu.
 *
 * The chip only ever names the committed mode, so the toolbar keeps the width
 * of a single label; the other two modes are one menu away instead of one
 * cycle-click away. Team is a separate switch below the modes: it combines
 * with any of them, and the chip only adds a small badge while it is on.
 */
export function ComposerModePicker({
  t,
  mode,
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
  planningLive: boolean;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  controlsBlocked: boolean;
  onCloseOtherMenus: () => void;
  onSelect: (mode: Mode) => void | Promise<void>;
  /** Team switch for the current session; omitted or `hidden` shows no item. */
  team?: ComposerTeamMode;
}) {
  const label = t(MODE_LABEL_KEYS[mode]);
  const teamOn = team?.enabled === true;
  const modeName = teamOn ? t("team.modeWithTeam", { mode: label }) : label;
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
          data-mode={mode}
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
          <span className="composer-mode-chip-face" key={mode}>
            <ModeIcon mode={mode} />
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
        <button
          key={candidate}
          type="button"
          role="menuitemradio"
          aria-checked={mode === candidate}
          disabled={controlsBlocked}
          className={`composer-plus-item ${mode === candidate ? "active" : ""}`}
          onClick={async () => {
            setOpen(false);
            await onSelect(candidate);
          }}
        >
          <span className="flex-1 text-left">{t(MODE_LABEL_KEYS[candidate])}</span>
          {mode === candidate ? <IconCheck size={13} /> : null}
        </button>
      ))}
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

/**
 * Team in the mode menu: a checkbox item next to the mode radios. Before the
 * first message there is no session to switch, so the item explains why it
 * is unavailable.
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
  const hintId = useId();
  const draft = team.availability === "draft";
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={team.enabled}
      aria-label={t("team.title")}
      aria-describedby={draft ? hintId : undefined}
      disabled={disabled || draft || team.saving}
      className={cx("composer-plus-item composer-team-item", team.enabled && "active")}
      onClick={() => {
        onDone();
        team.toggle();
      }}
    >
      <span className="composer-team-item-copy">
        <span>{t("team.title")}</span>
        {draft ? (
          <span id={hintId} className="composer-team-item-hint">
            {t("team.availableAfterFirstMessage")}
          </span>
        ) : null}
      </span>
      {team.shortcutLabel ? (
        <kbd className="composer-team-item-shortcut">{team.shortcutLabel}</kbd>
      ) : null}
      {team.enabled ? <IconCheck size={13} /> : null}
    </button>
  );
}
