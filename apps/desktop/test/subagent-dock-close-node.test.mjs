import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * The dock's per-node close: one settled delegate can be put away on its own.
 * The graph itself decides what it draws, so these pin the three things a user
 * meets: a settled node carries the control, a running or queued node never
 * does, and every other caller of the topology gets exactly the markup it had
 * before the control existed.
 */

let clock = Date.parse("2026-10-29T08:00:00.000Z");
const stamp = () => new Date((clock += 1_000)).toISOString();

const user = (id, content) => ({ id, role: "user", content, createdAt: stamp() });
const assistant = (id, content) => ({ id, role: "assistant", content, createdAt: stamp() });

/** A `Task` call as the runtime records it (ADR 0089). */
function task(id, delegationId) {
  return {
    id,
    role: "tool",
    toolName: "Task",
    toolCallId: id,
    content: "",
    createdAt: stamp(),
    toolArgs: { subagent_type: "explorer", description: `Work ${id}`, task: `Do ${id}` },
    toolStatus: "success",
    toolResult: {
      content: [],
      details: { delegationId, status: "running", startedAt: clock },
    },
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

const noop = () => {};
const CLOSE = /<button type="button" class="subagent-topology-node-close" aria-label="([^"]*)" title="([^"]*)">/g;
const closeButtons = (html) => [...html.matchAll(CLOSE)];

// The label is the catalog's own entry for the control. A unit run renders
// against the built i18n package, which may lag the catalog source, so the key
// itself is accepted too — what matters here is that the graph asks for that
// one key and hands it to both the accessible name and the tooltip.
const catalogCopy = (
  await readFile(
    new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
    "utf8",
  )
).match(/^\s*closeDelegation: "([^"]+)",$/m)?.[1];
const isCloseLabel = (label) => label === catalogCopy || label === "chat.closeDelegation";

test("the dock offers a close on a settled node and never on a running one", async (t) => {
  const ssr = await slotSsr(t);
  const [
    { SubagentTopology },
    { SubagentDockPanel },
    { buildTranscriptEntries },
    { collectLiveDelegationEntries },
    { sessionDelegations },
  ] = await Promise.all([
    ssr.load("/src/features/chat/transcript/SubagentDetail.tsx"),
    ssr.load("/src/features/chat/subagent-dock/SubagentDockPanel.tsx"),
    ssr.load("/src/lib/assistant-turns.ts"),
    ssr.load("/src/lib/live-delegation-entries.ts"),
    ssr.load("/src/lib/session-delegations.ts"),
  ]);

  const messages = [
    user("u1", "Map the repository"),
    assistant("m1", "Delegating."),
    task("a1", "d-a1"),
    task("a2", "d-a2"),
    taskWait("w1", [{ delegationId: "d-a2", status: "completed" }]),
  ];
  const { entries, runs } = buildTranscriptEntries(messages);
  const liveEntries = collectLiveDelegationEntries(entries.slice(0, -1), entries.at(-1), true);
  const graph = sessionDelegations(entries, liveEntries, runs);
  // One delegate is still working, the other has settled: `a1` running, `a2` done.
  assert.deepEqual(graph.items.map((item) => item.message.id), ["a1", "a2"]);

  const topologyProps = {
    items: graph.items,
    delegationStatuses: graph.statuses,
    delegationTimings: graph.timings,
    childrenByNode: graph.children,
    deepNodeIds: graph.deepNodeIds,
    onUserInteraction: noop,
  };
  const render = (props) => ssr.render(createElement(SubagentTopology, props), { sessionId: null });

  await t.test("a settled node carries the ×, with the catalog's own label", () => {
    const html = render({ ...topologyProps, onCloseNode: noop, closableNodeIds: new Set(["a2"]) });
    const buttons = closeButtons(html);
    assert.equal(buttons.length, 1);
    assert.ok(isCloseLabel(buttons[0][1]), `close label: ${buttons[0][1]}`);
    assert.equal(buttons[0][2], buttons[0][1], "the tooltip repeats the accessible name");
    // It belongs to the settled node, not to the running one drawn before it.
    const closeAt = html.indexOf('<button type="button" class="subagent-topology-node-close"');
    assert.ok(html.indexOf('data-message-id="a2"') < closeAt, "the close follows the node it closes");
    assert.ok(closeAt > html.indexOf('data-message-id="a1"'));
  });

  await t.test("a running node is offered no control at all", () => {
    // The dock never names a running node, and the graph would refuse it even
    // if it did: nothing that is still working may be put away.
    const named = render({ ...topologyProps, onCloseNode: noop, closableNodeIds: new Set(["a1"]) });
    assert.equal(closeButtons(named).length, 0);
    const unnamed = render({ ...topologyProps, onCloseNode: noop, closableNodeIds: new Set() });
    assert.equal(closeButtons(unnamed).length, 0);
  });

  await t.test("a graph without the action keeps the markup it had", () => {
    const html = render(topologyProps);
    assert.equal(closeButtons(html).length, 0);
    assert.doesNotMatch(html, /subagent-topology-node-close/);
  });

  await t.test("the dock threads the action to its own nodes only", () => {
    const html = ssr.render(
      createElement(SubagentDockPanel, {
        listId: "dock-subagents",
        sessionId: "s1",
        delegations: graph,
        interactive: true,
        team: false,
      }),
      { sessionId: null },
    );
    const buttons = closeButtons(html);
    assert.equal(buttons.length, 1);
    assert.ok(isCloseLabel(buttons[0][1]), `close label: ${buttons[0][1]}`);
    // The batch control is untouched: settling the round still offers it.
    assert.match(html, /subagent-dock-end-round/);
  });
});
