import assert from "node:assert/strict";
import test from "node:test";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/**
 * A tooling or test harness can publish a `window` stub that carries only the
 * bridge the renderer code reads. The pagehide teardown is a capability of a
 * real window, not a load-time requirement: importing the controller against a
 * stub without the event-target API must not throw. It used to fail with
 * `window.addEventListener is not a function` and took every importer of the
 * chat surface down with it.
 */
test("the progress controller imports against a window stub without addEventListener", async (t) => {
  const ssr = await slotSsr(t);
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  t.after(() => {
    delete globalThis.window;
  });

  const controller = await ssr.load("/src/features/chat/progress/progress-controller.ts");

  assert.equal(typeof controller.ensureProgressScheduler, "function");
  assert.equal(controller.progressScheduler.running(), false);
});
