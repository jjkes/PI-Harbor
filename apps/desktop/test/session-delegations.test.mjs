import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * The composer dock draws every delegate of the session as one graph. These
 * pin the merge rules on real transcript entries: one node per delegate, each
 * judged by its own turn exactly as its transcript card judges it, running work
 * first, and a stable identity while nothing a node shows has changed.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const { collectLiveDelegationEntries } = await import("../src/lib/live-delegation-entries.ts");
const { reuseSessionDelegations, sessionDelegations } = await import("../src/lib/session-delegations.ts");
const { subagentOutcome } = await import("../src/lib/subagent-topology.ts");
const { getTranscriptProjection } = await import("../src/lib/transcript-projection.ts");
const { upsertLiveSessionMessage } = await import("../src/lib/session-transcript.ts");

let clock = Date.parse("2026-10-29T08:00:00.000Z");
const stamp = () => new Date((clock += 1_000)).toISOString();

const user = (id, content) => ({ id, role: "user", content, createdAt: stamp() });
const assistant = (id, content) => ({ id, role: "assistant", content, createdAt: stamp() });

/**
 * A `Task` call as the runtime records it (ADR 0089): the call settles as soon
 * as the delegate starts, so a started delegate is a successful call whose
 * result says `running`, and a call still being created has no result yet.
 */
function task(id, { delegationId, resume } = {}) {
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
    toolStatus: delegationId ? "success" : "running",
    ...(delegationId
      ? { toolResult: { content: [], details: { delegationId, status: "running", startedAt: clock } } }
      : {}),
  };
}

/** A `TaskWait` row reporting how delegates ended. */
function taskWait(id, delegations) {
  return {
    id,
    role: "tool",
    toolName: "TaskWait",
    toolCallId: id,
    content: "",
    createdAt: stamp(),
    toolArgs: {},
    toolStatus: "success",
    toolResult: { content: [], details: { delegations } },
  };
}

/** The graph the dock draws for these messages. */
function graphOf(messages, running) {
  const { entries, runs } = buildTranscriptEntries(messages);
  const liveEntries = collectLiveDelegationEntries(entries.slice(0, -1), entries.at(-1), running);
  return sessionDelegations(entries, liveEntries, runs);
}

/**
 * The reading the dock hook makes: through the cached transcript projection, so
 * a reading built from a grown array reuses every entry that did not change.
 */
function readingOf(messages, running) {
  const projection = getTranscriptProjection(messages);
  const liveEntries = collectLiveDelegationEntries(projection.history, projection.entries.at(-1), running);
  return sessionDelegations(projection.entries, liveEntries, projection.runs);
}

/** A `Task` call a delegate made itself: it hangs off its owner's call like every delegate row. */
function nestedTask(id, parent, options) {
  return { ...task(id, options), parentToolCallId: parent, agentName: "explorer" };
}

/** A `TaskWait` a delegate made on its own children. */
function nestedTaskWait(id, parent, delegations) {
  return { ...taskWait(id, delegations), parentToolCallId: parent, agentName: "explorer" };
}

/** A row a delegate wrote itself. */
function delegateRow(id, parent, content) {
  return { id, role: "assistant", content, createdAt: stamp(), parentToolCallId: parent, agentName: "explorer" };
}

const ids = (graph) => graph.items.map((item) => item.message.id);
const outcomes = (graph) => graph.items.map((item) => subagentOutcome(item.message, graph.statuses));

test("every fan-out of the session joins one graph: running work first, then the newest settled work", () => {
  const graph = graphOf([
    user("u1", "Map the repository"),
    assistant("m1", "Delegating."),
    task("a1", { delegationId: "d-a1" }),
    task("a2", { delegationId: "d-a2" }),
    taskWait("w1", [
      { delegationId: "d-a1", status: "completed" },
      { delegationId: "d-a2", status: "failed" },
    ]),
    assistant("m2", "Both reported."),
    user("u2", "Verify it"),
    assistant("m3", "Delegating."),
    task("b1", { delegationId: "d-b1" }),
    taskWait("w2", [{ delegationId: "d-b1", status: "completed" }]),
    assistant("m4", "Verified."),
    user("u3", "Check the docs"),
    assistant("m5", "Delegating."),
    task("c1", { delegationId: "d-c1" }),
    // Still being created: it joins the graph before it has a delegation id.
    task("c2"),
  ], true);

  assert.deepEqual(ids(graph), ["c1", "c2", "b1", "a1", "a2"]);
  assert.deepEqual(outcomes(graph), ["running", "running", "completed", "completed", "failed"]);
  assert.deepEqual(graph.nodes, [
    { id: "c1", active: true },
    { id: "c2", active: true },
    { id: "b1", active: false },
    { id: "a1", active: false },
    { id: "a2", active: false },
  ]);
  assert.equal(graph.summary.total, 5);
  assert.equal(graph.summary.running, 2);
  assert.equal(graph.summary.issues, 1);
});

test("a turn that ended reads its leftover running node as aborted, as its card does", () => {
  const messages = [
    user("u1", "Map the repository"),
    assistant("m1", "Delegating."),
    task("a1", { delegationId: "d-a1" }),
  ];
  const live = graphOf(messages, true);
  assert.deepEqual(outcomes(live), ["running"]);
  assert.deepEqual(live.nodes, [{ id: "a1", active: true }]);

  const ended = graphOf(messages, false);
  assert.deepEqual(outcomes(ended), ["aborted"]);
  assert.deepEqual(ended.nodes, [{ id: "a1", active: false }]);
});

test("a resumed delegate is one node, drawn by its latest call and judged by that call's turn", () => {
  const graph = graphOf([
    user("u1", "Explore"),
    assistant("m1", "Delegating."),
    task("x1", { delegationId: "d-x1" }),
    taskWait("w1", [{ delegationId: "d-x1", status: "completed" }]),
    assistant("m2", "Done."),
    user("u2", "Go deeper"),
    assistant("m3", "Resuming."),
    task("x2", { delegationId: "d-x2", resume: "d-x1" }),
  ], true);

  assert.deepEqual(ids(graph), ["x2"]);
  assert.deepEqual(outcomes(graph), ["running"]);
  assert.equal(graph.summary.total, 1);
});

test("calls that report the same delegation id are one delegate, and the earlier turn does not leak in", () => {
  const graph = graphOf([
    user("u1", "Explore"),
    assistant("m1", "Delegating."),
    task("x1", { delegationId: "d-x" }),
    taskWait("w1", [{ delegationId: "d-x", status: "completed" }]),
    assistant("m2", "Done."),
    user("u2", "Again"),
    assistant("m3", "Resuming."),
    task("x2", { delegationId: "d-x", resume: "d-x" }),
  ], true);

  assert.deepEqual(ids(graph), ["x2"]);
  // The first turn's `completed` belongs to that turn's card, not to this node.
  assert.deepEqual(outcomes(graph), ["running"]);
});

test("a reading that changed nothing keeps the graph's identity", () => {
  const messages = [
    user("u1", "Map the repository"),
    assistant("m1", "Delegating."),
    task("a1", { delegationId: "d-a1" }),
    task("a2", { delegationId: "d-a2" }),
  ];
  const { entries } = buildTranscriptEntries(messages);
  const liveEntries = collectLiveDelegationEntries(entries.slice(0, -1), entries.at(-1), true);
  const first = sessionDelegations(entries, liveEntries);
  const second = sessionDelegations(entries, liveEntries);
  assert.notEqual(second, first);
  assert.equal(reuseSessionDelegations(first, second), first);

  // A settled delegate is a different reading, and it moves below running work.
  const settled = graphOf([...messages, taskWait("w1", [{ delegationId: "d-a1", status: "completed" }])], true);
  const next = reuseSessionDelegations(first, settled);
  assert.notEqual(next, first);
  assert.deepEqual(ids(next), ["a2", "a1"]);
  assert.deepEqual(outcomes(next), ["running", "completed"]);
});

test("a delegate's own Task calls are its children in dispatch order, each carrying its own run", () => {
  const graph = graphOf([
    user("u1", "Map the repository"),
    assistant("m1", "Delegating."),
    task("a1", { delegationId: "d-a1" }),
    nestedTask("n1", "a1", { delegationId: "d-n1" }),
    nestedTask("n2", "a1", { delegationId: "d-n2" }),
    delegateRow("i1", "n1", "Surveyed the package."),
    nestedTaskWait("nw1", "a1", [{ delegationId: "d-n1", status: "completed" }]),
  ], true);

  // The graph's nodes stay the main agent's delegates; nested work is not counted again.
  assert.deepEqual(ids(graph), ["a1"]);
  assert.deepEqual(graph.nodes, [{ id: "a1", active: true }]);
  assert.equal(graph.summary.total, 1);

  const children = graph.children.get("a1");
  assert.deepEqual(children.map((child) => child.message.id), ["n1", "n2"]);
  assert.deepEqual(children[0].delegate.items.map((row) => row.message.id), ["i1"]);
  assert.equal(children[1].delegate, undefined);
  // A nested node is judged by its owner's own rows.
  assert.equal(subagentOutcome(children[0].message, graph.statuses), "completed");
  assert.equal(subagentOutcome(children[1].message, graph.statuses), "running");
  assert.equal(graph.deepNodeIds.size, 0);
});

test("a nested delegate left running under a settled owner reads as aborted", () => {
  const rows = [
    user("u1", "Map the repository"),
    assistant("m1", "Delegating."),
    task("a1", { delegationId: "d-a1" }),
    nestedTask("n1", "a1", { delegationId: "d-n1" }),
  ];
  const live = graphOf(rows, true);
  assert.equal(subagentOutcome(live.children.get("a1")[0].message, live.statuses), "running");

  const settled = graphOf([...rows, taskWait("w1", [{ delegationId: "d-a1", status: "completed" }])], true);
  assert.deepEqual(outcomes(settled), ["completed"]);
  assert.equal(subagentOutcome(settled.children.get("a1")[0].message, settled.statuses), "aborted");
});

test("a delegation started by a nested delegate is flagged instead of drawn as a third level", () => {
  const graph = graphOf([
    user("u1", "Map the repository"),
    assistant("m1", "Delegating."),
    task("a1", { delegationId: "d-a1" }),
    nestedTask("n1", "a1", { delegationId: "d-n1" }),
    nestedTask("g1", "n1", { delegationId: "d-g1" }),
  ], true);

  assert.deepEqual([...graph.children.keys()], ["a1"]);
  assert.deepEqual(graph.children.get("a1").map((child) => child.message.id), ["n1"]);
  assert.deepEqual([...graph.deepNodeIds], ["n1"]);
});

test("a delegation the runtime refused is not counted as a third level", () => {
  // A nested delegate has no Task tool, so a call it makes ends in an error with
  // no delegation id. No delegate ever started behind it, and the dock must not
  // claim a deeper level that does not exist.
  const refused = {
    ...nestedTask("g1", "n1", {}),
    toolStatus: "error",
    toolResult: { content: [{ type: "text", text: "Unknown tool: Task" }], details: {} },
  };
  const graph = graphOf([
    user("u1", "Map the repository"),
    assistant("m1", "Delegating."),
    task("a1", { delegationId: "d-a1" }),
    nestedTask("n1", "a1", { delegationId: "d-n1" }),
    refused,
  ], true);

  assert.deepEqual(graph.children.get("a1").map((child) => child.message.id), ["n1"]);
  assert.equal(graph.deepNodeIds.size, 0);
});

test("a nested run that grew changes the children and nothing else of the reading", () => {
  const rows = [
    user("u1", "Map the repository"),
    assistant("m1", "Delegating."),
    task("a1", { delegationId: "d-a1" }),
    nestedTask("n1", "a1", { delegationId: "d-n1" }),
    delegateRow("i1", "n1", "Surveyed the package."),
  ];
  const first = readingOf(rows, true);
  assert.equal(reuseSessionDelegations(first, readingOf(rows, true)), first);

  const grown = readingOf(upsertLiveSessionMessage(rows, delegateRow("i2", "n1", "Read the tests.")), true);
  const next = reuseSessionDelegations(first, grown);
  assert.notEqual(next, first);
  assert.equal(next.items, first.items);
  assert.equal(next.statuses, first.statuses);
  assert.notEqual(next.children, first.children);
  assert.deepEqual(
    next.children.get("a1")[0].delegate.items.map((row) => row.message.id),
    ["i1", "i2"],
  );
});
