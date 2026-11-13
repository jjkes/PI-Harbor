/**
 * A topology node reports what its delegate spent. These tests pin the two
 * sources and their precedence: the runtime's settled total wins, the delegate's
 * own assistant rows are the live fallback, and a node with no measurement shows
 * nothing rather than a zero.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  delegateRowUsage,
  publishedDelegationUsage,
  subagentNodeUsage,
  tokensPerSecond,
  usageTokens,
} = await import("../src/lib/subagent-usage.ts");

const usage = (over = {}) => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  ...over,
});

const row = (role, rowUsage) => ({
  kind: role === "assistant" ? "answer" : "tool",
  message: { role, usage: rowUsage },
});

test("a provider total wins, and a bucket-only row is summed instead of read as zero", () => {
  assert.equal(usageTokens(usage({ inputTokens: 900, outputTokens: 100, totalTokens: 1000 })), 1000);
  // A missing total is not a zero: the buckets are the measurement.
  assert.equal(usageTokens(usage({ inputTokens: 900, outputTokens: 100 })), 1000);
  assert.equal(usageTokens(usage()), 0);
  assert.equal(usageTokens(undefined), 0);
});

test("delegate rows are summed for assistant messages only, once per operation", () => {
  assert.equal(
    usageTokens(
      delegateRowUsage([
        row("assistant", usage({ totalTokens: 120, operationId: "op-1" })),
        // A retried stream repeats the same operation: it is one request.
        row("assistant", usage({ totalTokens: 120, operationId: "op-1" })),
        row("assistant", usage({ totalTokens: 80, operationId: "op-2" })),
        row("user", usage({ totalTokens: 500, operationId: "op-3" })),
      ]),
    ),
    200,
  );
  assert.equal(delegateRowUsage([]), undefined);
});

test("only a well-formed published block counts as the runtime total", () => {
  assert.deepEqual(
    publishedDelegationUsage({ delegationId: "d1", usage: usage({ inputTokens: 30, outputTokens: 70 }) }),
    { inputTokens: 30, outputTokens: 70, totalTokens: 100 },
  );
  assert.equal(publishedDelegationUsage({ delegationId: "d1" }), undefined);
  assert.equal(publishedDelegationUsage({ usage: "1200" }), undefined);
  assert.equal(publishedDelegationUsage({ usage: {} }), undefined);
  assert.equal(publishedDelegationUsage([usage({ totalTokens: 10 })]), undefined);
  assert.equal(publishedDelegationUsage(null), undefined);
});

test("throughput needs a real span: a sub-second node has no rate", () => {
  assert.equal(tokensPerSecond(600, 12_000), 50);
  assert.equal(tokensPerSecond(600, 999), undefined);
  assert.equal(tokensPerSecond(600, undefined), undefined);
  assert.equal(tokensPerSecond(0, 12_000), undefined);
});

test("the published total replaces the live row sum, and the rate follows the span", () => {
  const items = [row("assistant", usage({ totalTokens: 1_000, operationId: "live" }))];
  assert.deepEqual(
    subagentNodeUsage({
      payload: { usage: usage({ totalTokens: 4_000 }) },
      items,
      durationMs: 8_000,
    }),
    { tokens: 4_000, ratePerSecond: 500 },
  );
  // Running: the rows are all there is, and the node still shows a rate.
  assert.deepEqual(subagentNodeUsage({ items, durationMs: 10_000 }), {
    tokens: 1_000,
    ratePerSecond: 100,
  });
  // Nothing measured yet: no `0 tokens used` and no invented throughput.
  assert.equal(subagentNodeUsage({ items: [], durationMs: 10_000 }), undefined);
  assert.equal(subagentNodeUsage({ payload: { delegationId: "d1" } }), undefined);
});

test("a topology node prints the total and the rate, from the delegate's rows", async () => {
  // The node is the only surface that reports this, and the labels are the same
  // two the turn usage capsule uses, so the wording stays consistent.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../src/features/chat/transcript/ToolRow.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /subagentNodeUsage\(/);
  assert.match(source, /\.\.\.\(delegate \? \{ items: delegate\.items \} : \{\}\)/);
  assert.match(source, /t\("chat\.usageContextSpent"/);
  assert.match(source, /t\("chat\.usageThroughput"/);
  assert.match(source, /nodeRateText \? ` · \$\{nodeRateText\}` : ""/);
});
