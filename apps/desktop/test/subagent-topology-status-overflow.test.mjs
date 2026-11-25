import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * A topology node's status line carries status, duration, token spend and
 * throughput. The model name and spend fragment must stay visible at every
 * level of the DAG: they wrap to a second line in nested or narrow contexts
 * instead of being hidden with display:none.
 *
 * Server rendering runs no measurement, so the layout contract is checked from
 * two sides: the markup exposes a meta line that holds the model and spend,
 * and the stylesheet stacks that line for nested and narrow nodes.
 */

const startedAt = Date.parse("2026-10-29T08:00:00.000Z");
const createdAt = new Date(startedAt).toISOString();

/** A settled `Task` row, with optional runtime model id and usage details. */
function taskRow(id, delegationId, { modelId, usage } = {}) {
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
        ...(modelId ? { modelId } : {}),
        ...(usage ? { usage } : {}),
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

test("a topology node's status line keeps model and spend visible at every level", async (t) => {
  const ssr = await slotSsr(t);
  const { SubagentTopology } = await ssr.load("/src/features/chat/transcript/SubagentDetail.tsx");

  const parent = {
    kind: "tool",
    message: taskRow("a1", "d-a1", {
      modelId: "parent-model",
      usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1_000 },
    }),
  };
  const child = {
    kind: "tool",
    message: taskRow("n1", "d-n1", { modelId: "child-model" }),
    delegate: { items: [{ kind: "answer", message: delegateAnswer("i1") }] },
  };
  const childWithoutModel = {
    kind: "tool",
    message: taskRow("n2", "d-n2"),
    delegate: { items: [{ kind: "answer", message: delegateAnswer("i2") }] },
  };
  const timings = new Map([
    ["d-a1", { startedAt, completedAt: startedAt + 42_000 }],
    ["d-n1", { startedAt, completedAt: startedAt + 42_000 }],
    ["d-n2", { startedAt, completedAt: startedAt + 42_000 }],
  ]);
  const statuses = new Map([
    ["d-a1", "completed"],
    ["d-n1", "completed"],
    ["d-n2", "completed"],
  ]);
  const html = ssr.render(
    createElement(SubagentTopology, {
      items: [parent],
      childrenByNode: new Map([
        ["a1", [child, childWithoutModel]],
      ]),
      deepNodeIds: new Set(),
      delegationStatuses: statuses,
      delegationTimings: timings,
      coordinatorName: "Main agent",
      onUserInteraction: () => {},
    }),
    { sessionId: null },
  );

  await t.test("status and duration stay in the primary line", () => {
    const statusesHtml = [...html.matchAll(/<span class="subagent-topology-node-status">([^<]*)<\/span>/g)];
    assert.equal(statusesHtml.length, 3, "each node renders one primary status line");
    for (const [, body] of statusesHtml) {
      assert.match(body, /^Completed · 42s$/, "status and duration are the visible head");
      assert.doesNotMatch(body, /tokens used|tokens\/s/, "usage and rate are not in the primary line");
    }
  });

  await t.test("model and spend are grouped in a meta element with full tooltip", () => {
    const metas = [...html.matchAll(/<span class="subagent-topology-node-meta" title="([^"]*)">/g)].map((m) => m[1]);
    assert.equal(metas.length, 3, "each node renders a meta line");
    assert.match(metas[0], /parent-model/, "parent meta names its model");
    assert.match(metas[0], /1K tokens used · 24 tokens\/s/, "parent meta includes usage and rate");
    assert.match(metas[1], /child-model/, "child meta names its own model");
    assert.match(metas[1], /1K tokens used · 24 tokens\/s/, "child meta includes its own usage and rate");
    assert.doesNotMatch(metas[1], /parent-model/, "child meta does not inherit the parent's model");
    assert.match(metas[2], /1K tokens used · 24 tokens\/s/, "a node without a model still shows its usage and rate");
    assert.doesNotMatch(metas[2], /undefined/, "missing model is not rendered as text");
  });

  await t.test("a node without a model id omits the model element", () => {
    const nodes = [...html.matchAll(/<div class="tool-row subagent-topology-node[^"]*"/g)];
    assert.equal(nodes.length, 3, "three nodes rendered");
    const modellessStart = nodes[2].index;
    const modellessEnd = nodes[3]?.index ?? html.length;
    const modelless = html.slice(modellessStart, modellessEnd);
    assert.doesNotMatch(modelless, /class="subagent-topology-node-model"/, "no model element when there is no model id");
  });

  await t.test("the rendered line never hard-codes a width in the markup", () => {
    assert.doesNotMatch(html, /subagent-topology-node-meta[^>]*style="/, "no inline width or layout style");
  });

  await t.test("the base node status wraps instead of pushing its column", () => {
    const body = ruleBody(css("src/styles/messages.css"), ".subagent-topology-node-status");
    assert.match(body, /min-width: 0;/);
    assert.match(body, /flex: 0 1 auto;/);
    assert.match(body, /overflow-wrap: anywhere;/);
    assert.match(body, /white-space: normal;/);
  });

  await t.test("the meta line is visible for nested nodes and stacks on its own line", () => {
    const source = css("src/styles/messages.css");
    assert.doesNotMatch(
      source,
      /\.subagent-topology-children \.subagent-topology-node-status-secondary,\s*\.subagent-topology-child \.subagent-topology-node-status-secondary\s*\{[^}]*display:\s*none/,
      "nested spend fragment is no longer hidden",
    );
    assert.match(
      source,
      /\.subagent-topology-children \.subagent-topology-node-meta,\s*\.subagent-topology-child \.subagent-topology-node-meta\s*\{[^}]*flex-basis:\s*100%;/,
      "nested meta line stacks instead of hiding",
    );
  });

  await t.test("the meta line is visible in a narrow dock and stacks on its own line", () => {
    const source = css("src/styles/messages.css");
    assert.doesNotMatch(
      source,
      /@container subagent-activity \(max-width: 640px\)\s*\{[\s\S]*?\.subagent-topology-node-status-secondary\s*\{[^}]*display:\s*none/,
      "narrow dock spend fragment is no longer hidden",
    );
    assert.match(
      source,
      /@container subagent-activity \(max-width: 640px\)\s*\{[\s\S]*?\.subagent-topology-node-meta\s*\{[^}]*flex-basis:\s*100%;/,
      "narrow dock meta line stacks instead of hiding",
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

  await t.test("the dock no longer hides the model badge by default", () => {
    const source = css("src/features/chat/subagent-dock/subagent-dock.css");
    assert.doesNotMatch(
      source,
      /\.subagent-dock-panel \.subagent-topology-node-model\s*\{[^}]*display:\s*none/,
      "model badge is not display:none in the dock",
    );
  });

  await t.test("the node's own ancestors can shrink", () => {
    const source = css("src/styles/messages.css");
    assert.match(ruleBody(source, ".subagent-topology-node-title-row"), /flex-wrap: wrap;/);
    assert.match(ruleBody(source, ".subagent-topology-node-copy"), /min-width: 0;/);
  });

  await t.test("the topology renders inside a named container host", () => {
    assert.match(html, /<div class="subagent-topology-host">/);
    const hostRule = ruleBody(css("src/styles/messages.css"), ".subagent-topology-host");
    assert.match(hostRule, /container:\s*subagent-activity\s*\/\s*inline-size/);
    assert.match(hostRule, /min-width:\s*0/);
  });

  await t.test("the dock forces nested child meta onto its own line at narrow widths", () => {
    const source = css("src/features/chat/subagent-dock/subagent-dock.css");
    assert.match(
      source,
      /\.subagent-dock-panel \.subagent-topology-children \.subagent-topology-node-meta,\s*\.subagent-dock-panel \.subagent-topology-child \.subagent-topology-node-meta\s*\{[^}]*flex-basis:\s*100%;/,
      "dock nested/child meta stacks with explicit flex-basis",
    );
  });

  await t.test("the topology node exposes model and spend on its label while status is announced live", () => {
    const nodes = [
      ...html.matchAll(/<div class="tool-row subagent-topology-node[^"]*"[^>]*aria-label="([^"]*)"[^>]*>/g),
    ];
    assert.equal(nodes.length, 3, "three topology nodes rendered");
    const parentLabel = nodes[0][1];
    const childLabel = nodes[1][1];
    assert.match(parentLabel, /parent-model/, "outer label names the parent model");
    assert.match(parentLabel, /1K tokens used/, "outer label includes parent token spend");
    assert.match(childLabel, /child-model/, "outer label names the child model");
    assert.doesNotMatch(parentLabel, /Completed/, "outer label does not repeat visible status");
    assert.doesNotMatch(childLabel, /Completed/, "outer label does not repeat visible status");
    const srStatuses = [
      ...html.matchAll(/<span class="sr-only" role="status" aria-live="polite">([^<]*)<\/span>/g),
    ];
    assert.ok(srStatuses.length > 0, "a live status region exists");
    assert.ok(
      srStatuses.some(([, text]) => /Completed/.test(text)),
      "live region announces the status",
    );
  });

});
