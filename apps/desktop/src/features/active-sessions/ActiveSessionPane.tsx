import { useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Panel, cx } from "../../components/ui";
import { headPermission } from "../../lib/pending-permissions";
import { isDefaultSessionTitle, useAppStore } from "../../stores/app-store";
import {
  type ActiveSessionEntry,
  activeSessionProject,
  type TranscriptPreviewLine,
  transcriptPreviewLines,
} from "./active-sessions-model";
import { useSessionTranscriptPreview } from "./useSessionTranscriptPreview";

/** Distance from the bottom that still counts as following the newest row. */
const FOLLOW_THRESHOLD_PX = 24;

/** One read-only live preview on the Active sessions page. */
export function ActiveSessionPane({
  entry,
  onOpen,
}: {
  entry: ActiveSessionEntry;
  onOpen: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const { session, status } = entry;
  const projectMeta = useAppStore((state) => state.projectMeta);
  const permission = useAppStore((state) =>
    headPermission(state.pendingPermissions, session.id),
  );
  const preview = useSessionTranscriptPreview(session.id);
  const lines = useMemo(
    () => (preview.messages ? transcriptPreviewLines(preview.messages) : []),
    [preview.messages],
  );
  // Same title as the session's sidebar row.
  const taskTitle = isDefaultSessionTitle(session.title)
    ? t("chat.untitledTask")
    : session.title;
  const crumb = activeSessionProject(session, projectMeta);

  // The feed follows the newest row like a terminal until the reader scrolls up.
  const feedRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (feed && following.current && lines.length > 0) feed.scrollTop = feed.scrollHeight;
  }, [lines]);

  // Approval and input both wait on the user; only approval names a tool.
  const waiting = status !== "running";
  return (
    <Panel className={cx("page-card active-session-pane", waiting && "is-waiting")}>
      <div className="active-session-pane-header">
        <div className="active-session-pane-heading">
          <h2 className="active-session-pane-title" title={taskTitle}>
            {taskTitle}
          </h2>
          {crumb ? (
            <p className="active-session-pane-crumb" title={crumb}>
              {crumb}
            </p>
          ) : null}
        </div>
        <Badge tone={waiting ? "warning" : "neutral"}>
          {status === "permission"
            ? t("activeSessions.statusWaiting")
            : status === "input"
              ? t("nav.sessionInput")
              : t("nav.sessionRunning")}
        </Badge>
      </div>
      {status === "permission" && permission ? (
        <p className="active-session-permission">
          {t("activeSessions.permissionTool", { tool: permission.toolName })}
        </p>
      ) : null}
      <div
        ref={feedRef}
        className="active-session-feed"
        role="group"
        aria-label={t("activeSessions.previewLabel", { title: taskTitle })}
        tabIndex={0}
        onScroll={(event) => {
          const feed = event.currentTarget;
          following.current =
            feed.scrollHeight - feed.scrollTop - feed.clientHeight <= FOLLOW_THRESHOLD_PX;
        }}
      >
        {preview.status === "loading" ? (
          <p className="active-session-feed-status">{t("common.loading")}</p>
        ) : preview.status === "unavailable" ? (
          <p className="active-session-feed-status">{t("activeSessions.previewUnavailable")}</p>
        ) : lines.length === 0 ? (
          <p className="active-session-feed-status">{t("activeSessions.previewEmpty")}</p>
        ) : (
          <ol className="active-session-lines">
            {lines.map((line) => (
              <PreviewLine key={line.id} line={line} />
            ))}
          </ol>
        )}
      </div>
      <div className="active-session-pane-footer">
        <Button
          size="sm"
          variant={waiting ? "primary" : "secondary"}
          aria-label={t("activeSessions.openLabel", { title: taskTitle })}
          onClick={() => onOpen(session.id)}
        >
          {t("activeSessions.open")}
        </Button>
      </div>
    </Panel>
  );
}

function PreviewLine({ line }: { line: TranscriptPreviewLine }) {
  const { t } = useTranslation();
  if (line.kind === "tool") {
    const statusLabel =
      line.status === "running"
        ? t("chat.toolRunning")
        : line.status === "error"
          ? t("chat.toolFailed")
          : line.status === "denied"
            ? t("chat.toolDenied")
            : t("chat.toolCompleted");
    return (
      <li className={cx("active-session-line is-tool", `is-${line.status}`)}>
        <span className="active-session-line-tool">{line.toolName}</span>
        <span className="active-session-line-status">{statusLabel}</span>
      </li>
    );
  }
  const speaker =
    line.kind === "assistant" ? t("chat.speakerAssistant") : (line.from ?? t("chat.speakerYou"));
  return (
    <li className={cx("active-session-line", `is-${line.kind}`)}>
      <span className="active-session-line-speaker">{speaker}</span>
      <span className="active-session-line-text">{line.text}</span>
    </li>
  );
}
