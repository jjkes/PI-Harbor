/**
 * The debate surface is a view preference, and the chip's fourth choice is the
 * only thing that turns it on. These tests pin the read: an absent or unknown
 * value is off, planning never lights the debate, and choosing the debate puts
 * the session back on the Agent contract a round runs under.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { debateSurfaceOn, isDebateMode, releasedDebateSettings, sessionModeForChoice } =
  await import("../src/features/plan-debate/debate-mode.ts");

test("an absent, unknown or malformed debate mode reads as off", () => {
  assert.equal(isDebateMode(undefined), false);
  assert.equal(isDebateMode(null), false);
  assert.equal(isDebateMode({}), false);
  assert.equal(isDebateMode({ debateMode: "debates" }), false);
  assert.equal(isDebateMode({ debateMode: "" }), false);
  assert.equal(isDebateMode({ debateMode: undefined }), false);
  assert.equal(isDebateMode({ debateMode: "debate" }), true);
});

test("the debate surface needs the Agent contract, never planning or a goal", () => {
  assert.equal(debateSurfaceOn({ debateMode: "debate" }, "agent"), true);
  assert.equal(debateSurfaceOn({ debateMode: "debate" }, "plan"), false);
  assert.equal(debateSurfaceOn({ debateMode: "debate" }, "goal"), false);
  assert.equal(debateSurfaceOn({ debateMode: "agent" }, "agent"), false);
  assert.equal(debateSurfaceOn(undefined, "agent"), false);
});

test("choosing the debate configures Agent; the three modes stay themselves", () => {
  assert.equal(sessionModeForChoice("debate"), "agent");
  assert.equal(sessionModeForChoice("agent"), "agent");
  assert.equal(sessionModeForChoice("plan"), "plan");
  assert.equal(sessionModeForChoice("goal"), "goal");
});

test("approval releases the debate surface once, and only when it is on", () => {
  // The host writes session.mode = 'agent' on approve; the surface switch must
  // follow, so the chip cannot keep naming a debate the session has left.
  const on = releasedDebateSettings({ debateMode: "debate", defaultMode: "plan" });
  assert.equal(on?.debateMode, "agent");
  // Everything else in the settings row survives the release.
  assert.equal(on?.defaultMode, "plan");
  // Already off is a no-op, so a second approval writes nothing.
  assert.equal(releasedDebateSettings({ debateMode: "agent" }), null);
  assert.equal(releasedDebateSettings({}), null);
});
