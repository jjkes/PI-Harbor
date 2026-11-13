import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * `COMPOSER_MODE_MENU` is the composer menu's own list. Planning moved to the
 * topbar, so the composer stops offering it — while `Mode`, `MODE_CYCLE` and
 * the chip label keep it, because a session already stored in plan mode must
 * keep running and keep naming itself.
 *
 * The list is a pure value, so it is asserted as one.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { COMPOSER_MODE_MENU, MODE_CYCLE, MODE_LABEL_KEYS } = await import(
  "../src/features/chat/composer/model.ts"
);

test("the composer menu offers agent and goal, never plan", () => {
  assert.deepEqual([...COMPOSER_MODE_MENU], ["agent", "goal"]);
});

test("plan stays a real mode: it still cycles and still has a chip label", () => {
  assert.ok(MODE_CYCLE.includes("plan"));
  assert.ok(MODE_LABEL_KEYS.plan);
});
