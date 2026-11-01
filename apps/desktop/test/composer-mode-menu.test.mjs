import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { composerToolbar } from "./helpers/composer-toolbar.mjs";
import { readComposerModule, readComposerSource } from "./helpers/source-contracts.mjs";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * The operating mode is a compact chip that opens one menu. It used to advance
 * one state per click, so reaching Goal from Agent took two clicks and the two
 * other modes were never on screen; a row of three always-visible options fixed
 * the clicks but cost the toolbar a wide cluster. The chip names the committed
 * mode only, and the menu lists the three modes with their check marks. Team is
 * not a fourth mode: it is a checkbox item under the modes that combines with
 * any of them (ADR 0339), and the chip only adds a badge while it is on.
 */

const modePicker = await readComposerModule("ComposerModePicker.tsx");
const composerSource = await readComposerSource();

async function toolbar(t, overrides = {}) {
  const ssr = await slotSsr(t);
  return (await composerToolbar(t, ssr, overrides))();
}

test("the chip opens a labelled menu instead of cycling", async (t) => {
  const html = await toolbar(t, { mode: "plan" });
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
  // The trigger names the committed mode only: no other mode label in the chip.
  assert.match(html, /class="composer-mode-chip-label text-sm">settings\.modePlan</);
  // Without a session the Team switch is off, so the chip carries no badge.
  assert.doesNotMatch(html, /data-team=/);
  // No state-advancing helper survives: the chip only opens the menu.
  assert.doesNotMatch(composerSource, /\bnextMode\b/);
  assert.match(modePicker, /menuClassName="composer-mode-menu"/);
  assert.match(modePicker, /role="menu"/);
});

test("the menu lists every mode with the committed one checked", () => {
  assert.match(modePicker, /\{MODE_CYCLE\.map\(\(candidate\) => \(/);
  assert.match(modePicker, /role="menuitemradio"/);
  assert.match(modePicker, /aria-checked=\{mode === candidate\}/);
  assert.match(modePicker, /composer-mode-menu/);
});

test("choosing a mode closes the menu and configures the active session once", () => {
  assert.match(
    modePicker,
    /onClick=\{async \(\) => \{\s*\n\s*setOpen\(false\);\s*\n\s*await onSelect\(candidate\);/,
  );
  const toolbarSource = composerSource.slice(
    composerSource.indexOf("<ComposerModePicker"),
    composerSource.indexOf("<ComposerPermissionPicker"),
  );
  assert.match(toolbarSource, /onSelect=\{async \(next\) => \{/);
  assert.match(toolbarSource, /mode: next,/);
});

test("opening one menu closes the other", () => {
  const toolbarSource = composerSource.slice(
    composerSource.indexOf("<ComposerModePicker"),
    composerSource.indexOf('<div className="composer-right">'),
  );
  assert.match(
    toolbarSource,
    /onCloseOtherMenus=\{\(\) => \{\s*\n\s*modelMenu\.setOpen\(false\);\s*\n\s*setPermissionOpen\(false\);/,
  );
  assert.match(
    toolbarSource,
    /onCloseOtherMenus=\{\(\) => \{\s*\n\s*modelMenu\.setOpen\(false\);\s*\n\s*setModeOpen\(false\);/,
  );
  // A blocked composer closes both menus, not just the approval one.
  assert.match(composerSource, /setModeOpen\(false\);\s*\n\s*setPermissionOpen\(false\);/);
});

test("Team is a checkbox item below the modes that runs the shared session switch", () => {
  assert.match(modePicker, /<div className="composer-menu-separator" role="separator" \/>/);
  assert.match(modePicker, /role="menuitemcheckbox"/);
  assert.match(modePicker, /aria-checked=\{team\.enabled\}/);
  assert.match(modePicker, /onClick=\{\(\) => \{\s*\n\s*onDone\(\);\s*\n\s*team\.toggle\(\);/);
  assert.match(modePicker, /team && team\.availability !== "hidden"/);
  assert.match(modePicker, /onDone=\{\(\) => setOpen\(false\)\}/);
  // The toolbar wires the session's switch; Composer.tsx is not involved.
  const toolbarSource = composerSource.slice(
    composerSource.indexOf("<ComposerModePicker"),
    composerSource.indexOf("<ComposerPermissionPicker"),
  );
  assert.match(toolbarSource, /team=\{team\}/);
  assert.match(composerSource, /const team = useComposerTeamMode\(\);/);
});

function teamMode(overrides = {}) {
  return {
    availability: "available",
    enabled: false,
    saving: false,
    shortcutLabel: "⇧⌘T",
    toggle() {},
    ...overrides,
  };
}

test("the Team item and chip reflect the session's switch", async (t) => {
  const ssr = await slotSsr(t);
  const { ComposerModePicker, ComposerTeamModeItem } = await ssr.load(
    "/src/features/chat/composer/ComposerModePicker.tsx",
  );
  const key = (value) => value;
  const item = (team, disabled = false) =>
    ssr.render(createElement(ComposerTeamModeItem, { t: key, team, disabled, onDone() {} }), {
      sessionId: null,
    });

  const off = item(teamMode());
  assert.match(off, /role="menuitemcheckbox" aria-checked="false" aria-label="team\.title"/);
  assert.match(off, /<kbd class="composer-team-item-shortcut">⇧⌘T<\/kbd>/);
  assert.doesNotMatch(off, /disabled=""/);
  assert.doesNotMatch(off, /composer-team-item-hint|aria-describedby|availableAfterFirstMessage/);
  assert.match(
    item(teamMode({ enabled: true })),
    /aria-checked="true"[^>]*class="composer-plus-item composer-team-item active"/,
  );
  assert.match(item(teamMode({ saving: true })), /disabled=""/);
  assert.match(item(teamMode(), true), /disabled=""/);

  const chip = (team) =>
    ssr.render(
      createElement(ComposerModePicker, {
        t: key,
        mode: "agent",
        planningLive: false,
        open: false,
        setOpen() {},
        controlsBlocked: false,
        onCloseOtherMenus() {},
        onSelect() {},
        team,
      }),
      { sessionId: null },
    );
  const teamOn = chip(teamMode({ enabled: true }));
  assert.match(teamOn, /data-team="true"/);
  assert.match(teamOn, /aria-label="settings\.mode: team\.modeWithTeam"/);
  assert.match(teamOn, /class="composer-mode-chip-team" aria-hidden="true">team\.title</);
  const teamOff = chip(teamMode());
  assert.doesNotMatch(teamOff, /data-team=|composer-mode-chip-team/);
  assert.match(teamOff, /aria-label="settings\.mode: settings\.modeAgent"/);
});
