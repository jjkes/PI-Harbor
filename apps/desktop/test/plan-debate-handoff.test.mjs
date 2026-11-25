import assert from "node:assert/strict";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

/*
 * Handing a chosen plan to team mode is the one irreversible step of a round.
 * The rule the panel's button obeys is a pure function, so this file tests that
 * function rather than a React tree: choosing a plan (a draft or the merge) is
 * what enables the handoff, the same round is handed over at most once, and a
 * round with nothing readable cannot be handed over at all.
 */

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
const apiCalls = [];
const apiMock = {
  planDebateHandoff: async (request) => {
    apiCalls.push(request);
    return { ok: true, turnId: `turn-${request.traceId}`, traceId: request.traceId };
  },
};
const handoff = load("../src/features/plan-debate/plan-debate-handoff.ts", {
  "./plan-debate-view": view,
  "../../lib/api.js": { api: apiMock },
});
const { planDebateView } = view;
const {
  planDebateHandoffPlan,
  planDebateHandoffText,
  buildPlanDebateHandoffRequest,
  executePlanDebateHandoff,
} = handoff;

const ROLES = [
  { name: "explorer", brief: "map the code that changes", seat: 1 },
  { name: "reviewer", brief: "find the risks the plan ignores", seat: 1 },
  { name: "builder", brief: "order the work", seat: 1 },
];

const MERGED_REPORT = [
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

function delegate({ delegationId, role, phase, status, report, seat = 1 }) {
  return toolRow(
    "Task",
    {
      delegationId,
      agent: role,
      status,
      startedAt: 1000,
      ...(status === "complete" ? { completedAt: 2000 } : {}),
      phase,
      debateRound: 1,
      debateRole: role,
      debateSeat: seat,
      ...(report === undefined ? {} : { debateReport: report }),
    },
    `task-${delegationId}`,
  );
}

/** One finished round: three drafts, their objections, and the merged plan. */
function finishedRound() {
  return planDebateView([
    toolRow(
      "PlanDebate",
      {
        planDebate: {
          round: 1,
          requirement: "Ship the plan debate end to end",
          roles: ROLES,
          phase: "proposing",
        },
      },
      "plan-debate-1",
    ),
    ...ROLES.map((role) =>
      delegate({
        delegationId: `draft-${role.name}`,
        role: role.name,
        phase: "draft",
        status: "complete",
        report: `## ${role.name} plan\nstep one`,
      }),
    ),
    ...ROLES.map((role) =>
      delegate({
        delegationId: `critique-${role.name}`,
        role: role.name,
        phase: "critique",
        status: "complete",
        report: `## ${role.name} objections`,
      }),
    ),
    delegate({
      delegationId: "integrate-explorer",
      role: "explorer",
      phase: "integrate",
      status: "complete",
      report: MERGED_REPORT,
    }),
  ]);
}

test("nothing chosen yet: the handoff has no plan to carry", () => {
  const plan = planDebateHandoffPlan(finishedRound(), null, null);
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "no-selection");
});

test("choosing a draft enables the handoff with that draft's text", () => {
  const round = finishedRound();
  const plan = planDebateHandoffPlan(
    round,
    { kind: "draft", round: 1, role: "reviewer" },
    null,
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.round, 1);
  assert.ok(plan.text.includes("## reviewer plan"));
  assert.ok(plan.text.includes("Ship the plan debate end to end"));
});

test("choosing the merged plan carries the verdicts with it", () => {
  const round = finishedRound();
  const plan = planDebateHandoffPlan(round, { kind: "merged", round: 1 }, null);
  assert.equal(plan.ok, true);
  assert.ok(plan.text.includes("1. Persist the round."));
  assert.ok(plan.text.includes("adopted store the plan in SQLite"));
  // The merged document is the plan, not the verdict block in front of it.
  assert.ok(!plan.text.includes("VERDICTS"));
});

test("choosing the user's own suggestion enables the handoff with their words", () => {
  const round = finishedRound();
  const plan = planDebateHandoffPlan(
    round,
    { kind: "suggestion", round: 1, text: "change the migration order" },
    null,
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.round, 1);
  assert.ok(plan.text.includes("change the migration order"));
  assert.ok(plan.text.includes("Ship the plan debate end to end"));
  // Once only, like every other choice.
  const second = planDebateHandoffPlan(round, plan.selection, { round: 1, at: 1234 });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already-handed-off");
});

test("a suggestion needs no generated plan behind it", () => {
  // A round that was only proposed: no draft, no merged plan — the user's
  // suggestion still hands over, because only the user ever chooses.
  const view = planDebateView([
    toolRow(
      "PlanDebate",
      {
        planDebate: {
          round: 1,
          requirement: "Ship it",
          roles: ROLES,
          phase: "proposing",
        },
      },
      "plan-debate-1",
    ),
  ]);
  const plan = planDebateHandoffPlan(view, { kind: "suggestion", round: 1, text: "my plan" }, null);
  assert.equal(plan.ok, true);
  assert.ok(plan.text.includes("my plan"));
});

test("one round is handed over once: the stored marker disables it", () => {
  const round = finishedRound();
  const selection = { kind: "merged", round: 1 };
  const first = planDebateHandoffPlan(round, selection, null);
  assert.equal(first.ok, true);
  // The record is what the panel reads back after the click, and after a reload.
  const second = planDebateHandoffPlan(round, selection, { round: 1, at: 1234 });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already-handed-off");
});

test("a marker for another round does not block this one", () => {
  const round = finishedRound();
  const plan = planDebateHandoffPlan(
    round,
    { kind: "draft", round: 1, role: "explorer" },
    { round: 2, at: 1234 },
  );
  assert.equal(plan.ok, true);
});

test("a draft a reader cannot open is not a plan", () => {
  const round = finishedRound();
  const failed = structuredClone(round);
  for (const draft of failed.rounds[0].drafts) {
    if (draft.role === "builder") {
      draft.status = "failed";
      draft.text = "";
    }
  }
  const plan = planDebateHandoffPlan(failed, { kind: "draft", round: 1, role: "builder" }, null);
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "no-plan");
});

test("a round the view does not know cannot be handed over", () => {
  const plan = planDebateHandoffPlan(finishedRound(), { kind: "merged", round: 7 }, null);
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "no-round");
});

test("a peer seat's draft is carried under its own seat handle", () => {
  const round = planDebateView([
    toolRow(
      "PlanDebate",
      {
        planDebate: {
          round: 1,
          requirement: "Ship it",
          roles: [
            { name: "frontend", brief: "the component tree", seat: 1 },
            { name: "frontend", brief: "bundle size", seat: 2 },
            { name: "backend", brief: "persistence", seat: 1 },
          ],
          phase: "proposing",
        },
      },
      "plan-debate-1",
    ),
    delegate({
      delegationId: "draft-frontend-1",
      role: "frontend",
      phase: "draft",
      status: "complete",
      report: "## first frontend plan",
    }),
    delegate({
      delegationId: "draft-frontend-2",
      role: "frontend",
      seat: 2,
      phase: "draft",
      status: "complete",
      report: "## second frontend plan",
    }),
  ]);
  const plan = planDebateHandoffPlan(round, { kind: "draft", round: 1, role: "frontend #2" }, null);
  assert.equal(plan.ok, true);
  assert.ok(plan.text.includes("## second frontend plan"));
});

test("the text names the round and the requirement it answers", () => {
  const round = finishedRound();
  const text = planDebateHandoffText(
    round.rounds[0],
    { kind: "merged", round: 1 },
  );
  assert.ok(text.startsWith("## Plan handed to team mode (round 1)"));
  assert.ok(text.includes("Requirement: Ship the plan debate end to end"));
});

test("the panel's button is the handoff plan, and the new path runs before the marker", () => {
  const tab = readFileSync(
    new URL("../src/components/workpanel/PlanDebateTab.tsx", import.meta.url),
    "utf8",
  );
  const hook = readFileSync(
    new URL("../src/features/plan-debate/usePlanDebateActions.ts", import.meta.url),
    "utf8",
  );
  // One gate for each button and the click: no second, stricter reading of the
  // round can grey the button out while a plan is on screen. Team mode is gated
  // by eligibility, single-agent by the session's prompt capability.
  assert.ok(tab.includes("disabled={!handoffPlan.ok || actions.busy || !teamEligible}"));
  assert.ok(tab.includes("disabled={!handoffPlan.ok || actions.busy || !singleAgentReady}"));
  assert.ok(!tab.includes("canHandoff("));
  // The old chain is gone: no team toggle, no session mode switch, no prompt.
  assert.ok(!tab.includes("teamService.setEnabled("));
  assert.ok(!tab.includes('mode: "agent"'));
  assert.ok(!tab.includes("await useAppStore.getState().sendPrompt"));
  assert.ok(!tab.includes("configureActiveSession"));
  // The new chain lives in the actions hook: build request, execute handoff, then record success.
  assert.ok(hook.includes("buildPlanDebateHandoffRequest("));
  assert.ok(hook.includes("executePlanDebateHandoff("));
  const execute = hook.indexOf("await executePlanDebateHandoff(");
  const marker = tab.indexOf("writePlanDebateHandoff(sessionId, { round, at })");
  assert.ok(execute > 0 && marker > execute);
  // No manual supplement splicing: the addendum travels inside the request.
  assert.ok(!tab.includes("supplement"));
  assert.ok(!tab.includes("Additional user suggestion"));
});

test("the panel renders a real start control, the user's suggestion, and per-plan choice", () => {
  const tab = readFileSync(
    new URL("../src/components/workpanel/PlanDebateTab.tsx", import.meta.url),
    "utf8",
  );
  const hook = readFileSync(
    new URL("../src/features/plan-debate/usePlanDebateActions.ts", import.meta.url),
    "utf8",
  );
  // The user-gated start: a real button, bound to the typed api call that
  // forwards to the session's runtime — never to the model.
  assert.ok(tab.includes("data-plan-debate-start={shownRound.round}"));
  assert.ok(hook.includes("api.planDebateStart({ sessionId, round })"));
  assert.ok(tab.includes('t("planning.startDebate")'));
  assert.ok(tab.includes("planDebateAwaitingStart(shownRound)"));
  // The user may write their own suggestion and choose it instead of a plan.
  assert.ok(tab.includes('t("planning.suggestionLabel")'));
  // The addition box is not a choice: its text only ever rides along with the
  // plan the user chose, so nothing turns it into the selection itself.
  assert.ok(tab.includes('t("planning.suggestionLabel")'));
  assert.ok(tab.includes('t("planning.suggestionPlaceholder")'));
  assert.ok(tab.includes('data-plan-debate-block="suggestion"'));
  assert.equal(tab.includes('data-plan-debate-choice="suggestion"'), false);
  assert.ok(tab.includes("data-plan-debate-choice={`draft:${handle}`}"));
  assert.ok(tab.includes('data-plan-debate-choice="merged"'));
  assert.ok(tab.includes('t("planning.selectDraft")'));
  assert.ok(tab.includes('t("planning.selectMerged")'));
  // Each seat's node opens its own delegation's transcript in a work-panel tab.
  assert.ok(tab.includes("data-plan-debate-node={node.delegationId}"));
  assert.ok(tab.includes("openSubagentTab(node.delegationId, node.role)"));
  assert.ok(tab.includes("data-plan-debate-open={node.delegationId}"));
  assert.ok(hook.includes('t("planning.errorStartDebate",'));
});

test("handoff request carries explicit sourceSessionId, round, and traceId", () => {
  const request = buildPlanDebateHandoffRequest(
    "session-A",
    "team",
    { round: 3, selection: { kind: "merged", round: 3 }, text: "plan text" },
  );
  assert.equal(request.sourceSessionId, "session-A");
  assert.equal(request.targetMode, "team");
  assert.equal(request.round, 3);
  assert.equal(request.selection.kind, "merged");
  assert.equal(request.selection.text, "plan text");
  assert.ok(typeof request.traceId === "string" && request.traceId.length > 0);
});

test("handoff request supports both team and single-agent targets", () => {
  const team = buildPlanDebateHandoffRequest("s-1", "team", {
    round: 1,
    selection: { kind: "merged", round: 1 },
    text: "t",
  });
  const single = buildPlanDebateHandoffRequest("s-1", "single-agent", {
    round: 1,
    selection: { kind: "merged", round: 1 },
    text: "t",
  });
  assert.equal(team.targetMode, "team");
  assert.equal(single.targetMode, "single-agent");
});

test("handoff request atomically carries selected text and user addendum", () => {
  const request = buildPlanDebateHandoffRequest(
    "s-1",
    "team",
    { round: 1, selection: { kind: "draft", round: 1, role: "builder" }, text: "selected proposal" },
    "addendum line",
  );
  assert.equal(request.selection.kind, "draft");
  assert.equal(request.selection.role, "builder");
  assert.equal(request.selection.text, "selected proposal");
  assert.equal(request.userAddendum, "addendum line");
});

test("empty addendum is omitted from the handoff request", () => {
  const request = buildPlanDebateHandoffRequest(
    "s-1",
    "team",
    { round: 1, selection: { kind: "suggestion", round: 1, text: "plan" }, text: "plan" },
    "  ",
  );
  assert.equal(request.userAddendum, undefined);
});

test("executePlanDebateHandoff routes through api.planDebateHandoff", async () => {
  apiCalls.length = 0;
  const request = buildPlanDebateHandoffRequest(
    "s-1",
    "team",
    { round: 1, selection: { kind: "merged", round: 1 }, text: "plan" },
    "",
    "trace-1",
  );
  const result = await executePlanDebateHandoff(request);
  assert.equal(result.ok, true);
  assert.equal(result.traceId, "trace-1");
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].sourceSessionId, "s-1");
  assert.equal(apiCalls[0].targetMode, "team");
});

test("handoff request never derives session from a mutable active session id", () => {
  // The old renderer chain read activeSessionId twice; the new request is
  // bound to the explicit sourceSessionId argument.
  const request = buildPlanDebateHandoffRequest(
    "explicit-session-id",
    "single-agent",
    { round: 1, selection: { kind: "merged", round: 1 }, text: "plan" },
  );
  assert.equal(request.sourceSessionId, "explicit-session-id");
  assert.ok(!("activeSessionId" in request));
});

test("draft/merged selection carries full proposal text and user addendum", () => {
  const request = buildPlanDebateHandoffRequest(
    "s-1",
    "team",
    { round: 1, selection: { kind: "draft", round: 1, role: "builder" }, text: "full selected proposal" },
    "addendum line",
  );
  assert.equal(request.selection.text, "full selected proposal");
  assert.equal(request.userAddendum, "addendum line");
});

test("suggestion-only selection omits addendum and uses its own text", () => {
  const request = buildPlanDebateHandoffRequest(
    "s-1",
    "single-agent",
    { round: 1, selection: { kind: "suggestion", round: 1, text: "my suggestion" }, text: "my suggestion" },
    "   ",
  );
  assert.equal(request.selection.kind, "suggestion");
  assert.equal(request.selection.text, "my suggestion");
  assert.equal(request.userAddendum, undefined);
});

test("PlanDebate actions capture source session id at click time", () => {
  const hook = readFileSync(
    new URL("../src/features/plan-debate/usePlanDebateActions.ts", import.meta.url),
    "utf8",
  );
  // The request is built with the session id captured before the await, so a
  // switch during the handoff cannot redirect the plan to a different session.
  assert.ok(hook.includes("const sourceSessionId = sessionId"));
  assert.ok(hook.includes("sourceSessionId,"));
});
