import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  ReviewChangeStatus,
  ReviewFileDiff,
  ReviewFileDiffStatus,
} from "@pi-harbor/shared";
import {
  useFileDiff,
  type FileDiffLoad,
} from "../../features/chat/session-changes/useFileDiff";
import { useChatSessionCapability } from "../../hooks/use-chat-session-capability";
import {
  fileDiffSnapshotChain,
  numberDiffHunkLines,
} from "../../lib/session-file-changes";
import {
  REVIEW_STATUS_MARKS,
  reviewChangesFromMessages,
} from "../../lib/workspace-review";
import { useAppStore } from "../../stores/app-store";
import { Badge, cx } from "../ui";

/**
 * Read-only diff of one workspace file: its bytes before the conversation's
 * first recorded change, compared with the file on disk now
 * (`review.fileDiff`). The snapshot chain is read from the transcript on every
 * render, so a later recorded change to the file reloads the diff.
 */
export function FileDiffTab({ path }: { path: string }) {
  const { t } = useTranslation();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const messages = useAppStore((state) => state.messages);
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const chain = useMemo(
    () =>
      fileDiffSnapshotChain(
        reviewChangesFromMessages(messages).map((entry) => entry.change),
        path,
      ),
    [messages, path],
  );
  // Remote sessions keep no local snapshots, as for rollback.
  const snapshotIds = localToolsAllowed ? chain : [];
  const load = useFileDiff(sessionId, snapshotIds);
  const loaded = snapshotIds.length > 0 ? load : null;
  const diff = loaded?.status === "ready" ? loaded.diff : null;

  return (
    <div className="review-tab file-diff-tab">
      <div className="review-toolbar">
        {diff ? <DiffStatusMark diff={diff} /> : null}
        <span className="file-diff-path" title={path}>
          {path}
        </span>
        {diff ? <DiffCounts diff={diff} /> : null}
        <Badge>{t("panel.review.readOnly")}</Badge>
      </div>
      <div className="review-scroll">
        <p className="file-diff-baseline">{t("panel.review.diffBaseline")}</p>
        <DiffBody load={loaded} />
      </div>
    </div>
  );
}

function isNetChange(status: ReviewFileDiffStatus): status is ReviewChangeStatus {
  return status === "added" || status === "modified" || status === "deleted";
}

function DiffStatusMark({ diff }: { diff: ReviewFileDiff }) {
  const { t } = useTranslation();
  if (!isNetChange(diff.status)) return null;
  const label = t(`panel.review.status.${diff.status}`);
  return (
    <span className={cx("session-change-mark", `is-${diff.status}`)} title={label}>
      <span aria-hidden>{REVIEW_STATUS_MARKS[diff.status]}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function DiffCounts({ diff }: { diff: ReviewFileDiff }) {
  if (!isNetChange(diff.status) || diff.binary || diff.truncated) return null;
  return (
    <span className="review-toolbar-counts diff-counts">
      <span className="diff-count-add">+{diff.additions}</span>
      <span className="diff-count-del">−{diff.deletions}</span>
    </span>
  );
}

type DiffNoteKey =
  | "panel.review.diffUnavailable"
  | "panel.review.diffUnchanged"
  | "panel.review.binary"
  | "panel.review.tooLarge"
  | "panel.review.noLineDetails";

function diffNoteKey(diff: ReviewFileDiff): DiffNoteKey | null {
  if (diff.status === "unavailable") return "panel.review.diffUnavailable";
  if (diff.status === "unchanged") return "panel.review.diffUnchanged";
  if (diff.binary) return "panel.review.binary";
  if (diff.truncated) return "panel.review.tooLarge";
  if (diff.hunks.length === 0) return "panel.review.noLineDetails";
  return null;
}

function DiffBody({ load }: { load: FileDiffLoad | null }) {
  const { t } = useTranslation();
  if (!load) {
    return (
      <div className="review-change-note">{t("panel.review.diffUnavailable")}</div>
    );
  }
  if (load.status === "loading") {
    return (
      <div className="review-change-note" role="status">
        {t("panel.files.loading")}
      </div>
    );
  }
  if (load.status === "error") {
    return (
      <div className="review-change-note" role="alert">
        {t("panel.review.diffError")}
      </div>
    );
  }
  const { diff } = load;
  const note = diffNoteKey(diff);
  return (
    <>
      {diff.drifted ? (
        <p className="file-diff-drift">{t("panel.review.diffDrifted")}</p>
      ) : null}
      {note ? (
        <div className="review-change-note">{t(note)}</div>
      ) : (
        <DiffHunks diff={diff} />
      )}
    </>
  );
}

function DiffHunks({ diff }: { diff: ReviewFileDiff }) {
  return (
    <div className="file-diff-lines">
      {diff.hunks.map((hunk, hunkIndex) => (
        <div className="diff-hunk" key={`${hunk.header}-${hunkIndex}`}>
          <div className="diff-line hunk">
            <span className="diff-line-text">{hunk.header}</span>
          </div>
          {numberDiffHunkLines(hunk).map((line, lineIndex) => (
            <div className={cx("diff-line", line.type)} key={lineIndex}>
              <span className="diff-line-number">{line.oldLine ?? ""}</span>
              <span className="diff-line-number">{line.newLine ?? ""}</span>
              <span className="diff-line-sign" aria-hidden>
                {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
              </span>
              <span className="diff-line-text">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
