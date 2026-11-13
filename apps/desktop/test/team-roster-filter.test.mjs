import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * The Team roster carries two presentation-only filters: the free-text search
 * and the coarse category chip. They narrow together (both run, neither resets
 * the other) and neither touches the roster, so a half-typed query or a chip
 * press can never toggle, enable or forget a member.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  filterTeamRosterCards,
  filterTeamRosterCardsByCategory,
  groupByCategory,
  teamRosterCategoryChips,
} = await import("../src/features/team/team-roster-model.ts");

function card(handle, category, description = `${handle} role`) {
  const definition = {
    name: handle,
    description,
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

/* "plan" is the shared search token the composing tests narrow on: it reaches
   one card in three different categories, and neither of the last two. */
const roster = () => [
  card("planner", "plan", "plan the work"),
  card("critic", "debate", "critique the plan"),
  card("fixer", "build", "fix what the plan broke"),
  card("scout", "explore", "survey the repo"),
  card("legacy", undefined, "legacy helper"), // no category: filed under build
];

const handles = (cards) => cards.map((entry) => entry.handle);
const counts = (chips) => chips.map((chip) => [chip.category, chip.count]);

test("a category chip keeps only that category", () => {
  const cards = roster();
  assert.deepEqual(handles(filterTeamRosterCardsByCategory(cards, "plan")), ["planner"]);
  assert.deepEqual(handles(filterTeamRosterCardsByCategory(cards, "explore")), ["scout"]);
  // A role that never declared a category is filed under build, like the section.
  assert.deepEqual(handles(filterTeamRosterCardsByCategory(cards, "build")), ["fixer", "legacy"]);
});

test("the all chip clears the category filter", () => {
  const cards = roster();
  assert.deepEqual(handles(filterTeamRosterCardsByCategory(cards, null)), handles(cards));
  assert.deepEqual(
    handles(filterTeamRosterCardsByCategory(cards, null)),
    handles(filterTeamRosterCards(cards, "")),
  );
  // The roster itself is never mutated by either filter.
  assert.equal(cards.length, 5);
});

test("category and search compose without resetting each other", () => {
  const cards = roster();
  const searched = filterTeamRosterCards(cards, "plan");
  assert.deepEqual(handles(searched), ["planner", "critic", "fixer"]);
  // The search stays in effect while a chip is chosen.
  assert.deepEqual(handles(filterTeamRosterCardsByCategory(searched, "debate")), ["critic"]);
  assert.deepEqual(handles(filterTeamRosterCardsByCategory(searched, "build")), ["fixer"]);
  // A chip that no searched card reaches draws nothing, and nothing throws.
  assert.deepEqual(filterTeamRosterCardsByCategory(searched, "explore"), []);
  // The narrower list still groups into the sections the picker draws.
  assert.deepEqual(
    groupByCategory(filterTeamRosterCardsByCategory(searched, "debate")).map((group) => [
      group.category,
      handles(group.cards),
    ]),
    [["debate", ["critic"]]],
  );
});

test("chips come out all first, then the fixed category order", () => {
  const chips = teamRosterCategoryChips(roster(), null);
  assert.deepEqual(
    chips.map((chip) => chip.category),
    [null, "plan", "debate", "build", "explore"],
  );
  assert.deepEqual(counts(chips), [
    [null, 5],
    ["plan", 1],
    ["debate", 1],
    ["build", 2],
    ["explore", 1],
  ]);
  // All five chips are always drawn, so a category never vanishes under the pointer.
  assert.deepEqual(teamRosterCategoryChips([], null).map((chip) => chip.count), [0, 0, 0, 0, 0]);
});

test("chip counts describe the search, not the category filter", () => {
  const cards = roster();
  const searched = filterTeamRosterCards(cards, "plan");
  assert.deepEqual(handles(searched), ["planner", "critic", "fixer"]);
  // Counted before the category filter: choosing "plan" must not zero the others.
  const chips = teamRosterCategoryChips(searched, "plan");
  assert.deepEqual(counts(chips), [
    [null, 3],
    ["plan", 1],
    ["debate", 1],
    ["build", 1],
    ["explore", 0],
  ]);
  // The chip counts agree with what a press of that chip actually shows.
  for (const chip of chips) {
    assert.equal(
      filterTeamRosterCardsByCategory(searched, chip.category).length,
      chip.count,
    );
  }
});

test("exactly the chosen chip is active", () => {
  const cards = roster();
  const activeOf = (chips) => chips.filter((chip) => chip.active).map((chip) => chip.category);
  assert.deepEqual(activeOf(teamRosterCategoryChips(cards, null)), [null]);
  assert.deepEqual(activeOf(teamRosterCategoryChips(cards, "build")), ["build"]);
  // Selection is independent of the counts it is drawn with.
  assert.deepEqual(activeOf(teamRosterCategoryChips([], "explore")), ["explore"]);
});

test("an empty roster filters and counts without throwing", () => {
  assert.deepEqual(filterTeamRosterCardsByCategory([], "plan"), []);
  assert.deepEqual(filterTeamRosterCardsByCategory([], null), []);
  assert.deepEqual(
    teamRosterCategoryChips([], "plan").map((chip) => chip.category),
    [null, "plan", "debate", "build", "explore"],
  );
});
