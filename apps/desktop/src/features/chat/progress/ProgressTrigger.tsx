import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { progressAvailableFor } from "@pi-harbor/shared";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { IconActivity } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { useAppStore } from "../../../stores/app-store";
import {
  ensureProgressScheduler,
  progressService,
  useProgressSession,
} from "./progress-controller";
import { progressTriggerVisual } from "./progress-types";
import { ProgressPopover } from "./ProgressPopover";

/**
 * The progress-report trigger (ADR 0350).
 *
 * It leads the Composer's bottom-left group and is the only entry point to the
 * feature. It never configures the session, so it stays enabled while a turn
 * runs and while composer controls are blocked.
 */
export function ProgressTrigger({ t, sessionId }: { t: TFunction; sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const state = useProgressSession(sessionId);
  const sessionSource = useAppStore(
    (store) => store.sessions.find((candidate) => candidate.id === sessionId)?.source,
  );
  const newestMessageId = useAppStore((store) => {
    if (!sessionId) return null;
    const messages =
      store.activeSessionId === sessionId
        ? store.messages
        : (store.retainedTranscripts[sessionId] ?? []);
    return messages[messages.length - 1]?.id ?? null;
  });
  const available = sessionId !== undefined && progressAvailableFor({ id: sessionId, source: sessionSource });

  useEffect(() => {
    if (!available || !sessionId) return;
    void progressService.load(sessionId);
  }, [available, sessionId]);

  // A report that lands while the popover is open has been seen already.
  useEffect(() => {
    if (open && sessionId && state.unseen) progressService.markSeen(sessionId);
  }, [open, sessionId, state.unseen]);

  if (!available || !sessionId) return null;

  const visual = progressTriggerVisual(state);
  const tooltip =
    visual === "collecting"
      ? t("chat.progressReport.trigger.collecting")
      : visual === "unseen"
        ? t("chat.progressReport.trigger.unseen")
        : visual === "auto"
          ? t("chat.progressReport.trigger.autoOn", { minutes: state.settings.intervalMinutes })
          : t("chat.progressReport.trigger.label");

  return (
    <>
      <TooltipButton
        ref={triggerRef}
        type="button"
        className={`icon-btn icon-btn-square progress-trigger${open ? " active" : ""}`}
        tooltip={tooltip}
        ariaLabel={
          state.unseen
            ? t("chat.progressReport.trigger.unseenAria")
            : t("chat.progressReport.trigger.label")
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={state.run !== null}
        onClick={() => {
          ensureProgressScheduler();
          setOpen(!open);
        }}
      >
        {state.run ? (
          <span className="tool-spinner" aria-hidden="true" />
        ) : (
          <IconActivity size={15} aria-hidden="true" />
        )}
        {visual === "unseen" ? (
          <span className="progress-trigger-dot progress-trigger-dot-unseen" aria-hidden="true" />
        ) : null}
        {visual === "auto" ? (
          <span className="progress-trigger-dot progress-trigger-dot-auto" aria-hidden="true" />
        ) : null}
      </TooltipButton>
      <AnchoredMenu
        open={open}
        onClose={() => setOpen(false)}
        trigger={() => null}
        anchorRef={triggerRef}
        role="dialog"
        label={t("chat.progressReport.title")}
        side="top"
        align="start"
        initialFocus="selected"
        menuClassName="progress-popover"
      >
        <ProgressPopover
          t={t}
          sessionId={sessionId}
          state={state}
          newestMessageId={newestMessageId}
          onClose={() => setOpen(false)}
        />
      </AnchoredMenu>
    </>
  );
}
