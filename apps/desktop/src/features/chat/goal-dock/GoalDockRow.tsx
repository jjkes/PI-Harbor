import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui";
import { IconTarget } from "../../../components/icons";
import { preferredFileWorkPanelTab } from "../../../lib/work-panel-tabs";
import { useAppStore } from "../../../stores/app-store";
import type { DockGoal } from "./dock-goal";

/**
 * The composer dock's Goal line: the approved Goal the session is executing.
 *
 * It sits outside the dock's disclosure, so a collapsed dock still names the
 * goal and whether its run is queued or in progress; the checklist under the
 * header carries the step progress. The title opens the approved contract in
 * the work panel, as the transcript's Goal card does; the dock mounts only
 * where local tools are allowed, which is the card's own condition for that.
 * A phase change is not announced: the transcript reports the run, and a
 * second live region would say it twice.
 */
export function GoalDockRow({ sessionId, goal }: { sessionId: string; goal: DockGoal }) {
  const { t } = useTranslation();
  const openTab = useAppStore((state) => state.openWorkPanelTabForSession);
  const views = useAppStore((state) => state.pluginViews);
  const title = goal.title || t("goal.untitled");
  const path = goal.artifactPath;
  return (
    <div className="dock-goal" data-phase={goal.phase}>
      <span className="dock-header-symbol" aria-hidden>
        <IconTarget size={14} />
      </span>
      <span className="dock-goal-label">{t("taskDock.goal")}</span>
      {path ? (
        <Button
          type="button"
          variant="ghost"
          className="dock-goal-title"
          title={t("goal.openArtifactLabel", { path })}
          onClick={() => openTab(sessionId, preferredFileWorkPanelTab(path, views))}
        >
          <span className="dock-goal-text">{title}</span>
        </Button>
      ) : (
        <span className="dock-goal-title">
          <span className="dock-goal-text">{title}</span>
        </span>
      )}
      {goal.phase === "running" ? (
        <span className="dock-live dock-goal-state">
          <span className="dock-live-dot" aria-hidden />
          <span>{t("taskDock.goalRunning")}</span>
        </span>
      ) : (
        <span className="dock-goal-state">{t("taskDock.goalQueued")}</span>
      )}
    </div>
  );
}
