import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";

// Transpile the renderer modules; the card derivation may only depend on the
// machine and the round view, so every other import would be a dependency this
// harness must know about.
function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected plan-debate-card dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

const machine = load("../src/features/plan-debate/plan-debate-machine.ts", {});
const view = load("../src/features/plan-debate/plan-debate-view.ts", {
  "./plan-debate-machine": machine,
});
const { planDebateCard, planTitleLine } = load(
  "../src/features/plan-debate/plan-debate-card.ts",
  {
    "./plan-debate-machine": machine,
    "./plan-debate-view": view,
  },
);
const { planDebateView } = view;

const ROLES = [
  { name: "explorer", brief: "map the code that has to change" },
  { name: "reviewer", brief: "find the risks the plan ignores" },
  { name: "architect", brief: "order the migration" },
];

const MERGED_REPORT = [
  "VERDICTS",
  "- adopted | persist the round in SQLite | explorer",
  "PLAN",
  "## Keep the transcript as the only timeline",
  "",
  "1. Derive the rounds from the tool rows.",
].join("\n");

function toolRow(toolName, details, id) {
  return {
    id,
    role: "tool",
    content: "",
    toolName,
    toolResult: { details },
    toolCallId: id,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function proposal(round = 1) {
  return toolRow(
    "PlanDebate",
    {
      planDebate: {
        round,
        requirement: `Requirement ${round}`,
        roles: ROLES,
        phase: "draft",
        delegationIds: [],
      },
    },
    `plan-debate-${round}`,
  );
}

function delegate({
  delegationId,
  round = 1,
  role,
  phase,
  status,
  startedAt = 1000,
  completedAt,
  report,
}) {
  return toolRow(
    "Task",
    {
      delegationId,
      agent: role,
      status,
      startedAt,
      ...(completedAt === undefined ? {} : { completedAt }),
      phase,
      debateRound: round,
      debateRole: role,
      ...(report === undefined ? {} : { debateReport: report }),
    },
    `task-${delegationId}`,
  );
}

/** Two drafts settled, the third still running: the round is in drafting. */
function draftingMessages() {
  return [
    proposal(),
    delegate({
      delegationId: "d1",
      role: "explorer",
      phase: "draft",
      status: "complete",
      completedAt: 2000,
      report: "## Draft one\n\nMove the store first.",
    }),
    delegate({
      delegationId: "d2",
      role: "reviewer",
      phase: "draft",
      status: "complete",
      completedAt: 2500,
      report: "Draft two: keep the machine pure.",
    }),
    delegate({
      delegationId: "d3",
      role: "architect",
      phase: "draft",
      status: "running",
    }),
  ];
}

test("a session with no round has no card", () => {
  assert.equal(planDebateCard(null), null);
  const empty = planDebateView([]);
  assert.equal(empty.latest, null);
  assert.equal(planDebateCard(empty.latest), null);
});

test("a running phase reports its label with the delegates it has settled", () => {
  const round = planDebateView(draftingMessages()).latest;
  assert.notEqual(round, null);
  const card = planDebateCard(round);
  assert.equal(card.round, 1);
  assert.deepEqual(card.phase, { name: "drafting", status: "running" });
  assert.deepEqual(card.progress, { phase: "drafting", done: 2, total: 3 });
  // Drafts are on offer before a merge exists; the card names the first one.
  assert.equal(card.plan.source, "draft");
  assert.equal(card.plan.role, "explorer");
  assert.equal(card.plan.title, "Draft one");
});

test("the chosen plan is what the card reports", () => {
  const messages = [
    ...draftingMessages(),
    delegate({
      delegationId: "d3",
      role: "architect",
      phase: "draft",
      status: "complete",
      completedAt: 3000,
      report: "Draft three.",
    }),
    delegate({
      delegationId: "merge",
      role: "integrator",
      phase: "integrate",
      status: "complete",
      completedAt: 4000,
      report: MERGED_REPORT,
    }),
  ];
  const round = planDebateView(messages).latest;

  // Nothing chosen: the merged plan is the round's answer, and critiquing is
  // still the phase the round has reached — no objection has run yet.
  const unmade = planDebateCard(round, null);
  assert.deepEqual(unmade.phase, { name: "critiquing", status: "pending" });
  assert.equal(unmade.plan.source, "merged");
  assert.equal(unmade.plan.title, "Keep the transcript as the only timeline");
  assert.deepEqual(unmade.progress, { phase: "critiquing", done: 0, total: 3 });

  const merged = planDebateCard(round, { kind: "merged", round: 1 });
  assert.deepEqual(merged.plan, {
    source: "merged",
    role: null,
    title: "Keep the transcript as the only timeline",
  });

  const draft = planDebateCard(round, { kind: "draft", round: 1, role: "architect" });
  assert.deepEqual(draft.plan, {
    source: "draft",
    role: "architect",
    title: "Draft three.",
  });

  // A choice from another round does not leak into this one.
  const stale = planDebateCard(round, { kind: "draft", round: 2, role: "architect" });
  assert.equal(stale.plan.source, "merged");
});

test("a round that has not drafted yet waits for its start", () => {
  const messages = [proposal()];
  const card = planDebateCard(planDebateView(messages).latest);
  // Nothing started yet, so the frontier is still the proposing phase.
  assert.deepEqual(card.phase, { name: "proposing", status: "running" });
  assert.equal(card.progress, null);
  assert.equal(card.plan, null);
});

test("a plan's title is its first readable line without the markdown decoration", () => {
  assert.equal(planTitleLine("## Heading\n\nbody"), "Heading");
  assert.equal(planTitleLine("\n\n- first item\n- second"), "first item");
  assert.equal(planTitleLine("```\ncode"), "code");
  assert.equal(planTitleLine(""), "");
  assert.equal(planTitleLine("###\n\n  \n"), "");
});
