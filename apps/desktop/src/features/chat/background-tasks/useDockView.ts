import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SessionTodo } from "@pi-harbor/shared";
import type { BackgroundTaskSummary } from "../../../lib/api";
import {
  type DockSides,
  type DockSubagentNode,
  EMPTY_DOCK_VIEW,
  type DockTab,
  type DockViewState,
  badgeLabel,
  clearBadge,
  clearSubagentBadge,
  observeSessionSubagents,
  observeSessionTasks,
  pruneDockView,
  resolveDockTabFor,
  selectTab,
  sessionDockState,
  subagentsPanelVisible,
  tasksPanelVisible,
  toggleCollapsed,
} from "./dock-state";
import { subscribeDockReveal, takeDockReveal } from "./dock-reveal";

/** How many sessions keep the subagents they were already shown. */
const SEEN_SUBAGENT_SESSIONS = 32;

/**
 * Every side of the container, described the way the tab rule expects.
 *
 * Both the render rule and the badge rules consume this one description, so
 * they cannot disagree about which panel is on screen. The task side is the
 * rows the panel lists, so a task it no longer lists keeps no tab.
 */
function sidesFor(
  tasks: readonly BackgroundTaskSummary[],
  todos: readonly SessionTodo[],
  subagents: readonly DockSubagentNode[],
  teamEnabled: boolean,
): DockSides {
  let runningTasks = 0;
  for (const task of tasks) {
    if (task.state === "running") runningTasks += 1;
  }
  return {
    hasTodo: todos.length > 0,
    hasTasks: tasks.length > 0,
    runningTasks,
    inProgressTodos: todos.filter((todo) => todo.status === "in_progress").length,
    hasSubagents: subagents.length > 0,
    runningSubagents: subagents.filter((node) => node.active).length,
    teamEnabled,
  };
}

/** Remember a session's seen subagents, keeping only the most recent sessions. */
function rememberSubagents(
  seen: Map<string, Set<string>>,
  sessionId: string,
  ids: Set<string>,
): void {
  seen.delete(sessionId);
  seen.set(sessionId, ids);
  if (seen.size <= SEEN_SUBAGENT_SESSIONS) return;
  const oldest = seen.keys().next().value;
  if (oldest !== undefined) seen.delete(oldest);
}

/** What each side of the container currently holds. */
export type DockViewInput = {
  /** The session's checklist, as the container read it. */
  todos: readonly SessionTodo[];
  /** The registry's last snapshot, across every session. */
  registryTasks: readonly BackgroundTaskSummary[];
  /** The registry's tasks for the session on screen; the badge counts these. */
  sessionTasks: readonly BackgroundTaskSummary[];
  /**
   * The session's tasks the panel lists: running ones, finished ones inside
   * their post-exit grace window, and the row whose output is open. The tab
   * rule reads this list, so registry history and removed rows keep no tab.
   */
  visibleTasks: readonly BackgroundTaskSummary[];
  /**
   * The session's subagents, one per graph node. A new array is read as a new
   * snapshot, so keep it stable while no node appeared or settled.
   */
  subagents: readonly DockSubagentNode[];
  /**
   * Team is on for the session, which keeps the Subagent page offered while the
   * graph is still empty.
   */
  teamEnabled?: boolean;
};

/**
 * The shared container's view state: the tab on screen, the collapse, and the
 * badges for work that appeared while it was not being looked at.
 *
 * The container owns this, not a side: each side only reports what it holds,
 * so the registry hook never learns about tabs and a new side joins the tab
 * rule here. Everything stays renderer memory, as `dock-state.ts` describes.
 */
export function useDockView(
  sessionId: string | null | undefined,
  { todos, registryTasks, sessionTasks, visibleTasks, subagents, teamEnabled = false }: DockViewInput,
) {
  const [dockView, setDockView] = useState<DockViewState>(EMPTY_DOCK_VIEW);
  // Ids already folded into the badge, per session, so a re-read of the same
  // snapshot cannot count the same task twice.
  const knownIds = useRef(new Map<string, Set<string>>());
  // The same for subagents. These outlive the container's per-session entry,
  // so returning to a session never announces a subagent it already showed.
  const knownSubagents = useRef(new Map<string, Set<string>>());
  const sides = sidesFor(visibleTasks, todos, subagents, teamEnabled);
  const dock = sessionDockState(dockView, sessionId);

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

  // Fold the session's subagents the same way. A subagent counts once, when it
  // is first seen starting; while the container is collapsed that also turns
  // the container to the graph, so opening it shows the new work.
  useLayoutEffect(() => {
    if (!sessionId) return;
    const seen = knownSubagents.current.get(sessionId) ?? new Set<string>();
    setDockView((current) => {
      const folded = observeSessionSubagents(current, sessionId, subagents, {
        knownIds: seen,
        subagentsVisible: subagentsPanelVisible(sessionDockState(current, sessionId), sides),
      });
      rememberSubagents(knownSubagents.current, sessionId, folded.knownIds);
      return folded.view;
    });
  }, [sessionId, subagents]);

  // The subagent badge is seen once the graph is on screen, however it got
  // there: the container turns to the graph on its own, so waiting for a click
  // on the tab would leave a badge on the panel already in view.
  const subagentsVisible = subagentsPanelVisible(dock, sides);
  const unseenSubagents = dock.newSubagentCount;
  useLayoutEffect(() => {
    if (!sessionId || !subagentsVisible || unseenSubagents === 0) return;
    setDockView((current) => clearSubagentBadge(current, sessionId));
  }, [sessionId, subagentsVisible, unseenSubagents]);

  // The task badge counts commands that started while their tab was not on
  // screen. Once the side has no row left, nothing it counted can still be
  // looked at, so the next command starts the count over.
  const hasTaskRows = sides.hasTasks;
  const unseenTasks = dock.newCount;
  useLayoutEffect(() => {
    if (!sessionId || hasTaskRows || unseenTasks === 0) return;
    setDockView((current) => clearBadge(current, sessionId));
  }, [sessionId, hasTaskRows, unseenTasks]);

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

  const openSubagentsTab = useCallback(() => {
    if (!sessionId) return;
    setDockView((current) => clearSubagentBadge(selectTab(current, sessionId, "subagents"), sessionId));
  }, [sessionId]);

  // A one-shot request (Team switched on, a transcript summary clicked) opens
  // the graph and expands the container. The dock can mount after the request
  // was made, so a pending request is also taken when the dock mounts or the
  // session changes.
  useLayoutEffect(() => {
    if (!sessionId) return;
    const take = () => {
      if (takeDockReveal(sessionId)) openSubagentsTab();
    };
    take();
    return subscribeDockReveal(take);
  }, [sessionId, openSubagentsTab]);

  // The collapse belongs to the container, so it is written even before a
  // session is on screen and never reset by a session switch.
  const setCollapsed = useCallback((collapsed: boolean) => {
    setDockView((current) => (current.collapsed === collapsed ? current : toggleCollapsed(current)));
  }, []);

  const activeTab: DockTab = resolveDockTabFor(dock, sides);

  return {
    activeTab,
    openTasksTab,
    openTodoTab,
    openSubagentsTab,
    collapsed: dock.collapsed,
    setCollapsed,
    badge: dock.newCount,
    badgeText: badgeLabel(dock.newCount),
    subagentBadge: dock.newSubagentCount,
    subagentBadgeText: badgeLabel(dock.newSubagentCount),
  };
}
