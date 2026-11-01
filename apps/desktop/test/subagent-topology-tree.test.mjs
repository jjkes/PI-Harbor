import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * Server-render the real session delegation pipeline and topology. Tree mode
 * owns the L1/L2 reading order and the ARIA list structure; plain mode keeps
 * nested work as a count rather than drawing it in the work panel.
 */

let clock = Date.parse("2026-10-29T08:00:00.000Z");
const stamp = () => new Date((clock += 1_000)).toISOString();

const user = (id, content) => ({ id, role: "user", content, createdAt: stamp() });
const assistant = (id, content) => ({ id, role: "assistant", content, createdAt: stamp() });

/** A `Task` call as the runtime records it (ADR 0089). */
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

/** A `Task` call a delegate made itself. */
function nestedTask(id, parent, options) {
  return { ...task(id, options), parentToolCallId: parent, agentName: "explorer" };
}

/** A row a delegate wrote itself. */
function delegateRow(id, parent, content) {
  return { id, role: "assistant", content, createdAt: stamp(), parentToolCallId: parent, agentName: "explorer" };
}

const noop = () => {};
const occurrences = (html, pattern) => [...html.matchAll(pattern)].length;

function topologyNodes(html) {
  return [
    ...html.matchAll(
      /<div class="[^"]*subagent-topology-node[^"]*" role="(group|listitem)" data-message-id="([^"]+)"/g,
    ),
  ].map((match) => ({ role: match[1], id: match[2] }));
}

function topologyBranches(html) {
  return [
    ...html.matchAll(
      /<div class="subagent-topology-branch([^"]*)" role="listitem"><div class="[^"]*subagent-topology-node[^"]*" role="group" data-message-id="([^"]+)"/g,
    ),
  ].map((match) => ({ id: match[2], modifier: match[1] }));
}

function rootCopy(html) {
  const match = html.match(
    /<span class="subagent-topology-root-copy"><strong id="[^"]+">[^<]*<\/strong><span(?: title="[^"]*")?>([^<]*)<\/span><\/span>/,
  );
  assert.ok(match, "the topology root copy is rendered");
  return match[1];
}

test("SubagentTopology SSR exposes the tree structure and live-region contract", async (t) => {
  const ssr = await slotSsr(t);
  const [
    { SubagentTopology },
    { buildTranscriptEntries },
    { collectLiveDelegationEntries },
    { sessionDelegations },
  ] = await Promise.all([
    ssr.load("/src/features/chat/transcript/SubagentDetail.tsx"),
    ssr.load("/src/lib/assistant-turns.ts"),
    ssr.load("/src/lib/live-delegation-entries.ts"),
    ssr.load("/src/lib/session-delegations.ts"),
  ]);

  /** The graph the dock draws for these messages. */
  function graphOf(messages, running) {
    const { entries, runs } = buildTranscriptEntries(messages);
    const liveEntries = collectLiveDelegationEntries(entries.slice(0, -1), entries.at(-1), running);
    return sessionDelegations(entries, liveEntries, runs);
  }

  const graph = graphOf(
    [
      user("u1", "Map the repository"),
      assistant("m1", "Delegating."),
      task("a1", { delegationId: "d-a1" }),
      nestedTask("n1", "a1", { delegationId: "d-n1" }),
      nestedTask("g1", "n1", { delegationId: "d-g1" }),
      delegateRow("i1", "n1", "Surveyed the package."),
      nestedTask("n2", "a1", { delegationId: "d-n2" }),
      task("a2", { delegationId: "d-a2" }),
      taskWait("w1", [{ delegationId: "d-a2", status: "completed" }]),
    ],
    true,
  );
  const emptyGraph = graphOf([user("empty-u", "Explore"), assistant("empty-m", "Planning.")], false);
  const baseProps = {
    items: graph.items,
    delegationStatuses: graph.statuses,
    delegationTimings: graph.timings,
    emptyHint: "No delegates yet.",
    coordinatorName: "Main agent",
    onUserInteraction: noop,
  };
  const treeProps = {
    ...baseProps,
    childrenByNode: graph.children,
    deepNodeIds: graph.deepNodeIds,
  };
  const renderTopology = (props) =>
    ssr.render(createElement(SubagentTopology, props), { sessionId: null });
  const treeHtml = renderTopology(treeProps);

  await t.test("L1 branches wrap grouped nodes and own their labelled L2 lists", () => {
    assert.deepEqual(graph.items.map((item) => item.message.id), ["a1", "a2"]);
    assert.deepEqual(graph.children.get("a1").map((item) => item.message.id), ["n1", "n2"]);
    assert.deepEqual([...graph.deepNodeIds], ["n1"]);
    assert.deepEqual(topologyBranches(treeHtml), [
      { id: "a1", modifier: " has-children" },
      { id: "a2", modifier: "" },
    ]);
    assert.match(
      treeHtml,
      /<div class="subagent-topology-children" role="list" aria-label="Delegated tasks started by explorer">/,
    );
    assert.equal(occurrences(treeHtml, /<div class="subagent-topology-children"/g), 1);
    const children = [
      ...treeHtml.matchAll(
        /<div class="subagent-topology-child" role="listitem"><div class="[^"]*subagent-topology-node[^"]*" role="group" data-message-id="([^"]+)"/g,
      ),
    ].map((match) => match[1]);
    assert.deepEqual(children, ["n1", "n2"]);
  });

  await t.test("DOM order keeps each L1 node before its children and the next branch", () => {
    const first = treeHtml.indexOf('data-message-id="a1"');
    const children = treeHtml.indexOf('class="subagent-topology-children"');
    const next = treeHtml.indexOf('data-message-id="a2"');
    assert.ok(first >= 0 && children >= 0 && next >= 0, "both L1 nodes and the children list exist");
    assert.ok(first < children && children < next, "a1, its children, then a2");
  });

  await t.test("an empty children map selects tree mode without drawing nested markup", () => {
    const html = renderTopology({ ...treeProps, childrenByNode: new Map(), deepNodeIds: new Set() });
    assert.match(html, /<section class="subagent-topology is-tree" aria-labelledby="/);
    assert.doesNotMatch(html, /subagent-topology-children|has-nested|has-children/);
  });

  await t.test("a third-level delegation adds the deep note only to its L2 owner", () => {
    assert.equal(occurrences(treeHtml, /<p class="subagent-topology-deep-note" role="note">/g), 1);
    assert.match(
      treeHtml,
      /<p class="subagent-topology-deep-note" role="note">[\s\S]*?<span>This delegation exceeds the supported two-level graph\.<\/span><\/p>/,
    );
    const owner = treeHtml.indexOf('data-message-id="n1"');
    const note = treeHtml.indexOf('class="subagent-topology-deep-note"');
    const sibling = treeHtml.indexOf('data-message-id="n2"');
    assert.ok(owner < note && note < sibling, "the note belongs to n1, not n2");
  });

  await t.test("plain work-panel mode lists L1 nodes directly and retains the nested count", () => {
    const plainHtml = renderTopology(baseProps);
    assert.match(plainHtml, /<section class="subagent-topology" aria-labelledby="/);
    assert.match(
      plainHtml,
      /<div class="subagent-topology-agents" role="list" aria-label="Delegated tasks"><div class="[^"]*subagent-topology-node[^"]*" role="listitem" data-message-id="a1"/,
    );
    assert.doesNotMatch(plainHtml, /subagent-topology-branch|subagent-topology-children/);
    assert.deepEqual(topologyNodes(plainHtml), [
      { role: "listitem", id: "a1" },
      { role: "listitem", id: "a2" },
    ]);
    assert.equal(rootCopy(plainHtml), "Coordinating 2 delegated tasks · +2 nested");
    assert.equal(rootCopy(treeHtml), "Coordinating 2 delegated tasks");
  });

  await t.test("the empty hint replaces the agents list", () => {
    const hint = "The main agent is planning its delegation.";
    const html = renderTopology({
      items: emptyGraph.items,
      delegationStatuses: emptyGraph.statuses,
      delegationTimings: emptyGraph.timings,
      childrenByNode: emptyGraph.children,
      deepNodeIds: emptyGraph.deepNodeIds,
      emptyHint: hint,
      coordinatorName: "Main agent",
      onUserInteraction: noop,
    });
    assert.match(html, /<section class="subagent-topology is-tree is-empty" aria-labelledby="/);
    assert.equal(rootCopy(html), hint);
    assert.doesNotMatch(html, /subagent-topology-agents/);
  });

  await t.test("every node announces politely by default and announce=false disables it", () => {
    assert.equal(topologyNodes(treeHtml).length, 4, "two L1 and two L2 nodes; g1 is not drawn");
    assert.equal(
      occurrences(treeHtml, /<span class="sr-only" role="status" aria-live="polite">/g),
      4,
    );
    const silentHtml = renderTopology({ ...treeProps, announce: false });
    assert.equal(topologyNodes(silentHtml).length, 4);
    assert.doesNotMatch(silentHtml, /aria-live="polite"/);
  });
});
