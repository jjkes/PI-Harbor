import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildTeamGraph } = await import(
  "../src/features/team/team-graph-model.ts"
);

const CREATED_AT = "2026-10-28T00:00:00.000Z";

function user(id) {
  return { id, role: "user", content: id, createdAt: CREATED_AT };
}

function assistant(id) {
  return {
    id,
    role: "assistant",
    content: `Assistant ${id}`,
    createdAt: CREATED_AT,
  };
}

function task(callId, options = {}) {
  const delegationId =
    options.delegationId === null
      ? undefined
      : (options.delegationId ?? `delegation-${callId}`);
  const startedAt =
    options.startedAt === undefined ? 1_000 : options.startedAt;
  const completedAt =
    options.completedAt === undefined ? 2_000 : options.completedAt;
  return {
    id: `row-${callId}`,
    role: "tool",
    content: "",
    createdAt: CREATED_AT,
    toolName: "Task",
    toolCallId: callId,
    toolStatus: options.toolStatus ?? "success",
    toolArgs: {
      agent: options.agent ?? "explorer",
      ...(options.description !== undefined
        ? { description: options.description }
        : {}),
      task: options.brief ?? `Brief for ${callId}`,
      ...(options.resume ? { resume: options.resume } : {}),
    },
    ...(options.parent ? { parentToolCallId: options.parent } : {}),
    ...(options.agentName ? { agentName: options.agentName } : {}),
    toolResult: {
      details: {
        ...(delegationId ? { delegationId } : {}),
        status: options.status ?? "completed",
        modelId: options.modelId ?? "model-default",
        ...(startedAt !== null ? { startedAt } : {}),
        ...(completedAt !== null ? { completedAt } : {}),
      },
    },
  };
}

let lifecycleSequence = 0;
function lifecycle(toolName, details) {
  lifecycleSequence += 1;
  return {
    id: `row-lifecycle-${lifecycleSequence}`,
    role: "tool",
    content: "",
    createdAt: CREATED_AT,
    toolName,
    toolCallId: `lifecycle-${lifecycleSequence}`,
    toolStatus: "success",
    toolResult: { details },
  };
}

test("builds flat L1 nodes with identity, display fields, timing and assistant turns", () => {
  const first = task("call-flat", {
    description: "Review the patch",
    brief: "Review every changed file.\nReport correctness issues.",
    modelId: "model-reviewer",
    status: "running",
    startedAt: 1_000,
    completedAt: null,
  });
  const second = task("call-other", {
    agent: "fixer",
    delegationId: null,
    brief: "Fix the failing test\nKeep the change focused.",
    modelId: "model-fixer",
  });
  const graph = buildTeamGraph([
    user("user-1"),
    assistant("assistant-1"),
    first,
    lifecycle("TaskWait", {
      delegations: [
        {
          delegationId: "delegation-call-flat",
          status: "completed",
          startedAt: 1_000,
          completedAt: 4_250,
        },
      ],
    }),
    user("user-2"),
    assistant("assistant-2"),
    second,
  ]);

  assert.deepEqual(graph.nodes.map((node) => node.id), [
    "delegation-call-flat",
    "call-other",
  ]);
  assert.deepEqual(graph.turns, [
    {
      id: "assistant-1",
      rootIds: ["delegation-call-flat"],
      nodeIds: ["delegation-call-flat"],
    },
    {
      id: "assistant-2",
      rootIds: ["call-other"],
      nodeIds: ["call-other"],
    },
  ]);
  const [flat, fallbackIdentity] = graph.nodes;
  assert.equal(flat.messageId, "row-call-flat");
  assert.equal(flat.delegationId, "delegation-call-flat");
  assert.equal(flat.toolCallId, "call-flat");
  assert.equal(flat.agentName, "explorer");
  assert.equal(flat.description, "Review the patch");
  assert.equal(flat.brief, "Review every changed file.\nReport correctness issues.");
  assert.equal(flat.modelId, "model-reviewer");
  assert.equal(flat.status, "completed");
  assert.equal(flat.startedAt, 1_000);
  assert.equal(flat.completedAt, 4_250);
  assert.equal(flat.durationMs, 3_250);
  assert.equal(flat.depth, 1);
  assert.equal(flat.turnId, "assistant-1");
  assert.equal(flat.rootId, flat.id);
  assert.equal(flat.ownerId, undefined);
  assert.equal(flat.orphan, false);
  assert.equal(flat.depthAnomaly, false);
  assert.equal(flat.cycle, false);
  assert.equal(fallbackIdentity.description, "Fix the failing test");
  assert.equal(fallbackIdentity.brief, "Fix the failing test\nKeep the change focused.");
  assert.equal(fallbackIdentity.delegationId, undefined);
  assert.equal(fallbackIdentity.toolCallId, "call-other");
});

test("links a nested Task to its L1 owner and the root Task turn", () => {
  const graph = buildTeamGraph([
    assistant("assistant-nested"),
    task("call-root", { agent: "explorer" }),
    task("call-child", {
      parent: "call-root",
      agent: "test-runner",
      // This names the owner that emitted the row, not the spawned L2 agent.
      agentName: "explorer",
      description: "Run the tests",
    }),
  ]);

  assert.deepEqual(graph.nodes.map((node) => node.depth), [1, 2]);
  const [root, child] = graph.nodes;
  assert.equal(child.id, "delegation-call-child");
  assert.equal(child.agentName, "test-runner");
  assert.equal(child.parentToolCallId, "call-root");
  assert.equal(child.ownerId, root.id);
  assert.equal(child.rootId, root.id);
  assert.equal(child.turnId, "assistant-nested");
  assert.equal(child.orphan, false);
  assert.equal(child.depthAnomaly, false);
  assert.deepEqual(graph.turns, [
    {
      id: "assistant-nested",
      rootIds: [root.id],
      nodeIds: [root.id, child.id],
    },
  ]);
});

test("keeps a resumed call as an independent L1 node and records its source", () => {
  const graph = buildTeamGraph(
    [
      assistant("assistant-resume"),
      task("call-original"),
      task("call-resumed", {
        delegationId: "delegation-resumed",
        resume: "delegation-call-original",
      }),
    ],
    new Map([["delegation-resumed", "aborted"]]),
  );

  assert.deepEqual(graph.turns[0].rootIds, [
    "delegation-call-original",
    "delegation-resumed",
  ]);
  assert.equal(graph.nodes[0].resumed, false);
  assert.equal(graph.nodes[1].resumed, true);
  assert.equal(graph.nodes[1].resumeFrom, "delegation-call-original");
  assert.equal(graph.nodes[1].depth, 1);
  assert.equal(graph.nodes[1].ownerId, undefined);
  assert.equal(graph.nodes[1].status, "aborted");
});

test("marks a nested row with an unloaded owner as a partial-history orphan", () => {
  const graph = buildTeamGraph([
    assistant("assistant-orphan"),
    task("call-orphan", { parent: "call-not-loaded" }),
  ]);

  assert.equal(graph.nodes.length, 1);
  const [orphan] = graph.nodes;
  assert.equal(orphan.orphan, true);
  assert.equal(orphan.depth, null);
  assert.equal(orphan.depthAnomaly, false);
  assert.equal(orphan.cycle, false);
  assert.equal(orphan.ownerId, undefined);
  assert.equal(orphan.parentToolCallId, "call-not-loaded");
  assert.equal(orphan.rootId, undefined);
  assert.equal(orphan.turnId, undefined);
  assert.deepEqual(graph.turns, []);
});

test("reports cycles without recursively attaching or dropping their nodes", () => {
  const graph = buildTeamGraph([
    task("call-a", { parent: "call-b" }),
    task("call-b", { parent: "call-a" }),
  ]);

  assert.equal(graph.nodes.length, 2);
  for (const node of graph.nodes) {
    assert.equal(node.cycle, true);
    assert.equal(node.depthAnomaly, true);
    assert.equal(node.depth, null);
    assert.equal(node.orphan, false);
    assert.equal(node.turnId, undefined);
  }
  assert.equal(graph.nodes[0].ownerId, "delegation-call-b");
  assert.equal(graph.nodes[1].ownerId, "delegation-call-a");
  assert.deepEqual(graph.turns, []);
});

test("retains actual depth greater than two and raises an explicit anomaly", () => {
  const graph = buildTeamGraph([
    assistant("assistant-deep"),
    task("call-l1"),
    task("call-l2", { parent: "call-l1" }),
    task("call-l3", { parent: "call-l2" }),
  ]);

  assert.deepEqual(
    graph.nodes.map((node) => [node.depth, node.depthAnomaly, node.cycle]),
    [
      [1, false, false],
      [2, false, false],
      [3, true, false],
    ],
  );
  const deep = graph.nodes[2];
  assert.equal(deep.ownerId, "delegation-call-l2");
  assert.equal(deep.rootId, "delegation-call-l1");
  assert.equal(deep.turnId, "assistant-deep");
  assert.deepEqual(graph.turns[0].nodeIds, [
    "delegation-call-l1",
    "delegation-call-l2",
    "delegation-call-l3",
  ]);
});

test("TaskWait, TaskList and TaskStop rows never create nodes", () => {
  const graph = buildTeamGraph([
    assistant("assistant-lifecycle"),
    lifecycle("TaskWait", {
      delegations: [{ delegationId: "d1", status: "completed" }],
    }),
    lifecycle("TaskList", {
      delegations: [{ delegationId: "d2", status: "running" }],
    }),
    lifecycle("TaskStop", {
      stopped: [{ delegationId: "d3", status: "stopped" }],
    }),
  ]);

  assert.deepEqual(graph, { nodes: [], turns: [] });
});

test("a rejected Task call without a delegation id never becomes a graph node", () => {
  const graph = buildTeamGraph([
    assistant("assistant-rejected"),
    task("call-root-rejected"),
    task("call-child-rejected", { parent: "call-root-rejected" }),
    {
      id: "row-rejected-l3",
      role: "tool",
      content: "Unknown tool: Task",
      createdAt: CREATED_AT,
      toolName: "Task",
      toolCallId: "call-rejected-l3",
      parentToolCallId: "call-child-rejected",
      toolStatus: "error",
      isError: true,
      toolArgs: { agent: "worker", task: "Attempt L3" },
      toolResult: {
        content: [{ type: "text", text: "Unknown tool: Task" }],
        details: { status: "failed" },
      },
    },
  ]);

  assert.deepEqual(graph.nodes.map((node) => node.id), [
    "delegation-call-root-rejected",
    "delegation-call-child-rejected",
  ]);
  assert.deepEqual(graph.nodes.map((node) => node.depth), [1, 2]);
});

test("empty input produces an empty graph", () => {
  assert.deepEqual(buildTeamGraph([]), { nodes: [], turns: [] });
});
