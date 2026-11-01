import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { IconActivity } from "../components/icons";
import { Panel } from "../components/ui";
import { ActiveSessionPane } from "../features/active-sessions/ActiveSessionPane";
import { selectActiveSessions } from "../features/active-sessions/active-sessions-model";
import { useAppStore } from "../stores/app-store";
import "../features/active-sessions/active-sessions.css";

/** Live, read-only previews of every session that is working or waiting. */
export function ActiveSessionsPage() {
  const { t } = useTranslation();
  const sessions = useAppStore((state) => state.sessions);
  const runningSessions = useAppStore((state) => state.runningSessions);
  const pendingPermissions = useAppStore((state) => state.pendingPermissions);
  const selectSession = useAppStore((state) => state.selectSession);
  const showToast = useAppStore((state) => state.showToast);
  const entries = useMemo(
    () => selectActiveSessions({ sessions, runningSessions, pendingPermissions }),
    [sessions, runningSessions, pendingPermissions],
  );
  const openSession = useCallback(
    (sessionId: string) => {
      void selectSession(sessionId).catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : String(error), {
          variant: "error",
        });
      });
    },
    [selectSession, showToast],
  );

  return (
    <div className="route-scroll">
      <div className="page-frame active-sessions-frame">
        <div className="page-header">
          <div>
            <h1 className="page-title">{t("activeSessions.title")}</h1>
            <p className="dest-row-meta">{t("activeSessions.description")}</p>
          </div>
        </div>
        {entries.length === 0 ? (
          <Panel className="page-card page-empty">
            <div className="page-empty-icon">
              <IconActivity size={20} aria-hidden />
            </div>
            <h2>{t("activeSessions.emptyTitle")}</h2>
            <p className="dest-row-meta">{t("activeSessions.emptyDescription")}</p>
          </Panel>
        ) : (
          <ul className="active-sessions-grid">
            {entries.map((entry) => (
              <li
                key={entry.session.id}
                className="active-sessions-item"
                data-session-id={entry.session.id}
              >
                <ActiveSessionPane entry={entry} onOpen={openSession} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
