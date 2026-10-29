import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { IconWorkflow, IconX } from "../../components/icons";
import { OverlayBackdrop, TooltipButton } from "../../components/ui";
import { TeamPanel, type TeamPanelProps } from "./TeamPanel";
import { containTabFocus } from "./team-focus";
import {
  TEAM_PANEL_RAIL_WIDTH,
  resolveTeamLayout,
  teamPanelInlineMaxWidth,
  teamPanelWidthFromKeyboard,
  teamPanelWidthFromPointer,
  type TeamPanelPointerGesture,
} from "./team-layout-model";
import { useTeamLayoutStore } from "./team-layout-store";
import "./team-layout.css";

export type TeamLayoutProps = TeamPanelProps & {
  children: ReactNode;
};

/** Team's own MainChat split; sidebar and work-panel budgets stay outside it. */
export function TeamLayout({
  session,
  messages,
  isRunning,
  children,
}: TeamLayoutProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<(TeamPanelPointerGesture & { pointerId: number }) | null>(null);
  const [mainChatWidth, setMainChatWidth] = useState(0);
  const preferredWidth = useTeamLayoutStore((state) => state.preferredWidth);
  const setPreferredWidth = useTeamLayoutStore((state) => state.setPreferredWidth);
  const openOverlay = useTeamLayoutStore((state) => state.openOverlay);
  const closeOverlay = useTeamLayoutStore((state) => state.closeOverlay);
  const setPresentation = useTeamLayoutStore((state) => state.setPresentation);
  const consumeReveal = useTeamLayoutStore((state) => state.consumeReveal);
  const overlayOpen = useTeamLayoutStore(
    (state) => state.overlaySessionId === session.id,
  );
  const revealPending = useTeamLayoutStore(
    (state) => state.revealSessionId === session.id,
  );

  // This is the real MainChat client box after the outer shell has funded its
  // own columns. Window width would make the collapse thresholds incorrect.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setMainChatWidth(Math.round(root.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () => resolveTeamLayout(mainChatWidth, preferredWidth),
    [mainChatWidth, preferredWidth],
  );
  const overlayVisible = overlayOpen && layout.presentation !== "inline";

  useEffect(() => {
    setPresentation(session.id, layout.presentation);
  }, [layout.presentation, session.id, setPresentation]);

  // Switching Team on from the composer or the shortcut shows the view once:
  // an inline split already does, and a narrower layout opens the drawer. The
  // first render has no measured width, so the request waits for one.
  useEffect(() => {
    if (!revealPending || mainChatWidth <= 0) return;
    consumeReveal(session.id, layout.presentation);
  }, [consumeReveal, layout.presentation, mainChatWidth, revealPending, session.id]);

  // Session changes and Team disable both unmount or re-target this layout.
  // Neither may leave a drawer armed for a later visit.
  useEffect(() => {
    return () => closeOverlay(session.id);
  }, [closeOverlay, session.id]);

  const closeDrawer = useCallback(
    () => closeOverlay(session.id),
    [closeOverlay, session.id],
  );

  // The drawer is a true modal layer: Escape is claimed before global shortcuts,
  // Tab cannot reach the covered conversation, and closing restores the opener.
  useEffect(() => {
    if (!overlayVisible) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeDrawer();
        return;
      }
      if (event.key !== "Tab") return;
      const root = dialogRef.current;
      if (root) containTabFocus(event, root);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [closeDrawer, overlayVisible]);

  const beginPointerResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || layout.presentation !== "inline") return;
    event.preventDefault();
    event.currentTarget.focus();
    gestureRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startWidth: layout.panelWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePointerResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    setPreferredWidth(
      teamPanelWidthFromPointer(gesture, event.clientX, mainChatWidth),
    );
  };
  const endPointerResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const resizeFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setPreferredWidth(
      teamPanelWidthFromKeyboard(layout.panelWidth, event.key, mainChatWidth),
    );
  };

  const panel = (
    <TeamPanel session={session} messages={messages} isRunning={isRunning} />
  );
  const revealOverlay = () => openOverlay(session.id);

  return (
    <div
      ref={rootRef}
      className="team-layout"
      data-team-presentation={layout.presentation}
    >
      {layout.presentation === "inline" ? (
        <div
          className="team-layout-inline-panel"
          style={{ width: layout.panelWidth, flexBasis: layout.panelWidth }}
        >
          {panel}
        </div>
      ) : layout.presentation === "rail" ? (
        <div
          className="team-layout-rail"
          style={{ width: TEAM_PANEL_RAIL_WIDTH, flexBasis: TEAM_PANEL_RAIL_WIDTH }}
          aria-label={t("team.title")}
        >
          <TooltipButton
            type="button"
            className="team-layout-rail-button"
            tooltip={t("team.openPanel")}
            ariaLabel={t("team.openPanel")}
            aria-controls="team-panel-overlay"
            aria-expanded={overlayVisible}
            onClick={revealOverlay}
          >
            <IconWorkflow size={18} />
          </TooltipButton>
        </div>
      ) : null}

      {layout.presentation !== "hidden" ? (
        layout.presentation === "inline" ? (
          <div
            className="team-layout-separator"
            role="separator"
            aria-label={t("team.resizePanel")}
            aria-orientation="vertical"
            aria-valuemin={260}
            aria-valuemax={teamPanelInlineMaxWidth(mainChatWidth)}
            aria-valuenow={layout.panelWidth}
            aria-valuetext={t("team.panelWidth", { width: layout.panelWidth })}
            tabIndex={0}
            onPointerDown={beginPointerResize}
            onPointerMove={movePointerResize}
            onPointerUp={endPointerResize}
            onPointerCancel={endPointerResize}
            onLostPointerCapture={() => { gestureRef.current = null; }}
            onKeyDown={resizeFromKeyboard}
          />
        ) : (
          <div className="team-layout-separator team-layout-rail-separator" aria-hidden />
        )
      ) : null}

      <div className="team-layout-conversation">{children}</div>

      {overlayVisible ? (
        <div className="team-layout-overlay">
          <OverlayBackdrop
            className="team-layout-overlay-backdrop"
            aria-hidden
            onClick={closeDrawer}
          />
          <div
            ref={dialogRef}
            id="team-panel-overlay"
            className="team-layout-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="team-panel-overlay-title"
            tabIndex={-1}
            style={{ "--team-drawer-width": `${preferredWidth}px` } as CSSProperties}
          >
            <div className="team-layout-drawer-head">
              <h2 id="team-panel-overlay-title">{t("team.title")}</h2>
              <TooltipButton
                type="button"
                className="team-layout-drawer-close"
                tooltip={t("team.closePanel")}
                ariaLabel={t("team.closePanel")}
                onClick={closeDrawer}
              >
                <IconX size={15} />
              </TooltipButton>
            </div>
            <div className="team-layout-drawer-body">{panel}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
