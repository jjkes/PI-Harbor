/**
 * Pure layout math for Team mode's split view inside MainChat. The Team panel
 * sits beside the complete conversation column (transcript and composer); it
 * is separate from, and does not participate in, sidebar/work-panel budgeting.
 * Those outer layouts supply the available MainChat width used here.
 *
 * The preferred panel width belongs to the caller. Inline clamping and collapse
 * are derived presentation only: never persist a returned panelWidth over the
 * user's preference, so the preference can be restored when space returns.
 */
export const TEAM_PANEL_DEFAULT_WIDTH = 320;
export const TEAM_PANEL_MIN_WIDTH = 260;
export const TEAM_PANEL_RAIL_WIDTH = 44;
export const TEAM_CONVERSATION_MIN_WIDTH = 450;
export const TEAM_SEPARATOR_WIDTH = 6;
export const TEAM_PANEL_KEYBOARD_STEP = 16;

export const TEAM_INLINE_MIN_MAIN_CHAT_WIDTH =
  TEAM_CONVERSATION_MIN_WIDTH +
  TEAM_PANEL_MIN_WIDTH +
  TEAM_SEPARATOR_WIDTH;
export const TEAM_RAIL_MIN_MAIN_CHAT_WIDTH =
  TEAM_CONVERSATION_MIN_WIDTH +
  TEAM_PANEL_RAIL_WIDTH +
  TEAM_SEPARATOR_WIDTH;

export type TeamLayoutPresentation = "inline" | "rail" | "hidden";

export type TeamLayoutModel = {
  presentation: TeamLayoutPresentation;
  /** Rendered Team width: clamped inline, 44px as a rail, or zero when hidden. */
  panelWidth: number;
  /** Width left for the complete transcript-and-composer conversation column. */
  conversationWidth: number;
  /** No separator participates in the budget while the panel is hidden. */
  separatorWidth: number;
  /** True when the topbar must reveal the hidden panel as an overlay drawer. */
  overlay: boolean;
};

export type TeamPanelPointerGesture = {
  startClientX: number;
  startWidth: number;
};

function safeMainChatWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, width) : 0;
}

function normalizePreferredWidth(width: number): number {
  return Number.isFinite(width)
    ? Math.max(TEAM_PANEL_MIN_WIDTH, width)
    : TEAM_PANEL_DEFAULT_WIDTH;
}

/** Maximum inline panel width that preserves the conversation and separator. */
export function teamPanelInlineMaxWidth(mainChatWidth: number): number {
  return Math.max(
    0,
    safeMainChatWidth(mainChatWidth) -
      TEAM_CONVERSATION_MIN_WIDTH -
      TEAM_SEPARATOR_WIDTH,
  );
}

/**
 * Clamp a width for an inline budget. If inline mode cannot fit, return the
 * normalized preference unchanged: a rail/hidden collapse must not rewrite it.
 */
export function clampTeamPanelWidth(
  preferredPanelWidth: number,
  mainChatWidth: number,
): number {
  const preferred = normalizePreferredWidth(preferredPanelWidth);
  const maximum = teamPanelInlineMaxWidth(mainChatWidth);
  return maximum >= TEAM_PANEL_MIN_WIDTH
    ? Math.min(preferred, maximum)
    : preferred;
}

/** Apply a pointer or keyboard delta without ever producing an unsafe width. */
export function resizeTeamPanelWidth(
  preferredPanelWidth: number,
  delta: number,
  mainChatWidth: number,
): number {
  const movement = Number.isFinite(delta) ? delta : 0;
  return clampTeamPanelWidth(
    normalizePreferredWidth(preferredPanelWidth) + movement,
    mainChatWidth,
  );
}

/** The panel is left of the conversation, so dragging right grows it. */
export function teamPanelWidthFromPointer(
  gesture: TeamPanelPointerGesture,
  clientX: number,
  mainChatWidth: number,
): number {
  return resizeTeamPanelWidth(
    gesture.startWidth,
    clientX - gesture.startClientX,
    mainChatWidth,
  );
}

/** Arrow keys resize by 16px; other keys leave the preference unchanged. */
export function teamPanelWidthFromKeyboard(
  preferredPanelWidth: number,
  key: string,
  mainChatWidth: number,
): number {
  if (key !== "ArrowLeft" && key !== "ArrowRight") {
    return normalizePreferredWidth(preferredPanelWidth);
  }
  return resizeTeamPanelWidth(
    preferredPanelWidth,
    key === "ArrowRight"
      ? TEAM_PANEL_KEYBOARD_STEP
      : -TEAM_PANEL_KEYBOARD_STEP,
    mainChatWidth,
  );
}

/**
 * Resolve the deterministic collapse ladder. Exact thresholds fit. Below the
 * rail threshold the in-flow panel and separator disappear; an overlay can
 * still be opened from the topbar without reducing the conversation width.
 */
export function resolveTeamLayout(
  mainChatWidth: number,
  preferredPanelWidth = TEAM_PANEL_DEFAULT_WIDTH,
): TeamLayoutModel {
  const available = safeMainChatWidth(mainChatWidth);

  if (available >= TEAM_INLINE_MIN_MAIN_CHAT_WIDTH) {
    const panelWidth = clampTeamPanelWidth(preferredPanelWidth, available);
    return {
      presentation: "inline",
      panelWidth,
      conversationWidth: Math.max(
        TEAM_CONVERSATION_MIN_WIDTH,
        available - panelWidth - TEAM_SEPARATOR_WIDTH,
      ),
      separatorWidth: TEAM_SEPARATOR_WIDTH,
      overlay: false,
    };
  }

  if (available >= TEAM_RAIL_MIN_MAIN_CHAT_WIDTH) {
    return {
      presentation: "rail",
      panelWidth: TEAM_PANEL_RAIL_WIDTH,
      conversationWidth: Math.max(
        TEAM_CONVERSATION_MIN_WIDTH,
        available - TEAM_PANEL_RAIL_WIDTH - TEAM_SEPARATOR_WIDTH,
      ),
      separatorWidth: TEAM_SEPARATOR_WIDTH,
      overlay: false,
    };
  }

  return {
    presentation: "hidden",
    panelWidth: 0,
    conversationWidth: available,
    separatorWidth: 0,
    overlay: true,
  };
}
