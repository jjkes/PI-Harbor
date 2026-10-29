import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const CREATED_AT = "2026-10-29T00:00:00.000Z";
function task(toolCallId, agent, parentToolCallId) {
  return {
    id: `row-${toolCallId}`,
    role: "tool",
    content: "",
    createdAt: CREATED_AT,
    toolName: "Task",
    toolCallId,
    toolStatus: "success",
    toolArgs: { agent, task: `Work for ${agent}` },
    ...(parentToolCallId ? { parentToolCallId } : {}),
    toolResult: { details: { delegationId: `delegation-${toolCallId}`, status: "running" } },
  };
}

test("permission lineage follows loaded Task owners and PermissionCard renders it", async (t) => {
  const ssr = await slotSsr(t);
  const [
    { delegationAgentLineage, formatDelegationAgentLineage },
    { PermissionCard },
    { useAppStore },
  ] = await Promise.all([
    ssr.load("/src/lib/subagent-lineage.ts"),
    ssr.load("/src/components/PermissionCard.tsx"),
    ssr.load("/src/stores/app-store.ts"),
  ]);
  const messages = [
    task("root-call", "explorer"),
    task("nested-call", "test-runner", "root-call"),
  ];
  const request = { parentToolCallId: "nested-call", agentName: "test-runner" };
  assert.deepEqual(delegationAgentLineage(messages, request), ["explorer", "test-runner"]);
  assert.equal(formatDelegationAgentLineage(messages, request), "explorer › test-runner");
  assert.deepEqual(
    delegationAgentLineage([messages[1]], request),
    ["test-runner"],
    "an unloaded root falls back to the asking agent without inventing ancestry",
  );
  const cyclic = [
    task("cycle-a", "explorer", "cycle-b"),
    task("cycle-b", "test-runner", "cycle-a"),
  ];
  assert.deepEqual(
    delegationAgentLineage(cyclic, { parentToolCallId: "cycle-a", agentName: "test-runner" }),
    ["test-runner"],
    "a cycle falls back to the asking agent instead of inventing an order",
  );

  Object.assign(useAppStore.getInitialState(), {
    activeSessionId: "session-team",
    sessions: [{ id: "session-team", source: "desktop", projectPath: "/workspace" }],
    messages,
    retainedTranscripts: {},
  });
  const html = ssr.render(createElement(PermissionCard, {
    permission: {
      sessionId: "session-team",
      requestId: "permission-l2",
      toolCallId: "read-l2",
      toolName: "Read",
      argsPreview: { path: "fixture.ts" },
      risk: "low",
      ...request,
    },
  }));
  assert.match(html, /explorer › test-runner/);
});
