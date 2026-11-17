import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * The runner's own progress reporter (D682).
 *
 * Plugin tools and MCP calls execute in Electron main, and that is where their
 * output has to be coalesced: one frame per interval, bounded in size, and the
 * last frame flushed before the call's result so the tail of a long tool is not
 * lost. Nothing here decides what the model receives.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  TOOL_PROGRESS_MAX_CHUNK_CHARS,
  createToolProgressReporter,
  mcpProgressText,
} = await import("../electron/main/tool-progress.ts");

/** A scheduler the test drives by hand, so nothing waits on a real timer. */
function manualSchedule() {
  const pending = new Map();
  let next = 1;
  return {
    schedule(flush, delayMs) {
      const id = next++;
      pending.set(id, { flush, delayMs });
      return () => pending.delete(id);
    },
    get size() {
      return pending.size;
    },
    fire() {
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) entry.flush();
    },
  };
}

test("reports land as one frame per interval, not one per line", () => {
  const frames = [];
  const scheduler = manualSchedule();
  const reporter = createToolProgressReporter({
    send: (chunk) => frames.push(chunk),
    schedule: scheduler.schedule,
  });
  reporter.push("one\n");
  reporter.push("two\n");
  assert.deepEqual(frames, [], "nothing leaves before the interval elapses");
  assert.equal(scheduler.size, 1, "both lines share one pending frame");
  scheduler.fire();
  assert.deepEqual(frames, ["one\ntwo\n"]);
  assert.equal(scheduler.size, 0);
});

test("the last words flush before the call's result", () => {
  const frames = [];
  const scheduler = manualSchedule();
  const reporter = createToolProgressReporter({
    send: (chunk) => frames.push(chunk),
    schedule: scheduler.schedule,
  });
  reporter.push("still working\n");
  reporter.flush();
  assert.deepEqual(frames, ["still working\n"]);
  // A settle with nothing pending sends nothing at all.
  reporter.flush();
  assert.deepEqual(frames, ["still working\n"]);
});

test("a burst larger than one frame is sent early and stays bounded", () => {
  const frames = [];
  const scheduler = manualSchedule();
  const reporter = createToolProgressReporter({
    send: (chunk) => frames.push(chunk),
    schedule: scheduler.schedule,
  });
  reporter.push("x".repeat(TOOL_PROGRESS_MAX_CHUNK_CHARS));
  assert.equal(frames.length, 1, "an oversized frame is not held back");
  assert.ok(frames[0].length >= TOOL_PROGRESS_MAX_CHUNK_CHARS);

  // A single report cannot leave an unbounded buffer behind either.
  reporter.push("y".repeat(TOOL_PROGRESS_MAX_CHUNK_CHARS * 8));
  scheduler.fire();
  assert.ok(frames.at(-1).length <= TOOL_PROGRESS_MAX_CHUNK_CHARS * 8);
});

test("disposing a call drops its pending preview", () => {
  const frames = [];
  const scheduler = manualSchedule();
  const reporter = createToolProgressReporter({
    send: (chunk) => frames.push(chunk),
    schedule: scheduler.schedule,
  });
  reporter.push("orphan\n");
  reporter.dispose();
  reporter.push("after\n");
  scheduler.fire();
  assert.deepEqual(frames, [], "a disposed call never reports again");
});

test("an MCP progress frame is read as a reader can use it", () => {
  assert.equal(mcpProgressText({ progress: 1, total: 3, message: "step one" }), "step one");
  assert.equal(mcpProgressText({ progress: 2, total: 3 }), "2/3");
  assert.equal(mcpProgressText({ progress: 7 }), "7");
  // Nothing readable: no line of JSON noise in the row.
  assert.equal(mcpProgressText({}), "");
  assert.equal(mcpProgressText("text"), "");
  assert.equal(mcpProgressText(null), "");
});
