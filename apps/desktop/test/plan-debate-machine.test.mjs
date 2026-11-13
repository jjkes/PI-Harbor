import assert from "node:assert/strict";
import test from "node:test";

/*
 * The plan debate is one round of drafts, objections and one merged plan, and a
 * re-debate is a new round over the previous one. These tests hold the parts a
 * reload, a failed delegate, or an impatient click could corrupt: phase order,
 * a partial round, the immutability of history, and the single irreversible
 * step — handing a plan to team mode.
 */

const machine = await import("../src/features/plan-debate/plan-debate-machine.ts");
const {
  PLAN_DEBATE_PHASES,
  beginPhase,
  canHandoff,
  choosePlan,
  completePhase,
  currentPlanDebateRound,
  draftingSettled,
  failPhase,
  fromPlanDebateSnapshot,
  idlePlanDebateState,
  planDebateElapsed,
  planDebatePhase,
  readableDrafts,
  recordDraft,
  redebatePlan,
  setMergedPlan,
  startPlanDebateRound,
  stopPhase,
  toPlanDebateSnapshot,
} = machine;

const ROLES = [
  { name: "explorer", brief: "Read the tree", seat: 1 },
  { name: "code-reviewer", brief: "Find the risk", seat: 1 },
  { name: "test-runner", brief: "Prove it", seat: 1 },
];

function started(now = 1000, constraint = "Ship the work panel") {
  return startPlanDebateRound(idlePlanDebateState(), { roles: ROLES, constraint, now });
}

function withDrafts(state, statuses) {
  let next = state;
  for (const [index, status] of statuses.entries()) {
    next = recordDraft(next, {
      role: ROLES[index].name,
      status,
      text: status === "complete" ? `draft ${index}` : "",
      ...(status === "failed" ? { error: "delegate exited" } : {}),
    });
  }
  return next;
}

test("a round runs proposing through handing off, stamping each phase once", () => {
  let state = started(1000);
  let round = currentPlanDebateRound(state);
  assert.equal(round.round, 1);
  assert.equal(round.redebate, false);
  // Nothing has run: every phase is pending and nothing has a clock.
  for (const name of PLAN_DEBATE_PHASES) {
    assert.equal(planDebatePhase(round, name).status, "pending");
    assert.equal(planDebatePhase(round, name).startedAt, undefined);
  }

  state = beginPhase(state, "proposing", 1000);
  round = currentPlanDebateRound(state);
  assert.equal(planDebatePhase(round, "proposing").status, "running");
  // A running phase counts against the clock, so the timeline shows movement.
  assert.equal(planDebateElapsed(planDebatePhase(round, "proposing"), 1250), 250);

  state = completePhase(state, "proposing", 1200);
  round = currentPlanDebateRound(state);
  const proposing = planDebatePhase(round, "proposing");
  assert.equal(proposing.status, "complete");
  assert.equal(proposing.startedAt, 1000);
  assert.equal(proposing.completedAt, 1200);
  // A completed phase stops moving even though the clock kept going.
  assert.equal(planDebateElapsed(proposing, 9999), 200);
  // Completing one phase leaves its neighbours alone.
  assert.equal(planDebatePhase(round, "drafting").status, "pending");

  state = beginPhase(state, "drafting", 1200);
  state = completePhase(state, "drafting", 1400);
  state = beginPhase(state, "critiquing", 1400);
  state = completePhase(state, "critiquing", 1600);
  state = beginPhase(state, "integrating", 1600);
  state = completePhase(state, "integrating", 1700);
  state = beginPhase(state, "reviewing", 1700);
  round = currentPlanDebateRound(state);
  assert.deepEqual(
    round.phases.map((phase) => [phase.name, phase.status]),
    [
      ["proposing", "complete"],
      ["drafting", "complete"],
      ["critiquing", "complete"],
      ["integrating", "complete"],
      ["reviewing", "running"],
      ["handingoff", "pending"],
    ],
  );
});

test("a failed phase records why and does not silently read as complete", () => {
  let state = beginPhase(started(1000), "drafting", 1000);
  state = failPhase(state, "drafting", "all delegates exited", 1100);
  const drafting = planDebatePhase(currentPlanDebateRound(state), "drafting");
  assert.equal(drafting.status, "failed");
  assert.equal(drafting.error, "all delegates exited");
  assert.equal(drafting.completedAt, 1100);

  const stopped = stopPhase(state, "critiquing", 1200);
  const phase = planDebatePhase(currentPlanDebateRound(stopped), "critiquing");
  assert.equal(phase.status, "stopped");
  assert.equal(phase.completedAt, 1200);
});

test("one failed draft does not abort the round", () => {
  let state = beginPhase(started(1000), "drafting", 1000);
  state = withDrafts(state, ["running", "complete", "running"]);
  const partial = currentPlanDebateRound(state);
  // While any role is still drafting the phase is not over.
  assert.equal(draftingSettled(partial), "running");

  state = recordDraft(state, {
    role: "explorer",
    status: "failed",
    text: "",
    error: "delegate exited",
  });
  state = recordDraft(state, { role: "test-runner", status: "complete", text: "draft 2" });
  const round = currentPlanDebateRound(state);

  // Two of three came back, so the round carries on with what it has.
  assert.equal(draftingSettled(round), "complete");
  assert.deepEqual(readableDrafts(round).map((draft) => draft.role), [
    "code-reviewer",
    "test-runner",
  ]);
  assert.equal(round.drafts.find((draft) => draft.role === "explorer").status, "failed");
  // A re-recorded role replaces its entry instead of duplicating the row.
  assert.equal(round.drafts.length, 3);
});

test("a round whose every draft failed is a failed round, not a finished one", () => {
  let state = beginPhase(started(1000), "drafting", 1000);
  state = withDrafts(state, ["failed", "failed", "failed"]);
  assert.equal(draftingSettled(currentPlanDebateRound(state)), "failed");
  assert.deepEqual(readableDrafts(currentPlanDebateRound(state)), []);
});

test("a blank draft is not a readable document", () => {
  let state = beginPhase(started(1000), "drafting", 1000);
  state = recordDraft(state, { role: "explorer", status: "complete", text: "   " });
  assert.deepEqual(readableDrafts(currentPlanDebateRound(state)), []);
});

test("re-debate starts a new round and leaves the previous one untouched", () => {
  let state = started(1000, "Ship the work panel");
  state = beginPhase(state, "drafting", 1100);
  state = recordDraft(state, { role: "explorer", status: "complete", text: "old draft" });
  state = setMergedPlan(state, { text: "old merged plan", verdicts: [] });
  state = beginPhase(state, "reviewing", 1200);
  state = choosePlan(state, { kind: "merged", round: 1 });
  assert.equal(canHandoff(state), true);

  const firstRound = currentPlanDebateRound(state);
  // A deep copy taken before the re-debate, so any mutation would show up.
  const history = JSON.parse(JSON.stringify(firstRound));

  state = redebatePlan(state, { objection: "The migration order is wrong", now: 2000 });
  const second = currentPlanDebateRound(state);

  assert.equal(second.round, 2);
  assert.equal(second.redebate, true);
  // The objection becomes the constraint every role now drafts against.
  assert.equal(second.constraint, "The migration order is wrong");
  // The roster is the planner's, so a re-debate reuses it rather than inventing one.
  assert.deepEqual(second.roles, ROLES);
  assert.equal(second.phases.every((phase) => phase.status === "pending"), true);
  assert.deepEqual(second.drafts, []);
  assert.equal(second.merged, null);

  // Round 1 is exactly as it finished, and still the record a reader can open.
  assert.deepEqual(JSON.parse(JSON.stringify(state.rounds[0])), history);
  assert.equal(state.rounds.length, 2);
  // The choice belonged to round 1, so a new round cannot hand off a stale plan.
  assert.equal(state.selection, null);
  assert.equal(canHandoff(state), false);
});

test("a plan can only be chosen when the round produced it", () => {
  let state = beginPhase(started(1000), "drafting", 1000);
  state = recordDraft(state, { role: "explorer", status: "complete", text: "draft" });
  state = recordDraft(state, { role: "code-reviewer", status: "failed", text: "" });
  state = beginPhase(state, "reviewing", 1200);

  // A role that failed has no draft to pick.
  assert.equal(choosePlan(state, { kind: "draft", round: 1, role: "code-reviewer" }).selection, null);
  // A merged plan that was never produced cannot be picked either.
  assert.equal(choosePlan(state, { kind: "merged", round: 1 }).selection, null);
  // A round that does not exist is not a choice.
  assert.equal(choosePlan(state, { kind: "merged", round: 9 }).selection, null);

  const choseDraft = choosePlan(state, { kind: "draft", round: 1, role: "explorer" });
  assert.deepEqual(choseDraft.selection, { kind: "draft", round: 1, role: "explorer" });

  const merged = setMergedPlan(state, {
    text: "merged",
    verdicts: [{ item: "draft", verdict: "adopted", source: "explorer" }],
  });
  const choseMerged = choosePlan(merged, { kind: "merged", round: 1 });
  assert.deepEqual(choseMerged.selection, { kind: "merged", round: 1 });
  // A choice can be cleared, which is how the radio group goes blank.
  assert.equal(choosePlan(choseMerged, null).selection, null);
});

test("a user suggestion is a choice of its own, and an empty one is not", () => {
  let state = started(1000);
  state = beginPhase(state, "drafting", 1000);
  state = recordDraft(state, { role: "explorer", status: "complete", text: "draft" });

  // The user's own words need no generated artifact behind them.
  const chose = choosePlan(state, { kind: "suggestion", round: 1, text: "fix the migration order" });
  assert.deepEqual(chose.selection, { kind: "suggestion", round: 1, text: "fix the migration order" });
  // An empty suggestion has nothing to hand over.
  assert.equal(choosePlan(state, { kind: "suggestion", round: 1, text: "   " }).selection, null);
  assert.equal(choosePlan(state, { kind: "suggestion", round: 9, text: "x" }).selection, null);
});

test("handing off needs a chosen plan in a round that reached review", () => {
  let state = started(1000);
  state = recordDraft(state, { role: "explorer", status: "complete", text: "draft" });
  // Chosen but not reviewed: the user has not seen the result yet.
  state = choosePlan(state, { kind: "draft", round: 1, role: "explorer" });
  assert.equal(canHandoff(state), false);

  state = beginPhase(state, "reviewing", 1200);
  state = choosePlan(state, { kind: "draft", round: 1, role: "explorer" });
  assert.equal(canHandoff(state), true);

  // Without a choice there is nothing to hand over.
  assert.equal(canHandoff({ ...state, selection: null }), false);
  // A round that no longer exists (a pruned snapshot) cannot be handed off.
  assert.equal(canHandoff({ ...state, rounds: [] }), false);
});

test("a session snapshot round-trips, and a damaged one is dropped", () => {
  let state = beginPhase(started(1000), "drafting", 1100);
  state = recordDraft(state, { role: "explorer", status: "complete", text: "kept" });
  state = recordDraft(state, { role: "code-reviewer", status: "failed", text: "", error: "exit" });
  state = setMergedPlan(state, {
    text: "merged plan",
    verdicts: [{ item: "kept", verdict: "adopted", source: "explorer" }],
  });
  state = beginPhase(state, "reviewing", 1500);
  state = choosePlan(state, { kind: "merged", round: 1 });

  const restored = fromPlanDebateSnapshot(JSON.parse(JSON.stringify(toPlanDebateSnapshot(state))));
  assert.deepEqual(restored, state);

  // Unknown versions, missing rounds, and unknown phase names are not guessed at.
  assert.equal(fromPlanDebateSnapshot({ version: 99, state }), null);
  assert.equal(fromPlanDebateSnapshot({ version: 1, state: {} }), null);
  assert.equal(fromPlanDebateSnapshot({ version: 1, state: { rounds: "nope" } }), null);
  assert.equal(fromPlanDebateSnapshot("nope"), null);
  const corrupted = toPlanDebateSnapshot(state);
  corrupted.state.rounds[0].phases[0].status = "exploded";
  assert.equal(fromPlanDebateSnapshot(corrupted), null);
  // An unknown selection kind is dropped without losing the rounds.
  const badSelection = toPlanDebateSnapshot(state);
  badSelection.state.selection = { kind: "sorcery", round: 1 };
  assert.equal(fromPlanDebateSnapshot(badSelection).selection, null);
});
