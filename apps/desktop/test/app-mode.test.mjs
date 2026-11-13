/**
 * The app-surface switch is a view preference. These tests pin the read: only
 * the value this build ships can turn the image workbench on, so a settings row
 * written by a newer or older client can never leave the window in a surface it
 * cannot draw.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { APP_MODES, appModeOf, isImagesMode, isPlanMode } = await import("../src/lib/app-mode.ts");

test("an absent, unknown or malformed app mode reads as agent development", () => {
  assert.equal(appModeOf(undefined), "agent");
  assert.equal(appModeOf(null), "agent");
  assert.equal(appModeOf({}), "agent");
  assert.equal(appModeOf({ appMode: "chat" }), "agent");
  assert.equal(appModeOf({ appMode: "" }), "agent");
  assert.equal(appModeOf({ appMode: null }), "agent");
});

test("the shipped image mode is the only value that turns the workbench on", () => {
  assert.equal(appModeOf({ appMode: "agent" }), "agent");
  assert.equal(appModeOf({ appMode: "images" }), "images");
  assert.equal(isImagesMode({ appMode: "images" }), true);
  assert.equal(isImagesMode({ appMode: "agent" }), false);
  assert.equal(isImagesMode(undefined), false);
  assert.deepEqual([...APP_MODES], ["agent", "images", "plan"]);
});

test("planning is its own surface and never reads as the other two", () => {
  assert.equal(appModeOf({ appMode: "plan" }), "plan");
  assert.equal(isPlanMode({ appMode: "plan" }), true);
  assert.equal(isPlanMode({ appMode: "images" }), false);
  assert.equal(isPlanMode(undefined), false);
  // Planning must not light up the image workbench's behaviour by accident.
  assert.equal(isImagesMode({ appMode: "plan" }), false);
  assert.equal(isPlanMode({ appMode: "gallery" }), false);
});
