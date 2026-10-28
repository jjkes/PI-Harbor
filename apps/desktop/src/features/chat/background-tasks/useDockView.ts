import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SessionTodo } from "@pi-harbor/shared";
import type { BackgroundTaskSummary } from "../../../lib/api";
import {
  type DockSides,
  EMPTY_DOCK_VIEW,
  type DockTab,
  type DockViewState,
  badgeLabel,
  clearBadge,
  observeSessionTasks,
  pruneDockView,
  resolveDockTabFor,
  selectTab,
  sessionDockState,
  tasksPanelVisible,
  toggleCollapsed,
} from "./dock-state";

/**
 * Every side of the container, described the way the tab rule expects.
 *
 * Both the render rule and the badge rule consume this one description, so
 * they cannot disagree about which panel is on screen.
 */
function sidesFor(
  sessionTasks: readonly BackgroundTaskSummary[],
  todos: readonly SessionTodo[],
): DockSides {
  let runningTasks = 0;
  for (const task of sessionTasks) {
    if (task.state === "running") runningTasks += 1;
  }
  return {
    hasTodo: todos.length > 0,
    hasTasks: sessionTasks.length > 0,
    runningTasks,
    inProgressTodos: todos.filter((todo) => todo.status === "in_progress").length,
  };
}

/** What each side of the container currently holds. */
export type DockViewInput = {
  /** The session's checklist, as the container read it. */
  todos: readonly SessionTodo[];
  /** The registry's last snapshot, across every session. */
  registryTasks: readonly BackgroundTaskSummary[];
  /** The registry's tasks for the session on screen. */
  sessionTasks: readonly BackgroundTaskSummary[];
};

/**
 * The shared container's view state: the tab on screen, the collapse, and the
 * badge for work that appeared while it was not being looked at.
 *
 * The container owns this, not a side: each side only reports what it holds,
 * so the registry hook never learns about tabs and a new side joins the tab
 * rule here. Everything stays renderer memory, as `dock-state.ts` describes.
 */
export function useDockView(
  sessionId: string | null | undefined,
  { todos, registryTasks, sessionTasks }: DockViewInput,
) {
  const [dockView, setDockView] = useState<DockViewState>(EMPTY_DOCK_VIEW);
  // Ids already folded into the badge, per session, so a re-read of the same
  // snapshot cannot count the same task twice.
  const knownIds = useRef(new Map<string, Set<string>>());
  const sides = sidesFor(sessionTasks, todos);

  // Fold each registry snapshot into the badge for the session on screen: a
  // task is "new" only while the tasks panel is not the one being looked at.
  // The fold is keyed on the snapshot alone, as the poll that produced it was,
  // and runs before paint so a new row never shows without its badge.
  useLayoutEffect(() => {
    if (!sessionId) return;
    const seen = knownIds.current.get(sessionId) ?? new Set<string>();
    setDockView((current) => {
      const folded = observeSessionTasks(current, sessionId, sessionTasks, {
        knownIds: seen,
        tasksVisible: tasksPanelVisible(sessionDockState(current, sessionId), sides),
      });
      knownIds.current.set(sessionId, folded.knownIds);
      return folded.view;
    });
  }, [registryTasks]);

  // Keep the per-session maps bounded as sessions come and go.
  useEffect(() => {
    const live = new Set(registryTasks.map((task) => task.sessionId));
    if (sessionId) live.add(sessionId);
    setDockView((current) => pruneDockView(current, live));
    for (const id of knownIds.current.keys()) {
      if (!live.has(id)) knownIds.current.delete(id);
    }
  }, [registryTasks, sessionId]);

  /**
   * Enter the tasks tab: this is the only path that clears the badge.
   *
   * `selectTab` also expands the container, so a click on a tab while collapsed
   * lands on a visible panel instead of appearing to do nothing.
   */
  const openTasksTab = useCallback(() => {
    if (!sessionId) return;
    setDockView((current) => clearBadge(selectTab(current, sessionId, "tasks"), sessionId));
  }, [sessionId]);

  const openTodoTab = useCallback(() => {
    if (!sessionId) return;
    setDockView((current) => selectTab(current, sessionId, "todo"));
  }, [sessionId]);

  // The collapse belongs to the container, so it is written even before a
  // session is on screen and never reset by a session switch.
  const setCollapsed = useCallback((collapsed: boolean) => {
    setDockView((current) => (current.collapsed === collapsed ? current : toggleCollapsed(current)));
  }, []);

  const dock = sessionDockState(dockView, sessionId);
  const activeTab: DockTab = resolveDockTabFor(dock, sides);

  return {
    activeTab,
    openTasksTab,
    openTodoTab,
    collapsed: dock.collapsed,
    setCollapsed,
    badge: dock.newCount,
    badgeText: badgeLabel(dock.newCount),
  };
}
