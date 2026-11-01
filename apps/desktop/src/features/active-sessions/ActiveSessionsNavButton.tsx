import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { IconActivity } from "../../components/icons";
import { TooltipButton, cx } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { selectActiveSessions } from "./active-sessions-model";
import "./active-sessions.css";

/** Sidebar footer entry for the Active sessions page, with a live count. */
export function ActiveSessionsNavButton() {
  const { t } = useTranslation();
  const page = useAppStore((state) => state.page);
  const sessions = useAppStore((state) => state.sessions);
  const runningSessions = useAppStore((state) => state.runningSessions);
  const pendingPermissions = useAppStore((state) => state.pendingPermissions);
  const setPage = useAppStore((state) => state.setPage);
  const canNavBack = useAppStore((state) => state.canNavBack);
  const navBack = useAppStore((state) => state.navBack);
  const count = useMemo(
    () => selectActiveSessions({ sessions, runningSessions, pendingPermissions }).length,
    [sessions, runningSessions, pendingPermissions],
  );
  const active = page === "activeSessions";
  const label =
    count > 0 ? t("activeSessions.navLabelCount", { count }) : t("activeSessions.title");

  return (
    <TooltipButton
      type="button"
      className={cx("footer-action active-sessions-nav", active && "active")}
      data-nav="active-sessions"
      tooltip={label}
      ariaLabel={label}
      aria-pressed={active}
      onClick={() => {
        // A second activation returns where the user came from, like Plugins.
        if (!active) setPage("activeSessions");
        else if (canNavBack()) navBack();
        else setPage("chat");
      }}
    >
      <IconActivity size={14} aria-hidden />
      {count > 0 ? (
        <span className="active-sessions-nav-badge" aria-hidden>
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </TooltipButton>
  );
}
