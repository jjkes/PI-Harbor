import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { BTW_QUESTION_MAX_CHARS, ErrorCodes } from "@pi-harbor/shared";
import {
  btwCompactionCountOf,
  btwController,
  btwMainMessagesOf,
  btwMainRunningOf,
  useBtwStore,
} from "../../features/chat/btw/btw-controller";
import {
  btwStaleness,
  btwThreadOf,
  type BtwMainView,
  type BtwToolRow,
  type BtwTurn,
} from "../../features/chat/btw/btw-model";
import { btwErrorText, type BtwTranslate } from "../../features/chat/btw/btw-service";
import { useFollowScroll } from "../../hooks/use-follow-scroll";
import { useAppStore } from "../../stores/app-store";
import { IconChat, IconCopy, IconRefresh } from "../icons";
import { Markdown } from "../Markdown";
import { Badge, Button, cx, Textarea, TooltipButton } from "../ui";

/**
 * The BTW tab (ADR 0344): read-only side questions about the session's main
 * conversation. Each answer comes from a snapshot taken when its question was
 * sent; its footer says when the main conversation has moved on since.
 */
export function BtwTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const thread = useBtwStore((state) => btwThreadOf(state, sessionId));
  const focusRequested = useBtwStore((state) => state.focusSessionId === sessionId);
  const messages = useAppStore((state) => btwMainMessagesOf(state, sessionId));
  const compactionCount = useAppStore((state) => btwCompactionCountOf(state, sessionId));
  const mainRunning = useAppStore((state) => btwMainRunningOf(state, sessionId));
  const compacting = useAppStore(
    (state) => state.agentStatuses[sessionId]?.activity?.phase === "compacting",
  );
  const enterToSend = useAppStore((state) => state.settings?.enterToSend ?? true);
  const mainView = useMemo<BtwMainView>(
    () => ({ messages, compactionCount, running: mainRunning }),
    [messages, compactionCount, mainRunning],
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { scrollRef, contentRef, handleScroll, scheduleFollowScroll } = useFollowScroll();
  const running = thread.activeRunId !== null;
  const lastTurn = thread.turns[thread.turns.length - 1];

  useLayoutEffect(() => {
    scheduleFollowScroll();
  }, [thread.turns, scheduleFollowScroll]);

  useEffect(() => {
    if (!focusRequested) return;
    inputRef.current?.focus();
    btwController.consumeFocus(sessionId);
  }, [focusRequested, sessionId]);

  const statusText = compacting
    ? t("panel.btw.statusCompacting")
    : mainRunning
      ? t("panel.btw.statusRunning")
      : t("panel.btw.statusIdle");
  const announcement = !lastTurn
    ? ""
    : lastTurn.status === "pending" || lastTurn.status === "streaming"
      ? t("panel.btw.answering")
      : lastTurn.status === "done"
        ? t("panel.btw.answerReady")
        : lastTurn.status === "aborted"
          ? t("panel.btw.stopped")
          : t("panel.btw.failed");

  const send = () => {
    if (running) return;
    void btwController.submitDraft(sessionId);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (!enterToSend && !event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    send();
  };

  return (
    <div className="btw-tab">
      <header className="btw-tab-header">
        <div className="btw-tab-heading">
          <span className="btw-tab-title">{t("panel.btw.title")}</span>
          <Badge>{t("panel.btw.readOnly")}</Badge>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="btw-tab-clear"
            disabled={running || thread.turns.length === 0}
            onClick={() => btwController.clear(sessionId)}
          >
            {t("panel.btw.clear")}
          </Button>
        </div>
        <p className="btw-tab-status" aria-live="polite">
          {statusText}
        </p>
      </header>
      <div ref={scrollRef} className="btw-tab-scroll" onScroll={handleScroll}>
        <div ref={contentRef} className="btw-tab-list">
          {thread.turns.length === 0 ? (
            <div className="work-tab-empty">
              <span className="work-tab-empty-icon" aria-hidden="true">
                <IconChat size={18} />
              </span>
              <p className="work-tab-empty-title">{t("panel.btw.emptyTitle")}</p>
              <p className="work-tab-empty-body">
                {messages.length === 0 ? t("panel.btw.emptyMain") : t("panel.btw.readOnlyHint")}
              </p>
            </div>
          ) : (
            thread.turns.map((turn) => (
              <BtwTurnView
                key={turn.runId}
                turn={turn}
                mainView={mainView}
                sessionId={sessionId}
                canRetry={!running && turn === lastTurn}
              />
            ))
          )}
        </div>
      </div>
      <p className="btw-tab-announcer" aria-live="polite">
        {announcement}
      </p>
      <form
        className="btw-tab-composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <Textarea
          ref={inputRef}
          rows={2}
          value={thread.draft}
          maxLength={BTW_QUESTION_MAX_CHARS}
          placeholder={t("panel.btw.placeholder")}
          aria-label={t("panel.btw.inputLabel")}
          onChange={(event) => btwController.setDraft(sessionId, event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="btw-tab-composer-controls">
          {running ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void btwController.stop(sessionId)}
            >
              {t("panel.btw.stop")}
            </Button>
          ) : (
            <Button type="submit" variant="primary" size="sm" disabled={!thread.draft.trim()}>
              {t("panel.btw.send")}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

function BtwTurnView({
  turn,
  mainView,
  sessionId,
  canRetry,
}: {
  turn: BtwTurn;
  mainView: BtwMainView;
  sessionId: string;
  canRetry: boolean;
}) {
  const { t, i18n } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const translate: BtwTranslate = (key, options) => t(key, options);
  const active = turn.status === "pending" || turn.status === "streaming";
  const staleness = btwStaleness(turn.baseline, mainView);
  const staleText =
    staleness.kind === "compacted"
      ? t("panel.btw.staleCompacted")
      : staleness.kind === "changed"
        ? t("panel.btw.staleChanged")
        : staleness.kind === "newer"
          ? t("panel.btw.staleNewer", { count: staleness.count })
          : staleness.kind === "midTurn"
            ? t("panel.btw.staleMidTurn")
            : "";
  const meta = [
    new Date(turn.askedAt).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" }),
    turn.modelId,
    turn.usage
      ? t("panel.btw.tokens", {
          count: turn.usage.totalTokens,
          tokens: new Intl.NumberFormat(i18n.language).format(turn.usage.totalTokens),
        })
      : undefined,
    turn.status === "aborted" ? t("panel.btw.stopped") : undefined,
  ].filter((part): part is string => Boolean(part));
  const copy = () => {
    void navigator.clipboard.writeText(turn.answer).then(
      () => showToast(t("chat.copied"), { variant: "success" }),
      () => showToast(t("chat.copyFailed"), { variant: "error" }),
    );
  };

  return (
    <article className="btw-turn">
      <p className="btw-turn-question">{turn.question}</p>
      {turn.tools.length > 0 ? (
        <ul className="btw-turn-tools" aria-label={t("panel.btw.toolsLabel")}>
          {turn.tools.map((tool) => (
            <li
              key={tool.toolCallId}
              className={cx("btw-turn-tool", tool.state === "failed" && "failed")}
            >
              <span className="btw-turn-tool-name">{tool.toolName}</span>
              {tool.summary ? <span className="btw-turn-tool-summary">{tool.summary}</span> : null}
              <span className="btw-turn-tool-state">{toolStateText(tool, t)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {turn.answer ? (
        <div className="prose-chat btw-turn-answer">
          <Markdown source={turn.answer} streaming={active} />
        </div>
      ) : active ? (
        <p className="btw-turn-pending">{t("panel.btw.answering")}</p>
      ) : null}
      {turn.status === "error" && turn.error ? (
        <p className="btw-turn-error">{btwErrorText(translate, turn.error)}</p>
      ) : null}
      {active ? null : (
        <footer className="btw-turn-footer">
          {meta.length > 0 ? <span className="btw-turn-meta">{meta.join(" · ")}</span> : null}
          {turn.answer && staleText ? <span className="btw-turn-stale">{staleText}</span> : null}
          <span className="btw-turn-actions">
            {canRetry && turn.status === "error" && turn.error?.retriable === true ? (
              <TooltipButton
                tooltip={t("panel.btw.retry")}
                className="btw-turn-action"
                onClick={() => void btwController.retry(sessionId, turn.runId)}
              >
                <IconRefresh size={14} />
              </TooltipButton>
            ) : null}
            {turn.answer ? (
              <TooltipButton
                tooltip={t("panel.btw.copy")}
                className="btw-turn-action"
                onClick={copy}
              >
                <IconCopy size={14} />
              </TooltipButton>
            ) : null}
          </span>
        </footer>
      )}
    </article>
  );
}

function toolStateText(tool: BtwToolRow, t: (key: string) => string): string {
  switch (tool.state) {
    case "ok":
      return "";
    case "running":
      return t("panel.btw.toolRunning");
    case "stopped":
      return t("panel.btw.toolStopped");
    case "failed":
      if (
        tool.errorCode === ErrorCodes.TOOL_DISABLED_IN_READ_ONLY ||
        tool.errorCode === ErrorCodes.EXTERNAL_PATH_DISABLED_IN_READ_ONLY
      ) {
        return t("panel.btw.toolDenied");
      }
      return tool.errorCode === ErrorCodes.BTW_TOOL_BUDGET_EXHAUSTED
        ? t("panel.btw.toolBudget")
        : t("panel.btw.toolFailed");
  }
}
