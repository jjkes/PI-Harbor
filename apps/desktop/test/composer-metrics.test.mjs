/**
 * The composer metric row's readings. The three cache figures look alike and are
 * deliberately separate: the newest request, this session's own requests, and its
 * delegate requests answer different questions and must never be mixed.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { composerMetricReadings } = await import("../src/lib/composer-metrics.ts");
const { aggregateSessionTokenUsage } = await import(
  "../src/lib/session-token-usage.ts"
);

const usage = (inputTokens, cacheReadTokens, outputTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: inputTokens + outputTokens + cacheReadTokens,
});

const assistant = (id, rowUsage, extra = {}) => ({
  id,
  role: "assistant",
  content: "",
  createdAt: "2026-10-01T00:00:00.000Z",
  usage: rowUsage,
  ...extra,
});

const inspector = ({ latest, responseOutputTokens, responseDurationMs }) => ({
  usage: latest,
  turnUsage: latest,
  contextWindow: 128_000,
  tools: [],
  ...(responseOutputTokens !== undefined ? { responseOutputTokens } : {}),
  ...(responseDurationMs !== undefined ? { responseDurationMs } : {}),
  responseOutputEstimated: false,
});

test("each cache reading measures its own scope", () => {
  const sessionUsage = aggregateSessionTokenUsage([
    // Main session: 600 uncached + 400 cached prompt tokens → 40%.
    assistant("main-1", usage(600, 400, 50)),
    // The team: 50 uncached + 150 cached → 75%.
    assistant("sub-1", usage(50, 150, 20), { parentToolCallId: "task-1" }),
  ]);

  const readings = composerMetricReadings(
    {
      ...inspector({ latest: usage(40, 60, 10) }),
    },
    sessionUsage,
  );

  // The newest request alone: 40 uncached + 60 cached → 60%.
  assert.equal(readings.latestCacheRate, 60);
  // The session's own rows only, not the team's.
  assert.equal(readings.sessionCacheRate, 40);
  // The team's rows only, not the session's.
  assert.equal(readings.teamCacheRate, 75);
  assert.equal(readings.showTeam, true);
});

test("a session that never delegated shows no team reading", () => {
  const sessionUsage = aggregateSessionTokenUsage([
    assistant("main-1", usage(600, 400, 50)),
  ]);
  const readings = composerMetricReadings(
    inspector({ latest: usage(600, 400, 50) }),
    sessionUsage,
  );
  assert.equal(readings.showTeam, false);
  assert.equal(readings.sessionCacheRate, 40);
});

test("speed falls back to the settled provider average", () => {
  const readings = composerMetricReadings(
    inspector({
      latest: usage(40, 60, 10),
      responseOutputTokens: 400,
      responseDurationMs: 4_000,
    }),
    null,
  );
  assert.equal(readings.averageRate, 100);
  // No session aggregate yet: the cache readings stay unmeasured, not zero.
  assert.equal(readings.sessionCacheRate, undefined);
  assert.equal(readings.teamCacheRate, undefined);
  assert.equal(readings.showTeam, false);
});

test("nothing measured yet reads as nothing, never as zero", () => {
  const readings = composerMetricReadings(null, null);
  assert.equal(readings.averageRate, undefined);
  assert.equal(readings.latestCacheRate, undefined);
  assert.equal(readings.sessionCacheRate, undefined);
  assert.equal(readings.teamCacheRate, undefined);
  assert.equal(readings.showTeam, false);

  // An empty session aggregates to zeroes, which has no cache denominator.
  const empty = composerMetricReadings(null, aggregateSessionTokenUsage([]));
  assert.equal(empty.sessionCacheRate, undefined);
});
