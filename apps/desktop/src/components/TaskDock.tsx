import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SessionTodo } from "@pi-harbor/shared";
import type { BackgroundTaskOutput, BackgroundTaskSummary } from "../lib/api";
import { Button } from "./ui";
import { IconChevronDown, IconChevronUp } from "./icons";
import { TodoPanel, todoProgress } from "./TodoDock";
import { useAppStore } from "../stores/app-store";
import { useBackgroundTasks } from "../features/chat/background-tasks/useBackgroundTasks";
import { useDockView } from "../features/chat/background-tasks/useDockView";
import { useSessionTodosRecovery } from "../features/chat/todos/useSessionTodosRecovery";
import { SubagentDockPanel } from "../features/chat/subagent-dock/SubagentDockPanel";
import { useSessionDelegations } from "../features/chat/subagent-dock/useSessionDelegations";
import { GoalDockRow } from "../features/chat/goal-dock/GoalDockRow";
import { dockGoalFor } from "../features/chat/goal-dock/dock-goal";

/**
 * The composer's shared container: the session's current Goal, its todo list,
 * its background tasks, and its subagents.
 *
 * Layout: one container, one header. The header carries the progress summary, a
 * live count, the tab list and the chevron; collapsing hides only the panels, so
 * the tabs stay reachable while collapsed. A single tab whose side is empty is
 * not rendered, and a container with nothing to show renders nothing at all.
 *
 * A Goal being executed sits above the header and outside the disclosure, so a
 * collapsed container still names the goal the work serves; a Goal alone is
 * one status line with nothing to expand.
 *
 * The container owns the disclosure and the tab choice; the panels only render
 * their content. Filtering and removal live in `useBackgroundTasks`, the
 * session's delegates in `useSessionDelegations`, and the tab, the collapse and
 * the badges in `useDockView`, so this file stays presentational.
 */
export function TaskDock({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const snapshot = useAppStore((state) => state.sessionTodos[sessionId]);
  const checkpoint = useAppStore((state) => state.planCheckpoints[sessionId]);
  const panelId = useId();

  // The container now owns the todo read, so it recovers the snapshot the same
  // way the standalone dock did.
  useSessionTodosRecovery(sessionId);

  const todos = snapshot?.todos ?? [];
  const hasTodo = todos.length > 0;

  const progress = useMemo(
    () => (hasTodo ? todoProgress(todos, t) : null),
    [hasTodo, todos, t],
  );

  // Pending approvals stay on the approval bar and settled runs on the
  // transcript card, so only an executing Goal reaches the dock.
  const goal = useMemo(() => dockGoalFor(checkpoint), [checkpoint]);

  const {
    tasks,
    sessionTasks,
    registryTasks,
    expandedId,
    output,
    toggleOutput,
    stop,
    remove,
    error,
    stoppingIds,
  } = useBackgroundTasks(sessionId);
  // Every delegate of the session, drawn as one graph on the subagents tab.
  const delegations = useSessionDelegations(sessionId);
  // The container owns the todo read, so it hands the view state every side:
  // one tab rule then decides both the visible panel and whether new work
  // needs a badge.
  const {
    activeTab,
    openTasksTab,
    openTodoTab,
    openSubagentsTab,
    collapsed,
    setCollapsed,
    badge,
    badgeText,
    subagentBadge,
    subagentBadgeText,
  } = useDockView(sessionId, {
    todos,
    registryTasks,
    sessionTasks,
    visibleTasks: tasks,
    subagents: delegations.nodes,
  });

  // The task side is the rows its panel lists, so registry history, a row past
  // its post-exit grace window and a removed row keep no tab, header count or
  // container of their own.
  const hasTasks = tasks.length > 0;
  const hasSubagents = delegations.items.length > 0;
  const running = tasks.filter((task) => task.state === "running").length;
  const runningSubagents = delegations.summary.running;
  const showTabs = [hasTodo, hasTasks, hasSubagents].filter(Boolean).length > 1;

  if (!hasTodo && !hasTasks && !hasSubagents && !error) {
    return goal ? (
      <div className="dock">
        <GoalDockRow sessionId={sessionId} goal={goal} />
      </div>
    ) : null;
  }

  // The tab rule only lands on a side with content, so a remembered tab that
  // lost its content falls back to another side.
  const tab = activeTab;

  // Without a checklist, the header describes the side on screen.
  const subagentHeader = !progress && tab === "subagents";
  const headerText = progress
    ? progress.label
    : subagentHeader
      ? t("chat.subagentCount", { count: delegations.summary.total })
      : t("backgroundTasks.headerCount", { count: tasks.length });
  const liveCount = subagentHeader ? runningSubagents : running;

  return (
    <div className={`dock${collapsed ? "" : " is-expanded"}`}>
      {goal ? <GoalDockRow sessionId={sessionId} goal={goal} /> : null}
      <div className="dock-header">
        <button
          type="button"
          className="dock-header-main"
          aria-expanded={!collapsed}
          aria-controls={panelId}
          aria-label={
            collapsed
              ? t("taskDock.expand", { label: headerText })
              : t("taskDock.collapse", { label: headerText })
          }
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className="dock-header-symbol" aria-hidden>
            {progress ? progress.symbol : "\u25d0"}
          </span>
          <span className="dock-header-copy">
            <span className="dock-header-text">{headerText}</span>
            {progress?.current ? (
              <span
                className={`dock-header-current${collapsed ? " todo-dock-shimmer" : ""}`}
                title={progress.current.content}
              >
                {progress.current.content}
              </span>
            ) : null}
          </span>
          {liveCount > 0 ? (
            <span className="dock-live">
              <span className="dock-live-dot" aria-hidden />
              <span className="dock-live-label">
                {t("taskDock.runningCount", { count: liveCount })}
              </span>
            </span>
          ) : null}
        </button>

        {showTabs ? (
          <div className="dock-tablist is-inline" role="tablist" aria-label={t("taskDock.title")}>
            {hasTodo ? (
              <button
                type="button"
                role="tab"
                id={`${panelId}-todo-tab`}
                aria-controls={`${panelId}-todo`}
                aria-selected={tab === "todo"}
                tabIndex={tab === "todo" ? 0 : -1}
                className={`dock-tab${tab === "todo" ? " is-active" : ""}`}
                onClick={openTodoTab}
              >
                {t("taskDock.tabTodo")}
              </button>
            ) : null}
            {hasTasks ? (
              <button
                type="button"
                role="tab"
                id={`${panelId}-tasks-tab`}
                aria-controls={`${panelId}-tasks`}
                aria-selected={tab === "tasks"}
                tabIndex={tab === "tasks" ? 0 : -1}
                className={`dock-tab${tab === "tasks" ? " is-active" : ""}`}
                onClick={openTasksTab}
              >
                {t("taskDock.tabTasks")}
                {badge > 0 ? (
                  <span
                    className="dock-tab-badge"
                    aria-label={t("taskDock.newTasks", { count: badge })}
                  >
                    {badgeText}
                  </span>
                ) : null}
              </button>
            ) : null}
            {hasSubagents ? (
              <button
                type="button"
                role="tab"
                id={`${panelId}-subagents-tab`}
                aria-controls={`${panelId}-subagents`}
                aria-selected={tab === "subagents"}
                tabIndex={tab === "subagents" ? 0 : -1}
                className={`dock-tab${tab === "subagents" ? " is-active" : ""}`}
                onClick={openSubagentsTab}
              >
                {t("taskDock.tabSubagents")}
                {/* Running work outranks the badge: a live count already says
                    there is something to look at. The number stays short so
                    the inline tab list never wraps. */}
                {runningSubagents > 0 ? (
                  <span
                    className="dock-live"
                    aria-label={t("taskDock.runningCount", { count: runningSubagents })}
                  >
                    <span className="dock-live-dot" aria-hidden />
                    {runningSubagents}
                  </span>
                ) : subagentBadge > 0 ? (
                  <span
                    className="dock-tab-badge"
                    aria-label={t("taskDock.newSubagents", { count: subagentBadge })}
                  >
                    {subagentBadgeText}
                  </span>
                ) : null}
              </button>
            ) : null}
          </div>
        ) : null}

        <Button
          type="button"
          variant="ghost"
          className="dock-toggle"
          aria-expanded={!collapsed}
          aria-controls={panelId}
          aria-label={
            collapsed
              ? t("taskDock.expand", { label: headerText })
              : t("taskDock.collapse", { label: headerText })
          }
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
        </Button>
      </div>

      <div id={panelId} className="dock-content" aria-hidden={collapsed}>
        <div className="dock-clip">
          {error ? (
            <p className="background-task-error" role="alert">
              {t(`backgroundTasks.${error === "remove" ? "removeFailed" : `${error}Failed`}`)}
            </p>
          ) : null}
          {hasTodo ? (
            <TodoPanel
              todos={todos}
              listId={`${panelId}-todo`}
              interactive={!collapsed && tab === "todo"}
            />
          ) : null}
          {hasTasks ? (
            <TaskPanel
              listId={`${panelId}-tasks`}
              hidden={tab !== "tasks"}
              tasks={tasks}
              expandedId={expandedId}
              output={output}
              stoppingIds={stoppingIds}
              onToggleOutput={toggleOutput}
              onStop={(id) => void stop(id)}
              onRemove={remove}
            />
          ) : null}
          {hasSubagents ? (
            <SubagentDockPanel
              listId={`${panelId}-subagents`}
              delegations={delegations}
              interactive={!collapsed && tab === "subagents"}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Task rows. `Output` and `Stop`/`Remove` sit outside the row body so the
 * clickable band never swallows a control, and the whole row stays one line:
 * a long command ellipsizes with its full text in `title`.
 */
function TaskPanel({
  listId,
  hidden,
  tasks,
  expandedId,
  output,
  stoppingIds,
  onToggleOutput,
  onStop,
  onRemove,
}: {
  listId: string;
  /** True while another tab's panel is the one on screen. */
  hidden: boolean;
  tasks: readonly BackgroundTaskSummary[];
  expandedId: string | null;
  output: BackgroundTaskOutput | null;
  stoppingIds: ReadonlySet<string>;
  onToggleOutput: (id: string) => void;
  onStop: (id: string) => void;
  onRemove: (id: string) => boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      id={listId}
      className="dock-panel"
      role="tabpanel"
      aria-labelledby={`${listId}-tab`}
      hidden={hidden}
    >
      <div className="task-list">
        {tasks.map((task) => {
          const running = task.state === "running";
          const stopping = stoppingIds.has(task.id);
          const expanded = expandedId === task.id;
          const meta = [
            t(`backgroundTasks.${task.state}`),
            running ? formatElapsed(task.elapsedMs) : null,
            task.exitCode !== undefined ? String(task.exitCode) : null,
          ].filter(Boolean).join(" \u00b7 ");
          return (
            <div
              key={task.id}
              className="task-row"
              data-state={task.state}
              data-expanded={expanded ? "true" : undefined}
            >
              <div className="task-band">
                <div
                  className="task-main"
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  onClick={() => onToggleOutput(task.id)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onToggleOutput(task.id);
                    }
                  }}
                >
                  <span className="task-state" aria-hidden />
                  <span className="task-command" title={task.command}>{task.command}</span>
                  <span className="task-meta">{meta}</span>
                </div>
                {running ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="task-action is-stop"
                    onClick={() => onStop(task.id)}
                    disabled={stopping}
                  >
                    {stopping ? t("backgroundTasks.stopping") : t("backgroundTasks.stop")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="task-action"
                    onClick={() => onRemove(task.id)}
                  >
                    {t("backgroundTasks.dismiss")}
                  </Button>
                )}
              </div>
              {expanded ? (
                <pre className="task-output">{formatOutput(output, task.id)}</pre>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** Characters shown when a finished task produced no output at all. */
const NO_OUTPUT = "\u2014";

function formatOutput(output: BackgroundTaskOutput | null, id: string): string {
  if (!output || output.id !== id) return "";
  const tail = (text: string, limit: number) =>
    text.length > limit ? `\u2026${text.slice(-limit)}` : text;
  return [tail(output.stdout, 8000), tail(output.stderr, 4000)]
    .filter((part) => part.length > 0)
    .join("\n---\n")
    .trim() || NO_OUTPUT;
}

export type { SessionTodo };
