import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * The composer container's third side: the session's subagents. These pin
 * what a user can observe once the graph joins the tab list (which panel is on
 * screen, when the tab raises a badge, when the container turns to the graph
 * on its own) and that the todo/task rule is unchanged while a session has no
 * subagent. Everything is plain renderer memory, so a controlled input decides
 * every case.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  EMPTY_DOCK_VIEW,
  EMPTY_SESSION_DOCK,
  chooseTab,
  clearSubagentBadge,
  observeSessionSubagents,
  resolveDockTab,
  resolveDockTabFor,
  selectTab,
  sessionDockState,
  subagentsPanelVisible,
  tasksPanelVisible,
} = await import("../src/features/chat/background-tasks/dock-state.ts");

const SESSION = "session-1";
const running = (id) => ({ id, active: true });
const settled = (id) => ({ id, active: false });
const sidesWith = (patch) => ({
  hasTodo: false,
  hasTasks: false,
  runningTasks: 0,
  inProgressTodos: 0,
  hasSubagents: false,
  runningSubagents: 0,
  ...patch,
});
const fold = (view, nodes, knownIds = new Set(), subagentsVisible = false) =>
  observeSessionSubagents(view, SESSION, nodes, { knownIds, subagentsVisible });

/** The tab rule as it read before the container had a third side. */
function todoTaskRule(state, hasTodo, hasTasks, runningTasks, inProgressTodos) {
  if (hasTodo && hasTasks) {
    if (state.chosenTab === "todo") return "todo";
    if (state.chosenTab === "tasks") return "tasks";
    if (runningTasks > 0) return "tasks";
    if (inProgressTodos > 0) return "todo";
    return "todo";
  }
  if (hasTasks) return "tasks";
  return "todo";
}

test("without a subagent the tab rule is the todo/task rule it replaced", () => {
  for (const chosenTab of [null, "todo", "tasks", "subagents"]) {
    for (const autoTab of [null, "subagents"]) {
      for (const hasTodo of [false, true]) {
        for (const hasTasks of [false, true]) {
          for (const runningTasks of [0, 2]) {
            for (const inProgressTodos of [0, 1]) {
              // Sides are always described consistently by the container.
              if ((!hasTasks && runningTasks) || (!hasTodo && inProgressTodos)) continue;
              const state = { ...EMPTY_SESSION_DOCK, chosenTab, autoTab };
              const expected = todoTaskRule(state, hasTodo, hasTasks, runningTasks, inProgressTodos);
              const label = JSON.stringify({ chosenTab, autoTab, hasTodo, hasTasks, runningTasks, inProgressTodos });
              assert.equal(resolveDockTab(state, hasTodo, hasTasks, runningTasks, inProgressTodos), expected, label);
              assert.equal(
                resolveDockTabFor(state, sidesWith({ hasTodo, hasTasks, runningTasks, inProgressTodos })),
                expected,
                label,
              );
            }
          }
        }
      }
    }
  }
});

test("a subagent that starts while the container is collapsed is what opening it shows", () => {
  // The user had picked the checklist; the container is collapsed (its default).
  const chosen = chooseTab(EMPTY_DOCK_VIEW, SESSION, "todo");
  const state = sessionDockState(fold(chosen, [running("call-a")]).view, SESSION);
  assert.equal(state.autoTab, "subagents");
  assert.equal(state.newSubagentCount, 1);
  // Only a user action writes the remembered tab.
  assert.equal(state.chosenTab, "todo");

  const sides = sidesWith({ hasTodo: true, inProgressTodos: 1, hasSubagents: true, runningSubagents: 1 });
  assert.equal(resolveDockTabFor(state, sides), "subagents");
  // Expanding is all it takes for the graph to be the panel on screen.
  assert.equal(subagentsPanelVisible({ ...state, collapsed: false }, sides), true);
});

test("while the container is open on another tab a new subagent only raises the badge", () => {
  const chosen = chooseTab({ ...EMPTY_DOCK_VIEW, collapsed: false }, SESSION, "todo");
  const sides = sidesWith({ hasTodo: true, inProgressTodos: 1, hasSubagents: true, runningSubagents: 1 });
  assert.equal(subagentsPanelVisible(sessionDockState(chosen, SESSION), sides), false);

  const state = sessionDockState(fold(chosen, [running("call-a")]).view, SESSION);
  assert.equal(state.autoTab, null);
  assert.equal(state.newSubagentCount, 1);
  // The panel on screen does not change under the user.
  assert.equal(resolveDockTabFor(state, sides), "todo");
});

test("a delegate counts once, and one first seen settled never counts", () => {
  let view = EMPTY_DOCK_VIEW;
  let known = new Set();
  ({ view, knownIds: known } = fold(view, [running("a")], known));
  ({ view, knownIds: known } = fold(view, [running("a")], known));
  assert.equal(sessionDockState(view, SESSION).newSubagentCount, 1);

  // A session opened after its delegates settled has nothing new to announce.
  ({ view, knownIds: known } = fold(view, [settled("a"), settled("b")], known));
  assert.equal(sessionDockState(view, SESSION).newSubagentCount, 1);

  // A resumed delegate is drawn by a new call, so it is new work again.
  ({ view, knownIds: known } = fold(view, [settled("a"), settled("b"), running("c")], known));
  assert.equal(sessionDockState(view, SESSION).newSubagentCount, 2);
  assert.deepEqual([...known].sort(), ["a", "b", "c"]);
});

test("a delegate that starts while its graph is on screen needs no badge", () => {
  const open = { sessions: {}, collapsed: false };
  const folded = fold(open, [running("a")], new Set(), true);
  assert.equal(folded.view, open);
  assert.ok(folded.knownIds.has("a"));
});

test("picking a tab hands the choice back to the user", () => {
  const auto = fold(EMPTY_DOCK_VIEW, [running("a")]).view;
  const sides = sidesWith({ hasTodo: true, inProgressTodos: 1, hasSubagents: true, runningSubagents: 1 });

  const picked = sessionDockState(selectTab(auto, SESSION, "todo"), SESSION);
  assert.equal(picked.autoTab, null);
  assert.equal(picked.chosenTab, "todo");
  assert.equal(picked.collapsed, false);
  assert.equal(resolveDockTabFor(picked, sides), "todo");

  assert.equal(sessionDockState(chooseTab(auto, SESSION, "tasks"), SESSION).autoTab, null);
});

test("seeing the graph clears its badge and leaves the task badge alone", () => {
  const counted = fold(EMPTY_DOCK_VIEW, [running("a")]).view;
  const withTaskBadge = {
    ...counted,
    sessions: { [SESSION]: { ...sessionDockState(counted, SESSION), newCount: 3 } },
  };

  const cleared = clearSubagentBadge(withTaskBadge, SESSION);
  assert.equal(sessionDockState(cleared, SESSION).newSubagentCount, 0);
  assert.equal(sessionDockState(cleared, SESSION).newCount, 3);
  assert.equal(clearSubagentBadge(cleared, SESSION), cleared);
});

test("the graph and the task list are never on screen together", () => {
  const state = { ...EMPTY_SESSION_DOCK, collapsed: false, chosenTab: "subagents" };
  const sides = sidesWith({ hasTasks: true, runningTasks: 1, hasSubagents: true, runningSubagents: 1 });
  assert.equal(resolveDockTabFor(state, sides), "subagents");
  assert.equal(subagentsPanelVisible(state, sides), true);
  assert.equal(tasksPanelVisible(state, sides), false);

  // A collapsed container shows no panel at all.
  const collapsed = { ...state, collapsed: true };
  assert.equal(subagentsPanelVisible(collapsed, sides), false);
  assert.equal(tasksPanelVisible(collapsed, sides), false);
});

test("with nothing chosen, running subagents rank after running tasks and an in-progress todo", () => {
  const state = EMPTY_SESSION_DOCK;
  assert.equal(resolveDockTabFor(state, sidesWith({ hasSubagents: true })), "subagents");
  assert.equal(
    resolveDockTabFor(state, sidesWith({ hasTodo: true, hasSubagents: true, runningSubagents: 2 })),
    "subagents",
  );
  assert.equal(
    resolveDockTabFor(state, sidesWith({ hasTodo: true, inProgressTodos: 1, hasSubagents: true, runningSubagents: 2 })),
    "todo",
  );
  assert.equal(
    resolveDockTabFor(state, sidesWith({ hasTasks: true, runningTasks: 1, hasSubagents: true, runningSubagents: 2 })),
    "tasks",
  );
  // With nothing running, the first side with content is shown.
  assert.equal(resolveDockTabFor(state, sidesWith({ hasTodo: true, hasSubagents: true })), "todo");
  assert.equal(resolveDockTabFor(state, sidesWith({ hasTasks: true, hasSubagents: true })), "tasks");
});
