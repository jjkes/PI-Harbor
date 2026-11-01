import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { diffWorkPanelTab } from "../../../lib/work-panel-tabs";
import {
  sessionFileChanges,
  splitWorkspacePath,
  type SessionFileChange,
} from "../../../lib/session-file-changes";
import {
  REVIEW_STATUS_MARKS,
  reviewChangesFromMessages,
} from "../../../lib/workspace-review";
import { useAppStore } from "../../../stores/app-store";
import { Button, cx } from "../../../components/ui";
import {
  IconChevronDown,
  IconChevronUp,
  IconDiff,
} from "../../../components/icons";

/**
 * The composer's changed-files bar: every workspace file the conversation's
 * recorded Write/Edit changes still affect, collapsed to a count by default.
 * A row opens that file's read-only diff in the work panel; nothing opens the
 * panel on its own (D451).
 */
export function SessionChangesBar() {
  const { t } = useTranslation();
  const messages = useAppStore((state) => state.messages);
  const openWorkPanelTab = useAppStore((state) => state.openWorkPanelTab);
  const files = useMemo(
    () =>
      sessionFileChanges(
        reviewChangesFromMessages(messages).map((entry) => entry.change),
      ),
    [messages],
  );
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  if (files.length === 0) return null;

  const summary = t("panel.review.filesChanged", { count: files.length });
  const toggleLabel = expanded
    ? t("taskDock.collapse", { label: summary })
    : t("taskDock.expand", { label: summary });
  const toggle = () => setExpanded((value) => !value);

  return (
    <div className={cx("dock", "session-changes", expanded && "is-expanded")}>
      <div className="dock-header">
        <button
          type="button"
          className="dock-header-main"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={toggleLabel}
          onClick={toggle}
        >
          <span className="dock-header-symbol" aria-hidden>
            <IconDiff size={14} />
          </span>
          <span className="dock-header-copy">
            <span className="dock-header-text">{summary}</span>
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          className="dock-toggle"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={toggleLabel}
          onClick={toggle}
        >
          {expanded ? <IconChevronDown size={18} /> : <IconChevronUp size={18} />}
        </Button>
      </div>
      <div id={listId} className="dock-content">
        <div className="dock-clip">
          {/* Rows mount only while expanded, so a collapsed bar keeps them out
              of the tab order. */}
          {expanded ? (
            <ul className="session-changes-list">
              {files.map((file) => (
                <li key={file.path}>
                  <SessionChangeRow
                    file={file}
                    onOpen={() => openWorkPanelTab(diffWorkPanelTab(file.path))}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SessionChangeRow({
  file,
  onOpen,
}: {
  file: SessionFileChange;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const { name, directory } = splitWorkspacePath(file.path);
  const label = t("panel.review.openDiff", {
    path: file.path,
    status: t(`panel.review.status.${file.status}`),
  });
  return (
    <button
      type="button"
      className="session-change-row"
      aria-label={label}
      title={label}
      onClick={onOpen}
    >
      <span className={cx("session-change-mark", `is-${file.status}`)} aria-hidden>
        {REVIEW_STATUS_MARKS[file.status]}
      </span>
      <span className="session-change-name">{name}</span>
      {directory ? <span className="session-change-dir">{directory}</span> : null}
    </button>
  );
}
