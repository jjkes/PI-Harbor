import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  TEAM_CONVERSATION_MIN_WIDTH,
  TEAM_INLINE_MIN_MAIN_CHAT_WIDTH,
  TEAM_PANEL_DEFAULT_WIDTH,
  TEAM_PANEL_KEYBOARD_STEP,
  TEAM_PANEL_MIN_WIDTH,
  TEAM_PANEL_RAIL_WIDTH,
  TEAM_RAIL_MIN_MAIN_CHAT_WIDTH,
  TEAM_SEPARATOR_WIDTH,
  clampTeamPanelWidth,
  resizeTeamPanelWidth,
  resolveTeamLayout,
  teamPanelInlineMaxWidth,
  teamPanelWidthFromKeyboard,
  teamPanelWidthFromPointer,
} = await import("../src/features/team/team-layout-model.ts");

test("uses the specified constants and the default inline panel on a wide MainChat", () => {
  assert.equal(TEAM_PANEL_DEFAULT_WIDTH, 320);
  assert.equal(TEAM_PANEL_MIN_WIDTH, 260);
  assert.equal(TEAM_PANEL_RAIL_WIDTH, 44);
  assert.equal(TEAM_CONVERSATION_MIN_WIDTH, 450);
  assert.equal(TEAM_SEPARATOR_WIDTH, 6);
  assert.equal(TEAM_PANEL_KEYBOARD_STEP, 16);
  assert.equal(TEAM_INLINE_MIN_MAIN_CHAT_WIDTH, 716);
  assert.equal(TEAM_RAIL_MIN_MAIN_CHAT_WIDTH, 500);

  assert.deepEqual(resolveTeamLayout(1200), {
    presentation: "inline",
    panelWidth: 320,
    conversationWidth: 874,
    separatorWidth: 6,
    overlay: false,
  });
});

test("fits inline at the exact threshold and clamps to the 450px conversation floor", () => {
  assert.deepEqual(resolveTeamLayout(TEAM_INLINE_MIN_MAIN_CHAT_WIDTH, 500), {
    presentation: "inline",
    panelWidth: TEAM_PANEL_MIN_WIDTH,
    conversationWidth: TEAM_CONVERSATION_MIN_WIDTH,
    separatorWidth: TEAM_SEPARATOR_WIDTH,
    overlay: false,
  });

  const clamped = resolveTeamLayout(800, 500);
  assert.equal(clamped.presentation, "inline");
  assert.equal(clamped.panelWidth, 344);
  assert.equal(clamped.conversationWidth, 450);
  assert.equal(
    clamped.panelWidth + clamped.conversationWidth + clamped.separatorWidth,
    800,
  );
});

test("uses a 44px rail below the inline threshold, including exact rail fit", () => {
  for (const width of [
    TEAM_INLINE_MIN_MAIN_CHAT_WIDTH - 1,
    TEAM_RAIL_MIN_MAIN_CHAT_WIDTH,
  ]) {
    const layout = resolveTeamLayout(width, 420);
    assert.equal(layout.presentation, "rail");
    assert.equal(layout.panelWidth, 44);
    assert.equal(layout.separatorWidth, 6);
    assert.equal(layout.overlay, false);
    assert.ok(layout.conversationWidth >= 450);
  }
  assert.equal(resolveTeamLayout(500).conversationWidth, 450);
  assert.equal(resolveTeamLayout(715).conversationWidth, 665);
});

test("hides the in-flow panel and enables overlay below the rail threshold", () => {
  assert.deepEqual(resolveTeamLayout(TEAM_RAIL_MIN_MAIN_CHAT_WIDTH - 1), {
    presentation: "hidden",
    panelWidth: 0,
    conversationWidth: 499,
    separatorWidth: 0,
    overlay: true,
  });
});

test("handles NaN, infinite, negative, zero and tiny MainChat widths safely", () => {
  for (const width of [Number.NaN, Number.POSITIVE_INFINITY, -20, 0]) {
    assert.deepEqual(resolveTeamLayout(width), {
      presentation: "hidden",
      panelWidth: 0,
      conversationWidth: 0,
      separatorWidth: 0,
      overlay: true,
    });
  }

  const tiny = resolveTeamLayout(0.25);
  assert.equal(tiny.presentation, "hidden");
  assert.equal(tiny.conversationWidth, 0.25);
  assert.equal(teamPanelInlineMaxWidth(Number.NaN), 0);
  assert.equal(teamPanelInlineMaxWidth(0.25), 0);
});

test("normalizes invalid preferred widths without producing NaN layout values", () => {
  assert.equal(resolveTeamLayout(1200, Number.NaN).panelWidth, 320);
  assert.equal(resolveTeamLayout(1200, Number.POSITIVE_INFINITY).panelWidth, 320);
  assert.equal(resolveTeamLayout(1200, 0).panelWidth, 260);
  assert.equal(resolveTeamLayout(1200, -100).panelWidth, 260);
});

test("clamps pointer and direct resize deltas to inline bounds", () => {
  assert.equal(teamPanelInlineMaxWidth(800), 344);
  assert.equal(clampTeamPanelWidth(500, 800), 344);
  assert.equal(resizeTeamPanelWidth(320, 1000, 800), 344);
  assert.equal(resizeTeamPanelWidth(320, -1000, 1200), 260);
  assert.equal(resizeTeamPanelWidth(320, Number.NaN, 1200), 320);

  assert.equal(
    teamPanelWidthFromPointer(
      { startWidth: 320, startClientX: 100 },
      147,
      1200,
    ),
    367,
  );
  assert.equal(
    teamPanelWidthFromPointer(
      { startWidth: 320, startClientX: 100 },
      -500,
      1200,
    ),
    260,
  );
  assert.equal(
    teamPanelWidthFromPointer(
      { startWidth: 320, startClientX: 100 },
      Number.NaN,
      1200,
    ),
    320,
  );
});

test("keyboard resizing uses 16px steps and ignores unrelated keys", () => {
  assert.equal(teamPanelWidthFromKeyboard(320, "ArrowRight", 1200), 336);
  assert.equal(teamPanelWidthFromKeyboard(320, "ArrowLeft", 1200), 304);
  assert.equal(teamPanelWidthFromKeyboard(260, "ArrowLeft", 1200), 260);
  assert.equal(teamPanelWidthFromKeyboard(340, "ArrowRight", 800), 344);
  assert.equal(teamPanelWidthFromKeyboard(500, "Home", 800), 500);
});

test("collapse and temporary inline clamping never consume the preferred width", () => {
  const preferredWidth = 420;

  assert.equal(resolveTeamLayout(800, preferredWidth).panelWidth, 344);
  assert.equal(resolveTeamLayout(700, preferredWidth).presentation, "rail");
  assert.equal(resolveTeamLayout(400, preferredWidth).presentation, "hidden");
  assert.equal(clampTeamPanelWidth(preferredWidth, 400), preferredWidth);
  assert.equal(clampTeamPanelWidth(preferredWidth, 0), preferredWidth);
  assert.equal(clampTeamPanelWidth(preferredWidth, Number.NaN), preferredWidth);

  const restored = resolveTeamLayout(1200, preferredWidth);
  assert.equal(restored.presentation, "inline");
  assert.equal(restored.panelWidth, preferredWidth);
  assert.equal(restored.conversationWidth, 774);
});
