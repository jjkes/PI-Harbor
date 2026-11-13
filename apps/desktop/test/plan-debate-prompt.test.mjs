/**
 * The debate button sends the user's own words first, with the instruction in a
 * collapsible block; never the instruction in the user's mouth and never a
 * trailing fragment that trims the requirement away.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { planDebateRequest } = await import(
  "../src/features/plan-debate/plan-debate-prompt.ts"
);

test("the requirement leads and the instruction stays out of its way", () => {
  const prompt = planDebateRequest("  为单体应用设计缓存选型  ");
  // The user's words are the first thing read, verbatim, trimmed.
  assert.match(prompt, /^为单体应用设计缓存选型/);
  // The instruction still names the tool so the round starts.
  assert.match(prompt, /Call the PlanDebate tool now/);
  // ...and it is folded away, not in the user's mouth.
  assert.match(prompt, /<details>[\s\S]*Call the PlanDebate tool now[\s\S]*<\/details>/);
  assert.doesNotMatch(prompt, /^Run a plan debate/);
});

test("a blank requirement still carries the instruction (the button, not the prompt, gates it)", () => {
  const prompt = planDebateRequest("   ");
  assert.equal(prompt.includes("debate"), true);
  assert.equal(prompt.trim().startsWith("为单体应用设计缓存选型"), false);
  // ...and the framing is present so a stray empty send still says what it was for.
  assert.match(prompt, /Call the PlanDebate tool now/);
});
