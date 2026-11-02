import assert from "node:assert/strict";
import test from "node:test";
import { aggregateSessionTokenUsage } from "../src/lib/session-token-usage.ts";

const usage = (inputTokens, outputTokens, extra = {}) => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  ...extra,
});

const assistant = (id, value, extra = {}) => ({
  id,
  role: "assistant",
  content: "",
  createdAt: "2026-10-01T00:00:00.000Z",
  ...(value ? { usage: value } : {}),
  ...extra,
});

test("session token usage separates the main session from delegates", () => {
  const result = aggregateSessionTokenUsage([
    assistant("main-1", usage(1_000, 200)),
    assistant("main-2", usage(400, 100)),
    assistant("sub-1", usage(300, 50), { parentToolCallId: "task-1", agentName: "scout" }),
    assistant("sub-2", usage(100, 25), { parentToolCallId: "task-1", agentName: "scout" }),
    assistant("sub-3", usage(10, 5), { parentToolCallId: "task-2", agentName: "worker" }),
  ]);

  assert.equal(result.main.inputTokens, 1_400);
  assert.equal(result.main.outputTokens, 300);
  assert.equal(result.main.totalTokens, 1_700);
  assert.equal(result.main.modelCallCount, 2);

  assert.equal(result.subagents.inputTokens, 410);
  assert.equal(result.subagents.outputTokens, 80);
  assert.equal(result.subagents.totalTokens, 490);
  // One delegate call per distinct Task tool call, not per row.
  assert.equal(result.subagents.delegationCount, 2);

  assert.equal(result.total.inputTokens, 1_810);
  assert.equal(result.total.outputTokens, 380);
  assert.equal(result.total.totalTokens, 2_190);
});

test("session token usage keeps cache, write, and reasoning buckets", () => {
  const result = aggregateSessionTokenUsage([
    assistant(
      "main-1",
      usage(1_000, 200, {
        cacheReadTokens: 500,
        cacheWriteTokens: 250,
        reasoningTokens: 120,
      }),
    ),
  ]);

  assert.equal(result.main.cacheReadTokens, 500);
  assert.equal(result.main.cacheWriteTokens, 250);
  assert.equal(result.main.reasoningTokens, 120);
  // Reasoning is reported beside the buckets but never added: the provider's
  // output count already contains it (D103).
  assert.equal(result.main.totalTokens, 1_950);
});

test("session token usage ignores rows without provider usage", () => {
  const result = aggregateSessionTokenUsage([
    { id: "user-1", role: "user", content: "hi", createdAt: "2026-10-01T00:00:00.000Z" },
    assistant("main-1", undefined),
    { id: "tool-1", role: "tool", content: "ok", createdAt: "2026-10-01T00:00:01.000Z" },
  ]);

  assert.equal(result.main.totalTokens, 0);
  assert.equal(result.main.modelCallCount, 0);
  assert.equal(result.subagents.delegationCount, 0);
  assert.equal(result.total.totalTokens, 0);
});

test("negative and non-finite counts never reach the totals", () => {
  const result = aggregateSessionTokenUsage([
    assistant("main-1", {
      inputTokens: Number.NaN,
      outputTokens: -40,
      totalTokens: 0,
      cacheReadTokens: Number.POSITIVE_INFINITY,
    }),
  ]);

  assert.equal(result.main.totalTokens, 0);
});

test("per-agent breakdown groups delegate spend by definition name", () => {
  const result = aggregateSessionTokenUsage(
    [
      assistant("sub-1", usage(100, 40), { parentToolCallId: "task-1", agentName: "scout" }),
      assistant("sub-2", usage(60, 20), { parentToolCallId: "task-1", agentName: "scout" }),
      assistant("sub-3", usage(10, 5), { parentToolCallId: "task-2", agentName: "worker" }),
    ],
    true,
  );

  assert.ok(result.byAgent);
  assert.deepEqual(result.byAgent.get("scout"), {
    inputTokens: 160,
    outputTokens: 60,
    totalTokens: 220,
    callCount: 2,
  });
  assert.deepEqual(result.byAgent.get("worker"), {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    callCount: 1,
  });
});

test("by-agent breakdown is opt-in so the toolbar stays cheap", () => {
  const result = aggregateSessionTokenUsage([
    assistant("sub-1", usage(100, 40), { parentToolCallId: "task-1", agentName: "scout" }),
  ]);

  assert.equal(result.byAgent, undefined);
});
