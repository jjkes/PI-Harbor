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
  delegateLiveTokens,
  delegateRowUsage,
  publishedDelegationUsage,
  subagentNodeUsage,
  tokensPerSecond,
  usageTokens,
} = await import("../src/lib/subagent-usage.ts");
const { resolveSpeedReading } = await import("../src/lib/instant-token-rate.ts");

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

test("a running node's live total comes from the text it has streamed", () => {
  // Four characters per token, code points counted once, and tool rows excluded
  // because they carry the model's input rather than its output.
  assert.equal(
    delegateLiveTokens([
      { kind: "thinking", message: { thinking: "abcd" } },
      { kind: "answer", message: { content: "abcdefgh" } },
      { kind: "tool", message: { content: "x".repeat(4_000) } },
    ]),
    3,
  );
  assert.equal(delegateLiveTokens([]), 0);
});

test("the published total replaces the live row sum", () => {
  const items = [row("assistant", usage({ totalTokens: 1_000, operationId: "live" }))];
  assert.deepEqual(
    subagentNodeUsage({
      payload: { usage: usage({ totalTokens: 4_000 }) },
      items,
    }),
    { tokens: 4_000 },
  );
  // Running: the rows are all there is, and the node still shows its spend.
  assert.deepEqual(subagentNodeUsage({ items }), { tokens: 1_000 });
  // Nothing measured yet: no `0 tokens used` and no invented throughput.
  assert.equal(subagentNodeUsage({ items: [] }), undefined);
  assert.equal(subagentNodeUsage({ payload: { delegationId: "d1" } }), undefined);
});

test("a topology node prints a live speed while running and the average once settled", async () => {
  // A node's spend and its speed have different sources: the runtime total is
  // only known once the run ends, so the running figure comes from the stream.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../src/features/chat/transcript/ToolRow.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /subagentNodeUsage\(/);
  assert.match(source, /\.\.\.\(delegate \? \{ items: delegate\.items \} : \{\}\)/);
  assert.match(source, /t\("chat\.usageContextSpent"/);
  assert.match(
    source,
    /const nodeRunning = variant === "topology" && outcome === "running"/,
  );
  assert.match(source, /delegateLiveTokens\(delegate\.items\)/);
  assert.match(source, /useInstantTokenRate\(nodeLiveTokens, nodeRunning\)/);
  assert.match(source, /resolveSpeedReading\(\s*nodeRunning,/);
  // The elapsed-clock average is now only the settled reading.
  assert.match(source, /nodeUsage && !nodeRunning\s*\?\s*tokensPerSecond\(/);
  // The estimate is labelled as one, in the capsule's own wording.
  assert.match(
    source,
    /nodeRate\.estimated\s*\?\s*"chat\.usageThroughputEstimated"/,
  );
  // The meta line groups model, usage and rate, and an aria label repeats usage/rate.
  assert.match(source, /const topologyMetaLabel = /);
  assert.match(source, /const topologyUsageRateLabel = /);
  assert.match(source, /<span className="subagent-topology-node-meta" title=\{topologyMetaLabel\}>/);
  assert.match(source, /topologyUsageRateLabel \? `, \$\{topologyUsageRateLabel\}` : ""/);
});

test("resolveSpeedReading picks the instant estimate while running and the average once settled", () => {
  assert.deepEqual(resolveSpeedReading(true, 12, 24), {
    tokensPerSecond: 12,
    estimated: true,
  });
  assert.deepEqual(resolveSpeedReading(false, 12, 24), {
    tokensPerSecond: 24,
    estimated: false,
  });
  assert.deepEqual(resolveSpeedReading(true, undefined, 24), { estimated: true });
  assert.deepEqual(resolveSpeedReading(false, 12, undefined), { estimated: false });
  assert.deepEqual(resolveSpeedReading(false, undefined, undefined), { estimated: false });
});
