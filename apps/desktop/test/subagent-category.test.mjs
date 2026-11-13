import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

/*
 * A subagent definition's coarse category: an optional `category:` frontmatter
 * key the roster groups by. Old documents must keep loading, so an absent key
 * and an unknown value both land on the default with at most a warning.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  DEFAULT_SUBAGENT_CATEGORY,
  SUBAGENT_CATEGORIES,
  isSubagentCategory,
  parseSubagentDefinition,
} = await import("@pi-harbor/shared");

function document(frontmatter) {
  return `---
name: reviewer
description: Review a diff for defects.
tools: [Read, Grep]
${frontmatter}
---
Report the defects you can prove.
`;
}

function parse(raw) {
  const result = parseSubagentDefinition(raw, { source: "user", fallbackName: "reviewer" });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

test("the category vocabulary is the four coarse roles with build as default", () => {
  assert.deepEqual([...SUBAGENT_CATEGORIES], ["plan", "debate", "build", "explore"]);
  assert.equal(DEFAULT_SUBAGENT_CATEGORY, "build");
  assert.equal(isSubagentCategory("debate"), true);
  assert.equal(isSubagentCategory("review"), false);
  assert.equal(isSubagentCategory(undefined), false);
});

test("a declared category is parsed", () => {
  for (const category of SUBAGENT_CATEGORIES) {
    const result = parse(document(`category: ${category}`));
    assert.equal(result.definition.category, category);
    assert.deepEqual(result.warnings, []);
  }
});

test("the key is matched loosely, like every other frontmatter key", () => {
  const result = parse(document("Category: explore"));
  assert.equal(result.definition.category, "explore");
});

test("a document without a category keeps loading as the default", () => {
  const result = parse(document(""));
  assert.equal(result.definition.category, DEFAULT_SUBAGENT_CATEGORY);
  assert.deepEqual(result.warnings, []);
});

test("an unknown category warns and falls back instead of failing", () => {
  const result = parse(document("category: orchestrate"));
  assert.equal(result.definition.category, DEFAULT_SUBAGENT_CATEGORY);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /unknown category "orchestrate"/);
});

test("a document round-trip keeps the category", () => {
  // Parse, write the same fields back as a document, parse again: the field a
  // person wrote survives every hop the roster takes.
  for (const category of ["plan", "explore"]) {
    const first = parse(document(`category: ${category}`)).definition;
    const written = `---
name: ${first.name}
description: ${first.description}
tools: [${first.tools.join(", ")}]
category: ${first.category}
---
${first.prompt}
`;
    const second = parse(written).definition;
    assert.equal(second.category, category);
    assert.equal(second.name, first.name);
  }
});

test("the editor draft and the save payload carry the category", async () => {
  // The editor is a .tsx module, so this stays a source contract: the draft
  // reads the value from the document and the payload sends it back.
  const sheet = await readFile(
    new URL("../src/components/settings/SubagentEditorSheet.tsx", import.meta.url),
    "utf8",
  );
  assert.match(sheet, /category: SubagentCategory;/);
  assert.match(sheet, /category: DEFAULT_SUBAGENT_CATEGORY,/);
  assert.match(sheet, /category: record\.category \?\? DEFAULT_SUBAGENT_CATEGORY,/);
  assert.match(sheet, /category: definition\.category \?\? DEFAULT_SUBAGENT_CATEGORY,/);
  const page = await readFile(
    new URL("../src/components/settings/AgentSubagentsPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /category: draft\.category,/);
});
