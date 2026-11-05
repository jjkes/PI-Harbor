import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { SessionContextSnapshot } from "@pi-harbor/shared";
import { api } from "../../../lib/api";
import { useBlockingOverlay } from "../../../lib/blocking-overlay";
import { Button, OverlayBackdrop, SegmentedControl, TooltipButton } from "../../../components/ui";
import { IconCheck, IconClose, IconCopy } from "../../../components/icons";

export type SessionContextState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "loaded"; snapshot: SessionContextSnapshot };

/**
 * Load one session's context snapshot. A result that arrives after the dialog
 * moved to another session, or closed, is dropped.
 */
export function useSessionContextSnapshot(sessionId: string): {
  state: SessionContextState;
  reload: () => void;
} {
  const [state, setState] = useState<SessionContextState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    api.getSessionContext(sessionId).then(
      (snapshot) => {
        if (current) setState({ status: "loaded", snapshot });
      },
      (error: unknown) => {
        if (current) {
          setState({ status: "failed", message: error instanceof Error ? error.message : String(error) });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [sessionId, attempt]);
  return { state, reload: () => setAttempt((value) => value + 1) };
}

function formatRecordedTime(iso: string, locale: string): string | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(time);
}

/** What the dialog body shows for one load state; kept pure for render tests. */
export function SessionContextView({
  state,
  onRetry,
}: {
  state: SessionContextState;
  onRetry: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<"prompt" | "tools">("prompt");
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  if (state.status === "loading") {
    return <p className="session-context-status" role="status">{t("common.loading")}</p>;
  }
  if (state.status === "failed") {
    return (
      <div className="session-context-status" role="alert">
        <p>{t("chat.sessionContextFailed")}</p>
        <p className="session-context-detail">{state.message}</p>
        <Button variant="secondary" size="sm" onClick={onRetry}>{t("chat.sessionContextRetry")}</Button>
      </div>
    );
  }
  const { snapshot } = state;
  if (snapshot.status !== "ready") {
    const key = snapshot.status === "empty"
      ? "chat.sessionContextEmpty"
      : snapshot.reason === "remote" ? "chat.sessionContextRemote" : "chat.sessionContextNative";
    return <p className="session-context-status" role="status">{t(key)}</p>;
  }

  const recorded = formatRecordedTime(snapshot.updatedAt, i18n.language);
  const copyPrompt = () => {
    clearTimeout(copyTimer.current);
    void navigator.clipboard.writeText(snapshot.systemPrompt).then(
      () => setCopy("copied"),
      () => setCopy("failed"),
    ).finally(() => {
      copyTimer.current = setTimeout(() => setCopy("idle"), 2_000);
    });
  };
  const copyLabel = copy === "copied"
    ? t("chat.copied")
    : copy === "failed" ? t("chat.copyFailed") : t("chat.sessionContextCopyPrompt");

  return (
    <div className="session-context-body">
      <div className="session-context-toolbar">
        {/* A toggle group, not a tablist: SegmentedControl has no arrow-key
            tab navigation, so it must not claim tab semantics. */}
        <SegmentedControl
          role="group"
          label={t("chat.sessionContextTabs")}
          value={tab}
          onChange={setTab}
          options={[
            { value: "prompt", label: t("chat.sessionContextPromptTab") },
            { value: "tools", label: t("chat.sessionContextToolsTab", { count: snapshot.tools.length }) },
          ]}
        />
        {recorded ? (
          <span className="session-context-meta">{t("chat.sessionContextUpdated", { time: recorded })}</span>
        ) : null}
      </div>
      <section
        aria-label={tab === "prompt"
          ? t("chat.sessionContextPromptTab")
          : t("chat.sessionContextToolsTab", { count: snapshot.tools.length })}
        className="session-context-panel"
      >
        {tab === "prompt" ? (
          <>
            <div className="session-context-panel-head">
              <span className="session-context-meta">
                {t("chat.sessionContextPromptSize", { chars: snapshot.systemPrompt.length.toLocaleString(i18n.language) })}
              </span>
              <TooltipButton
                type="button"
                className="session-context-copy"
                tooltip={copyLabel}
                ariaLabel={copyLabel}
                onClick={copyPrompt}
              >
                {copy === "copied" ? <IconCheck size={14} /> : <IconCopy size={14} />}
              </TooltipButton>
            </div>
            <pre className="session-context-prompt" tabIndex={0}>{snapshot.systemPrompt}</pre>
          </>
        ) : snapshot.tools.length === 0 ? (
          <p className="session-context-status">{t("chat.sessionContextNoTools")}</p>
        ) : (
          <ul className="session-context-tools">
            {snapshot.tools.map((tool) => (
              <li key={tool.name}>
                <details className="session-context-tool">
                  <summary>
                    <code className="session-context-tool-name">{tool.name}</code>
                    <span className="session-context-tool-summary">{tool.description.split(/\r?\n/, 1)[0]}</span>
                  </summary>
                  <p className="session-context-tool-description">{tool.description}</p>
                  <pre className="session-context-schema">{JSON.stringify(tool.parameters, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Read-only view of the system prompt and tools a session last sent. */
export function SessionContextDialog({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const { state, reload } = useSessionContextSnapshot(sessionId);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const dialog = (
    <OverlayBackdrop className="overlay session-context-dialog-overlay" role="presentation" onClick={onClose}>
      <div
        className="dialog session-context-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="session-context-dialog-head">
          <div>
            <h3 id={titleId} className="session-context-dialog-title">{t("chat.sessionContextTitle")}</h3>
            <p id={descriptionId} className="session-context-dialog-description">
              {t("chat.sessionContextDescription")}
            </p>
          </div>
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
        <SessionContextView state={state} onRetry={reload} />
      </div>
    </OverlayBackdrop>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
