import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
 * Per-round lifecycle: "End round" folds the settled delegates of the current
 * dispatch out of the live view, and one settled node can also be put away on
 * its own. The rules under test are the ones the dock and the transcript depend
 * on: only settled work, idempotent, one set shared by both actions, and a
 * running delegate can never be folded away.
 */

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  currentSettledRound,
  foldedRoundSummary,
  fromRetiredRoundsSnapshot,
  isRoundFolded,
  liveSessionDelegations,
  retireCurrentRound,
  retireDelegation,
  retiredDelegationIds,
  toRetiredRoundsSnapshot,
  NO_RETIRED_ROUNDS,
} = await import("../src/lib/subagent-rounds.ts");
const { summarizeSubagentActivity } = await import("../src/lib/subagent-topology.ts");

/** One `Task` row, shaped as `toolResultPayload` reads a delegation result. */
function task(id, status) {
  return {
    kind: "tool",
    message: {
      id,
      role: "tool",
      content: "",
      createdAt: "2026-08-10T00:00:00.000Z",
      toolName: "Task",
      toolCallId: id,
      toolStatus: status === "running" ? "running" : "success",
      toolArgs: { agent: "reviewer", description: id },
      toolResult: { details: { delegationId: id, status } },
    },
  };
}

/** A session reading, in the order `sessionDelegations` publishes it. */
function reading(entries) {
  const items = entries.map((entry) => entry.item);
  const statuses = new Map(entries.map((entry) => [entry.item.message.toolCallId, entry.status]));
  const rounds = new Map(entries.map((entry) => [entry.item.message.toolCallId, entry.round]));
  return {
    items,
    statuses,
    timings: new Map(),
    nodes: entries.map((entry) => ({
      id: entry.item.message.toolCallId,
      active: entry.status === "running",
    })),
    summary: summarizeSubagentActivity(items, statuses),
    children: new Map(),
    deepNodeIds: new Set(),
    rounds,
  };
}

// Newest round first for settled work, then the older round, running work
// hoisted to the front — the order `sessionDelegations` publishes.
function session() {
  return reading([
    { item: task("c1", "running"), round: "round-2", status: "running" },
    { item: task("b1", "completed"), round: "round-2", status: "completed" },
    { item: task("a1", "completed"), round: "round-1", status: "completed" },
    { item: task("a2", "failed"), round: "round-1", status: "failed" },
  ]);
}

test("the current round is the newest one with a settled delegate", () => {
  assert.equal(currentSettledRound(session()), "round-2");
  assert.equal(currentSettledRound(reading([])), null);
  assert.equal(
    currentSettledRound(reading([{ item: task("c1", "running"), round: "r", status: "running" }])),
    null,
  );
});

test("retiring folds only settled delegates of the current round", () => {
  const retired = retireCurrentRound(session(), NO_RETIRED_ROUNDS);
  assert.deepEqual([...retired.keys()], ["round-2"]);
  assert.deepEqual(retired.get("round-2"), ["b1"]);
  // The running sibling keeps its place: nothing a subagent is doing now may
  // be folded out of the graph.
  assert.equal(retired.get("round-2").includes("c1"), false);
  // An older round is untouched: one click ends one round.
  assert.equal(retired.has("round-1"), false);
});

test("retiring is idempotent", () => {
  const once = retireCurrentRound(session(), NO_RETIRED_ROUNDS);
  const twice = retireCurrentRound(session(), once);
  assert.equal(twice, once);
  assert.equal(twice.size, 1);
  assert.deepEqual(twice.get("round-2"), ["b1"]);
});

test("nothing settled means nothing to retire", () => {
  const runningOnly = reading([
    { item: task("c1", "running"), round: "round-2", status: "running" },
  ]);
  assert.equal(retireCurrentRound(runningOnly, NO_RETIRED_ROUNDS), NO_RETIRED_ROUNDS);
});

test("the folded summary names the newest retired round and its count", () => {
  const readingWithRounds = session();
  const once = retireCurrentRound(readingWithRounds, NO_RETIRED_ROUNDS);
  assert.deepEqual(foldedRoundSummary(readingWithRounds, once), {
    round: "round-2",
    count: 1,
  });
  assert.equal(foldedRoundSummary(readingWithRounds, NO_RETIRED_ROUNDS), null);
  // A retired round the reading no longer knows about reports nothing.
  assert.equal(
    foldedRoundSummary(readingWithRounds, new Map([["round-9", ["zz"]]])),
    null,
  );
});

test("a transcript group is folded only when all of its rows were", () => {
  const retired = new Map([["round-2", ["b1"]]]);
  assert.equal(isRoundFolded(["b1"], retired), true);
  assert.equal(isRoundFolded(["b1", "b2"], retired), false);
  assert.equal(isRoundFolded([], retired), false);
  assert.equal(isRoundFolded(["b1"], NO_RETIRED_ROUNDS), false);
});

test("the live view drops folded nodes and keeps the running sibling", () => {
  const full = session();
  const retired = retireCurrentRound(full, NO_RETIRED_ROUNDS);
  const live = liveSessionDelegations(full, retired);
  assert.deepEqual(
    live.items.map((item) => item.message.toolCallId),
    ["c1", "a1", "a2"],
  );
  assert.deepEqual(
    live.nodes.map((node) => node.id),
    ["c1", "a1", "a2"],
  );
  assert.equal(live.summary.total, 3);
  assert.equal(live.summary.running, 1);
  // Nothing retired is the same object back: a session that never folded pays
  // nothing for the feature.
  assert.equal(liveSessionDelegations(full, NO_RETIRED_ROUNDS), full);
});

test("retired delegation ids drive the tab close", () => {
  const full = session();
  const retired = retireCurrentRound(full, NO_RETIRED_ROUNDS);
  assert.deepEqual(retiredDelegationIds(full, retired), ["b1"]);
  assert.deepEqual(retiredDelegationIds(full, NO_RETIRED_ROUNDS), []);
});

test("the folded set survives a versioned snapshot round-trip", () => {
  const retired = retireCurrentRound(session(), NO_RETIRED_ROUNDS);
  const restored = fromRetiredRoundsSnapshot(JSON.parse(JSON.stringify(toRetiredRoundsSnapshot(retired))));
  assert.deepEqual([...restored.entries()], [...retired.entries()]);
  // Anything else is dropped rather than folding the wrong work.
  assert.equal(fromRetiredRoundsSnapshot({ version: 0, rounds: [{ round: "r", nodes: ["a"] }] }).size, 0);
  assert.equal(fromRetiredRoundsSnapshot("nope").size, 0);
  assert.equal(fromRetiredRoundsSnapshot({ version: 1, rounds: [{ round: "", nodes: ["a"] }] }).size, 0);
});

test("closing one settled delegate leaves its running sibling live", () => {
  const full = session();
  const closed = retireDelegation(full, NO_RETIRED_ROUNDS, "b1");
  assert.deepEqual([...closed.entries()], [["round-2", ["b1"]]]);
  // The one node leaves the graph and its tab closes; the sibling that is still
  // working, and every other round, stay exactly where they were.
  const live = liveSessionDelegations(full, closed);
  assert.deepEqual(live.items.map((item) => item.message.toolCallId), ["c1", "a1", "a2"]);
  assert.equal(live.summary.running, 1);
  assert.deepEqual(retiredDelegationIds(full, closed), ["b1"]);
  // A delegate that has not settled is never closable, and neither is a node
  // the reading does not know.
  assert.equal(retireDelegation(full, NO_RETIRED_ROUNDS, "c1"), NO_RETIRED_ROUNDS);
  assert.equal(retireDelegation(full, NO_RETIRED_ROUNDS, "zz"), NO_RETIRED_ROUNDS);
});

test("closing one delegate is idempotent", () => {
  const full = session();
  const once = retireDelegation(full, NO_RETIRED_ROUNDS, "b1");
  const twice = retireDelegation(full, once, "b1");
  assert.equal(twice, once);
  assert.equal(twice.size, 1);
  assert.deepEqual(twice.get("round-2"), ["b1"]);
  assert.equal(retiredDelegationIds(full, twice).length, 1);
  // A node the reading keys to no round would have nothing following it into
  // the folded set, so it is left alone rather than half-retired.
  assert.equal(retireDelegation({ ...full, rounds: new Map() }, once, "a1"), once);
});

test("closing one node then ending the round keeps both ids once", () => {
  const full = session();
  // One delegate of the older round, went away on its own.
  const closed = retireDelegation(full, NO_RETIRED_ROUNDS, "a1");
  const ended = retireCurrentRound(full, closed);
  assert.deepEqual([...ended.keys()].sort(), ["round-1", "round-2"]);
  assert.deepEqual(ended.get("round-1"), ["a1"]);
  assert.deepEqual(ended.get("round-2"), ["b1"]);
  assert.deepEqual(foldedRoundSummary(full, ended), { round: "round-2", count: 1 });
  assert.deepEqual(retiredDelegationIds(full, ended).sort(), ["a1", "b1"]);
  // Ending it again folds nothing new and reports the same set.
  assert.equal(retireCurrentRound(full, ended), ended);
});

test("a partly closed round takes the rest in when it ends, once each", () => {
  const round = reading([
    { item: task("c1", "running"), round: "round-2", status: "running" },
    { item: task("b1", "completed"), round: "round-2", status: "completed" },
    { item: task("b3", "failed"), round: "round-2", status: "failed" },
  ]);
  const closed = retireDelegation(round, NO_RETIRED_ROUNDS, "b1");
  const ended = retireCurrentRound(round, closed);
  assert.deepEqual(ended.get("round-2"), ["b1", "b3"]);
  assert.equal(ended.get("round-2").includes("c1"), false);
  assert.deepEqual(retiredDelegationIds(round, ended), ["b1", "b3"]);
});
