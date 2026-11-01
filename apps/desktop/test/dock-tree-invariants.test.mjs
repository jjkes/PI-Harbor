import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const { collectLiveDelegationEntries } = await import("../src/lib/live-delegation-entries.ts");
const { sessionDelegations } = await import("../src/lib/session-delegations.ts");
const { getTranscriptProjection } = await import("../src/lib/transcript-projection.ts");

let clock = Date.parse("2026-10-29T08:00:00.000Z");
const stamp = () => new Date((clock += 1_000)).toISOString();
const user = (id, content) => ({ id, role: "user", content, createdAt: stamp() });
const assistant = (id, content) => ({ id, role: "assistant", content, createdAt: stamp() });

/** 按运行时记录构造 Task 行；Task 返回时 delegate 通常仍在运行。 */
function task(id, { delegationId = `d-${id}`, parent, resume, startedAt = 1_000 } = {}) {
  return {
    id,
    role: "tool",
    toolName: "Task",
    toolCallId: id,
    content: "",
    createdAt: stamp(),
    toolArgs: {
      subagent_type: "explorer",
      description: `Work ${id}`,
      task: `Do ${id}`,
      ...(resume ? { resume } : {}),
    },
    toolStatus: "success",
    toolResult: {
      content: [],
      details: { delegationId, status: "running", startedAt },
    },
    ...(parent ? { parentToolCallId: parent, agentName: "explorer" } : {}),
  };
}

/** 生命周期行只汇报既有 delegate，自身不应成为树节点。 */
function lifecycle(id, toolName, details, parent) {
  return {
    id,
    role: "tool",
    toolName,
    toolCallId: id,
    content: "",
    createdAt: stamp(),
    toolArgs: {},
    toolStatus: "success",
    toolResult: { content: [], details },
    ...(parent ? { parentToolCallId: parent, agentName: "explorer" } : {}),
  };
}

/** 与 dock 一样，将真实 transcript entries、live 范围和 runs 组合成会话树。 */
function graphFrom(projection, running) {
  const liveEntries = collectLiveDelegationEntries(
    projection.entries.slice(0, -1),
    projection.entries.at(-1),
    running,
  );
  return sessionDelegations(projection.entries, liveEntries, projection.runs);
}

function graphOf(messages, running = false) {
  return graphFrom(buildTranscriptEntries(messages), running);
}

function projectedGraphOf(messages, running = false) {
  const projection = getTranscriptProjection(messages);
  return { projection, graph: graphFrom(projection, running) };
}

const ids = (graph) => graph.items.map((item) => item.message.id);
const emptySummary = { total: 0, finished: 0, running: 0, issues: 0, warnings: 0 };

test("empty input produces an empty session graph through both transcript builders", () => {
  for (const graph of [graphOf([]), projectedGraphOf([]).graph]) {
    assert.deepEqual(ids(graph), []);
    assert.deepEqual(graph.nodes, []);
    assert.equal(graph.statuses.size, 0);
    assert.equal(graph.timings.size, 0);
    assert.equal(graph.children.size, 0);
    assert.equal(graph.deepNodeIds.size, 0);
    assert.deepEqual(graph.summary, emptySummary);
  }
});

test("TaskWait, TaskList and TaskStop settle real delegates without creating nodes", () => {
  const rows = [
    user("u-lifecycle", "Run three delegates"),
    assistant("m-lifecycle", "Delegating"),
    task("task-wait", { startedAt: 1_000 }),
    task("task-list", { startedAt: 2_000 }),
    task("task-stop", { startedAt: 3_000 }),
    lifecycle("wait-row", "TaskWait", {
      delegations: [{
        delegationId: "d-task-wait",
        status: "completed",
        startedAt: 1_000,
        completedAt: 4_250,
      }],
    }),
    lifecycle("list-row", "TaskList", {
      delegations: [{
        delegationId: "d-task-list",
        status: "completed",
        startedAt: 2_000,
        completedAt: 5_000,
      }],
    }),
    lifecycle("stop-row", "TaskStop", {
      stopped: [{
        delegationId: "d-task-stop",
        status: "running",
        startedAt: 3_000,
        completedAt: 6_000,
      }],
    }),
  ];
  const graph = projectedGraphOf(rows).graph;

  assert.deepEqual(ids(graph), ["task-wait", "task-list", "task-stop"]);
  assert.deepEqual(graph.nodes, [
    { id: "task-wait", active: false },
    { id: "task-list", active: false },
    { id: "task-stop", active: false },
  ]);
  assert.equal(graph.statuses.get("d-task-wait"), "completed");
  assert.equal(graph.statuses.get("d-task-list"), "completed");
  assert.equal(graph.statuses.get("d-task-stop"), "stopped");
  assert.deepEqual(graph.timings.get("d-task-wait"), { startedAt: 1_000, completedAt: 4_250 });
  assert.deepEqual(graph.timings.get("d-task-list"), { startedAt: 2_000, completedAt: 5_000 });
  assert.deepEqual(graph.timings.get("d-task-stop"), { startedAt: 3_000, completedAt: 6_000 });
  assert.deepEqual(graph.summary, { total: 3, finished: 3, running: 0, issues: 0, warnings: 1 });

  const lifecycleOnly = graphOf([
    user("u-only-lifecycle", "Inspect delegates"),
    assistant("m-only-lifecycle", "Checking"),
    lifecycle("only-wait", "TaskWait", {
      delegations: [{ delegationId: "not-loaded", status: "completed" }],
    }),
    lifecycle("only-list", "TaskList", {
      delegations: [{ delegationId: "also-not-loaded", status: "running" }],
    }),
    lifecycle("only-stop", "TaskStop", {
      stopped: [{ delegationId: "still-not-loaded", status: "stopped" }],
    }),
  ]);
  assert.deepEqual(ids(lifecycleOnly), []);
  assert.deepEqual(lifecycleOnly.nodes, []);
  assert.equal(lifecycleOnly.children.size, 0);
  assert.deepEqual(lifecycleOnly.summary, emptySummary);
});

test("a nested Task with an unloaded owner stays out of L1 until the owner is loaded", () => {
  const partialRows = [
    assistant("m-partial", "Only the nested row is loaded"),
    task("child", { parent: "root", startedAt: 2_000 }),
  ];
  const partial = projectedGraphOf(partialRows, true);
  assert.deepEqual(partial.projection.visible.map((message) => message.id), ["m-partial"]);
  assert.deepEqual(ids(partial.graph), []);
  assert.deepEqual(partial.graph.nodes, []);
  assert.equal(partial.graph.children.size, 0);
  assert.equal(partial.graph.deepNodeIds.size, 0);
  assert.deepEqual(partial.graph.summary, emptySummary);

  // owner 进入加载范围后，同一 nested Task 才挂到真实 L1 下，不能先伪造成 L1。
  const loaded = projectedGraphOf([
    user("u-root", "Run a nested delegate"),
    assistant("m-root", "Delegating"),
    task("root", { startedAt: 1_000 }),
    ...partialRows,
  ], true).graph;
  assert.deepEqual(ids(loaded), ["root"]);
  assert.deepEqual(loaded.children.get("root").map((item) => item.message.id), ["child"]);
});

test("self-parented and cyclic Task rows terminate without manufacturing tree nodes", () => {
  const malformedRuns = [
    [task("self", { parent: "self" })],
    [
      task("cycle-a", { parent: "cycle-b" }),
      task("cycle-b", { parent: "cycle-a" }),
    ],
  ];

  for (const [index, malformed] of malformedRuns.entries()) {
    const { projection, graph } = projectedGraphOf([
      user(`u-cycle-${index}`, "Keep valid work visible"),
      assistant(`m-cycle-${index}`, "Delegating"),
      task(`valid-${index}`),
      ...malformed,
    ], true);

    assert.deepEqual(ids(graph), [`valid-${index}`]);
    assert.deepEqual(graph.nodes, [{ id: `valid-${index}`, active: true }]);
    assert.equal(graph.children.size, 0);
    assert.equal(graph.deepNodeIds.size, 0);
    assert.deepEqual(graph.summary, { total: 1, finished: 0, running: 1, issues: 0, warnings: 0 });
    assert.deepEqual(
      projection.visible.filter((message) => message.role === "tool").map((message) => message.id),
      [`valid-${index}`],
    );
  }
});

test("an L2 node reads status and timing from its owning L1 run", () => {
  const graph = graphOf([
    user("u-nested-timing", "Run nested work"),
    assistant("m-nested-timing", "Delegating"),
    task("root", { startedAt: 1_000 }),
    task("child", { parent: "root", startedAt: 2_000 }),
    lifecycle("nested-wait", "TaskWait", {
      delegations: [{
        delegationId: "d-child",
        status: "completed",
        startedAt: 2_000,
        completedAt: 4_250,
      }],
    }, "root"),
    lifecycle("root-wait", "TaskWait", {
      delegations: [{
        delegationId: "d-root",
        status: "completed",
        startedAt: 1_000,
        completedAt: 9_000,
      }],
    }),
  ], true);

  assert.deepEqual(ids(graph), ["root"]);
  assert.deepEqual(graph.children.get("root").map((item) => item.message.id), ["child"]);
  assert.equal(graph.statuses.get("d-root"), "completed");
  assert.equal(graph.statuses.get("d-child"), "completed");
  assert.deepEqual(graph.timings.get("d-root"), { startedAt: 1_000, completedAt: 9_000 });
  assert.deepEqual(graph.timings.get("d-child"), { startedAt: 2_000, completedAt: 4_250 });
  assert.equal(graph.timings.size, 2);
});
