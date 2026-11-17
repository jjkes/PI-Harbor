/**
 * Instantaneous generation speed. A provider reports usage only when a response
 * settles, so a live figure has to come from the stream itself: the window's own
 * growth, never an average carried across a stall or across replies.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTANT_RATE_MIN_SPAN_MS,
  appendTokenSample,
  estimateTextTokens,
  instantTokenRate,
  resolveSpeedReading,
} from "../src/lib/instant-token-rate.ts";

const series = (points) =>
  points.reduce(
    (samples, [at, tokens]) => appendTokenSample(samples, { at, tokens }),
    [],
  );

test("visible text is priced at the runtime's four characters per token", () => {
  assert.equal(estimateTextTokens(undefined), 0);
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens("abcde"), 2);
  // Code points, not UTF-16 units: CJK output is not charged twice.
  assert.equal(estimateTextTokens("你好世"), 1);
});

test("a growing stream reports the window's own rate", () => {
  const samples = series([
    [0, 0],
    [1_000, 40],
    [2_000, 80],
  ]);
  assert.equal(instantTokenRate(samples), 40);
});

test("a stalled stream has no rate instead of a shrinking average", () => {
  const samples = series([
    [0, 100],
    [1_000, 100],
    [2_000, 100],
  ]);
  assert.equal(instantTokenRate(samples), undefined);
});

test("a span shorter than one second is never divided", () => {
  const samples = series([
    [0, 0],
    [INSTANT_RATE_MIN_SPAN_MS - 1, 10],
  ]);
  assert.equal(instantTokenRate(samples), undefined);
  assert.equal(instantTokenRate([]), undefined);
  assert.equal(instantTokenRate([{ at: 0, tokens: 10 }]), undefined);
});

test("the window slides and keeps only the baseline a reading needs", () => {
  const samples = series([
    [0, 0],
    [1_000, 10],
    [2_000, 20],
    [3_000, 30],
    [4_000, 40],
  ]);
  assert.deepEqual(
    samples.map((sample) => sample.at),
    [1_000, 2_000, 3_000, 4_000],
  );
  // Newest minus the sample just before the three-second window: 30 tokens over
  // three seconds, not the 40 the whole reply produced.
  assert.equal(instantTokenRate(samples), 10);
});

test("a new reply resets the series instead of averaging across replies", () => {
  const grown = series([
    [1_000, 0],
    [2_000, 40],
  ]);
  const restarted = appendTokenSample(grown, { at: 2_500, tokens: 3 });
  assert.deepEqual(restarted, [{ at: 2_500, tokens: 3 }]);
  assert.equal(instantTokenRate(restarted), undefined);
});

test("a backwards clock starts a fresh series", () => {
  const grown = series([
    [2_000, 40],
    [1_800, 10],
  ]);
  assert.deepEqual(grown, [{ at: 1_800, tokens: 10 }]);
});

test("an observation at the same instant replaces the previous one", () => {
  const samples = series([
    [1_000, 10],
    [1_000, 18],
  ]);
  assert.deepEqual(samples, [{ at: 1_000, tokens: 18 }]);
});

test("a settled reply prints the provider's average, an unsettled one does not", () => {
  assert.deepEqual(resolveSpeedReading(false, 42, 120), {
    tokensPerSecond: 120,
    estimated: false,
  });
  // A settled reply with no measurable span stays unmeasured: it must not borrow
  // the stream estimate it no longer has.
  assert.deepEqual(resolveSpeedReading(false, 42, undefined), { estimated: false });
});

test("a streaming reply prints the estimate and marks it estimated", () => {
  assert.deepEqual(resolveSpeedReading(true, 88, 120), {
    tokensPerSecond: 88,
    estimated: true,
  });
  // Too early to measure: still an estimate, with no figure to print.
  assert.deepEqual(resolveSpeedReading(true, undefined, 120), { estimated: true });
});
