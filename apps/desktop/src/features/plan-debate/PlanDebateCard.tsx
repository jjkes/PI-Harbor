/**
 * The debate as one compact card beside the transcript.
 *
 * The work-panel tab is the full round; this card is the line that keeps the
 * round visible while the user writes the next message — which round, what it
 * is doing, how far that phase got, and the plan on offer — with the single
 * action that opens the full panel. It is drawn in plan mode only and only when
 * a round exists, so an empty session gets no placeholder.
 *
 * Nothing is stored: the round comes from the transcript through the same view
 * the panel reads, and the choice comes from the panel itself, so the card can
 * never show a plan the panel does not have.
 */
import { useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button } from "../../components/ui";
import { planDebateWorkPanelTab } from "../../lib/work-panel-tabs";
import { useAppStore } from "../../stores/app-store";
import { planDebateCard } from "./plan-debate-card";
import {
  planDebateSelectionOf,
  subscribePlanDebateSelection,
} from "./plan-debate-selection";
import { readPlanDebateHandoff } from "./plan-debate-store";
import { PLAN_DEBATE_STATUS_TONE, planDebateView } from "./plan-debate-view";
import "../../styles/plan-debate.css";

/** Open the plan-debate tab; opening the existing tab id just focuses it. */
function openPlanningPanel() {
  useAppStore.getState().openWorkPanelTab(planDebateWorkPanelTab());
}

export function PlanDebateCard({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const messages = useAppStore((state) => state.messages);
  const selection = useSyncExternalStore(
    subscribePlanDebateSelection,
    () => planDebateSelectionOf(sessionId),
    () => null,
  );
  // The handoff marker is the one stored fact; a reload repaints the same card.
  const handoff = useMemo(() => readPlanDebateHandoff(sessionId), [sessionId]);
  const view = useMemo(() => planDebateView(messages, handoff), [messages, handoff]);
  const card = planDebateCard(view.latest, selection);
  if (card === null) return null;
  const items =
    card.progress === null
      ? null
      : t(card.progress.phase === "drafting" ? "planning.drafts" : "planning.objections");

  return (
    <div
      className="plan-debate-card"
      role="group"
      aria-label={t("planning.title")}
      data-plan-debate-card={card.round}
    >
      <div className="plan-debate-card-head">
        <span className="plan-debate-card-round">
          {t("planning.roundTitle", { round: card.round })}
        </span>
        <span className="plan-debate-card-phase" data-plan-debate-card-phase={card.phase.name}>
          {t(`planning.phase.${card.phase.name}`)}
        </span>
        <Badge tone={PLAN_DEBATE_STATUS_TONE[card.phase.status]}>
          {t(`planning.status.${card.phase.status}`)}
        </Badge>
        {card.progress !== null && items !== null ? (
          <span
            className="plan-debate-card-progress"
            data-plan-debate-card-progress={`${card.progress.done}/${card.progress.total}`}
          >
            {t("planning.cardProgress", {
              done: card.progress.done,
              total: card.progress.total,
              items,
            })}
          </span>
        ) : null}
      </div>
      {card.plan !== null ? (
        <p className="plan-debate-card-plan">
          <span className="plan-debate-card-plan-source">
            {card.plan.source === "merged"
              ? t("planning.merged")
              : card.plan.source === "suggestion"
                ? t("planning.suggestion")
                : card.plan.role ?? t("planning.drafts")}
          </span>
          <span className="plan-debate-card-plan-title" title={card.plan.title}>
            {card.plan.title}
          </span>
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="primary"
        className="plan-debate-card-open"
        onClick={openPlanningPanel}
      >
        {t("planning.openPanel")}
      </Button>
    </div>
  );
}
