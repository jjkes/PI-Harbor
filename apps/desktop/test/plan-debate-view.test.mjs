import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { catalogs, flattenCatalog } from "@pi-harbor/i18n";

// Transpile the renderer modules; the view may only depend on the machine, so
// every other import would be a real dependency this harness must know about.
function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected plan-debate dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

const machine = load("../src/features/plan-debate/plan-debate-machine.ts", {});
const view = load("../src/features/plan-debate/plan-debate-view.ts", {
  "./plan-debate-machine": machine,
});
const artifactCache = load("../src/features/plan-debate/plan-debate-artifact-cache.ts", {});
const deletion = load("../src/features/plan-debate/plan-debate-delete.ts", {});
const {
  planDebateAwaitingStart,
  planDebatePanelRound,
  planDebatePendingRounds,
  planDebateView,
  planDebateViewWithArtifacts,
  planDebatePhaseStatuses,
  planDebateRoundUnfinished,
  planDebateRunning,
  planDebateRoundRunning,
  planDebateState,
  planDebateUnfinishedRound,
  parseMergedPlan,
} = view;

const ROLES = [
  { name: "explorer", brief: "map the code that has to change" },
  { name: "reviewer", brief: "find the risks the plan ignores" },
];

const TEST_SESSION = "test-session";

const VERDICTS_REPORT = [
  "VERDICTS",
  "- adopted | store the plan in SQLite | explorer",
  "- rejected | a second timeline in renderer state | reviewer",
  "PLAN",
  "## Plan",
  "",
  "1. Persist the round.",
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

function proposal(round, overrides = {}) {
  return toolRow(
    "PlanDebate",
    {
      planDebate: {
        round,
        requirement: `Requirement ${round}`,
        roles: ROLES,
        phase: "proposing",
        ...overrides,
      },
    },
    `plan-debate-${round}`,
  );
}

function delegate({
  delegationId,
  round,
  role,
  phase,
  status,
  startedAt = 1000,
  completedAt,
  report,
  error,
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
      ...(error === undefined ? {} : { error }),
    },
    `task-${delegationId}`,
  );
}

function statusOf(round, name) {
  const phase = planDebatePhaseStatuses(round).find((candidate) => candidate.name === name);
  assert.ok(phase, `phase ${name} is missing`);
  return phase;
}

function names(list) {
  return list.map((item) => item.role);
}

test("rows group by round and by phase, with rounds ascending and nodes in transcript order", () => {
  const messages = [
    // A later round publishes first: the view still sorts the rounds.
    proposal(2, { requirement: "Second requirement" }),
    delegate({
      delegationId: "r2-critic",
      round: 2,
      role: "explorer",
      phase: "critique",
      status: "complete",
      completedAt: 9000,
      report: "round two objection",
    }),
    proposal(1, { requirement: "First requirement" }),
    delegate({
      delegationId: "r1-draft-reviewer",
      round: 1,
      role: "reviewer",
      phase: "draft",
      status: "complete",
      completedAt: 4000,
      report: "reviewer draft",
    }),
    delegate({
      delegationId: "r1-draft-explorer",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "complete",
      completedAt: 3500,
      report: "explorer draft",
    }),
    delegate({
      delegationId: "r1-critic",
      round: 1,
      role: "reviewer",
      phase: "critique",
      status: "running",
      startedAt: 5000,
    }),
    delegate({
      delegationId: "r1-integrator",
      round: 1,
      role: "explorer",
      phase: "integrate",
      status: "running",
      startedAt: 6000,
    }),
    // Rows the panel must not draw: an unknown status and an unknown phase.
    delegate({
      delegationId: "r1-bad-status",
      round: 1,
      role: "ghost",
      phase: "draft",
      status: "pending",
    }),
    delegate({
      delegationId: "r1-bad-phase",
      round: 1,
      role: "ghost",
      phase: "review",
      status: "complete",
    }),
  ];

  const result = planDebateView(messages);
  assert.deepEqual(
    result.rounds.map((round) => round.round),
    [1, 2],
  );
  assert.equal(result.latest.round, 2);

  const first = result.rounds[0];
  assert.equal(first.requirement, "First requirement");
  assert.deepEqual(
    first.roles.map((role) => role.name),
    ["explorer", "reviewer"],
  );
  assert.deepEqual(names(first.drafts), ["reviewer", "explorer"]);
  assert.deepEqual(names(first.critiques), ["reviewer"]);
  assert.equal(first.integrator.delegationId, "r1-integrator");
  // The two invalid rows contributed nothing.
  assert.equal(first.drafts.length + first.critiques.length, 3);

  const second = result.rounds[1];
  assert.equal(second.requirement, "Second requirement");
  assert.deepEqual(second.drafts, []);
  assert.equal(second.integrator, null);
  assert.deepEqual(names(second.critiques), ["explorer"]);
});

test("phase statuses are derived from the rows: pending, running, complete, and failed", () => {
  // A round the model only proposed waits for the user's start: proposing is
  // running, every delegate phase has no artifact, and no draft exists.
  const pending = planDebateView([proposal(1)]).latest;
  assert.equal(statusOf(pending, "proposing").status, "running");
  assert.equal(statusOf(pending, "drafting").status, "pending");
  assert.equal(statusOf(pending, "critiquing").status, "pending");
  assert.equal(statusOf(pending, "integrating").status, "pending");
  assert.equal(statusOf(pending, "reviewing").status, "pending");
  assert.equal(statusOf(pending, "handingoff").status, "pending");
  assert.equal(planDebateAwaitingStart(pending), true);
  assert.equal(pending.drafts.length, 0);
  assert.equal(pending.merged, null);

  // No round at all: nothing started, so the proposal phase is pending too.
  assert.equal(planDebateView([]).latest, null);

  const running = planDebateView([
    proposal(1),
    delegate({
      delegationId: "d1",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "running",
      startedAt: 2000,
    }),
  ]).latest;
  assert.equal(statusOf(running, "drafting").status, "running");
  assert.equal(statusOf(running, "reviewing").status, "pending");
  // Started: proposing is complete and the start control is gone.
  assert.equal(statusOf(running, "proposing").status, "complete");
  assert.equal(planDebateAwaitingStart(running), false);
  assert.equal(planDebateAwaitingStart(null), false);

  const failedDrafts = planDebateView([
    proposal(1),
    delegate({
      delegationId: "d1",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "failed",
      startedAt: 2000,
      completedAt: 3000,
      error: "model unavailable",
    }),
    delegate({
      delegationId: "d2",
      round: 1,
      role: "reviewer",
      phase: "draft",
      status: "stopped",
      startedAt: 2200,
      completedAt: 3200,
    }),
  ]).latest;
  assert.equal(statusOf(failedDrafts, "drafting").status, "failed");
  assert.equal(statusOf(failedDrafts, "reviewing").status, "pending");
  assert.equal(failedDrafts.merged, null);
  assert.equal(failedDrafts.drafts[0].error, "model unavailable");

  // One failure among the drafts is still a round that can be reviewed.
  const partial = planDebateView([
    proposal(1),
    delegate({
      delegationId: "d1",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "failed",
      startedAt: 2000,
      completedAt: 3000,
    }),
    delegate({
      delegationId: "d2",
      round: 1,
      role: "reviewer",
      phase: "draft",
      status: "complete",
      startedAt: 2100,
      completedAt: 4100,
      report: "reviewer draft",
    }),
  ]).latest;
  assert.equal(statusOf(partial, "drafting").status, "complete");
  assert.equal(statusOf(partial, "reviewing").status, "running");
  const drafting = statusOf(partial, "drafting");
  assert.equal(drafting.startedAt, 2000);
  assert.equal(drafting.completedAt, 4100);
  // Proposing runs from the round's first row to the start of drafting.
  const proposing = statusOf(partial, "proposing");
  assert.equal(proposing.startedAt, 2000);
  assert.equal(proposing.completedAt, 2000);

  const complete = planDebateView([
    proposal(1),
    delegate({
      delegationId: "d1",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "complete",
      startedAt: 1000,
      completedAt: 2000,
      report: "explorer draft",
    }),
    delegate({
      delegationId: "c1",
      round: 1,
      role: "reviewer",
      phase: "critique",
      status: "complete",
      startedAt: 3000,
      completedAt: 4000,
      report: "I object to step 2",
    }),
    delegate({
      delegationId: "i1",
      round: 1,
      role: "explorer",
      phase: "integrate",
      status: "complete",
      startedAt: 5000,
      completedAt: 6000,
      report: VERDICTS_REPORT,
    }),
  ]).latest;
  assert.equal(statusOf(complete, "drafting").status, "complete");
  assert.equal(statusOf(complete, "critiquing").status, "complete");
  assert.equal(statusOf(complete, "integrating").status, "complete");
  assert.equal(statusOf(complete, "reviewing").status, "running");
  assert.equal(statusOf(complete, "handingoff").status, "pending");
  assert.equal(complete.merged.verdicts.length, 2);

  // Every critique failing is a failed critique phase, not a settled one.
  const failedCritiques = planDebateView([
    proposal(1),
    delegate({
      delegationId: "d1",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "complete",
      startedAt: 1000,
      completedAt: 2000,
      report: "explorer draft",
    }),
    delegate({
      delegationId: "c1",
      round: 1,
      role: "reviewer",
      phase: "critique",
      status: "failed",
      startedAt: 3000,
      completedAt: 4000,
      error: "stopped by user",
    }),
  ]).latest;
  assert.equal(statusOf(failedCritiques, "critiquing").status, "failed");

  // An integrator that settled without a report failed; an empty one is not a plan.
  const failedIntegration = planDebateView([
    proposal(1),
    delegate({
      delegationId: "i1",
      round: 1,
      role: "explorer",
      phase: "integrate",
      status: "complete",
      startedAt: 5000,
      completedAt: 6000,
      report: "   ",
    }),
  ]).latest;
  assert.equal(statusOf(failedIntegration, "integrating").status, "failed");
  assert.equal(failedIntegration.merged, null);
});

test("a row replaced by its settled payload changes the phase and supplies the report", () => {
  const drafts = [
    proposal(1),
    delegate({
      delegationId: "d1",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "running",
      startedAt: 1000,
    }),
  ];
  const before = planDebateView(drafts).latest;
  assert.equal(statusOf(before, "drafting").status, "running");
  assert.equal(before.drafts.length, 1);
  assert.equal(before.drafts[0].text, "");

  // The runtime replaces the same row in place when the delegate settles.
  const settled = [
    drafts[0],
    delegate({
      delegationId: "d1",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "complete",
      startedAt: 1000,
      completedAt: 3000,
      report: "the settled draft",
    }),
  ];
  const after = planDebateView(settled).latest;
  assert.equal(statusOf(after, "drafting").status, "complete");
  assert.equal(after.drafts.length, 1);
  assert.equal(after.drafts[0].status, "complete");
  assert.equal(after.drafts[0].text, "the settled draft");
  assert.equal(statusOf(after, "reviewing").status, "running");

  // The same holds for the integrator: a running row becomes the merged plan.
  const integrating = planDebateView([
    settled[0],
    settled[1],
    delegate({
      delegationId: "i1",
      round: 1,
      role: "explorer",
      phase: "integrate",
      status: "running",
      startedAt: 4000,
    }),
  ]).latest;
  assert.equal(statusOf(integrating, "integrating").status, "running");
  assert.equal(integrating.merged, null);

  const merged = planDebateView([
    settled[0],
    settled[1],
    delegate({
      delegationId: "i1",
      round: 1,
      role: "explorer",
      phase: "integrate",
      status: "complete",
      startedAt: 4000,
      completedAt: 9000,
      report: VERDICTS_REPORT,
    }),
  ]).latest;
  assert.equal(statusOf(merged, "integrating").status, "complete");
  assert.equal(merged.integrator.text, VERDICTS_REPORT);
  assert.match(merged.merged.text, /Persist the round/);
  assert.deepEqual(merged.merged.verdicts, [
    { item: "store the plan in SQLite", verdict: "adopted", source: "explorer" },
    { item: "a second timeline in renderer state", verdict: "rejected", source: "reviewer" },
  ]);
});

test("parseMergedPlan reads the verdict block, the Chinese words, and a plain report", () => {
  assert.equal(parseMergedPlan(""), null);
  assert.equal(parseMergedPlan("   \n\n "), null);

  const english = parseMergedPlan(VERDICTS_REPORT);
  assert.equal(english.text, "## Plan\n\n1. Persist the round.");
  assert.deepEqual(english.verdicts, [
    { item: "store the plan in SQLite", verdict: "adopted", source: "explorer" },
    { item: "a second timeline in renderer state", verdict: "rejected", source: "reviewer" },
  ]);

  const chinese = parseMergedPlan(
    [
      "VERDICTS",
      "- 采纳 | 先落地持久化 | explorer",
      "- 驳回：在渲染层再存一份时间线：reviewer",
      "PLAN",
      "先做最少的改动。",
    ].join("\n"),
  );
  assert.equal(chinese.text, "先做最少的改动。");
  assert.deepEqual(chinese.verdicts, [
    { item: "先落地持久化", verdict: "adopted", source: "explorer" },
    { item: "在渲染层再存一份时间线", verdict: "rejected", source: "reviewer" },
  ]);

  const plain = parseMergedPlan("## Plan\n\nJust do the obvious thing.");
  assert.deepEqual(plain, {
    text: "## Plan\n\nJust do the obvious thing.",
    verdicts: [],
  });

  // A block without the PLAN heading keeps the whole report as the plan.
  const noPlan = parseMergedPlan(["VERDICTS", "- adopted | keep it simple | explorer"].join("\n"));
  assert.equal(noPlan.text, ["VERDICTS", "- adopted | keep it simple | explorer"].join("\n"));
  assert.deepEqual(noPlan.verdicts, [
    { item: "keep it simple", verdict: "adopted", source: "explorer" },
  ]);
});

function reviewingMessages() {
  return [
    proposal(1),
    delegate({
      delegationId: "d1",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "complete",
      startedAt: 1000,
      completedAt: 2000,
      report: "explorer draft",
    }),
    delegate({
      delegationId: "d2",
      round: 1,
      role: "reviewer",
      phase: "draft",
      status: "failed",
      startedAt: 1000,
      completedAt: 1500,
      error: "unavailable",
    }),
    delegate({
      delegationId: "i1",
      round: 1,
      role: "explorer",
      phase: "integrate",
      status: "complete",
      startedAt: 3000,
      completedAt: 4000,
      report: VERDICTS_REPORT,
    }),
  ];
}

test("selection is gated by what the round actually produced", () => {
  const result = planDebateView(reviewingMessages());
  const state = planDebateState(result, null, null);

  const draftChoice = machine.choosePlan(state, { kind: "draft", round: 1, role: "explorer" });
  assert.deepEqual(draftChoice.selection, { kind: "draft", round: 1, role: "explorer" });

  // A draft that failed is not a choice, and neither is one from another round.
  assert.equal(
    machine.choosePlan(state, { kind: "draft", round: 1, role: "reviewer" }).selection,
    null,
  );
  assert.equal(machine.choosePlan(state, { kind: "draft", round: 9, role: "explorer" }), state);
  assert.equal(machine.choosePlan(state, { kind: "merged", round: 9 }).selection, null);

  const mergedChoice = machine.choosePlan(state, { kind: "merged", round: 1 });
  assert.deepEqual(mergedChoice.selection, { kind: "merged", round: 1 });

  // A round with no merged plan refuses the merged selection but keeps drafting.
  const noIntegrator = planDebateState(
    planDebateView([
      proposal(1),
      delegate({
        delegationId: "d1",
        round: 1,
        role: "explorer",
        phase: "draft",
        status: "complete",
        startedAt: 1000,
        completedAt: 2000,
        report: "explorer draft",
      }),
    ]),
    null,
    null,
  );
  assert.equal(machine.choosePlan(noIntegrator, { kind: "merged", round: 1 }), noIntegrator);

  // Clearing the choice is allowed and is how the panel undoes one.
  assert.equal(machine.choosePlan(draftChoice, null).selection, null);
});

test("handoff is allowed once per round, and only after a plan was chosen", () => {
  const messages = reviewingMessages();
  const result = planDebateView(messages);
  assert.equal(statusOf(result.latest, "reviewing").status, "running");

  const chosen = machine.choosePlan(planDebateState(result, null, null), {
    kind: "merged",
    round: 1,
  });
  assert.deepEqual(chosen.selection, { kind: "merged", round: 1 });
  assert.equal(machine.canHandoff(chosen), true);

  const handedOff = machine.markPlanDebateHandoff(chosen, 5000);
  assert.deepEqual(handedOff.handoff, { round: 1, at: 5000 });
  assert.equal(machine.canHandoff(handedOff), false);
  // A raced second click changes nothing.
  assert.equal(machine.markPlanDebateHandoff(handedOff, 6000), handedOff);

  const reopened = planDebateView(messages, { round: 1, at: 5000 });
  assert.equal(statusOf(reopened.rounds[0], "handingoff").status, "complete");
  const reopenedState = planDebateState(reopened, chosen.selection, { round: 1, at: 5000 });
  assert.equal(machine.canHandoff(reopenedState), false);

  // A handoff of a different round does not close this one.
  const otherRound = planDebateState(planDebateView(messages, { round: 7, at: 1 }), chosen.selection, {
    round: 7,
    at: 1,
  });
  assert.equal(machine.canHandoff(otherRound), true);
  assert.equal(
    statusOf(planDebateView(messages, { round: 7, at: 1 }).rounds[0], "handingoff").status,
    "pending",
  );
});

test("two seats of one specialty stay two delegates with two documents", () => {
  const ROSTER = [
    { name: "frontend", brief: "the component tree", seat: 1 },
    { name: "frontend", brief: "bundle size", seat: 2 },
    { name: "backend", brief: "the persistence contract", seat: 1 },
  ];
  const messages = [
    toolRow(
      "PlanDebate",
      {
        planDebate: {
          round: 1,
          requirement: "Ship the plan",
          roles: ROSTER,
          phase: "draft",
          delegationIds: [],
        },
      },
      "plan-debate-1",
    ),
    toolRow(
      "Task",
      {
        delegationId: "draft-frontend-1",
        agent: "frontend",
        status: "complete",
        startedAt: 1000,
        completedAt: 2000,
        phase: "draft",
        debateRound: 1,
        debateRole: "frontend",
        debateSeat: 1,
        debateReport: "## first frontend plan",
      },
      "task-draft-frontend-1",
    ),
    toolRow(
      "Task",
      {
        delegationId: "draft-frontend-2",
        agent: "frontend",
        status: "complete",
        startedAt: 1000,
        completedAt: 2500,
        phase: "draft",
        debateRound: 1,
        debateRole: "frontend",
        debateSeat: 2,
        debateReport: "## second frontend plan",
      },
      "task-draft-frontend-2",
    ),
    toolRow(
      "Task",
      {
        delegationId: "draft-backend",
        agent: "backend",
        status: "complete",
        startedAt: 1000,
        completedAt: 2000,
        phase: "draft",
        debateRound: 1,
        debateRole: "backend",
        debateSeat: 1,
        debateReport: "## backend plan",
      },
      "task-draft-backend",
    ),
  ];

  const round = planDebateView(messages).latest;
  // The roster keeps both seats, with their own briefs.
  assert.deepEqual(
    round.roles.map((role) => [role.name, role.seat]),
    [["frontend", 1], ["frontend", 2], ["backend", 1]],
  );
  // Two delegates, not one: the seats are distinct nodes.
  assert.deepEqual(
    round.drafts.map((node) => view.planDebateNodeLabel(node)),
    ["frontend", "frontend #2", "backend"],
  );
  // The machine keys contributions by the seat handle, so the peers cannot
  // overwrite each other and both are choosable.
  assert.deepEqual(
    round.state.drafts.map((draft) => draft.role),
    ["frontend", "frontend #2", "backend"],
  );
  assert.equal(
    view.planDebatePhaseStatuses(round).find((phase) => phase.name === "drafting").status,
    "complete",
  );
});

test("a round is running exactly while one of its delegates has not settled", () => {
  // Nothing published yet: no round, nothing to stop.
  assert.equal(planDebateRunning([]), false);
  assert.equal(planDebateRoundRunning(null), false);

  const draftRow = (id, role, status) =>
    delegate({ delegationId: id, round: 1, role, phase: "draft", status });
  const proposalRow = proposal(1);
  const criticRow = (status) =>
    delegate({ delegationId: "r1-critic", round: 1, role: "reviewer", phase: "critique", status });
  const integratorRow = (status) =>
    delegate({ delegationId: "r1-integrator", round: 1, role: "explorer", phase: "integrate", status });

  // A proposal alone is not a running round: the runtime publishes delegate
  // rows when a seat starts, and the button keeps launching until one does.
  assert.equal(planDebateRunning([proposalRow]), false);

  assert.equal(planDebateRunning([proposalRow, draftRow("r1-d1", "explorer", "running")]), true);
  assert.equal(planDebateRunning([proposalRow, draftRow("r1-d1", "explorer", "complete"), criticRow("running")]), true);
  assert.equal(planDebateRunning([proposalRow, integratorRow("running")]), true);

  // Settled — however the round ended — is not running, so the button returns
  // to launching without any user action.
  for (const settled of ["complete", "failed", "stopped"]) {
    const messages = [
      proposalRow,
      draftRow("r1-d1", "explorer", "complete"),
      criticRow(settled),
      integratorRow(settled),
    ];
    assert.equal(planDebateRunning(messages), false, `a ${settled} round is not running`);
  }

  // The `reviewing` phase stays open while a plan exists, but it is not a
  // running delegate: the round itself has finished producing.
  const readable = [
    proposalRow,
    delegate({
      delegationId: "r1-d1",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "complete",
      report: "a plan",
    }),
  ];
  assert.equal(planDebateRunning(readable), false);
  assert.equal(
    planDebatePhaseStatuses(planDebateView(readable).latest).find((p) => p.name === "reviewing")
      .status,
    "running",
    "reviewing is open while the user chooses, which must not read as a running debate",
  );
});

test("only the newest round can be running", () => {
  const messages = [
    proposal(1),
    delegate({ delegationId: "r1-d1", round: 1, role: "explorer", phase: "draft", status: "running" }),
    proposal(2),
    delegate({ delegationId: "r2-d1", round: 2, role: "explorer", phase: "draft", status: "complete" }),
  ];
  assert.equal(
    planDebateRunning(messages),
    false,
    "an older round still marked running does not hold the composer's button",
  );
  assert.equal(planDebateRoundRunning(planDebateView(messages).rounds[0]), true);
});

/** Both seats settled their draft; nothing has been critiqued yet. */
function draftedOnly(round = 1) {
  return [
    proposal(round),
    delegate({
      delegationId: `r${round}-d1`,
      round,
      role: "explorer",
      phase: "draft",
      status: "complete",
      completedAt: 2000,
      report: "explorer draft",
    }),
    delegate({
      delegationId: `r${round}-d2`,
      round,
      role: "reviewer",
      phase: "draft",
      status: "complete",
      completedAt: 2500,
      report: "reviewer draft",
    }),
  ];
}

/** Round `round` finished: drafts, both objections, and a merged plan. */
function finishedRound(round = 1) {
  return [
    ...draftedOnly(round),
    delegate({
      delegationId: `r${round}-c1`,
      round,
      role: "explorer",
      phase: "critique",
      status: "complete",
      completedAt: 3000,
      report: "objection one",
    }),
    delegate({
      delegationId: `r${round}-c2`,
      round,
      role: "reviewer",
      phase: "critique",
      status: "complete",
      completedAt: 3200,
      report: "objection two",
    }),
    delegate({
      delegationId: `r${round}-i`,
      round,
      role: "explorer",
      phase: "integrate",
      status: "complete",
      completedAt: 5000,
      report: VERDICTS_REPORT,
    }),
  ];
}

test("an unfinished round is one the composer must not start a second round beside", () => {
  // A roster nobody started is unfinished: the user's start is the only thing
  // that opens it, so a debate press here would ask for a second round.
  assert.equal(planDebateUnfinishedRound([proposal(1)]), 1);

  // Drafts still producing.
  const drafting = [
    proposal(1),
    delegate({
      delegationId: "r1-d1",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "running",
    }),
  ];
  assert.equal(planDebateUnfinishedRound(drafting), 1);

  // Every draft settled but no objection has published: exactly the shape the
  // dock showed while a second round was being proposed over it.
  const drafted = draftedOnly();
  assert.equal(planDebateUnfinishedRound(drafted), 1);
  assert.equal(planDebateRoundUnfinished(planDebateView(drafted).latest), true);

  // Objections are in, the merged plan is not.
  const critiqued = drafted.concat(finishedRound().slice(3, 5));
  assert.equal(planDebateUnfinishedRound(critiqued), 1);

  // The integrator settled: the round is over, so the next debate may start.
  const integrated = finishedRound();
  assert.equal(planDebateUnfinishedRound(integrated), null);
  assert.equal(planDebateRoundUnfinished(planDebateView(integrated).latest), false);
});

test("a round whose every draft failed is finished, not stuck", () => {
  // Both seats published and neither produced a document: the runtime fails the
  // round with NO_DRAFTS, so nothing is left to critique or merge.
  const messages = [
    proposal(1),
    delegate({
      delegationId: "r1-d1",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "failed",
      completedAt: 2000,
      error: "provider refused",
    }),
    delegate({
      delegationId: "r1-d2",
      round: 1,
      role: "reviewer",
      phase: "draft",
      status: "stopped",
      completedAt: 2100,
    }),
  ];
  assert.equal(planDebateRoundUnfinished(planDebateView(messages).latest), false);
  assert.equal(planDebateUnfinishedRound(messages), null);
});

test("the panel draws the round that owns the delegates, not an empty newest one", () => {
  // Round 2 was proposed and started nothing while round 1 is still producing.
  // The panel must draw round 1, or its six pending rows are the whole tab.
  const phantom = draftedOnly(1).concat(proposal(2, { requirement: "Second requirement" }));
  const phantomView = planDebateView(phantom);
  assert.equal(phantomView.latest.round, 2);
  assert.equal(planDebatePanelRound(phantomView).round, 1);
  assert.equal(planDebateUnfinishedRound(phantom), 1);


  // The owning round being over does not hand the tab to the empty one: the
  // body stays the round with the artifacts, and the round nobody started is
  // drawn as the header line with the control that starts it.
  const nextRound = finishedRound(1).concat(proposal(2, { requirement: "Second requirement" }));
  const nextView = planDebateView(nextRound);
  const shown = planDebatePanelRound(nextView);
  assert.equal(shown.round, 1);
  assert.equal(planDebateRoundUnfinished(shown), false);
  const pending = planDebatePendingRounds(nextView, shown);
  assert.deepEqual(pending.map((round) => round.round), [2]);
  assert.equal(planDebateAwaitingStart(pending[0]), true);
  // The older round's seats are still the ones on screen.
  assert.deepEqual(names(shown.drafts), ["explorer", "reviewer"]);
  // The proposed round is unfinished, so the composer still points at it.
  assert.equal(planDebateUnfinishedRound(nextRound), 2);

  // A finished round with no empty successor has nothing to announce.
  const settled = planDebateView(finishedRound(1));
  assert.deepEqual(planDebatePendingRounds(settled, planDebatePanelRound(settled)), []);
});

test("the owning round's phases read what its nodes say", () => {
  // Four drafts settled, so drafting is complete and the untouched phases are
  // not: the status comes from the nodes, not from the newest round.
  const phantomView = planDebateView(
    draftedOnly(1).concat(proposal(2, { requirement: "Second requirement" })),
  );
  const shown = planDebatePanelRound(phantomView);
  const phases = planDebatePhaseStatuses(shown);
  const status = (name) => phases.find((phase) => phase.name === name).status;
  assert.equal(status("proposing"), "complete");
  assert.equal(status("drafting"), "complete");
  assert.equal(status("critiquing"), "pending");
  assert.equal(status("integrating"), "pending");
  // The artifact a reader opens is the delegate's report, carried by its seat.
  assert.deepEqual(names(shown.drafts), ["explorer", "reviewer"]);
  assert.deepEqual(
    shown.drafts.map((draft) => draft.text),
    ["explorer draft", "reviewer draft"],
  );
});

test("a seat's status is the delegation's, shared with the dock's reading", () => {
  const messages = draftedOnly(1);
  const seatStatus = (view) => view.latest.drafts[0].status;
  // The row still says `complete`; the docks' status map says the delegate was
  // aborted (a closed turn, a stop). The panel must draw the map's answer, so
  // the two surfaces can never disagree about the same delegation.
  const shared = planDebateView(messages, null, new Map([["r1-d1", "aborted"]]));
  assert.equal(seatStatus(shared), "stopped");
  // Every dock outcome has one badge, and the row's own report is the fallback
  // when the map has nothing to say about that delegation.
  const completed = planDebateView(messages, null, new Map([["r1-d1", "completed"]]));
  assert.equal(seatStatus(completed), "complete");
  assert.equal(seatStatus(planDebateView(messages)), "complete");
  // A seat the map cannot settle stays whatever it reported, and the round's
  // own "still producing" answer follows the same status.
  const running = planDebateView(
    [proposal(1), delegate({
      delegationId: "r1-d1",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "running",
    })],
    null,
    new Map([["r1-d1", "running"]]),
  );
  assert.equal(seatStatus(running), "running");
  assert.equal(planDebateRoundRunning(running.latest), true);
});

/* -------------------------------------------------------------------------- */
/* Phase status is a projection of the seats                                  */
/* -------------------------------------------------------------------------- */

/** The four seats the live panel showed, one per specialty. */
const FOUR_SEATS = [
  { name: "ui-架构", brief: "own the layout", seat: 1 },
  { name: "code-reviewer", brief: "own the risks", seat: 1 },
  { name: "rust-开发", brief: "own the host", seat: 1 },
  { name: "typescript-开发", brief: "own the renderer", seat: 1 },
];

/** One seat's row, in the shape the runtime publishes for a plan debate. */
function seatRow(handle, phase, status, extra = {}) {
  return toolRow(
    "Task",
    {
      delegationId: `${phase}-${handle}`,
      agent: handle,
      status,
      startedAt: 1000,
      ...(status === "running" ? {} : { completedAt: 2000 }),
      phase,
      debateRound: 1,
      debateRole: handle,
      ...extra,
    },
    `task-${phase}-${handle}`,
  );
}

/** One row per roster seat in `phase`; `reportOf` gives each its document. */
function seatsOfPhase(phase, status, reportOf) {
  return FOUR_SEATS.map((role) =>
    seatRow(
      role.name,
      phase,
      status,
      reportOf === undefined ? {} : { debateReport: reportOf(role.name) },
    ),
  );
}

function roundOf(rows) {
  return planDebateView([proposal(1, { roles: FOUR_SEATS }), ...rows]).latest;
}

const DRAFTS_DONE = seatsOfPhase("draft", "complete", (handle) => `## ${handle} draft`);
const CRITIQUES_DONE = seatsOfPhase("critique", "complete", (handle) => `objection from ${handle}`);
const MERGED = [
  "VERDICTS",
  "- adopted | keep the transcript | ui-架构",
  "PLAN",
  "# Merged plan",
  "Ship it.",
].join("\n");
const INTEGRATOR_RUNNING = [seatRow("ui-架构", "integrate", "running")];
const INTEGRATOR_DONE = [
  seatRow("ui-架构", "integrate", "complete", { debateReport: MERGED }),
];

/** One row of the table: the message set, and what the panel must read from it. */
const PHASE_CASES = [
  {
    label: "no seat started",
    rows: [],
    phase: "drafting",
    status: "pending",
  },
  {
    label: "every draft settled, each with its document",
    rows: DRAFTS_DONE,
    phase: "drafting",
    status: "complete",
    seats: DRAFTS_DONE.length,
    texts: FOUR_SEATS.map((role) => `## ${role.name} draft`),
  },
  {
    label: "every critique settled",
    rows: [...DRAFTS_DONE, ...CRITIQUES_DONE],
    phase: "critiquing",
    status: "complete",
    seats: CRITIQUES_DONE.length,
  },
  {
    label: "one integrator still working",
    rows: [...DRAFTS_DONE, ...CRITIQUES_DONE, ...INTEGRATOR_RUNNING],
    phase: "integrating",
    status: "running",
    merged: null,
  },
  {
    label: "the integrator settled with its merged plan",
    rows: [...DRAFTS_DONE, ...CRITIQUES_DONE, ...INTEGRATOR_DONE],
    phase: "integrating",
    status: "complete",
    merged: /Ship it\./,
  },
  {
    label: "every critique settled without a report is not a running phase",
    rows: [...DRAFTS_DONE, ...seatsOfPhase("critique", "complete")],
    phase: "critiquing",
    status: "failed",
  },
];

test("a phase reads its seats, table-driven over the shapes the panel draws", () => {
  for (const row of PHASE_CASES) {
    const round = roundOf(row.rows);
    const phase = statusOf(round, row.phase);
    assert.equal(phase.status, row.status, row.label);
    // A settled phase carries the end of its span, so nothing ticks past it.
    if (row.status === "complete" || row.status === "failed") {
      assert.equal(phase.completedAt, 2000, `${row.label}: the span is closed`);
    }
    if (row.seats !== undefined) {
      const listed =
        row.phase === "drafting"
          ? round.drafts
          : row.phase === "critiquing"
            ? round.critiques
            : round.integrator
              ? [round.integrator]
              : [];
      assert.equal(listed.length, row.seats, `${row.label}: every seat is listed`);
    }
    if (row.texts !== undefined) {
      assert.deepEqual(
        round.drafts.map((node) => node.text),
        row.texts,
        `${row.label}: the section lists the documents themselves`,
      );
    }
    if (row.merged === null) {
      assert.equal(round.merged, null, `${row.label}: no merged plan yet`);
    } else if (row.merged instanceof RegExp) {
      assert.match(round.merged.text, row.merged, `${row.label}: the merged plan is drawn`);
    }
  }
});

test("a failed seat among successes keeps the phase complete and says who failed", () => {
  const rows = DRAFTS_DONE.map((row) =>
    row.id === "task-draft-code-reviewer"
      ? toolRow(
          "Task",
          {
            delegationId: "draft-code-reviewer",
            agent: "code-reviewer",
            status: "failed",
            startedAt: 1000,
            completedAt: 2000,
            phase: "draft",
            debateRound: 1,
            debateRole: "code-reviewer",
            // The lifecycle summary settles a row with `{ code, message }`.
            error: { code: "MODEL_UNAVAILABLE", message: "the provider refused" },
          },
          row.id,
        )
      : row,
  );
  const round = roundOf(rows);
  assert.equal(statusOf(round, "drafting").status, "complete");
  const failed = round.drafts.find((node) => node.delegationId === "draft-code-reviewer");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "the provider refused");
  assert.equal(failed.text, "");
  // The three that produced documents are still drawn with them.
  assert.deepEqual(
    round.drafts.filter((node) => node.text !== "").map((node) => node.role),
    ["ui-架构", "rust-开发", "typescript-开发"],
  );
});

test("a settled row that declares the docks' outcome word is a finished seat", () => {
  // The runtime settles a `Task` row with the same outcomes the docks report;
  // the panel draws four badges, so each outcome collapses onto one of them.
  const outcomes = [
    ["completed", "complete"],
    ["failed", "failed"],
    ["timed_out", "stopped"],
    ["aborted", "stopped"],
    ["stopped", "stopped"],
    ["denied", "failed"],
  ];
  for (const [declared, drawn] of outcomes) {
    const round = roundOf([
      seatRow("ui-架构", "draft", declared, { debateReport: "a draft" }),
      ...seatsOfPhase("draft", "complete", () => "a draft").slice(1),
    ]);
    // A row the panel cannot read is a seat it would silently drop; every one of
    // these lands on one of the four badges instead.
    assert.equal(round.drafts.length, FOUR_SEATS.length, `a ${declared} seat is drawn`);
    assert.equal(round.drafts[0].status, drawn, `${declared} reads ${drawn}`);
  }
  // `queued` has not begun: a seat that is still open keeps its phase running.
  const queued = roundOf([...seatsOfPhase("draft", "complete", () => "a draft").slice(1), seatRow("ui-架构", "draft", "queued")]);
  assert.equal(statusOf(queued, "drafting").status, "running");
});

/*
 * The round also lives on disk.
 *
 * The transcript the panel reads is a window of the last hundred rows, and one
 * debate spends about fifteen of them. The drafts therefore fall out of it while
 * the critiques are still in it, which is exactly what the user saw: a settled
 * draft drawn as `起草中 / 等待中` with `此阶段暂无内容`, beside critiques still
 * reading `进行中`, and nothing at all after a reload. These tests pin the fix
 * at the view: disk is the durable copy for a seat that has settled, and the
 * transcript still supplies the seats disk cannot know about.
 */

/** One seat of a round index, in the shape main returns it. */
function artifactSeat(phase, role, status, report, extra = {}) {
  return {
    phase,
    role,
    seat: 1,
    status,
    delegationId: `${phase}-${role}`,
    startedAt: 1000,
    completedAt: 2000,
    ...(report === undefined ? {} : { report }),
    ...extra,
  };
}

/** One round index, as `<projectPath>/.pi-harbor/debate/round-<N>/` describes it. */
function artifactRound(round, seats, extra = {}) {
  return {
    version: 1,
    round,
    requirement: `Requirement ${round}`,
    seats,
    ...extra,
  };
}

test("a draft the window dropped is read back from disk, and its phase completes", () => {
  // The window kept the critique rows and lost the drafts: the reported bug.
  const messages = [proposal(1, { roles: FOUR_SEATS }), ...CRITIQUES_DONE];
  const transcript = planDebateView(messages).latest;
  assert.equal(transcript.drafts.length, 0, "the transcript really lost the drafts");
  assert.equal(statusOf(transcript, "drafting").status, "pending");

  const artifacts = [
    artifactRound(
      1,
      FOUR_SEATS.map((role) =>
        artifactSeat("draft", role.name, "complete", `## ${role.name} draft`),
      ),
    ),
  ];
  const round = planDebateViewWithArtifacts(messages, artifacts).latest;
  // Every seat is back, terminal, with the report the delegate actually wrote.
  assert.deepEqual(names(round.drafts), FOUR_SEATS.map((role) => role.name));
  assert.equal(round.drafts[0].text, "## ui-架构 draft");
  assert.equal(round.drafts[0].status, "complete");
  // The phase above them is complete, not the forever-pending one the user saw.
  assert.equal(statusOf(round, "drafting").status, "complete");
  // And the round is not "waiting for its start" any more.
  assert.equal(planDebateAwaitingStart(round), false);
  assert.equal(round.fromDisk, true, "the panel can say where it read the round");
});

test("a seat that is still running is kept from the transcript, which disk cannot know", () => {
  // Two drafts already settled on disk; a third critique is still producing.
  const messages = [
    proposal(1, { roles: FOUR_SEATS }),
    seatRow("ui-架构", "draft", "complete", { debateReport: "## ui-架构 draft" }),
    seatRow("code-reviewer", "critique", "running"),
  ];
  const artifacts = [
    artifactRound(1, [
      artifactSeat("draft", "ui-架构", "complete", "## ui-架构 draft"),
      // The reviewer's draft settled after the transcript's window moved on.
      artifactSeat("draft", "code-reviewer", "complete", "## code-reviewer draft"),
    ]),
  ];
  const round = planDebateViewWithArtifacts(messages, artifacts).latest;
  assert.equal(round.drafts.length, 2, "the disk draft joins the transcript's");
  assert.equal(round.critiques.length, 1, "the running critique survives the merge");
  assert.equal(round.critiques[0].status, "running");
  // A running seat keeps its phase running; a settled one completes it.
  assert.equal(statusOf(round, "drafting").status, "complete");
  assert.equal(statusOf(round, "critiquing").status, "running");
});

test("disk turns a stale running seat into its settled report", () => {
  // The row says `running` because the window predates the settlement; the file
  // says the delegate answered. Disk is the terminal fact.
  const messages = [
    proposal(1, { roles: FOUR_SEATS }),
    seatRow("ui-架构", "draft", "running"),
  ];
  const artifacts = [
    artifactRound(1, [artifactSeat("draft", "ui-架构", "complete", "## ui-架构 draft")]),
  ];
  const round = planDebateViewWithArtifacts(messages, artifacts).latest;
  assert.equal(round.drafts.length, 1, "one seat, not the same seat twice");
  assert.equal(round.drafts[0].status, "complete");
  assert.equal(round.drafts[0].text, "## ui-架构 draft");
  assert.equal(statusOf(round, "drafting").status, "complete");
});

test("a round only disk remembers is listed, with its seats and its merged plan", () => {
  // A reload whose window lost the proposal row as well: nothing in the
  // transcript names round 3, so the switcher and the body come from the files.
  const artifacts = [
    artifactRound(3, [
      artifactSeat("draft", "ui-架构", "complete", "## ui-架构 draft"),
      artifactSeat("draft", "code-reviewer", "complete", "## code-reviewer draft"),
      artifactSeat("critique", "ui-架构", "complete", "no objection"),
      artifactSeat("integrate", "ui-架构", "complete", MERGED),
    ], { mergedFile: "merged.md" }),
  ];
  const merged = planDebateViewWithArtifacts([], artifacts);
  assert.deepEqual(
    merged.rounds.map((round) => round.round),
    [3],
  );
  const round = planDebatePanelRound(merged);
  assert.equal(round.round, 3);
  // The roster is what the index knows: who sat, and which seat.
  assert.deepEqual(
    round.roles.map((role) => role.name),
    ["ui-架构", "code-reviewer"],
  );
  assert.deepEqual(names(round.drafts), ["ui-架构", "code-reviewer"]);
  assert.equal(round.merged.text.includes("# Merged plan"), true);
  assert.equal(statusOf(round, "drafting").status, "complete");
  assert.equal(statusOf(round, "integrating").status, "complete");
  assert.equal(round.fromDisk, true);
});

test("a session with no artifacts renders exactly as the transcript always did", () => {
  // Disk is additive, never required: every debate that predates the files has
  // to read back the way it did before they existed.
  const messages = [
    proposal(1, { roles: FOUR_SEATS }),
    ...DRAFTS_DONE,
    ...CRITIQUES_DONE,
    ...INTEGRATOR_DONE,
  ];
  assert.deepEqual(
    planDebateViewWithArtifacts(messages, []),
    planDebateView(messages),
  );
  // And an artifact list for another round changes nothing about this one.
  const other = planDebateViewWithArtifacts(messages, [
    artifactRound(9, [artifactSeat("draft", "explorer", "complete", "round nine")]),
  ]);
  assert.equal(other.rounds[0].fromDisk, undefined, "an untouched round is not from disk");
  assert.deepEqual(other.rounds[0], planDebateView(messages).rounds[0]);
  assert.deepEqual(
    other.rounds.map((round) => round.round),
    [1, 9],
  );
});

test("a recovered round draws the spans its files recorded, not a zero", () => {
  const artifacts = [
    artifactRound(
      4,
      [
        artifactSeat("draft", "explorer", "complete", "## explorer draft", {
          startedAt: 10_000,
          completedAt: 40_000,
        }),
        artifactSeat("draft", "reviewer", "complete", "## reviewer draft", {
          startedAt: 12_000,
          completedAt: 55_000,
        }),
      ],
      {
        roles: [
          { name: "explorer", brief: "map the code", seat: 1 },
          { name: "reviewer", brief: "find the risks", seat: 1 },
        ],
      },
    ),
  ];
  const round = planDebateViewWithArtifacts([], artifacts).latest;
  const drafting = statusOf(round, "drafting");
  // The phase span is its seats' span, read from the files.
  assert.equal(drafting.startedAt, 10_000);
  assert.equal(drafting.completedAt, 55_000);
  // Which is exactly what the panel converts into the seconds it prints.
  assert.equal(machine.planDebateElapsed(drafting, 999_999), 45_000);
  // Each seat keeps its own span: two seats of one phase are two durations.
  const seatSeconds = round.drafts.map(
    (node) =>
      machine.planDebateElapsed(
        {
          name: "drafting",
          status: node.status,
          startedAt: node.startedAt,
          completedAt: node.completedAt,
        },
        999_999,
      ) / 1000,
  );
  assert.deepEqual(seatSeconds, [30, 43]);
});

test("a disk seat with no clock is drawn without a span instead of zero seconds", () => {
  const artifacts = [
    artifactRound(4, [
      artifactSeat("draft", "explorer", "complete", "## explorer draft", {
        startedAt: undefined,
        completedAt: undefined,
      }),
    ]),
  ];
  const round = planDebateViewWithArtifacts([], artifacts).latest;
  const node = round.drafts[0];
  assert.equal(node.status, "complete");
  assert.equal(node.text, "## explorer draft");
  // Nothing invents a clock: the node and its phase both carry no span, which
  // is what lets the panel draw no duration at all.
  assert.equal("startedAt" in node, false);
  assert.equal("completedAt" in node, false);
  assert.equal("startedAt" in statusOf(round, "drafting"), false);
});

test("a round only disk remembers keeps the roster and briefs its index recorded", () => {
  const artifacts = [
    artifactRound(5, [artifactSeat("draft", "发布工程", "complete", "## draft")], {
      roles: [
        // A CJK-only handle survives in the index even though its report file is
        // named after its seat.
        { name: "发布工程", brief: "own the delivery", seat: 1 },
        { name: "explorer", brief: "map the work", seat: 1 },
      ],
    }),
  ];
  const round = planDebateViewWithArtifacts([], artifacts).latest;
  assert.deepEqual(
    round.roles.map((role) => [role.name, role.brief]),
    [
      ["发布工程", "own the delivery"],
      ["explorer", "map the work"],
    ],
  );
  // The panel names the seat by the handle the user recognises.
  assert.equal(round.drafts[0].role, "发布工程");

  // An index written before the roster was persisted still renders: the seats
  // it settled name the roster, with the brief empty rather than invented.
  const legacy = planDebateViewWithArtifacts([], [
    artifactRound(6, [artifactSeat("draft", "explorer", "complete", "## draft")]),
  ]).latest;
  assert.deepEqual(legacy.roles, [{ name: "explorer", brief: "", seat: 1 }]);
});

test("a reportless stopped seat reads stopped, not failed", () => {
  const round = planDebateView([
    proposal(1),
    delegate({
      delegationId: "stopped-draft",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "stopped",
      completedAt: 3000,
    }),
  ]).latest;
  assert.equal(round.drafts[0].status, "stopped");
  assert.equal(statusOf(round, "drafting").status, "stopped");
  assert.equal(statusOf(round, "critiquing").status, "pending");
});

test("stoppedAt closes a transcript round and every phase that never settled", () => {
  const round = planDebateView([
    proposal(1, { stoppedAt: 7000 }),
    delegate({
      delegationId: "stopped-draft",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "stopped",
      completedAt: 7000,
    }),
  ]).latest;
  assert.equal(round.stoppedAt, 7000);
  assert.equal(statusOf(round, "drafting").status, "stopped");
  assert.equal(statusOf(round, "critiquing").status, "stopped");
  assert.equal(statusOf(round, "integrating").status, "stopped");
  assert.equal(planDebateRoundRunning(round), false);
  assert.equal(planDebateRoundUnfinished(round), false);
  assert.equal(planDebateAwaitingStart(round), false);
});

test("a stopped round and its reportless seats recover as stopped from disk", () => {
  const round = planDebateViewWithArtifacts([], [
    artifactRound(4, [artifactSeat("draft", "explorer", "stopped", undefined, {
      completedAt: undefined,
    })], {
      stoppedAt: 9000,
    }),
  ]).latest;
  assert.equal(round.stoppedAt, 9000);
  assert.equal(round.fromDisk, true);
  assert.equal(round.drafts[0].status, "stopped");
  assert.equal(round.drafts[0].text, "");
  assert.equal(round.drafts[0].completedAt, 9000);
  assert.equal(statusOf(round, "drafting").status, "stopped");
  assert.equal(statusOf(round, "integrating").status, "stopped");
  assert.equal(planDebateRoundRunning(round), false);
});

test("artifact caches are project-bound, deletion is selective, and failed refreshes retain rounds", () => {
  const first = artifactRound(1, []);
  const second = artifactRound(2, []);
  const projectA = artifactCache.planDebateArtifactCacheForProject("/project/a", TEST_SESSION, [first, second]);
  assert.deepEqual(artifactCache.planDebateArtifactsForProject(projectA, TEST_SESSION, "/project/b"), []);
  assert.deepEqual(artifactCache.planDebateArtifactsForProject(projectA, TEST_SESSION, ""), []);
  assert.equal(artifactCache.planDebateArtifactCacheHasRound(projectA, TEST_SESSION, "/project/a", 1), true);
  assert.equal(
    artifactCache.planDebateArtifactCacheHasRound(projectA, TEST_SESSION, "/project/b", 1),
    false,
    "A's displayed round cannot authorize deleting B's same-numbered round",
  );
  assert.equal(
    artifactCache.removePlanDebateArtifactFromCache(projectA, TEST_SESSION, "/project/b", 1),
    projectA,
    "a project switch leaves the old cache untouched and cannot delete through it",
  );
  const retained = artifactCache.planDebateArtifactCacheAfterRefresh(projectA, TEST_SESSION, "/project/a", {
    ok: false,
  });
  assert.equal(retained, projectA);
  assert.deepEqual(retained.rounds.map((round) => round.round), [1, 2]);
  const remaining = artifactCache.removePlanDebateArtifactFromCache(projectA, TEST_SESSION, "/project/a", 1);
  assert.deepEqual(remaining.rounds.map((round) => round.round), [2]);
});

test("EACCES, ENOTDIR and host failures retain the panel's cache; only a real empty read clears it", () => {
  const original = artifactCache.planDebateArtifactCacheForProject("/project/a", TEST_SESSION, [
    artifactRound(1, []),
    artifactRound(2, []),
  ]);
  for (const errorCode of ["EACCES", "ENOTDIR", "HOST_UNAVAILABLE"]) {
    const retained = artifactCache.planDebateArtifactCacheAfterRefresh(original, TEST_SESSION, "/project/a", {
      ok: false,
      errorCode,
    });
    assert.equal(retained, original, errorCode);
    assert.deepEqual(retained.rounds.map((round) => round.round), [1, 2], errorCode);
  }
  const genuinelyEmpty = artifactCache.planDebateArtifactCacheAfterRefresh(original, TEST_SESSION, "/project/a", {
    ok: true,
    rounds: [],
  });
  assert.deepEqual(genuinelyEmpty.rounds, []);
});

test("a refresh started before deletion cannot revive the deleted round", () => {
  const first = artifactRound(1, []);
  const second = artifactRound(2, []);
  const original = artifactCache.planDebateArtifactCacheForProject("/project/a", TEST_SESSION, [first, second]);
  const requestId = 1;
  let currentRequestId = requestId;

  // This is the deletion branch's ordering: revoke, then evict.
  currentRequestId += 1;
  let cache = artifactCache.removePlanDebateArtifactFromCache(original, TEST_SESSION, "/project/a", 1);
  if (artifactCache.planDebateArtifactRequestIsCurrent(requestId, currentRequestId, false)) {
    cache = artifactCache.planDebateArtifactCacheAfterRefresh(cache, TEST_SESSION, "/project/a", {
      ok: true,
      rounds: [first, second, artifactRound(3, [])],
    });
  }
  assert.deepEqual(cache.rounds.map((round) => round.round), [2]);
  assert.equal(artifactCache.planDebateArtifactCacheHasRound(cache, TEST_SESSION, "/project/a", 1), false);
  assert.equal(artifactCache.planDebateArtifactRequestIsCurrent(2, 2, false), true);
  assert.equal(artifactCache.planDebateArtifactRequestIsCurrent(2, 2, true), false);

  const tab = fs.readFileSync(
    new URL("../src/components/workpanel/PlanDebateTab.tsx", import.meta.url),
    "utf8",
  );
  const hook = fs.readFileSync(
    new URL("../src/features/plan-debate/usePlanDebateActions.ts", import.meta.url),
    "utf8",
  );
  assert.match(tab, /const requestId = \+\+artifactsRequestRef\.current/);
  const invalidated = tab.indexOf("artifactsRequestRef.current += 1;");
  const removed = hook.indexOf("removePlanDebateArtifactFromCache(current, sessionId, deleteProjectPath, round)");
  const revokeInHook = hook.indexOf("revokeArtifactRequests();");
  assert.ok(invalidated > 0 && removed > 0, "deletion revokes older requests before eviction");
  assert.ok(revokeInHook > 0 && removed > revokeInHook, "hook revokes before evicting");
});

test("project-changed deletion failures use the localized catalog in all nine languages", () => {
  const result = {
    errorCode: "PLAN_DEBATE_PROJECT_CHANGED",
    message: "The session moved to another project. Reload the round before deleting it.",
  };
  for (const locale of ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ko", "pt-BR", "tr"]) {
    const catalog = flattenCatalog(catalogs[locale]);
    const message = deletion.planDebateDeleteErrorMessage(result, (key) => catalog[key]);
    assert.equal(message, catalog["planning.errorDeleteRoundProject"], locale);
    assert.notEqual(message, result.message, locale);
  }
  assert.equal(
    deletion.planDebateDeleteErrorMessage({ errorCode: "OTHER", message: "server detail" }, () => "unused"),
    "server detail",
  );
  assert.equal(
    deletion.planDebateDeleteErrorMessage({ errorCode: "OTHER" }, () => "unused"),
    "OTHER",
  );
});

test("a reportless failed disk seat outranks a stopped seat in the same phase", () => {
  const round = planDebateViewWithArtifacts([], [
    artifactRound(4, [
      artifactSeat("draft", "explorer", "failed", undefined),
      artifactSeat("draft", "reviewer", "stopped", undefined),
    ]),
  ]).latest;
  assert.deepEqual(round.drafts.map((node) => node.status), ["failed", "stopped"]);
  assert.equal(statusOf(round, "drafting").status, "failed");
});
