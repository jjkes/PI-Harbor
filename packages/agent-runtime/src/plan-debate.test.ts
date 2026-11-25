import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SubagentDefinition } from "@pi-harbor/shared";
import {
  PlanDebateArtifactWriter,
  debateRoleSlug,
  debateSeatFile,
  type PlanDebateArtifactSettlement,
} from "./plan-debate-artifacts.js";
import {
  PLAN_DEBATE_MAX_ROLES,
  PLAN_DEBATE_MIN_ROLES,
  planDebateIntentOf,
  planDebateLiveRoundResult,
  planDebateProposedResult,
  planDebateResolveIntegrator,
  planDebateRoundRequest,
  planDebateToolResult,
  planDebateUserOnlyResult,
  validatePlanDebateRoles,
} from "./plan-debate.js";

/*
 * The roster is the one thing a debate cannot recover from: a fabricated role
 * fails after the user waited, and a duplicate spelling silently shrinks a
 * debate the user believes is complete. The tool therefore rejects a bad roster
 * as text the model can correct, and never starts a delegate.
 */

function definition(name: string): SubagentDefinition {
  return {
    name,
    description: `${name} role`,
    tools: ["Read"],
    prompt: `You are ${name}.`,
    source: "project",
  } as unknown as SubagentDefinition;
}

const catalog = [
  definition("explorer"),
  definition("code-reviewer"),
  definition("test-runner"),
  definition("fixer"),
  definition("backend"),
  definition("frontend"),
];

function roster(names: string[]) {
  return { roles: names.map((name) => ({ name, brief: `${name} drafts` })) };
}

describe("PlanDebate roster validation", () => {
  it("accepts a roster whose every name is a real role", () => {
    const result = validatePlanDebateRoles(roster(["explorer", "code-reviewer", "fixer"]), catalog);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roles.map((role) => role.name)).toEqual(["explorer", "code-reviewer", "fixer"]);
    expect(result.roles[0].brief).toBe("explorer drafts");
  });

  it("keeps the upper bound of the roster", () => {
    expect(
      validatePlanDebateRoles(
        roster(["explorer", "code-reviewer", "test-runner", "fixer", "backend"]),
        catalog,
      ).ok,
    ).toBe(true);
    expect(PLAN_DEBATE_MAX_ROLES).toBe(5);
  });

  it("rejects fewer roles than a debate needs", () => {
    const result = validatePlanDebateRoles(roster(["explorer", "fixer"]), catalog);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(`at least ${PLAN_DEBATE_MIN_ROLES}`);
  });

  it("rejects more roles than a debate runs", () => {
    const result = validatePlanDebateRoles(
      roster(["explorer", "code-reviewer", "test-runner", "fixer", "backend", "frontend"]),
      catalog,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(`at most ${PLAN_DEBATE_MAX_ROLES}`);
  });

  it("rejects a role that is not in this session's catalog", () => {
    const result = validatePlanDebateRoles(
      roster(["explorer", "code-reviewer", "ghost-writer"]),
      catalog,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The message names the offending role and what it could have used, so the
    // model can correct itself in one more call.
    expect(result.message).toContain("ghost-writer");
    expect(result.message).toContain("not a subagent here");
    expect(result.message).toContain("explorer");
  });

  it("seats the same specialty twice when each seat has its own brief", () => {
    const result = validatePlanDebateRoles(
      {
        roles: [
          { name: "frontend", brief: "the component tree and its states" },
          { name: "frontend", brief: "bundle size and render cost" },
          { name: "backend", brief: "the persistence contract" },
        ],
      },
      catalog,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Seats, not names, identify a delegate: the peers are #1 and #2.
    expect(result.roles.map((role) => [role.name, role.seat])).toEqual([
      ["frontend", 1],
      ["frontend", 2],
      ["backend", 1],
    ]);
  });

  it("rejects a repeated seat whose brief is a copy, however it is spelled", () => {
    const result = validatePlanDebateRoles(
      {
        roles: [
          { name: "explorer", brief: "map the code that changes" },
          { name: "Explorer", brief: "Map  the CODE that changes" },
          { name: "fixer", brief: "implement the change" },
        ],
      },
      catalog,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("explorer #2");
    expect(result.message).toContain("own angle");
  });

  it("counts seats, not distinct handles, against the roster size", () => {
    const seat = (name: string, brief: string) => ({ name, brief });
    const result = validatePlanDebateRoles(
      {
        roles: [
          seat("frontend", "the component tree"),
          seat("frontend", "bundle size"),
          seat("backend", "the persistence contract"),
          seat("backend", "the RPC surface"),
          seat("explorer", "the call graph"),
          seat("fixer", "the migration order"),
        ],
      },
      catalog,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(`at most ${PLAN_DEBATE_MAX_ROLES}`);
  });

  it("normalizes a role name to the catalog handle", () => {
    const result = validatePlanDebateRoles(
      roster(["Explorer", "Code Reviewer", "test_runner"]),
      catalog,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roles.map((role) => role.name)).toEqual([
      "explorer",
      "code-reviewer",
      "test-runner",
    ]);
  });

  it("fills a blank brief from the catalog, and still rejects an empty proposal", () => {
    const blank = validatePlanDebateRoles(
      {
        roles: [
          { name: "explorer", brief: "drafts" },
          { name: "code-reviewer", brief: "  " },
          { name: "fixer", brief: "drafts" },
        ],
      },
      catalog,
    );
    // A blank brief is not a reason to fail the round: the catalog already
    // describes the role, so the seat keeps a readable brief.
    expect(blank.ok).toBe(true);
    if (!blank.ok) return;
    expect(blank.roles[1].brief).toBe("code-reviewer role");
    expect(validatePlanDebateRoles({}, catalog).ok).toBe(false);
    expect(validatePlanDebateRoles({ roles: [] }, catalog).ok).toBe(false);
    expect(validatePlanDebateRoles("nope", catalog).ok).toBe(false);
  });

describe("PlanDebate structured v2 brief", () => {
  it("accepts a role with mission instead of brief", () => {
    const result = validatePlanDebateRoles(
      {
        roles: [
          { name: "explorer", mission: "map the call graph" },
          { name: "code-reviewer", brief: "find the risk" },
          { name: "fixer", brief: "implement the change" },
        ],
      },
      catalog,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roles[0].brief).toBe("map the call graph");
    expect(result.roles[0].mission).toBe("map the call graph");
  });

  it("accepts structured fields and keeps them on the proposal", () => {
    const result = validatePlanDebateRoles(
      {
        roles: [
          {
            name: "explorer",
            mission: "map the tree",
            context_digest: "the repo uses pnpm workspaces",
            constraints: ["do not touch apps/desktop"],
            evidence_pack: ["package.json graph", "import graph"],
            done_criteria: ["lists all affected packages"],
            return_schema: "Markdown bullet list",
          },
          { name: "code-reviewer", brief: "find the risk" },
          { name: "fixer", brief: "implement the change" },
        ],
      },
      catalog,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roles[0]).toMatchObject({
      name: "explorer",
      brief: "map the tree",
      mission: "map the tree",
      context_digest: "the repo uses pnpm workspaces",
      constraints: ["do not touch apps/desktop"],
      evidence_pack: ["package.json graph", "import graph"],
      done_criteria: ["lists all affected packages"],
      return_schema: "Markdown bullet list",
    });
  });

  it("fills a missing brief from the catalog instead of failing the round", () => {
    // The schema calls `brief` required, but a provider may still omit it. The
    // catalog already describes the role, so the seat keeps a readable brief.
    const result = validatePlanDebateRoles(
      {
        roles: [
          { name: "explorer" },
          { name: "code-reviewer", brief: "find the risk" },
          { name: "fixer", brief: "implement the change" },
        ],
      },
      catalog,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roles[0].brief).toBe("explorer role");
  });

  it("rejects a role with no brief, no mission and no catalog description", () => {
    const bare = [
      { ...definition("explorer"), description: "" },
      definition("code-reviewer"),
      definition("fixer"),
    ];
    const result = validatePlanDebateRoles(
      {
        roles: [
          { name: "explorer" },
          { name: "code-reviewer", brief: "find the risk" },
          { name: "fixer", brief: "implement the change" },
        ],
      },
      bare,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("brief");
    expect(result.message).toContain("no description to fall back on");
  });

  it("detects duplicate structured angles, not just duplicate brief strings", () => {
    const result = validatePlanDebateRoles(
      {
        roles: [
          {
            name: "frontend",
            mission: "own the component tree",
            evidence_pack: ["component hierarchy"],
          },
          {
            name: "frontend",
            mission: "own the component tree",
            evidence_pack: ["component hierarchy"],
          },
          { name: "backend", brief: "own the persistence contract" },
        ],
      },
      catalog,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("frontend #2");
  });

  it("trims whitespace from structured array fields", () => {
    const result = validatePlanDebateRoles(
      {
        roles: [
          {
            name: "explorer",
            mission: "map the tree",
            constraints: ["  do not touch apps/desktop  ", "   ", ""],
            evidence_pack: ["  package.json graph  ", "import graph"],
          },
          { name: "code-reviewer", brief: "find the risk" },
          { name: "fixer", brief: "implement the change" },
        ],
      },
      catalog,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roles[0].constraints).toEqual(["do not touch apps/desktop"]);
    expect(result.roles[0].evidence_pack).toEqual(["package.json graph", "import graph"]);
  });

  it("allows the same role twice when evidence domains differ", () => {
    const result = validatePlanDebateRoles(
      {
        roles: [
          {
            name: "frontend",
            mission: "own the component tree",
            evidence_pack: ["component hierarchy"],
          },
          {
            name: "frontend",
            mission: "own bundle size",
            evidence_pack: ["bundle analyzer output"],
          },
          { name: "backend", brief: "own the persistence contract" },
        ],
      },
      catalog,
    );
    expect(result.ok).toBe(true);
  });
});

describe("planDebateResolveIntegrator", () => {
  const roles = [
    { name: "explorer", brief: "map", seat: 1 },
    { name: "code-reviewer", brief: "review", seat: 1 },
    { name: "code-reviewer", brief: "review second seat", seat: 2 },
  ] as const;

  it("falls back to the first role when no integrator is named", () => {
    expect(planDebateResolveIntegrator("", roles)).toEqual({ role: "explorer", seat: 1 });
    expect(planDebateResolveIntegrator("   ", roles)).toEqual({ role: "explorer", seat: 1 });
  });

  it("normalizes an un-normalized role name", () => {
    expect(planDebateResolveIntegrator("Code Reviewer", roles)).toEqual({
      role: "code-reviewer",
      seat: 1,
    });
    expect(planDebateResolveIntegrator("code_reviewer.md", roles)).toEqual({
      role: "code-reviewer",
      seat: 1,
    });
  });

  it("selects an explicit seat with the '#N' form", () => {
    expect(planDebateResolveIntegrator("code-reviewer #2", roles)).toEqual({
      role: "code-reviewer",
      seat: 2,
    });
  });

  it("falls back to the first role for an unknown name", () => {
    expect(planDebateResolveIntegrator("ghost", roles)).toEqual({ role: "explorer", seat: 1 });
  });
});
  it("returns the accepted roster to the renderer and starts nothing", () => {
    const accepted = planDebateToolResult(
      validatePlanDebateRoles(
        { ...roster(["explorer", "code-reviewer", "fixer"]), rationale: "risk and proof" },
        catalog,
      ),
    );
    expect(accepted.details.planDebate).toMatchObject({
      rationale: "risk and proof",
      roles: [
        { name: "explorer", brief: "explorer drafts" },
        { name: "code-reviewer", brief: "code-reviewer drafts" },
        { name: "fixer", brief: "fixer drafts" },
      ],
    });
    // Nothing started: no delegation ids, no status to converge on.
    expect(accepted.details).not.toHaveProperty("delegationId");
    expect(accepted.content[0].text).toContain("3 roles accepted");
    expect(accepted.content[0].text).toContain("Nothing has started");
  });

  it("proposes round N to the panel and starts nothing", () => {
    const roles = validatePlanDebateRoles(roster(["explorer", "code-reviewer", "fixer"]), catalog);
    if (!roles.ok) throw new Error("fixture roster must validate");
    const proposed = planDebateProposedResult({
      roles: roles.roles,
      round: 2,
      requirement: "Ship it",
      integratorRole: "explorer",
    });
    expect(proposed.details.planDebate).toMatchObject({
      round: 2,
      phase: "proposing",
      integratorRole: "explorer",
    });
    // Nothing started: no delegation ids, so there is no delegate to converge on.
    expect(proposed.details.planDebate).not.toHaveProperty("delegationIds");
    expect(proposed.content[0].text).toContain("round 2 proposed");
    expect(proposed.content[0].text).toContain("Waiting for the user's start");
  });

  it("reports a rejected roster as text the model can correct", () => {
    const rejected = planDebateToolResult(validatePlanDebateRoles(roster(["ghost"]), catalog));
    expect(rejected.details.planDebate).toBeNull();
    expect(typeof rejected.details.error).toBe("string");
    expect(rejected.content[0].text).toContain("rejected");
  });
  it("answers a second PlanDebate with the round that already exists", () => {
    const roles = validatePlanDebateRoles(
      roster(["explorer", "code-reviewer", "fixer"]),
      catalog,
    );
    if (!roles.ok) throw new Error("fixture roster must validate");
    // A live round refuses the new roster and names itself: the panel derives
    // rows per round, so the refusal carries the round the delegates belong to
    // rather than a second, empty one.
    const refused = planDebateLiveRoundResult({
      round: 1,
      requirement: "Ship it",
      roles: roles.roles,
      stage: "draft",
      summary: "round 1 (draft)",
    });
    expect(refused.details.error).toBe("debate running: round 1 (draft)");
    expect(refused.details.planDebate).toMatchObject({
      round: 1,
      requirement: "Ship it",
      stage: "draft",
      alreadyRunning: true,
    });
    // The payload is still a proposal-shaped row for *that* round, so the view
    // groups it with the running delegates instead of inventing round 2.
    const proposal = refused.details.planDebate as Record<string, unknown>;
    expect(proposal.round).toBe(1);
    expect(proposal.requirement).toBe("Ship it");
    expect(Array.isArray(proposal.roles)).toBe(true);
    // The text tells the model not to number the next round itself.
    expect(refused.content[0]?.text).toContain("already debating round 1 (draft)");
    expect(refused.content[0]?.text).toContain("do not number a new round");
    expect(refused.content[0]?.text).toContain("answered by round 1");
  });

  it("tells the model the panel is where a proposed round is started", () => {
    const roles = validatePlanDebateRoles(roster(["explorer", "code-reviewer", "fixer"]), catalog);
    if (!roles.ok) throw new Error("fixture roster must validate");
    const refused = planDebateLiveRoundResult({
      round: 3,
      requirement: "Ship it",
      roles: roles.roles,
      stage: "proposing",
      summary: "round 3 (proposing)",
    });
    expect(refused.content[0]?.text).toContain("Round 3 is proposed and waiting for the user");
    expect(refused.content[0]?.text).toContain("debate panel");
    expect(refused.details.planDebate).toMatchObject({ round: 3, stage: "proposing" });
  });
});

/*
 * Opening a round is the user's gesture. `intent: "start"` is the only thing
 * that carries it, and a call without it opens nothing — it answers with the
 * round that already exists, or says which control opens the first one.
 */
describe("PlanDebate only opens a round the user asked for", () => {
  it("reads the intent only from the renderer's own discriminator", () => {
    expect(planDebateIntentOf({ roles: [] })).toBeNull();
    expect(planDebateIntentOf({ intent: "continue" })).toBeNull();
    expect(planDebateIntentOf({ intent: true })).toBeNull();
    expect(planDebateIntentOf("nope")).toBeNull();
    expect(planDebateRoundRequest({ roles: [] }).intent).toBeNull();
    expect(planDebateIntentOf({ intent: "start" })).toBe("start");
    expect(planDebateRoundRequest({ intent: "start", requirement: "Ship" }).intent).toBe("start");
  });

  it("answers a model-initiated call with the controls that open a debate", () => {
    const guided = planDebateUserOnlyResult({ round: null });
    expect(guided.details.planDebate).toBeNull();
    expect(guided.details.intentRequired).toBe(true);
    expect(guided.content[0]?.text).toContain("only the user starts one");
    expect(guided.content[0]?.text).toContain("发起辩论");
    expect(guided.content[0]?.text).toContain("开始辩论");
  });

  it("answers a model-initiated call with the round that already exists", () => {
    const roles = validatePlanDebateRoles(roster(["explorer", "code-reviewer", "fixer"]), catalog);
    if (!roles.ok) throw new Error("fixture roster must validate");
    const live = planDebateUserOnlyResult({
      round: { round: 2, requirement: "Ship it", roles: roles.roles, stage: "draft" },
    });
    // The answer names round 2, so the panel groups it with the running round.
    expect(live.details.planDebate).toMatchObject({
      round: 2,
      requirement: "Ship it",
      stage: "draft",
      alreadyRunning: true,
    });
    expect(live.content[0]?.text).toContain("already debating round 2 (draft)");
    expect(live.content[0]?.text).toContain("answered by round 2");
    // A finished round is not live, and still is not re-numbered by the model.
    const finished = planDebateUserOnlyResult({
      round: { round: 2, requirement: "Ship it", roles: roles.roles, stage: "done" },
    });
    expect(finished.details.planDebate).toMatchObject({ round: 2, alreadyRunning: false });
    expect(finished.content[0]?.text).toContain("already finished (done)");
    expect(finished.content[0]?.text).toContain("重新辩论");
  });
});

/*
 * A round also lives on disk.
 *
 * The transcript is a window — one debate is about fifteen rows — so the panel
 * cannot read a round back from it after the drafts have fallen out, and a
 * reload has nothing at all. Every settled seat is therefore written into the
 * project: one Markdown file per seat, one index per round. These tests hold
 * the two rules that make that safe: a role handle never becomes a path, and a
 * disk that refuses the write never costs a settlement.
 */
describe("plan debate artifacts", () => {
  function draft(overrides: Partial<PlanDebateArtifactSettlement> = {}): PlanDebateArtifactSettlement {
    return {
      round: 1,
      requirement: "Ship the debate artifacts",
      phase: "draft",
      role: "explorer",
      seat: 1,
      outcome: "complete",
      delegationId: "delegation-1",
      report: "## Draft\n\nRead the round from disk.",
      startedAt: 1_000,
      completedAt: 4_000,
      ...overrides,
    };
  }

  async function project(): Promise<string> {
    return mkdtemp(join(tmpdir(), "pi-debate-artifacts-"));
  }

  function roundDir(root: string): string {
    return join(root, ".pi-harbor", "debate", "round-1");
  }

  it("writes the report beside an index that names it", async () => {
    const root = await project();
    try {
      const writer = new PlanDebateArtifactWriter(root);
      await writer.record(draft());

      const directory = roundDir(root);
      expect(await readFile(join(directory, "draft-explorer.md"), "utf8")).toContain(
        "Read the round from disk.",
      );
      const index = JSON.parse(await readFile(join(directory, "round-1.json"), "utf8"));
      expect(index).toMatchObject({
        version: 2,
        round: 1,
        requirement: "Ship the debate artifacts",
        startedAt: 1_000,
      });
      expect(index.seats).toEqual([
        {
          phase: "draft",
          role: "explorer",
          seat: 1,
          status: "complete",
          delegationId: "delegation-1",
          startedAt: 1_000,
          completedAt: 4_000,
          reportFile: "draft-explorer.md",
        },
      ]);
      // The round is not finished by a draft, so it carries no end stamp.
      expect(index.completedAt).toBeUndefined();
      expect(index.mergedFile).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes a further seat into the same index without losing the first", async () => {
    const root = await project();
    try {
      const writer = new PlanDebateArtifactWriter(root);
      await writer.record(draft());
      await writer.record(
        draft({ role: "code-reviewer", seat: 2, delegationId: "delegation-2", report: "Second." }),
      );
      const index = JSON.parse(await readFile(join(roundDir(root), "round-1.json"), "utf8"));
      expect(index.seats.map((seat: { reportFile: string }) => seat.reportFile)).toEqual([
        "draft-explorer.md",
        "draft-code-reviewer-2.md",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes merged.md for the integrator's settlement", async () => {
    const root = await project();
    try {
      const writer = new PlanDebateArtifactWriter(root);
      await writer.record(
        draft({
          phase: "integrate",
          role: "explorer",
          outcome: "complete",
          report: "VERDICTS\n- adopted | read from disk | explorer\nPLAN\n# merged plan",
        }),
      );
      const directory = roundDir(root);
      expect(await readFile(join(directory, "merged.md"), "utf8")).toContain("# merged plan");
      const index = JSON.parse(await readFile(join(directory, "round-1.json"), "utf8"));
      expect(index.mergedFile).toBe("merged.md");
      expect(index.seats[0]).toMatchObject({
        phase: "integrate",
        status: "complete",
        reportFile: "integrate-explorer.md",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives a plain file name from a handle that is a path or not ASCII", async () => {
    const root = await project();
    try {
      const writer = new PlanDebateArtifactWriter(root);
      // A handle keeps what ASCII it has; a traversal keeps only its tail.
      expect(debateRoleSlug("ui-架构")).toBe("ui");
      expect(debateRoleSlug("../../escape")).toBe("escape");
      expect(debateRoleSlug("a/b")).toBe("a-b");
      // A handle with nothing ASCII left has no stem of its own: the seat number
      // names the file and the index keeps the role the user recognises.
      expect(debateRoleSlug("架构")).toBe("");
      expect(debateSeatFile("draft", "../../escape", 1)).toBe("draft-escape.md");
      expect(debateSeatFile("critique", "ui-架构", 3)).toBe("critique-ui-3.md");
      expect(debateSeatFile("draft", "架构", 1)).toBe("draft-seat1.md");
      expect(debateSeatFile("critique", "架构", 2)).toBe("critique-seat2.md");

      await writer.record(draft({ role: "../../escape", report: "escaped name" }));
      await writer.record(draft({ role: "架构", report: "no ascii at all", delegationId: "d2" }));

      const directory = roundDir(root);
      const files = await readdir(directory);
      // Every file is a plain name in the round's own directory.
      expect(files.sort()).toEqual(["draft-escape.md", "draft-seat1.md", "round-1.json"].sort());
      expect(await readFile(join(directory, "draft-escape.md"), "utf8")).toContain("escaped name");
      expect(await readFile(join(directory, "draft-seat1.md"), "utf8")).toContain(
        "no ascii at all",
      );
      // Nothing was written beside the project, which is what `../../` would do.
      expect(await readdir(root)).toEqual([".pi-harbor"]);
      const index = JSON.parse(await readFile(join(directory, "round-1.json"), "utf8"));
      expect(index.seats.map((seat: { reportFile: string }) => seat.reportFile)).toEqual([
        "draft-escape.md",
        "draft-seat1.md",
      ]);
      // The CJK role round-trips: the file name is a plain name, and the index
      // still holds the handle the panel draws.
      expect(index.seats.map((seat: { role: string }) => seat.role)).toEqual([
        "../../escape",
        "架构",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records the roster at start and each settled seat's own span", async () => {
    const root = await project();
    try {
      const writer = new PlanDebateArtifactWriter(root);
      await writer.recordRoster({
        round: 1,
        requirement: "Ship the debate artifacts",
        roles: [
          { name: "explorer", brief: "own the map", seat: 1 },
          { name: "架构", brief: "own the shape", seat: 1 },
        ],
      });
      // The roster is durable before any delegate has answered, which is what a
      // reload reads the proposal's briefs back from.
      const first = JSON.parse(await readFile(join(roundDir(root), "round-1.json"), "utf8"));
      expect(first.roles).toEqual([
        { name: "explorer", brief: "own the map", seat: 1 },
        { name: "架构", brief: "own the shape", seat: 1 },
      ]);
      expect(first.seats).toEqual([]);
      expect(typeof first.startedAt).toBe("number");

      await writer.record(draft({ startedAt: 1_000, completedAt: 4_000 }));
      await writer.record(
        draft({ role: "架构", delegationId: "d2", startedAt: 2_000, completedAt: 6_500 }),
      );

      const index = JSON.parse(await readFile(join(roundDir(root), "round-1.json"), "utf8"));
      // Every seat carries the span it ran for; the panel draws its duration.
      expect(
        index.seats.map((seat: { role: string; startedAt: number; completedAt: number }) => [
          seat.role,
          seat.startedAt,
          seat.completedAt,
        ]),
      ).toEqual([
        ["explorer", 1_000, 4_000],
        ["架构", 2_000, 6_500],
      ]);
      // A settlement never rewrites the roster it came from.
      expect(index.roles.map((role: { name: string }) => role.name)).toEqual(["explorer", "架构"]);

      // A seat that reports no clock is written without one: the panel must be
      // able to tell "unknown" from "zero seconds".
      await writer.record(
        draft({
          phase: "critique",
          delegationId: "d3",
          report: "no clocks here",
          startedAt: undefined,
          completedAt: undefined,
        }),
      );
      const withoutClocks = JSON.parse(
        await readFile(join(roundDir(root), "round-1.json"), "utf8"),
      );
      const timestampless = withoutClocks.seats.find(
        (seat: { delegationId: string }) => seat.delegationId === "d3",
      );
      expect("startedAt" in timestampless).toBe(false);
      expect("completedAt" in timestampless).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps stoppedAt and the roster requirement when a stopped seat settles late", async () => {
    const root = await project();
    try {
      const writer = new PlanDebateArtifactWriter(root);
      await writer.recordRoster({
        round: 1,
        requirement: "Ship the debate artifacts",
        roles: [{ name: "explorer", brief: "own the map", seat: 1 }],
      });
      await writer.recordStopped(1, 9_000);
      await writer.record(
        draft({
          requirement: "",
          outcome: "stopped",
          report: "",
          completedAt: 10_000,
        }),
      );

      const index = JSON.parse(await readFile(join(roundDir(root), "round-1.json"), "utf8"));
      expect(index.requirement).toBe("Ship the debate artifacts");
      expect(index.stoppedAt).toBe(9_000);
      // A late seat has its own completion clock; it must not turn a user stop
      // into the round's successful/normal completion timestamp.
      expect(index.completedAt).toBeUndefined();
      expect(index.seats).toHaveLength(1);
      expect(index.seats[0]).toMatchObject({
        role: "explorer",
        status: "stopped",
        completedAt: 10_000,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tells two roles that collapse to one slug apart instead of overwriting", async () => {
    const root = await project();
    try {
      const writer = new PlanDebateArtifactWriter(root);
      await writer.record(draft({ role: "a/b", report: "first role" }));
      await writer.record(draft({ role: "a b", report: "second role", delegationId: "d2" }));
      const index = JSON.parse(await readFile(join(roundDir(root), "round-1.json"), "utf8"));
      const [first, second] = index.seats.map((seat: { reportFile: string }) => seat.reportFile);
      expect(first).toBe("draft-a-b.md");
      expect(second).toMatch(/^draft-a-b-[0-9a-f]{8}\.md$/);
      // Both reports are readable: neither seat overwrote the other's file.
      expect(await readFile(join(roundDir(root), first), "utf8")).toContain("first role");
      expect(await readFile(join(roundDir(root), second), "utf8")).toContain("second role");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs once and resolves when the project refuses the write", async () => {
    const root = await project();
    try {
      // A file where the artifact root should be: every mkdir under it is ENOTDIR.
      await writeFile(join(root, ".pi-harbor"), "not a directory");
      const logs: string[] = [];
      const writer = new PlanDebateArtifactWriter(root, (line) => logs.push(line));
      await expect(writer.record(draft())).resolves.toBeUndefined();
      await expect(
        writer.record(draft({ role: "code-reviewer", report: "still a settlement" })),
      ).resolves.toBeUndefined();
      // One broken project is one log line, not one per seat.
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("plan debate artifacts not written");
      expect(logs[0]).toContain("the round continues");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a settlement that names no delegation", async () => {
    const root = await project();
    try {
      const writer = new PlanDebateArtifactWriter(root, () => undefined);
      await expect(writer.record(draft({ delegationId: "" }))).resolves.toBeUndefined();
      await expect(readdir(root)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
