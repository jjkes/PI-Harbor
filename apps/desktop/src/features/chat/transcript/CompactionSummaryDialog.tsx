import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { formatCompactTokenCount, type ContextCompactionMark } from "@pi-harbor/shared";
import { Markdown } from "../../../components/Markdown";
import { TooltipButton } from "../../../components/ui";
import { OverlayBackdrop } from "../../../components/OverlayBackdrop";
import { IconCheck, IconClose, IconCopy } from "../../../components/icons";
import { useBlockingOverlay } from "../../../lib/blocking-overlay";

/**
 * Read-only viewer for one compaction's model-written summary. Opened from the
 * transcript's compaction divider, so the user can read what the model kept of
 * the earlier turns instead of only hearing that they were compacted.
 */
export function CompactionSummaryDialog({
  mark,
  onClose,
}: {
  mark: ContextCompactionMark & { summary?: string };
  onClose: () => void;
}) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const summary = mark.summary ?? "";
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const copySummary = async () => {
    clearTimeout(copyTimer.current);
    try {
      await navigator.clipboard.writeText(summary);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
    copyTimer.current = setTimeout(() => setCopy("idle"), 2_000);
  };
  const copyLabel = copy === "copied"
    ? t("chat.copied")
    : copy === "failed"
      ? t("chat.copyFailed")
      : t("chat.compactionSummaryCopy");

  const dialog = (
    <OverlayBackdrop className="overlay session-context-dialog-overlay" role="presentation" onClick={onClose}>
      <div
        className="dialog session-context-dialog compaction-summary-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="session-context-dialog-head">
          <div>
            <h3 id={titleId} className="session-context-dialog-title">
              {t("chat.compactionSummaryTitle", { times: mark.generation })}
            </h3>
            <p id={descriptionId} className="session-context-dialog-description">
              {t("chat.compactionRowSummary", { tokens: formatCompactTokenCount(mark.summaryTokens) })}
            </p>
          </div>
          <div className="compaction-summary-dialog-actions">
            <TooltipButton
              type="button"
              className="session-context-copy"
              tooltip={copyLabel}
              ariaLabel={copyLabel}
              onClick={() => void copySummary()}
            >
              {copy === "copied" ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </TooltipButton>
            <TooltipButton
              ref={closeRef}
              type="button"
              className="session-context-dialog-close"
              tooltip={t("common.close")}
              ariaLabel={t("common.close")}
              onClick={onClose}
            >
              <IconClose size={16} />
            </TooltipButton>
          </div>
        </div>
        <div className="compaction-summary-body">
          <Markdown source={summary} />
        </div>
      </div>
    </OverlayBackdrop>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
