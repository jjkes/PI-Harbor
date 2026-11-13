import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * The Team roster is grouped by the definition's coarse category. Grouping is
 * presentation only and runs after the search filter, so the section counts
 * describe what is on screen and no card can be toggled by a half-typed query.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { filterTeamRosterCards, groupByCategory, teamCardCategory } = await import(
  "../src/features/team/team-roster-model.ts"
);

function card(handle, category) {
  const definition = {
    name: handle,
    description: `${handle} role`,
    tools: ["Read"],
    prompt: "",
    source: "user",
    ...(category ? { category } : {}),
  };
  return {
    handle,
    entry: { handle, definition, enabled: true },
    on: true,
    settingsEnabled: true,
    hasSettings: false,
    effective: definition,
    canMutate: false,
    roleCanMutate: false,
    running: 0,
  };
}

test("sections come out in the fixed plan, debate, build, explore order", () => {
  const groups = groupByCategory([
    card("explore-role", "explore"),
    card("build-role", "build"),
    card("plan-role", "plan"),
    card("debate-role", "debate"),
  ]);
  assert.deepEqual(
    groups.map((group) => group.category),
    ["plan", "debate", "build", "explore"],
  );
  assert.deepEqual(
    groups.map((group) => group.cards.map((entry) => entry.handle)),
    [["plan-role"], ["debate-role"], ["build-role"], ["explore-role"]],
  );
});

test("a role with no category is filed under build", () => {
  const legacy = card("legacy-role");
  assert.equal(teamCardCategory(legacy), "build");
  const groups = groupByCategory([legacy, card("plan-role", "plan")]);
  assert.deepEqual(
    groups.map((group) => group.category),
    ["plan", "build"],
  );
  assert.deepEqual(groups[1].cards.map((entry) => entry.handle), ["legacy-role"]);
});

test("an empty category draws no section", () => {
  const groups = groupByCategory([card("build-role", "build")]);
  assert.deepEqual(groups.map((group) => group.category), ["build"]);
  assert.deepEqual(groupByCategory([]), []);
});

test("searching filters first, then groups", () => {
  const cards = [
    card("plan-writer", "plan"),
    card("plan-critic", "debate"),
    card("fixer", "build"),
  ];
  const visible = filterTeamRosterCards(cards, "plan");
  assert.deepEqual(visible.map((entry) => entry.handle), ["plan-writer", "plan-critic"]);
  const groups = groupByCategory(visible);
  // The counts describe the search, not the whole roster.
  assert.deepEqual(
    groups.map((group) => [group.category, group.cards.length]),
    [
      ["plan", 1],
      ["debate", 1],
    ],
  );
  // A blank query groups everything again.
  assert.equal(groupByCategory(filterTeamRosterCards(cards, "  ")).length, 3);
});
