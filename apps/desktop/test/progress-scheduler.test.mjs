import assert from "node:assert/strict";
import test from "node:test";

const { decideProgressTick } = await import(
  "../src/features/chat/progress/progress-scheduler.ts"
);

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function settings(overrides = {}) {
  return {
    sessionId: "s1",
    model: { followSession: true },
    autoEnabled: true,
    intervalMinutes: 5,
    lastCollectedAt: NOW - 6 * MINUTE,
    consecutiveFailures: 0,
    updatedAt: NOW,
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    sessionId: "s1",
    settings: settings(),
    latest: { id: "r1", lastMessageId: "m1", fingerprint: "abc" },
    running: false,
    ...overrides,
  };
}

function decide(overrides = {}) {
  return decideProgressTick({
    now: NOW,
    sessions: [session()],
    newestMessageIds: { s1: "m2" },
    autoRunsInFlight: 0,
    windowHidden: false,
    ...overrides,
  });
}

test("collects when auto is on, the interval expired, and the session moved on", () => {
  assert.deepEqual(decide(), [{ kind: "collect", sessionId: "s1" }]);
});

test("ignores a session whose auto-collect is off", () => {
  assert.deepEqual(decide({ sessions: [session({ settings: settings({ autoEnabled: false }) })] }), []);
});

test("waits while another collection for the session is running", () => {
  assert.deepEqual(decide({ sessions: [session({ running: true })] }), [
    { kind: "skip", sessionId: "s1", reason: "running" },
  ]);
});

test("respects the automatic-run cap", () => {
  assert.deepEqual(decide({ autoRunsInFlight: 2 }), [
    { kind: "skip", sessionId: "s1", reason: "cap" },
  ]);
});

test("waits until the interval has expired", () => {
  assert.deepEqual(
    decide({ sessions: [session({ settings: settings({ lastCollectedAt: NOW - MINUTE }) })] }),
    [{ kind: "skip", sessionId: "s1", reason: "not-due" }],
  );
});

test("skips a tick when the session produced nothing new", () => {
  assert.deepEqual(decide({ newestMessageIds: { s1: "m1" } }), [
    { kind: "skip", sessionId: "s1", reason: "unchanged" },
  ]);
});

test("never starts while the window is hidden", () => {
  assert.deepEqual(decide({ windowHidden: true }), [
    { kind: "skip", sessionId: "s1", reason: "hidden" },
  ]);
});

test("stays paused after repeated failures", () => {
  assert.deepEqual(
    decide({ sessions: [session({ settings: settings({ consecutiveFailures: 3 }) })] }),
    [{ kind: "skip", sessionId: "s1", reason: "paused" }],
  );
});

test("waits for a first collection before scheduling an automatic one", () => {
  assert.deepEqual(
    decide({ sessions: [session({ settings: settings({ lastCollectedAt: null }) })], latest: null }),
    [{ kind: "skip", sessionId: "s1", reason: "no-baseline" }],
  );
});

test("walks several sessions and raises the in-flight count as it goes", () => {
  const decisions = decideProgressTick({
    now: NOW,
    sessions: [
      session({ sessionId: "a" }),
      session({ sessionId: "b" }),
      session({ sessionId: "c" }),
    ],
    newestMessageIds: { a: "m2", b: "m2", c: "m2" },
    autoRunsInFlight: 0,
    windowHidden: false,
  });
  assert.deepEqual(decisions, [
    { kind: "collect", sessionId: "a" },
    { kind: "collect", sessionId: "b" },
    { kind: "skip", sessionId: "c", reason: "cap" },
  ]);
});

const { isProgressStale, progressTriggerVisual, emptyProgressSession, progressSessionOf } = await import(
  "../src/features/chat/progress/progress-types.ts"
);

test("staleness compares the report's message with the session's newest", () => {
  const report = { lastMessageId: "m1" };
  assert.equal(isProgressStale(null, "m9"), false);
  assert.equal(isProgressStale(report, "m1"), false);
  assert.equal(isProgressStale(report, "m2"), true);
  assert.equal(isProgressStale({ lastMessageId: null }, "m2"), true);
  assert.equal(isProgressStale({ lastMessageId: null }, null), false);
});

test("the unseen dot wins over the auto dot, and a run wins over both", () => {
  const base = emptyProgressSession("s1");
  assert.equal(progressTriggerVisual(base), "idle");
  assert.equal(
    progressTriggerVisual({ ...base, settings: { ...base.settings, autoEnabled: true } }),
    "auto",
  );
  assert.equal(
    progressTriggerVisual({
      ...base,
      unseen: true,
      settings: { ...base.settings, autoEnabled: true },
    }),
    "unseen",
  );
  assert.equal(
    progressTriggerVisual({
      ...base,
      unseen: true,
      run: { runId: "run_1", trigger: "manual", startedAt: 0 },
    }),
    "collecting",
  );
});

test("a session selector keeps a stable identity before and after it loads", () => {
  // A zustand selector must return the same reference for the same state, or
  // React re-renders forever ("Maximum update depth exceeded", seen live once).
  const empty = { sessions: {} };
  const first = progressSessionOf(empty, "s1");
  assert.equal(first, progressSessionOf(empty, "s1"));

  const loaded = { ...emptyProgressSession("s1"), loaded: true };
  const state = { sessions: { s1: loaded } };
  assert.equal(progressSessionOf(state, "s1"), loaded);
  // Distinct sessions never share one empty object.
  assert.notEqual(progressSessionOf(empty, "s2"), first);
});
