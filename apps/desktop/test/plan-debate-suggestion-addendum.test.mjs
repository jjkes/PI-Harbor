import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";

/*
 * The addition box never replaces the plan. Whatever the user types there is
 * submitted together with the drafted or merged plan they already chose, so the
 * request must carry both — and must not repeat the text when the addition *is*
 * the plan (a round with nothing else to choose).
 */

function load(relative, imports = {}) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    if (Object.hasOwn(imports, id)) return imports[id];
    throw new Error(`unexpected dependency: ${id} (from ${relative})`);
  }, module.exports, module);
  return module.exports;
}

const machine = load("../src/features/plan-debate/plan-debate-machine.ts", {});
const view = load("../src/features/plan-debate/plan-debate-view.ts", {
  "./plan-debate-machine": machine,
});
const handoffMod = load("../src/features/plan-debate/plan-debate-handoff.ts", {
  "./plan-debate-machine": machine,
  "./plan-debate-view": view,
  "../../lib/api.js": { api: {} },
});

const { buildPlanDebateHandoffRequest } = handoffMod;

test("the handoff carries the chosen conclusion and the typed addition together", () => {
  const request = buildPlanDebateHandoffRequest(
    "session-a",
    "team",
    { round: 1, selection: { kind: "draft", round: 1, role: "explorer" }, text: "draft body" },
    "  add the migration order  ",
    "trace-1",
  );
  assert.deepEqual(request.selection, {
    kind: "draft",
    round: 1,
    role: "explorer",
    text: "draft body",
  });
  assert.equal(request.userAddendum, "add the migration order");
});

test("the merged plan keeps its own text and takes the addition alongside", () => {
  const request = buildPlanDebateHandoffRequest(
    "session-a",
    "single-agent",
    { round: 2, selection: { kind: "merged", round: 2 }, text: "merged body" },
    "ship it behind a flag",
    "trace-2",
  );
  assert.deepEqual(request.selection, { kind: "merged", round: 2, text: "merged body" });
  assert.equal(request.userAddendum, "ship it behind a flag");
});

test("a round whose only plan is the addition does not repeat it as an addendum", () => {
  const request = buildPlanDebateHandoffRequest(
    "session-a",
    "team",
    { round: 1, selection: { kind: "suggestion", round: 1, text: "mine" }, text: "mine" },
    "",
    "trace-3",
  );
  assert.equal(request.selection.kind, "suggestion");
  assert.equal("userAddendum" in request, false);
});
