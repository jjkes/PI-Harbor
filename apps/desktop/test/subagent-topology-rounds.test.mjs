import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * A parent that starts another round keeps the earlier round's children in the
 * same run. The dock must not draw that history as this round's work: earlier
 * rounds collapse into one expandable row per round, and a role that repeats
 * across rounds carries its round ordinal.
 */

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  delegationChildRounds,
  delegationRoundOrdinals,
} = await import("../src/lib/subagent-topology.ts");

const at = "2026-10-29T08:00:00.000Z";

/** A `Task` call as one parent's child. */
function child(id, { parent, agent, status }) {
  return {
    kind: "tool",
    message: {
      id,
      role: "tool",
      content: "",
      createdAt: at,
      toolName: "Task",
      toolCallId: id,
      parentToolCallId: parent,
      toolStatus: "success",
      toolArgs: { agent, description: `Work ${id}`, task: `Do ${id}` },
      toolResult: { details: { delegationId: id, status } },
    },
  };
}

const handleOf = (item) => item.message.toolArgs.agent;

test("one parent's children split into the rounds that dispatched them", () => {
  const children = [
    child("n1", { parent: "a0", agent: "explorer", status: "completed" }),
    child("n2", { parent: "a1", agent: "explorer", status: "running" }),
    child("n3", { parent: "a1", agent: "reviewer", status: "running" }),
  ];

  const rounds = delegationChildRounds(children, "a1");

  assert.deepEqual(rounds.current.map((item) => item.message.id), ["n2", "n3"]);
  assert.deepEqual(
    rounds.previous.map((round) => ({ key: round.key, ids: round.items.map((item) => item.message.id) })),
    [{ key: "a0", ids: ["n1"] }],
  );
});

test("children without a recorded call stay in the round being drawn", () => {
  const rounds = delegationChildRounds(
    [child("n1", { parent: undefined, agent: "explorer", status: "running" })],
    "a1",
  );
  assert.deepEqual(rounds.current.map((item) => item.message.id), ["n1"]);
  assert.deepEqual(rounds.previous, []);
});

test("a role repeated across rounds gets a round ordinal, a unique one does not", () => {
  const previous = {
    key: "a0",
    items: [child("n1", { parent: "a0", agent: "explorer", status: "completed" })],
  };
  const current = {
    key: "a1",
    items: [
      child("n2", { parent: "a1", agent: "explorer", status: "running" }),
      child("n3", { parent: "a1", agent: "reviewer", status: "running" }),
    ],
  };

  const ordinals = delegationRoundOrdinals([previous, current], handleOf);

  assert.deepEqual([...ordinals.entries()].sort(), [["n1", 1], ["n2", 2]]);
});

test("the dock collapses earlier rounds and marks the repeated role", async (t) => {
  const ssr = await slotSsr(t);
  const { SubagentTopology } = await ssr.load("/src/features/chat/transcript/SubagentDetail.tsx");

  const parent = child("a1", { parent: undefined, agent: "lead", status: "running" });
  const history = child("n1", { parent: "a0", agent: "explorer", status: "completed" });
  const current = child("n2", { parent: "a1", agent: "explorer", status: "running" });
  const html = ssr.render(
    createElement(SubagentTopology, {
      items: [parent],
      childrenByNode: new Map([["a1", [history, current]]]),
      deepNodeIds: new Set(),
      delegationStatuses: new Map([["n1", "completed"], ["n2", "running"]]),
      coordinatorName: "Main agent",
      onUserInteraction: () => {},
    }),
    { sessionId: null },
  );

  await t.test("the earlier round is one expandable row", () => {
    assert.match(html, /<div class="subagent-topology-prev-round" role="listitem">/);
    assert.match(html, /<details class="subagent-topology-prev-round-details">/);
    assert.match(html, /<summary class="subagent-topology-prev-round-summary">/);
    assert.match(html, /<span class="subagent-topology-prev-round-label">Previous round · 1 delegations<\/span>/);
    assert.match(html, /<span class="subagent-topology-prev-round-tally">1\/1 finished<\/span>/);
  });

  await t.test("the historical node sits inside the collapsed round", () => {
    const roundStart = html.indexOf('class="subagent-topology-prev-round-nodes"');
    const historical = html.indexOf('data-message-id="n1"');
    const currentStart = html.indexOf('</details>');
    const current = html.indexOf('data-message-id="n2"');
    assert.ok(roundStart >= 0 && historical >= 0 && currentStart >= 0 && current >= 0);
    assert.ok(roundStart < historical && historical < currentStart, "n1 belongs to the earlier round");
    assert.ok(currentStart < current, "n2 is drawn as this round's work, after the history");
  });

  await t.test("each round of the repeated role carries its ordinal", () => {
    assert.match(html, /<span class="subagent-topology-node-round"> · R1<\/span>/);
    assert.match(html, /<span class="subagent-topology-node-round"> · R2<\/span>/);
  });

  await t.test("a single round draws no previous-round markup", () => {
    const single = ssr.render(
      createElement(SubagentTopology, {
        items: [parent],
        childrenByNode: new Map([["a1", [current]]]),
        deepNodeIds: new Set(),
        delegationStatuses: new Map([["n2", "running"]]),
        coordinatorName: "Main agent",
        onUserInteraction: () => {},
      }),
      { sessionId: null },
    );
    assert.doesNotMatch(single, /subagent-topology-prev-round/);
    assert.doesNotMatch(single, /subagent-topology-node-round/);
  });
});
