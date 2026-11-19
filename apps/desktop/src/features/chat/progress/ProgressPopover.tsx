import type { TFunction } from "i18next";
import { useMemo, useState } from "react";
import {
  PROGRESS_INTERVALS,
  type ProgressModelRef,
  type ProgressReport,
} from "@pi-harbor/shared";
import { IconBot, IconChevronDown, IconSearch } from "../../../components/icons";
import { Button, SegmentedControl, SettingsToggle } from "../../../components/ui";
import { useAppStore } from "../../../stores/app-store";
import { progressService } from "./progress-controller";
import { progressAutoPaused, progressNextCheckAt } from "./progress-scheduler";
import {
  isProgressStale,
  progressHeadlineOf,
  progressRemainingOf,
  type ProgressSessionState,
} from "./progress-types";

/**
 * The progress-report popover (design § 6.2–6.6): a header, the controls, one
 * scrolling body, and the history footer. The body switches between the
 * current report, the timeline, and the model list; only one of them renders.
 */
export function ProgressPopover({
  t,
  sessionId,
  state,
  newestMessageId,
}: {
  t: TFunction;
  sessionId: string;
  state: ProgressSessionState;
  newestMessageId: string | null;
  onClose: () => void;
}) {
  const { settings, latest, history, run } = state;
  const stale = isProgressStale(latest, newestMessageId);
  const paused = progressAutoPaused(settings);
  const nextCheck = progressNextCheckAt(settings);

  return (
    <div className="progress-popover-body">
      <header className="progress-popover-header">
        <span className="progress-popover-title">
          {state.modelViewOpen ? t("chat.progressReport.model.viewTitle") : t("chat.progressReport.title")}
        </span>
        <span className="progress-popover-status">
          {paused
            ? t("chat.progressReport.status.autoPaused")
            : settings.autoEnabled
              ? t("chat.progressReport.status.autoEvery", { minutes: settings.intervalMinutes })
              : t("chat.progressReport.status.autoOff")}
        </span>
      </header>

      {state.modelViewOpen ? (
        <ProgressModelView t={t} sessionId={sessionId} state={state} />
      ) : (
        <>
          <div className="progress-popover-controls">
            <button
              type="button"
              className="progress-model-chip"
              onClick={() => progressService.setModelViewOpen(sessionId, true)}
            >
              <IconBot size={13} aria-hidden="true" />
              <span className="progress-model-chip-label">{modelLabel(t, state, sessionId)}</span>
              <IconChevronDown size={12} aria-hidden="true" />
            </button>
            {run ? (
              <Button size="sm" variant="secondary" onClick={() => void progressService.cancel(sessionId)}>
                {t("chat.progressReport.cancel")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                onClick={() => void progressService.collect(sessionId, "manual")}
              >
                {t("chat.progressReport.collectNow")}
              </Button>
            )}
          </div>
          <div className="progress-popover-auto">
            <div className="progress-popover-auto-row">
              <span className="progress-popover-label">{t("chat.progressReport.auto.label")}</span>
              <SettingsToggle
                checked={settings.autoEnabled}
                label={t("chat.progressReport.auto.label")}
                onChange={() =>
                  void progressService.setAutoEnabled(sessionId, !settings.autoEnabled)
                }
              />
            </div>
            {settings.autoEnabled ? (
              <>
                <SegmentedControl
                  label={t("chat.progressReport.auto.intervalLabel")}
                  value={String(settings.intervalMinutes)}
                  role="radiogroup"
                  options={PROGRESS_INTERVALS.map((minutes) => ({
                    value: String(minutes),
                    label: t("chat.progressReport.auto.intervalOption", { minutes }),
                  }))}
                  onChange={(value) =>
                    void progressService.setIntervalMinutes(sessionId, Number(value))
                  }
                />
                <p className="progress-popover-hint">
                  {nextCheck === null
                    ? t("chat.progressReport.auto.nextCheckUnset")
                    : t("chat.progressReport.auto.nextCheck", {
                        time: clock(t, nextCheck),
                      })}
                </p>
              </>
            ) : null}
            {state.lastSkippedAt !== null ? (
              <p className="progress-popover-hint">
                {t("chat.progressReport.auto.skipped", { time: clock(t, state.lastSkippedAt) })}
              </p>
            ) : null}
          </div>

          <div className="progress-popover-scroll">
            {paused ? (
              <div className="progress-alert" role="status">
                <strong>{t("chat.progressReport.auto.pausedTitle", { count: settings.consecutiveFailures })}</strong>
                {state.lastError ? (
                  <p>
                    {t("chat.progressReport.auto.pausedLastError", { message: state.lastError.message })}
                  </p>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void progressService.setAutoEnabled(sessionId, false)}
                >
                  {t("chat.progressReport.resume")}
                </Button>
              </div>
            ) : null}

            {state.lastError && !paused ? (
              <div className="progress-alert" role="alert">
                <strong>
                  {t("chat.progressReport.error.title", { reason: state.lastError.message })}
                </strong>
                <p>{t("chat.progressReport.error.notAffected", { time: clock(t, state.lastError.at) })}</p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void progressService.collect(sessionId, "manual")}
                >
                  {t("chat.progressReport.retry")}
                </Button>
              </div>
            ) : null}

            {history.open ? (
              <ProgressHistory t={t} sessionId={sessionId} state={state} />
            ) : run && !latest ? (
              <div className="progress-state">
                <span className="tool-spinner" aria-hidden="true" />
                <strong>{t("chat.progressReport.running.title")}</strong>
                <p>{t("chat.progressReport.running.body")}</p>
              </div>
            ) : latest ? (
              <ProgressReportCard t={t} report={latest} stale={stale} />
            ) : (
              <div className="progress-state">
                <strong>{t("chat.progressReport.empty.title")}</strong>
                <p>{t("chat.progressReport.empty.body")}</p>
              </div>
            )}
          </div>

          <footer className="progress-popover-footer">
            <Button
              size="sm"
              variant="ghost"
              disabled={history.reports.length === 0}
              onClick={() => void progressService.toggleHistory(sessionId)}
            >
              {history.open
                ? t("chat.progressReport.history.hide")
                : t("chat.progressReport.history.toggle", { count: history.reports.length })}
            </Button>
          </footer>
        </>
      )}
    </div>
  );
}

function clock(t: TFunction, at: number): string {
  return new Intl.DateTimeFormat(t("chat.progressReport.localeTag", { defaultValue: "en" }), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));
}

/** "Session · gpt-4.1-mini" or the explicit pair the user picked. */
function modelLabel(t: TFunction, state: ProgressSessionState, sessionId: string): string {
  const model = state.settings.model;
  if ("followSession" in model) {
    const sessionModel = useAppStore.getState().sessions.find((row) => row.id === sessionId)?.modelId;
    return sessionModel
      ? t("chat.progressReport.model.followSessionChip", { model: sessionModel })
      : t("chat.progressReport.model.followSession");
  }
  return model.modelId;
}

function ProgressReportCard({
  t,
  report,
  stale,
}: {
  t: TFunction;
  report: ProgressReport;
  stale: boolean;
}) {
  const remaining = progressRemainingOf(report);
  const sections = [
    { key: "completed", label: t("chat.progressReport.section.completed"), items: report.body?.completed ?? [], dot: "progress-dot-done" },
    { key: "inProgress", label: t("chat.progressReport.section.inProgress"), items: report.body?.inProgress ?? [], dot: "progress-dot-now" },
    { key: "next", label: t("chat.progressReport.section.next"), items: report.body?.next ?? [], dot: "progress-dot-next" },
  ] as const;

  if (report.status === "unparsed") {
    return (
      <div className="progress-report">
        <p className="progress-report-meta">
          <span>{clock(t, report.createdAt)}</span>
          <span>{t(`chat.progressReport.meta.trigger.${report.trigger}`)}</span>
        </p>
        <div className="progress-alert" role="status">
          <strong>{t("chat.progressReport.unparsed.title")}</strong>
          <p>{t("chat.progressReport.unparsed.body")}</p>
        </div>
        <pre className="progress-report-raw">{report.raw ?? ""}</pre>
      </div>
    );
  }

  return (
    <div className="progress-report">
      <p className="progress-report-meta">
        <span>{clock(t, report.createdAt)}</span>
        <span>{t(`chat.progressReport.meta.trigger.${report.trigger}`)}</span>
        <span>
          {t("chat.progressReport.meta.coverage", {
            included: report.includedMessages,
            total: report.messageCount,
          })}
        </span>
        {stale ? <span className="progress-chip">{t("chat.progressReport.meta.stale")}</span> : null}
      </p>
      {sections.map((section) => (
        <section key={section.key} className="progress-section">
          <h3 className="progress-section-title">{section.label}</h3>
          {section.items.length === 0 ? (
            <p className="progress-section-empty">{t("chat.progressReport.section.empty")}</p>
          ) : (
            <ul className="progress-list">
              {section.items.map((item, index) => (
                <li key={`${section.key}-${index}`}>
                  <span className={`progress-dot ${section.dot}`} aria-hidden="true" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <section className="progress-remaining">
        <h3 className="progress-section-title">{t("chat.progressReport.section.remaining")}</h3>
        <p className="progress-remaining-numbers">
          {remaining.steps === null
            ? t("chat.progressReport.remaining.unknown")
            : t("chat.progressReport.remaining.steps", { count: remaining.steps })}
          {" · "}
          {remaining.minutes === null
            ? t("chat.progressReport.remaining.unknown")
            : t("chat.progressReport.remaining.minutes", { count: remaining.minutes })}
        </p>
        <p className="progress-remaining-meta">
          {report.body?.confidence
            ? t(`chat.progressReport.remaining.confidence.${report.body.confidence}`)
            : null}
          {report.body?.confidence ? " · " : null}
          {t("chat.progressReport.remaining.note")}
        </p>
      </section>
    </div>
  );
}

function ProgressHistory({
  t,
  sessionId,
  state,
}: {
  t: TFunction;
  sessionId: string;
  state: ProgressSessionState;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const { reports, cursor, loading } = state.history;
  return (
    <div className="progress-history">
      <p className="progress-history-heading">
        {t("chat.progressReport.history.heading", { count: reports.length })}
      </p>
      <ul className="progress-history-list">
        {reports.map((report) => {
          const headline = progressHeadlineOf(report);
          const remaining = progressRemainingOf(report);
          const open = expanded === report.id;
          return (
            <li key={report.id}>
              <button
                type="button"
                className="progress-history-item"
                aria-expanded={open}
                onClick={() => setExpanded(open ? null : report.id)}
              >
                <span
                  className={`progress-dot ${report.status === "ok" ? "progress-dot-done" : "progress-dot-hollow"}`}
                  aria-hidden="true"
                />
                <span className="progress-history-time">{clock(t, report.createdAt)}</span>
                <span className="progress-history-trigger">
                  {t(`chat.progressReport.meta.trigger.${report.trigger}`)}
                </span>
                <span className="progress-history-line">
                  {report.status === "unparsed"
                    ? t("chat.progressReport.history.unparsedLine")
                    : headline
                      ? t("chat.progressReport.history.inProgressLine", { text: headline })
                      : t("chat.progressReport.section.empty")}
                </span>
                <span className="progress-history-remaining">
                  {t("chat.progressReport.history.remainingLine", {
                    steps: remaining.steps ?? "?",
                    minutes: remaining.minutes ?? "?",
                  })}
                </span>
              </button>
              {open ? (
                <div className="progress-history-detail">
                  <ProgressReportCard t={t} report={report} stale={false} />
                  <p className="progress-report-meta">
                    <span>
                      {report.providerId}/{report.modelId}
                    </span>
                    {report.usage ? (
                      <span>
                        {t("chat.progressReport.history.usage", {
                          input: report.usage.inputTokens,
                          output: report.usage.outputTokens,
                        })}
                      </span>
                    ) : null}
                  </p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {cursor !== null ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => void progressService.loadMore(sessionId)}
        >
          {t("chat.progressReport.history.loadMore")}
        </Button>
      ) : null}
    </div>
  );
}

function ProgressModelView({
  t,
  sessionId,
  state,
}: {
  t: TFunction;
  sessionId: string;
  state: ProgressSessionState;
}) {
  const [query, setQuery] = useState("");
  const providers = useAppStore((store) => store.providers);
  const providerModels = useAppStore((store) => store.providerModels);
  const sessionModelId = useAppStore(
    (store) => store.sessions.find((row) => row.id === sessionId)?.modelId,
  );
  const options = useMemo(() => {
    const rows: { providerId: string; providerName: string; modelId: string }[] = [];
    for (const provider of providers) {
      if (!provider.enabled) continue;
      for (const model of providerModels[provider.id] ?? []) {
        const modelId = model.modelId;
        if (modelId.length === 0) continue;
        if (query.length > 0 && !`${provider.name} ${modelId}`.toLowerCase().includes(query.toLowerCase())) {
          continue;
        }
        rows.push({ providerId: provider.id, providerName: provider.name, modelId });
      }
    }
    return rows.slice(0, 60);
  }, [providers, providerModels, query]);
  const current: ProgressModelRef = state.settings.model;

  return (
    <div className="progress-model-view">
      <div className="progress-popover-controls">
        <Button size="sm" variant="ghost" onClick={() => progressService.setModelViewOpen(sessionId, false)}>
          {t("chat.progressReport.model.back")}
        </Button>
      </div>
      <label className="progress-model-search">
        <IconSearch size={13} aria-hidden="true" />
        <span className="sr-only">{t("chat.progressReport.model.search")}</span>
        <input
          type="text"
          value={query}
          placeholder={t("chat.progressReport.model.search")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <ul className="progress-model-list">
        <li>
          <button
            type="button"
            className={`progress-model-row${"followSession" in current ? " is-selected" : ""}`}
            aria-selected={"followSession" in current}
            onClick={() => {
              void progressService.setModel(sessionId, { followSession: true });
              progressService.setModelViewOpen(sessionId, false);
            }}
          >
            <span>{t("chat.progressReport.model.followSession")}</span>
            {sessionModelId ? <span className="progress-model-secondary">{sessionModelId}</span> : null}
          </button>
        </li>
        {options.map((option) => {
          const selected =
            !("followSession" in current) &&
            current.providerId === option.providerId &&
            current.modelId === option.modelId;
          return (
            <li key={`${option.providerId}/${option.modelId}`}>
              <button
                type="button"
                className={`progress-model-row${selected ? " is-selected" : ""}`}
                aria-selected={selected}
                onClick={() => {
                  void progressService.setModel(sessionId, {
                    providerId: option.providerId,
                    modelId: option.modelId,
                  });
                  progressService.setModelViewOpen(sessionId, false);
                }}
              >
                <span>{option.modelId}</span>
                <span className="progress-model-secondary">{option.providerName}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="progress-popover-hint">{t("chat.progressReport.model.egress")}</p>
    </div>
  );
}
