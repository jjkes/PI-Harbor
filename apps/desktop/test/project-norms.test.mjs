/**
 * Project norms are project-scoped by construction: only the entry stored under
 * the session's own project path is read, and it is appended to the chain the
 * runtime already renders for the main agent and every subagent.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { projectNormContent, withProjectNorms } = await import(
  "../electron/main/runtime/project-norms.ts"
);

const norms = {
  "/work/a": "  Always answer in Chinese.  ",
  "/work/b": "Use tabs.",
};

test("only the session's own project entry is read, trimmed", () => {
  assert.equal(projectNormContent(norms, "/work/a"), "Always answer in Chinese.");
  assert.equal(projectNormContent(norms, "/work/b"), "Use tabs.");
  // Another project, a missing key, no project, and no settings all read as none.
  assert.equal(projectNormContent(norms, "/work/c"), "");
  assert.equal(projectNormContent(norms, undefined), "");
  assert.equal(projectNormContent(undefined, "/work/a"), "");
  assert.equal(projectNormContent({ "/work/a": "   " }, "/work/a"), "");
});

test("norms append to the existing chain and never replace it", () => {
  const chain = { entries: [{ source: "AGENTS.md", content: "repo rules" }] };
  assert.deepEqual(withProjectNorms(chain, " project rules "), {
    entries: [
      { source: "AGENTS.md", content: "repo rules" },
      { source: "Project norms", content: "project rules" },
    ],
  });
  // A project that has no norms leaves the chain exactly as it was.
  assert.equal(withProjectNorms(chain, "  "), chain);
  assert.equal(withProjectNorms(undefined, ""), undefined);
  // With no chain at all, the norms become the one entry.
  assert.deepEqual(withProjectNorms(undefined, "only norms"), {
    entries: [{ source: "Project norms", content: "only norms" }],
  });
  // The caller's chain is not mutated.
  assert.equal(chain.entries.length, 1);
});
