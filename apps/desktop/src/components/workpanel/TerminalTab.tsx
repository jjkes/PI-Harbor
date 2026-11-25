import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { ErrorCodes } from "@pi-harbor/shared";
import { useTerminal } from "./use-terminal";
import { sessionAllows } from "../../lib/remote-session-safety";
import { useAppStore } from "../../stores/app-store";
import { IconTerminal, IconTriangleAlert, IconClose } from "../icons";
import { Button, cx, Textarea, TooltipButton } from "../ui";

function platform(): string {
  return typeof window !== "undefined" && window.piDesktop?.platform
    ? window.piDesktop.platform
    : "";
}

function isTerminalAllowed(session: ReturnType<typeof useAppStore.getState>["sessions"][number] | undefined): boolean {
  if (!session) return false;
  if (session.id.startsWith("native-pi:")) return false;
  if (session.source === "remote" || session.id.startsWith("remote:")) {
    return sessionAllows(session, "canUseTerminal");
  }
  return platform() === "linux" && sessionAllows(session, "canUseTerminal");
}

function terminalUnavailableReason(
  session: ReturnType<typeof useAppStore.getState>["sessions"][number] | undefined,
): "platform" | "capability" | "no-session" {
  if (!session) return "no-session";
  if (session.source === "remote" || session.id.startsWith("remote:")) {
    return "capability";
  }
  if (platform() !== "linux") return "platform";
  return "capability";
}

export function TerminalTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const session = useAppStore((state) =>
    state.sessions.find((item) => item.id === sessionId),
  );
  const allowed = isTerminalAllowed(session);
  const {
    status,
    terminalId,
    lines,
    error,
    actionError,
    pending,
    containerRef,
    open,
    reattach,
    close,
    sendInput,
    interrupt,
    dismissActionError,
  } = useTerminal(sessionId);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (status === "open" && !wasOpenRef.current) {
      inputRef.current?.focus();
    }
    wasOpenRef.current = status === "open";
  }, [status]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.scrollTop = scroll.scrollHeight;
  }, [lines]);

  const handleOpen = useCallback(() => {
    if (!allowed) return;
    void open();
  }, [allowed, open]);

  const submit = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      const text = draft;
      // An empty command is explicit: it is not sent to the PTY.
      if (text === "" || status !== "open" || pending) return;
      setDraft("");
      void sendInput(text);
    },
    [draft, status, pending, sendInput],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        submit();
        return;
      }
      // Ctrl+C copies selected text through the default browser behavior; when
      // nothing is selected it sends SIGINT to the PTY, mirroring the toolbar.
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "c"
      ) {
        const target = event.currentTarget;
        const hasSelection = target.selectionStart !== target.selectionEnd;
        if (!hasSelection) {
          event.preventDefault();
          void interrupt();
        }
      }
    },
    [submit, interrupt],
  );

  const onInterrupt = useCallback(() => {
    void interrupt();
  }, [interrupt]);

  const onReattach = useCallback(() => {
    void reattach();
  }, [reattach]);

  const onClose = useCallback(() => {
    void close();
  }, [close]);

  if (!allowed) {
    const reason = terminalUnavailableReason(session);
    return (
      <div className="terminal-tab">
        <div className="work-tab-empty">
          <span className="work-tab-empty-icon" aria-hidden="true">
            <IconTerminal size={18} />
          </span>
          <p className="work-tab-empty-title">{t("panel.terminal.unavailableTitle")}</p>
          <p className="work-tab-empty-body">
            {reason === "platform"
              ? t("panel.terminal.unavailablePlatform")
              : t("panel.terminal.unavailableCapability")}
          </p>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="terminal-tab">
        <div className="work-tab-empty">
          <span className="work-tab-empty-icon" aria-hidden="true">
            <IconTriangleAlert size={18} />
          </span>
          <p className="work-tab-empty-title">{t("panel.terminal.errorTitle")}</p>
          <p className="work-tab-empty-body">{error ?? t("panel.terminal.errorGeneric")}</p>
          <Button type="button" variant="secondary" size="sm" onClick={handleOpen}>
            {t("panel.terminal.retryOpen")}
          </Button>
        </div>
      </div>
    );
  }

  if (status === "idle" || status === "closed") {
    return (
      <div className="terminal-tab">
        <div className="work-tab-empty">
          <span className="work-tab-empty-icon" aria-hidden="true">
            <IconTerminal size={18} />
          </span>
          <p className="work-tab-empty-title">{t("panel.terminal.emptyTitle")}</p>
          <p className="work-tab-empty-body">{t("panel.terminal.emptyBody")}</p>
          <Button type="button" variant="primary" size="sm" onClick={handleOpen}>
            {t("panel.terminal.open")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-tab">
      <div className="terminal-tab-header">
        <div className="terminal-tab-heading">
          <IconTerminal size={14} />
          <span className="terminal-tab-title">{t("panel.terminal.title")}</span>
          {terminalId ? (
            <span className="terminal-tab-id" title={terminalId}>
              {terminalId}
            </span>
          ) : null}
        </div>
        <div className="terminal-tab-actions">
          <TooltipButton
            type="button"
            tooltip={t("panel.terminal.interrupt")}
            ariaLabel={t("panel.terminal.interrupt")}
            disabled={pending}
            onClick={onInterrupt}
          >
            <span aria-hidden="true">Ctrl+C</span>
          </TooltipButton>
          <TooltipButton
            type="button"
            tooltip={t("panel.terminal.close")}
            ariaLabel={t("panel.terminal.close")}
            onClick={onClose}
          >
            <IconClose size={14} />
          </TooltipButton>
        </div>
      </div>

      {status === "detached" ? (
        <div className="terminal-tab-banner" role="status">
          <IconTriangleAlert size={14} />
          <span className="terminal-tab-banner-text">
            <strong>{t("panel.terminal.detachedTitle")}</strong>{" "}
            {t("panel.terminal.detachedBody")}
          </span>
          <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={onReattach}>
            {t("panel.terminal.reattach")}
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <div className="terminal-tab-notice" role="alert">
          <span className="terminal-tab-notice-text">
            {t("panel.terminal.actionFailed")}: {actionError}
          </span>
          <TooltipButton
            type="button"
            tooltip={t("panel.terminal.dismissNotice")}
            ariaLabel={t("panel.terminal.dismissNotice")}
            onClick={dismissActionError}
          >
            <IconClose size={12} />
          </TooltipButton>
        </div>
      ) : null}
      <div
        ref={(node) => {
          containerRef.current = node;
          scrollRef.current = node;
        }}
        className="terminal-tab-output"
        role="log"
        aria-live="polite"
        aria-label={t("panel.terminal.outputLabel")}
      >
        {lines.length === 0 ? (
          <div className="terminal-tab-placeholder">{t("panel.terminal.ready")}</div>
        ) : (
          lines.map((line) => (
            <div
              key={line.id}
              className={cx(
                "terminal-tab-line",
                line.stream === "stderr" && "is-stderr",
              )}
            >
              <span className="terminal-tab-line-text">{line.text}</span>
            </div>
          ))
        )}
      </div>
      <form className="terminal-tab-composer" onSubmit={submit}>
        <Textarea
          ref={inputRef}
          rows={1}
          value={draft}
          disabled={pending || status === "detached"}
          placeholder={t("panel.terminal.inputPlaceholder")}
          aria-label={t("panel.terminal.inputLabel")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button type="submit" variant="primary" size="sm" disabled={!draft || pending}>
          {t("panel.terminal.send")}
        </Button>
      </form>
    </div>
  );
}

export function terminalErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code);
  }
  return undefined;
}

export function isTerminalCapabilityError(error: unknown): boolean {
  const code = terminalErrorCode(error);
  return code === "CAPABILITY_UNAVAILABLE" || code === ErrorCodes.CAPABILITY_UNAVAILABLE;
}
