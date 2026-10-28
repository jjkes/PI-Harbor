import type { BackgroundTaskSummary } from "../../../lib/api";

/**
 * View state for the composer's shared container: the session's checklist,
 * its background tasks, and its subagents.
 *
 * Everything here is renderer memory: never persisted and never sent to the
 * host. The registry and the transcript stay the source of truth for the work
 * itself, so switching a tab or collapsing the container cannot affect it.
 *
 * Reading follows the container's lifetime, not the session's, because the
 * container is one surface the user configures once: the tab choice is
 * remembered per session, while the collapse is one container-wide condition
 * that survives switching sessions. Anything else would reopen a container the
 * user had closed the moment they looked at another session.
 */
export type DockTab = "todo" | "tasks" | "subagents";

export type DockSessionState = {
  /** Tab the user last chose, or `null` while nothing was chosen yet. */
  readonly chosenTab: DockTab | null;
  /**
   * Tab the container turned to on its own, or `null`. It wins over
   * `chosenTab` until the user picks a tab again: a subagent that starts while
   * the container is collapsed makes its graph what opening the container
   * shows.
   */
  readonly autoTab: DockTab | null;
  /** New tasks counted since the tasks tab was last entered (the badge). */
  readonly newCount: number;
  /** Subagents that started while their graph was not on screen. */
  readonly newSubagentCount: number;
  /** Container-wide collapse; every tab shares it. */
  readonly collapsed: boolean;
};

export type DockViewState = Readonly<{
  /** Per-session entry: the tab choice and the badges. */
  sessions: Readonly<Record<string, DockSessionState>>;
  /** Container-wide collapse; independent of whichever session is on screen. */
  collapsed: boolean;
}>;

/** The container starts collapsed: the composer keeps its room by default. */
export const EMPTY_DOCK_VIEW: DockViewState = { sessions: {}, collapsed: true };

export const EMPTY_SESSION_DOCK: DockSessionState = {
  chosenTab: null,
  autoTab: null,
  newCount: 0,
  newSubagentCount: 0,
  collapsed: EMPTY_DOCK_VIEW.collapsed,
};

/** The badge value a tab shows; `0` means "no badge". */
export const MAX_BADGE = 9;

export function sessionDockState(
  view: DockViewState,
  sessionId: string | null | undefined,
): DockSessionState {
  if (!sessionId) return EMPTY_SESSION_DOCK;
  const session = view.sessions[sessionId];
  if (!session) return { ...EMPTY_SESSION_DOCK, collapsed: view.collapsed };
  return session.collapsed === view.collapsed
    ? session
    : { ...session, collapsed: view.collapsed };
}

function withSession(
  view: DockViewState,
  sessionId: string,
  patch: Partial<DockSessionState>,
): DockViewState {
  const current = sessionDockState(view, sessionId);
  const session = { ...current, ...patch, collapsed: view.collapsed };
  if (
    session.chosenTab === current.chosenTab &&
    session.autoTab === current.autoTab &&
    session.newCount === current.newCount &&
    session.newSubagentCount === current.newSubagentCount
  ) {
    return view;
  }
  return { ...view, sessions: { ...view.sessions, [sessionId]: session } };
}

/**
 * Which tab the container shows, for a caller that describes only the todo
 * and task sides. The rule is {@link resolveDockTabFor}.
 */
export function resolveDockTab(
  state: DockSessionState,
  hasTodo: boolean,
  hasTasks: boolean,
  runningTasks: number,
  inProgressTodos: number,
): DockTab {
  return resolveDockTabFor(state, { hasTodo, hasTasks, runningTasks, inProgressTodos });
}

/** Every side of the container, as the tab rule needs to see them. */
export type DockSides = {
  hasTodo: boolean;
  hasTasks: boolean;
  runningTasks: number;
  inProgressTodos: number;
  /** Whether the session delegated any subagent; absent means none. */
  hasSubagents?: boolean;
  /** Subagents still being created or running. */
  runningSubagents?: number;
};

function sideHasContent(sides: DockSides, tab: DockTab): boolean {
  if (tab === "todo") return sides.hasTodo;
  if (tab === "tasks") return sides.hasTasks;
  return sides.hasSubagents === true;
}

/**
 * Which tab the container shows.
 *
 * The tab the container turned to on its own wins while its side still has
 * content, then the tab the user chose; otherwise the content decides: running
 * tasks first, then an in-progress todo, then running subagents, then the first
 * side with anything in it. A tab whose side is empty is never selected, so the
 * caller never renders an empty panel.
 */
export function resolveDockTabFor(state: DockSessionState, sides: DockSides): DockTab {
  if (state.autoTab && sideHasContent(sides, state.autoTab)) return state.autoTab;
  if (state.chosenTab && sideHasContent(sides, state.chosenTab)) return state.chosenTab;
  if (sides.hasTasks && sides.runningTasks > 0) return "tasks";
  if (sides.hasTodo && sides.inProgressTodos > 0) return "todo";
  if (sides.hasSubagents && (sides.runningSubagents ?? 0) > 0) return "subagents";
  if (sides.hasTodo) return "todo";
  if (sides.hasTasks) return "tasks";
  if (sides.hasSubagents) return "subagents";
  return "todo";
}

/**
 * Whether the background-task panel is the one on screen, which is the only
 * condition under which a new task needs no badge. A collapsed container shows
 * no panel at all, so it never counts as looking at the tasks.
 *
 * Shared with the hook so the badge rule has one definition instead of a copy
 * that drifts from the render rule.
 */
export function tasksPanelVisible(state: DockSessionState, sides: DockSides): boolean {
  return !state.collapsed && resolveDockTabFor(state, sides) === "tasks";
}

/** Whether the subagent graph is the panel on screen, by the same rule. */
export function subagentsPanelVisible(state: DockSessionState, sides: DockSides): boolean {
  return !state.collapsed && resolveDockTabFor(state, sides) === "subagents";
}

/**
 * Record a task list snapshot for one session.
 *
 * The badge counts tasks that appear for the first time while the tasks panel is
 * not the one on screen: while it is visible a new row needs no announcement,
 * and a collapsed container hides it too, so that case does count.
 */
export function observeSessionTasks(
  view: DockViewState,
  sessionId: string,
  tasks: readonly BackgroundTaskSummary[],
  options: {
    /** Task ids this session had already seen, before this snapshot. */
    knownIds: ReadonlySet<string>;
    /** Whether the tasks panel is currently the visible one. */
    tasksVisible: boolean;
  },
): { view: DockViewState; knownIds: Set<string> } {
  const knownIds = new Set<string>();
  let added = 0;
  for (const task of tasks) {
    knownIds.add(task.id);
    if (options.knownIds.has(task.id)) continue;
    if (task.state !== "running") continue;
    if (!options.tasksVisible) added += 1;
  }
  if (added === 0) return { view, knownIds };
  const current = sessionDockState(view, sessionId);
  return {
    view: withSession(view, sessionId, { newCount: current.newCount + added }),
    knownIds,
  };
}

/** One node of the subagent graph, as the badge rule sees it. */
export type DockSubagentNode = {
  /** The call that started (or resumed) the delegate. */
  readonly id: string;
  /** The delegate is still being created or running. */
  readonly active: boolean;
};

/**
 * Record the session's subagents.
 *
 * A subagent counts once, the first time it is seen starting, and only while
 * its graph is not on screen. That raises the subagent badge, and while the
 * container is collapsed it also turns the container to the graph, so opening
 * the container shows the work that just started. A subagent first seen
 * already settled is history, not news.
 */
export function observeSessionSubagents(
  view: DockViewState,
  sessionId: string,
  nodes: readonly DockSubagentNode[],
  options: {
    /** Node ids this session had already seen, before this snapshot. */
    knownIds: ReadonlySet<string>;
    /** Whether the subagent graph is currently the visible panel. */
    subagentsVisible: boolean;
  },
): { view: DockViewState; knownIds: Set<string> } {
  const knownIds = new Set<string>();
  let added = 0;
  for (const node of nodes) {
    knownIds.add(node.id);
    if (options.knownIds.has(node.id) || !node.active) continue;
    if (!options.subagentsVisible) added += 1;
  }
  if (added === 0) return { view, knownIds };
  const current = sessionDockState(view, sessionId);
  return {
    view: withSession(view, sessionId, {
      newSubagentCount: current.newSubagentCount + added,
      ...(view.collapsed ? { autoTab: "subagents" as const } : {}),
    }),
    knownIds,
  };
}

/** The user entered the tasks tab: the badge has been seen. */
export function clearBadge(view: DockViewState, sessionId: string): DockViewState {
  const current = sessionDockState(view, sessionId);
  if (current.newCount === 0) return view;
  return withSession(view, sessionId, { newCount: 0 });
}

/** The subagent graph has been on screen: its badge has been seen. */
export function clearSubagentBadge(view: DockViewState, sessionId: string): DockViewState {
  const current = sessionDockState(view, sessionId);
  if (current.newSubagentCount === 0) return view;
  return withSession(view, sessionId, { newSubagentCount: 0 });
}

/**
 * The user picked a tab. Only a user action writes the remembered choice, so a
 * tab the container chose on its own never overwrites what the user wanted,
 * and the pick ends the container's own choice.
 */
export function chooseTab(
  view: DockViewState,
  sessionId: string,
  tab: DockTab,
): DockViewState {
  return withSession(view, sessionId, { chosenTab: tab, autoTab: null });
}

/**
 * The user clicked a tab in the header.
 *
 * Clicking a tab while collapsed also expands the container — otherwise the
 * click would only swap an invisible panel and appear to do nothing — so this
 * is the one user action that writes both the tab and the collapse.
 */
export function selectTab(
  view: DockViewState,
  sessionId: string,
  tab: DockTab,
): DockViewState {
  return withSession({ ...view, collapsed: false }, sessionId, { chosenTab: tab, autoTab: null });
}

/**
 * Flip the container's collapse. It belongs to the container, not to the
 * session on screen, so the answer the user gave is reused everywhere and kept
 * when they switch sessions.
 */
export function toggleCollapsed(view: DockViewState): DockViewState {
  return { ...view, collapsed: !view.collapsed };
}

/** Badge markup value: `0` hides it, and long counts collapse to `9+`. */
export function badgeLabel(count: number): string {
  return count > MAX_BADGE ? `${MAX_BADGE}+` : String(count);
}

/** Drop entries for sessions that no longer exist, so the map cannot grow. */
export function pruneDockView(
  view: DockViewState,
  liveSessionIds: ReadonlySet<string>,
): DockViewState {
  let changed = false;
  const next: Record<string, DockSessionState> = {};
  for (const [id, state] of Object.entries(view.sessions)) {
    if (liveSessionIds.has(id)) {
      next[id] = state;
    } else {
      changed = true;
    }
  }
  return changed ? { ...view, sessions: next } : view;
}
