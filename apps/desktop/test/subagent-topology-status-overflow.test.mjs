import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * A topology node's status line carries status, duration, token spend and
 * throughput. It is a wrapping line with one low-priority fragment (the spend):
 * the node must never widen its column into the sibling one, and the fragment
 * is the part that disappears when the node has no room for it.
 *
 * Server rendering runs no measurement, so the layout contract is checked from
 * two sides: the markup marks the droppable fragment, and the stylesheet wraps
 * the line and hides that fragment for nested and narrow nodes.
 */

const startedAt = Date.parse("2026-10-29T08:00:00.000Z");
const createdAt = new Date(startedAt).toISOString();

/** A settled `Task` row, with the runtime's usage total on its details. */
function taskRow(id, delegationId, usage) {
  return {
    id,
    role: "tool",
    toolName: "Task",
    toolCallId: id,
    content: "",
    createdAt,
    toolArgs: {
      subagent_type: "explorer",
      description: `Work ${id}`,
      task: `Do ${id}`,
    },
    toolStatus: "success",
    toolResult: {
      content: [],
      details: {
        delegationId,
        status: "completed",
        startedAt,
        completedAt: startedAt + 42_000,
        usage,
      },
    },
  };
}

/** The delegate's own assistant row, the only usage a live node has. */
function delegateAnswer(id) {
  return {
    id,
    role: "assistant",
    content: "Surveyed the package.",
    createdAt,
    usage: { inputTokens: 600, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000 },
  };
}

const css = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The one rule body whose selector list is exactly `selector`. */
function ruleBody(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `\`${selector}\` has a rule`);
  return match[1];
}

test("a topology node's status line wraps and drops its spend fragment first", async (t) => {
  const ssr = await slotSsr(t);
  const { SubagentTopology } = await ssr.load("/src/features/chat/transcript/SubagentDetail.tsx");

  const parent = { kind: "tool", message: taskRow("a1", "d-a1", { inputTokens: 900, outputTokens: 100, totalTokens: 1_000 }) };
  const child = {
    kind: "tool",
    message: taskRow("n1", "d-n1"),
    delegate: { items: [{ kind: "answer", message: delegateAnswer("i1") }] },
  };
  const timings = new Map([
    ["d-a1", { startedAt, completedAt: startedAt + 42_000 }],
    ["d-n1", { startedAt, completedAt: startedAt + 42_000 }],
  ]);
  const statuses = new Map([
    ["d-a1", "completed"],
    ["d-n1", "completed"],
  ]);
  const html = ssr.render(
    createElement(SubagentTopology, {
      items: [parent],
      childrenByNode: new Map([["a1", [child]]]),
      deepNodeIds: new Set(),
      delegationStatuses: statuses,
      delegationTimings: timings,
      coordinatorName: "Main agent",
      onUserInteraction: () => {},
    }),
    { sessionId: null },
  );

  await t.test("status and duration stay outside the droppable fragment", () => {
    const statusesHtml = [...html.matchAll(/<span class="subagent-topology-node-status">([\s\S]*?)<\/span><\/span>/g)];
    assert.equal(statusesHtml.length, 2, "each node renders one status line");
    for (const [, body] of statusesHtml) {
      assert.match(body, /^Completed · 42s<span class="subagent-topology-node-status-secondary">/, "status and duration are the visible head");
      assert.match(body, /subagent-topology-node-status-secondary"> · 1K tokens used · 24 tokens\/s$/, "spend and throughput are the marked tail");
    }
  });

  await t.test("the rendered line never hard-codes a width in the markup", () => {
    assert.doesNotMatch(html, /subagent-topology-node-status[^>]*style="/, "no inline width or layout style");
  });

  await t.test("the base node status wraps instead of pushing its column", () => {
    const body = ruleBody(css("src/styles/messages.css"), ".subagent-topology-node-status");
    assert.match(body, /min-width: 0;/);
    assert.match(body, /flex: 0 1 auto;/);
    assert.match(body, /overflow-wrap: anywhere;/);
    assert.match(body, /white-space: normal;/);
  });

  await t.test("the spend fragment is hidden for nested nodes", () => {
    const source = css("src/styles/messages.css");
    assert.match(
      source,
      /\.subagent-topology-children \.subagent-topology-node-status-secondary,\n\.subagent-topology-child \.subagent-topology-node-status-secondary \{\n  display: none;/,
    );
  });

  await t.test("the spend fragment is hidden in a narrow dock", () => {
    const source = css("src/styles/messages.css");
    assert.match(
      source,
      /@container subagent-activity \(max-width: 640px\) \{\n {2}\.subagent-topology-node-status-secondary \{\n {4}display: none;/,
    );
  });

  await t.test("the dock node status keeps the same wrapping contract", () => {
    const body = ruleBody(
      css("src/features/chat/subagent-dock/subagent-dock.css"),
      ".subagent-dock-panel .subagent-topology-node-status",
    );
    assert.match(body, /flex: 0 1 auto;/);
    assert.match(body, /min-width: 0;/);
    assert.match(body, /overflow-wrap: anywhere;/);
    assert.match(body, /white-space: normal;/);
  });

  await t.test("the node's own ancestors can shrink", () => {
    const source = css("src/styles/messages.css");
    assert.match(ruleBody(source, ".subagent-topology-node-title-row"), /flex-wrap: wrap;/);
    assert.match(ruleBody(source, ".subagent-topology-node-copy"), /min-width: 0;/);
  });
});
