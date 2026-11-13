import { describe, expect, it } from "vitest";
import {
  advancePlanDebate,
  createPlanDebateRun,
  planDebateBrief,
  planDebateLabel,
  planDebateMarkStarted,
  planDebatePendingStarts,
  planDebateRecordSettlement,
  startPlanDebate,
  type PlanDebateRun,
} from "./plan-debate-driver.js";
import type { PlanDebateRoleProposal } from "./plan-debate.js";

/*
 * The driver is the only thing that moves a debate forward. These tests hold the
 * four properties the pipeline cannot lose: the phase order, a failed role not
 * aborting the round, no phase ever enqueued twice, and an all-failed round
 * ending in a typed failure instead of a silent nothing.
 */

const ROLES: PlanDebateRoleProposal[] = [
  { name: "explorer", brief: "map the tree", seat: 1 },
  { name: "code-reviewer", brief: "find the risk", seat: 1 },
  { name: "test-runner", brief: "prove it", seat: 1 },
];

function run(overrides: Partial<Parameters<typeof createPlanDebateRun>[0]> = {}) {
  // The user's start is what opens a round; these tests exercise open rounds.
  return startPlanDebate(
    createPlanDebateRun({
      round: 1,
      requirement: "Ship the plan debate end to end",
      roles: ROLES,
      ...overrides,
    }),
  );
}

/** Start every seat a phase wants, the way the runtime does before awaiting. */
function startAll(run: PlanDebateRun): { run: PlanDebateRun; starts: string[] } {
  let next = run;
  const starts: string[] = [];
  for (const start of planDebatePendingStarts(next)) {
    next = planDebateMarkStarted(next, start);
    starts.push(`${start.phase}:${start.role}`);
  }
  return { run: next, starts };
}

/** Settle every started seat of the current phase with the given reports. */
function settlePhase(
  run: PlanDebateRun,
  phase: "draft" | "critique" | "integrate",
  reports: Record<string, { outcome?: "complete" | "failed" | "stopped"; report?: string; error?: string }>,
): PlanDebateRun {
  let next = run;
  for (const [role, answer] of Object.entries(reports)) {
    next = planDebateRecordSettlement(next, {
      phase,
      role,
      outcome: answer.outcome ?? "complete",
      report: answer.report ?? `${role} answer`,
      ...(answer.error ? { error: answer.error } : {}),
    });
  }
  return next;
}

const ALL_DRAFTS = {
  explorer: { report: "draft from explorer" },
  "code-reviewer": { report: "draft from code-reviewer" },
  "test-runner": { report: "draft from test-runner" },
};

describe("plan debate driver phase order", () => {
  it("runs draft, then critique, then integrate, and starts nothing before it should", () => {
    const created = run();
    expect(created.stage).toBe("draft");

    const drafted = startAll(created);
    expect(drafted.starts).toEqual([
      "draft:explorer",
      "draft:code-reviewer",
      "draft:test-runner",
    ]);
    // Nothing but drafts is pending while drafting.
    expect(planDebatePendingStarts(drafted.run)).toEqual([]);

    const afterDrafts = settlePhase(drafted.run, "draft", ALL_DRAFTS);
    expect(afterDrafts.stage).toBe("critique");
    const critiqued = startAll(afterDrafts);
    expect(critiqued.starts).toEqual([
      "critique:explorer",
      "critique:code-reviewer",
      "critique:test-runner",
    ]);

    const afterCritiques = settlePhase(critiqued.run, "critique", {
      explorer: { report: "no objection to explorer" },
      "code-reviewer": { report: "explorer ignores the rollback path" },
      "test-runner": { report: "no runnable check for the timeline" },
    });
    expect(afterCritiques.stage).toBe("integrate");
    // One integrator, and it is the round's own seat rather than a new pipeline.
    const integrating = startAll(afterCritiques);
    expect(integrating.starts).toEqual(["integrate:explorer"]);

    const done = planDebateRecordSettlement(integrating.run, {
      phase: "integrate",
      role: "explorer",
      outcome: "complete",
      report: "VERDICTS\n- adopted | drafts | explorer\nPLAN\n# merged",
    });
    expect(done.stage).toBe("done");
    expect(done.failure).toBeNull();
    expect(planDebatePendingStarts(done)).toEqual([]);
  });

  it("waits for every draft before it starts a critique", () => {
    const drafted = startAll(run());
    const partial = settlePhase(drafted.run, "draft", {
      explorer: { report: "draft from explorer" },
    });
    expect(partial.stage).toBe("draft");
    expect(planDebatePendingStarts(partial)).toEqual([]);
    // A settlement that changes nothing keeps the stage where it was.
    expect(advancePlanDebate(partial)).toEqual(partial);
  });
});

describe("a failed draft is reported, not fatal", () => {
  it("carries the round to critiquing and tells every critic what failed", () => {
    const drafted = startAll(run());
    const afterDrafts = settlePhase(drafted.run, "draft", {
      explorer: { outcome: "failed", report: "", error: "delegate exited without a report" },
      "code-reviewer": { report: "draft from code-reviewer" },
      "test-runner": { report: "draft from test-runner" },
    });

    expect(afterDrafts.stage).toBe("critique");
    expect(afterDrafts.failure).toBeNull();
    expect(afterDrafts.drafts.explorer).toMatchObject({
      outcome: "failed",
      error: "delegate exited without a report",
    });

    // Every critic is told which draft is missing, in the brief it receives.
    const brief = planDebateBrief(afterDrafts, { phase: "critique", role: "test-runner" });
    expect(brief).toContain("### explorer — no usable draft");
    expect(brief).toContain("delegate exited without a report");
    // The drafts that did come back are in the same brief.
    expect(brief).toContain("draft from code-reviewer");
    expect(brief).toContain("Ship the plan debate end to end");
  });

  it("still integrates when every critic failed", () => {
    const drafted = startAll(run());
    const afterDrafts = settlePhase(drafted.run, "draft", ALL_DRAFTS);
    const critiqued = startAll(afterDrafts);
    const afterCritiques = settlePhase(critiqued.run, "critique", {
      explorer: { outcome: "failed", report: "", error: "no output" },
      "code-reviewer": { outcome: "failed", report: "", error: "no output" },
      "test-runner": { outcome: "failed", report: "", error: "no output" },
    });
    expect(afterCritiques.stage).toBe("integrate");
    const brief = planDebateBrief(afterCritiques, { phase: "integrate", role: "explorer" });
    expect(brief).toContain("### explorer — no usable objections");
    expect(brief).toContain("VERDICTS");
    expect(brief).toContain("draft from explorer");
  });
});

describe("no phase is ever enqueued twice", () => {
  it("does not ask for a draft again once one settled", () => {
    const drafted = startAll(run());
    const once = settlePhase(drafted.run, "draft", { explorer: { report: "draft" } });
    // The settled seat is not re-offered, and the seats still running are not
    // re-offered either: they are already reserved.
    expect(planDebatePendingStarts(once)).toEqual([]);
    expect(once.started).toEqual([
      "draft:explorer",
      "draft:code-reviewer",
      "draft:test-runner",
    ]);
  });

  it("records a repeated settlement without adding a start or a seat", () => {
    const drafted = startAll(run());
    const settled = settlePhase(drafted.run, "draft", ALL_DRAFTS);
    const repeated = planDebateRecordSettlement(settled, {
      phase: "draft",
      role: "explorer",
      outcome: "complete",
      report: "draft from explorer",
    });
    // A late duplicate can only rewrite the seat it names; the round advanced
    // once and asks for critiques, never for another round of drafts.
    expect(repeated.stage).toBe("critique");
    expect(planDebatePendingStarts(repeated).map((start) => start.phase)).toEqual([
      "critique",
      "critique",
      "critique",
    ]);
    expect(repeated.started.filter((key) => key.startsWith("draft:"))).toHaveLength(3);
  });

  it("never starts a seat from a finished round", () => {
    const afterDrafts = settlePhase(startAll(run()).run, "draft", ALL_DRAFTS);
    const afterCritiques = settlePhase(
      startAll(afterDrafts).run,
      "critique",
      {
        explorer: { report: "ok" },
        "code-reviewer": { report: "ok" },
        "test-runner": { report: "ok" },
      },
    );
    const integrating = startAll(afterCritiques);
    const done = planDebateRecordSettlement(integrating.run, {
      phase: "integrate",
      role: "explorer",
      outcome: "complete",
      report: "PLAN\n# merged",
    });
    expect(done.stage).toBe("done");
    // A draft that reports after its phase closed cannot reopen it.
    const late = planDebateRecordSettlement(done, {
      phase: "draft",
      role: "explorer",
      outcome: "complete",
      report: "late draft",
    });
    expect(late.stage).toBe("done");
    expect(planDebatePendingStarts(done)).toEqual([]);
    expect(advancePlanDebate(done)).toBe(done);
  });
});

describe("an all-failed round ends in a typed failure", () => {
  it("fails with NO_DRAFTS and starts nothing more", () => {
    const drafted = startAll(run());
    const failed = settlePhase(drafted.run, "draft", {
      explorer: { outcome: "failed", report: "", error: "delegate exited" },
      "code-reviewer": { outcome: "failed", report: "" },
      "test-runner": { outcome: "stopped", report: "" },
    });

    expect(failed.stage).toBe("failed");
    expect(failed.failure?.code).toBe("NO_DRAFTS");
    expect(failed.failure?.message).toContain("round 1");
    expect(failed.failure?.message).toContain("explorer — delegate exited");
    expect(failed.failure?.message).toContain("Re-run PlanDebate");
    expect(planDebatePendingStarts(failed)).toEqual([]);
    // A typed failure is terminal: further settlements cannot revive the round.
    expect(advancePlanDebate(failed)).toBe(failed);
    expect(
      planDebateRecordSettlement(failed, {
        phase: "critique",
        role: "explorer",
        outcome: "complete",
        report: "late critique",
      }).stage,
    ).toBe("failed");
  });

  it("fails with NO_MERGED_PLAN when the integrator returns nothing", () => {
    const drafted = startAll(run());
    const afterDrafts = settlePhase(drafted.run, "draft", ALL_DRAFTS);
    const afterCritiques = settlePhase(startAll(afterDrafts).run, "critique", {
      explorer: { report: "ok" },
      "code-reviewer": { report: "ok" },
      "test-runner": { report: "ok" },
    });
    const failed = planDebateRecordSettlement(startAll(afterCritiques).run, {
      phase: "integrate",
      role: "explorer",
      outcome: "failed",
      report: "",
      error: "no merged plan produced",
    });
    expect(failed.stage).toBe("failed");
    expect(failed.failure?.code).toBe("NO_MERGED_PLAN");
    expect(failed.failure?.message).toContain("no merged plan produced");
  });
});

describe("briefs and labels", () => {
  it("gives a draft its role brief and the round's requirement", () => {
    const brief = planDebateBrief(run({ objection: "the migration order is wrong" }), {
      phase: "draft",
      role: "code-reviewer",
    });
    expect(brief).toContain("find the risk");
    expect(brief).toContain("Ship the plan debate end to end");
    expect(brief).toContain("the migration order is wrong");
    expect(brief).toContain("draft plan");
  });

  it("labels the topology row by phase and seat", () => {
    expect(planDebateLabel({ phase: "draft", role: "explorer" })).toBe("Draft · explorer");
    expect(planDebateLabel({ phase: "critique", role: "explorer" })).toBe("Critique · explorer");
    expect(planDebateLabel({ phase: "integrate", role: "explorer" })).toBe("Merge · explorer");
  });
});

describe("peer seats of one specialty", () => {
  const PEERS: PlanDebateRoleProposal[] = [
    { name: "frontend", brief: "the component tree", seat: 1 },
    { name: "frontend", brief: "bundle size", seat: 2 },
    { name: "backend", brief: "the persistence contract", seat: 1 },
  ];

  it("drafts once per seat and keys the peers' documents apart", () => {
    let next = startPlanDebate(
      createPlanDebateRun({ round: 1, requirement: "Ship it", roles: PEERS }),
    );
    const starts = planDebatePendingStarts(next);
    expect(starts.map((start) => [start.role, start.seat])).toEqual([
      ["frontend", 1],
      ["frontend", 2],
      ["backend", 1],
    ]);
    for (const start of starts) {
      next = planDebateMarkStarted(next, start);
      next = planDebateRecordSettlement(next, {
        phase: "draft",
        role: start.role,
        ...(start.seat === undefined ? {} : { seat: start.seat }),
        outcome: "complete",
        report: `${start.role} seat ${start.seat} draft`,
      });
    }
    // One document per seat: the second frontend seat did not overwrite the first.
    expect(Object.keys(next.drafts).sort()).toEqual(["backend", "frontend", "frontend #2"]);
    expect(next.stage).toBe("critique");
    // And the round cannot close until every seat has answered, peers included.
    expect(planDebatePendingStarts(next).map((start) => [start.role, start.seat])).toEqual([
      ["frontend", 1],
      ["frontend", 2],
      ["backend", 1],
    ]);
  });

  it("labels a peer seat with its number and gives it its own brief", () => {
    const run = createPlanDebateRun({ round: 1, requirement: "Ship it", roles: PEERS });
    expect(planDebateLabel({ phase: "draft", role: "frontend", seat: 2 })).toBe(
      "Draft · frontend #2",
    );
    expect(planDebateBrief(run, { phase: "draft", role: "frontend", seat: 2 })).toContain(
      "bundle size",
    );
    expect(planDebateBrief(run, { phase: "draft", role: "frontend", seat: 1 })).toContain(
      "the component tree",
    );
  });
});

describe("the proposal gate", () => {
  it("stays proposing until the user starts, and starts nothing before it", () => {
    const proposed = createPlanDebateRun({ round: 1, requirement: "Ship it", roles: ROLES });
    expect(proposed.stage).toBe("proposing");
    // No start is pending and no settlement can move the round.
    expect(planDebatePendingStarts(proposed)).toEqual([]);
    expect(advancePlanDebate(proposed)).toBe(proposed);
    expect(startPlanDebate(proposed).stage).toBe("draft");
    expect(planDebatePendingStarts(startPlanDebate(proposed))).toHaveLength(3);
  });

  it("is idempotent: starting a started round returns it unchanged", () => {
    const opened = run();
    expect(startPlanDebate(opened)).toBe(opened);
    expect(planDebatePendingStarts(opened)).toHaveLength(3);
  });
});
