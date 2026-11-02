import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { formatCompactTokenCount } from "@pi-harbor/shared";
import type { SessionTokenUsage } from "../lib/session-token-usage";
import { portalToBody } from "../lib/portal-visibility";
import {
  placeContextInspector,
  type ContextInspectorPlacement,
} from "../lib/context-inspector-position";
import "../styles/components/session-token-usage.css";

type SessionTokenUsagePanelProps = {
  usage: SessionTokenUsage;
};

/**
 * Compact session-wide token total in the composer toolbar; activating it opens
 * the main-session and delegate breakdown.
 *
 * The panel is portaled to the body and clamped to the conversation pane, for
 * the same reason as the context inspector: the work panel's native browser and
 * plugin surfaces composite above every renderer layer.
 */
export function SessionTokenUsagePanel({ usage }: SessionTokenUsagePanelProps) {
  const { t } = useTranslation();
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ContextInspectorPlacement | null>(
    null,
  );

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    const triggerRect = trigger.getBoundingClientRect();
    // A scrolled-away trigger has no anchor left to place the panel against.
    if (!(triggerRect.bottom > 0 && triggerRect.top < window.innerHeight)) {
      close();
      return;
    }

    const popoverRect = popover.getBoundingClientRect();
    const paneRect = trigger.closest(".main-pane")?.getBoundingClientRect();
    const placement = placeContextInspector({
      trigger: {
        left: triggerRect.left,
        top: triggerRect.top,
        bottom: triggerRect.bottom,
      },
      popover: { width: popoverRect.width, height: popoverRect.height },
      pane: paneRect ? { left: paneRect.left, right: paneRect.right } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    if (!placement) {
      close();
      return;
    }
    setPosition(placement);
  }, [close]);

  // The panel mounts on `open` alone, so the effect can measure it; until the
  // first placement lands it stays invisible rather than flashing at 0,0.
  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        popoverRef.current?.contains(event.target as Node) ||
        triggerRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      close();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  const showScopeRow = (label: string, tokens: number) => {
    if (tokens <= 0) return null;
    return (
      <div className="usage-row">
        <span className="label">{label}</span>
        <span className="value">{formatCompactTokenCount(tokens)}</span>
      </div>
    );
  };

  const main = usage.main;
  const subagents = usage.subagents;
  const hasSubagents = subagents.totalTokens > 0;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="session-token-usage-trigger"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        title={t("chat.sessionTokenUsage")}
      >
        <span className="token-count">
          {formatCompactTokenCount(usage.total.totalTokens)}
        </span>
        <span className="token-label">{t("chat.sessionTokenUsageLabel")}</span>
      </button>

      {open
        ? portalToBody(
            <div
              ref={popoverRef}
              id={panelId}
              role="dialog"
              aria-label={t("chat.sessionTokenUsage")}
              className="session-token-usage-panel"
              style={{
                position: "fixed",
                left: `${position?.left ?? 0}px`,
                top: `${position?.top ?? 0}px`,
                maxWidth: `${position?.maxWidth ?? 320}px`,
                visibility: position ? "visible" : "hidden",
              }}
            >
              <div className="panel-header">
                <h3>{t("chat.sessionTokenUsage")}</h3>
              </div>

              <div className="panel-content">
                <section className="usage-section">
                  <h4 className="section-title">
                    {t("chat.sessionTokenUsageMain")}
                  </h4>
                  <div className="usage-details">
                    {showScopeRow(
                      t("chat.sessionTokenUsageInput"),
                      main.inputTokens,
                    )}
                    {showScopeRow(
                      t("chat.sessionTokenUsageOutput"),
                      main.outputTokens,
                    )}
                    {showScopeRow(
                      t("chat.sessionTokenUsageCacheRead"),
                      main.cacheReadTokens,
                    )}
                    {showScopeRow(
                      t("chat.sessionTokenUsageCacheWrite"),
                      main.cacheWriteTokens,
                    )}
                    {showScopeRow(
                      t("chat.sessionTokenUsageReasoning"),
                      main.reasoningTokens,
                    )}
                    <div className="usage-row usage-subtotal">
                      <span className="label">
                        {t("chat.sessionTokenUsageTotal")}
                      </span>
                      <span className="value">
                        {formatCompactTokenCount(main.totalTokens)}
                      </span>
                    </div>
                  </div>
                </section>

                {hasSubagents ? (
                  <section className="usage-section">
                    <h4 className="section-title">
                      {t("chat.sessionTokenUsageSubagents")}{" "}
                      <span className="delegation-count">
                        {t("chat.sessionTokenUsageDelegations", {
                          count: subagents.delegationCount,
                        })}
                      </span>
                    </h4>
                    <div className="usage-details">
                      {showScopeRow(
                        t("chat.sessionTokenUsageInput"),
                        subagents.inputTokens,
                      )}
                      {showScopeRow(
                        t("chat.sessionTokenUsageOutput"),
                        subagents.outputTokens,
                      )}
                      {showScopeRow(
                        t("chat.sessionTokenUsageCacheRead"),
                        subagents.cacheReadTokens,
                      )}
                      {showScopeRow(
                        t("chat.sessionTokenUsageCacheWrite"),
                        subagents.cacheWriteTokens,
                      )}
                      {showScopeRow(
                        t("chat.sessionTokenUsageReasoning"),
                        subagents.reasoningTokens,
                      )}
                      <div className="usage-row usage-subtotal">
                        <span className="label">
                          {t("chat.sessionTokenUsageTotal")}
                        </span>
                        <span className="value">
                          {formatCompactTokenCount(subagents.totalTokens)}
                        </span>
                      </div>
                    </div>
                  </section>
                ) : null}

                <div className="usage-total">
                  <span className="total-label">
                    {t("chat.sessionTokenUsageSessionTotal")}
                  </span>
                  <span className="total-value">
                    {formatCompactTokenCount(usage.total.totalTokens)}
                  </span>
                  {main.modelCallCount > 0 ? (
                    <span className="turn-count">
                      {t("chat.sessionTokenUsageCalls", {
                        count: main.modelCallCount,
                      })}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>,
          )
        : null}
    </>
  );
}
