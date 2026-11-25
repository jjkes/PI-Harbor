import { describe, expect, it } from "vitest";
import {
  createPlanDebateRun,
  parsePlanDebateSynthesis,
  planDebateBrief,
  startPlanDebate,
  type PlanDebateRun,
} from "./plan-debate-driver.js";
import type { PlanDebateRoleProposal } from "./plan-debate.js";

/**
 * PlanDebate prompt smoke test (model-free).
 *
 * This file does not call paid models. It verifies that the prompts generated
 * for structured and legacy briefs contain the expected section headings, that
 * a deterministic mock following those headings can be parsed, and that the
 * parser ignores headings inside fenced report blocks and body text.
 *
 * Any scores logged here measure instruction compliance of the mock model, not
 * real model capability or product quality. They are for manual inspection only
 * and must not be reported as evidence of quality improvement.
 */

export type EvalCase = {
  id: string;
  requirement: string;
  /** Evidence domains the final plan should cover. */
  expectedEvidence: string[];
  /** Known conflicts between the expected single-plan answer and the drafts. */
  expectedConflicts: {
    factual?: string[];
    approach?: string[];
    evidenceGap?: string[];
  };
  /** Items that must appear in the final plan for it to be actionable. */
  expectedActions: string[];
  /** Whether the case has genuine unresolved conflict that synthesis must not hide. */
  hasUnresolvedConflict: boolean;
};

/** A mock model that follows instructions literally but does not infer. */
function mockModel(prompt: string, evalCase: EvalCase): string {
  if (prompt.includes("Write your draft plan")) {
    const evidence: string[] = [];
    const match = prompt.match(/EVIDENCE PACK\n([\s\S]*?)(?:\n\n|$)/);
    if (match) {
      evidence.push(
        ...match[1]
          .split("\n")
          .map((line) => line.replace(/^-\s*/, "").trim())
          .filter((line) => line !== ""),
      );
    }
    const lines = [`# Draft for ${evalCase.id}`, ""];
    lines.push("## Evidence considered");
    lines.push(...(evidence.length > 0 ? evidence : evalCase.expectedEvidence).map((e) => `- ${e}`));
    lines.push("");
    lines.push("## Steps");
    lines.push(...evalCase.expectedActions.map((a) => `- ${a}`));
    return lines.join("\n");
  }

  if (prompt.includes("You are the integrator")) {
    const hasStructured = prompt.includes("RULINGS");
    const lines: string[] = [];
    if (hasStructured) {
      lines.push(
        "RULINGS",
        "- migration order | adopt incremental | rollback test passed",
        "UNRESOLVED_CONFLICTS",
        ...(evalCase.hasUnresolvedConflict
          ? ["- sync vs async API | no latency benchmark yet"]
          : ["- none | all conflicts resolved"]),
        "EVIDENCE",
        "- fixer | rollback test passed",
        "CONFIDENCE",
        "- migration order | high | rollback test passed",
      );
    }
    lines.push(
      "VERDICTS",
      "- adopted | incremental migration | fixer",
      "- rejected | big-bang rewrite | code-reviewer",
      "PLAN",
      `# Merged plan for ${evalCase.id}`,
      ...evalCase.expectedActions.map((a) => `- ${a}`),
      ...evalCase.expectedEvidence.map((e) => `- consider ${e}`),
    );
    return lines.join("\n");
  }

  if (prompt.includes("FACTUAL_CONFLICTS")) {
    return [
      "FACTUAL_CONFLICTS",
      ...(evalCase.expectedConflicts.factual ?? []).map((c) => `- draft-A | ${c} | contradicts evidence`),
      "APPROACH_CONFLICTS",
      ...(evalCase.expectedConflicts.approach ?? []).map((c) => `- draft-B | ${c} | breaks existing contract`),
      "EVIDENCE_GAPS",
      ...(evalCase.expectedConflicts.evidenceGap ?? []).map((c) => `- draft-C | ${c} | need benchmark`),
      "SOUND_ITEMS",
      "- draft-A | incremental migration | aligns with evidence",
    ].join("\n");
  }

  if (prompt.includes("object to what is wrong")) {
    return [
      "I object that draft-A may be wrong because it lacks evidence.",
      "I also object that draft-B takes an approach that could break things.",
    ].join("\n");
  }

  return "unexpected prompt phase";
}

function runForRoles(roles: PlanDebateRoleProposal[], requirement: string): PlanDebateRun {
  return startPlanDebate(createPlanDebateRun({ round: 1, requirement, roles }));
}

function seatHandle(role: PlanDebateRoleProposal): string {
  return `${role.name}${role.seat > 1 ? ` #${role.seat}` : ""}`;
}

function singleOutput(evalCase: EvalCase, roles: PlanDebateRoleProposal[]): string {
  const run = runForRoles(roles, evalCase.requirement);
  const prompt = planDebateBrief(run, { phase: "draft", role: roles[0].name, seat: roles[0].seat });
  return mockModel(prompt, evalCase);
}

function oldMultiOutput(evalCase: EvalCase, roles: PlanDebateRoleProposal[]): string {
  const run = runForRoles(roles, evalCase.requirement);
  const drafts = roles.map((role) =>
    mockModel(planDebateBrief(run, { phase: "draft", role: role.name, seat: role.seat }), evalCase),
  );
  let state = run;
  for (const [index, role] of roles.entries()) {
    state = {
      ...state,
      drafts: {
        ...state.drafts,
        [seatHandle(role)]: { role: role.name, outcome: "complete", report: drafts[index] },
      },
    };
  }
  const critiquePrompt = planDebateBrief(state, { phase: "critique", role: roles[0].name, seat: roles[0].seat });
  const critique = mockModel(critiquePrompt, evalCase);
  for (const role of roles) {
    state = {
      ...state,
      critiques: {
        ...state.critiques,
        [seatHandle(role)]: { role: role.name, outcome: "complete", report: critique },
      },
    };
  }
  const integratePrompt = planDebateBrief(state, { phase: "integrate", role: roles[0].name, seat: roles[0].seat });
  return mockModel(integratePrompt, evalCase);
}

function newMultiOutput(evalCase: EvalCase, roles: PlanDebateRoleProposal[]): string {
  const run = runForRoles(roles, evalCase.requirement);
  const drafts = roles.map((role) =>
    mockModel(planDebateBrief(run, { phase: "draft", role: role.name, seat: role.seat }), evalCase),
  );
  let state = run;
  for (const [index, role] of roles.entries()) {
    state = {
      ...state,
      drafts: {
        ...state.drafts,
        [seatHandle(role)]: { role: role.name, outcome: "complete", report: drafts[index] },
      },
    };
  }
  const critiques = roles.map((role) =>
    mockModel(planDebateBrief(state, { phase: "critique", role: role.name, seat: role.seat }), evalCase),
  );
  for (const [index, role] of roles.entries()) {
    state = {
      ...state,
      critiques: {
        ...state.critiques,
        [seatHandle(role)]: { role: role.name, outcome: "complete", report: critiques[index] },
      },
    };
  }
  const integratePrompt = planDebateBrief(state, { phase: "integrate", role: roles[0].name, seat: roles[0].seat });
  return mockModel(integratePrompt, evalCase);
}

const FIXTURES: EvalCase[] = [
  {
    id: "migration-order",
    requirement: "Migrate the user settings store from localStorage to SQLite without losing data.",
    expectedEvidence: ["localStorage keys", "SQLite schema", "migration script", "rollback test"],
    expectedConflicts: {
      factual: ["localStorage is synchronous"],
      approach: ["one-shot migration vs phased migration"],
      evidenceGap: ["no user-data size distribution"],
    },
    expectedActions: ["read existing keys", "create SQLite table", "write migration script", "add rollback test"],
    hasUnresolvedConflict: false,
  },
  {
    id: "ipc-contract",
    requirement: "Add a new IPC channel for streaming tool results from the Rust host to the renderer.",
    expectedEvidence: ["existing IPC channels", "Rust event types", "renderer listener", "back-pressure handling"],
    expectedConflicts: {
      factual: ["channel name collision"],
      approach: ["SSE vs request-response"],
      evidenceGap: ["no latency benchmark"],
    },
    expectedActions: ["define channel name", "update Rust emitter", "add renderer handler", "test back-pressure"],
    hasUnresolvedConflict: true,
  },
  {
    id: "debate-quality",
    requirement: "Improve PlanDebate so seats do not all argue from the same brief skeleton.",
    expectedEvidence: ["current prompt", "seat evidence pack", "critique categories", "synthesis sections"],
    expectedConflicts: {
      factual: ["current briefs are independent"],
      approach: ["hardcoded roles vs catalog roles"],
      evidenceGap: ["no historical case corpus"],
    },
    expectedActions: ["add structured brief schema", "render evidence domains", "force critique categories", "require synthesis sections"],
    hasUnresolvedConflict: true,
  },
  {
    id: "theme-system",
    requirement: "Introduce a design-token-based theme system that supports light, dark and high-contrast modes.",
    expectedEvidence: ["current CSS variables", "token taxonomy", "mode switcher component", "a11y contrast ratios"],
    expectedConflicts: {
      factual: ["dark mode already exists partially"],
      approach: ["CSS-only vs runtime tokens"],
      evidenceGap: ["missing contrast audit"],
    },
    expectedActions: ["audit existing variables", "define token schema", "build mode provider", "run contrast checks"],
    hasUnresolvedConflict: false,
  },
  {
    id: "dependency-update",
    requirement: "Upgrade TypeScript to 5.9 across the monorepo without breaking the build.",
    expectedEvidence: ["current tsconfig files", "breaking changes list", "CI build log", "type error baseline"],
    expectedConflicts: {
      factual: ["some packages pin TS 5.5"],
      approach: ["big-bang upgrade vs per-package"],
      evidenceGap: ["no deprecation scan"],
    },
    expectedActions: ["scan tsconfig references", "review breaking changes", "upgrade root devDependency", "fix type errors"],
    hasUnresolvedConflict: false,
  },
  {
    id: "onboarding-flow",
    requirement: "Redesign first-run onboarding so users can skip it without losing project context.",
    expectedEvidence: ["current onboarding steps", "skip telemetry", "project state persistence", "fallback URL"],
    expectedConflicts: {
      factual: ["skipping deletes context"],
      approach: ["modal vs inline tour"],
      evidenceGap: ["no drop-off funnel"],
    },
    expectedActions: ["audit current steps", "add skip button", "persist state", "add telemetry"],
    hasUnresolvedConflict: false,
  },
  {
    id: "agent-policy-sync",
    requirement: "Keep AGENTS.md and CLAUDE.md policy-sync tokens synchronized across agent runs.",
    expectedEvidence: ["AGENTS.md content", "CLAUDE.md content", "sync script", "CI check"],
    expectedConflicts: {
      factual: ["tokens already match"],
      approach: ["pre-commit hook vs CI gate"],
      evidenceGap: ["no policy change history"],
    },
    expectedActions: ["read both files", "compute token", "add check:agent-policy", "run in CI"],
    hasUnresolvedConflict: true,
  },
  {
    id: "mcp-server-discovery",
    requirement: "Let the runtime discover MCP servers from a workspace-local config without bypassing permission checks.",
    expectedEvidence: ["mcp config schema", "permission allowlist", "server health check", "audit log"],
    expectedConflicts: {
      factual: ["MCP servers are trusted by default"],
      approach: ["static config vs dynamic registration"],
      evidenceGap: ["no sandbox test"],
    },
    expectedActions: ["define config schema", "validate permissions", "health-check on load", "log invocations"],
    hasUnresolvedConflict: false,
  },
];

function containsAny(output: string, phrases: string[]): boolean {
  const lowered = output.toLowerCase();
  return phrases.some((phrase) => lowered.includes(phrase.toLowerCase()));
}

function countPresent(output: string, phrases: string[]): number {
  const lowered = output.toLowerCase();
  return phrases.filter((phrase) => lowered.includes(phrase.toLowerCase())).length;
}

function scoreEvidenceCoverage(evalCase: EvalCase, output: string): number {
  if (evalCase.expectedEvidence.length === 0) return 1;
  return countPresent(output, evalCase.expectedEvidence) / evalCase.expectedEvidence.length;
}

function scoreConflictDetection(output: string): number {
  const headings = ["FACTUAL_CONFLICTS", "APPROACH_CONFLICTS", "EVIDENCE_GAPS", "SOUND_ITEMS"];
  return headings.filter((h) => output.includes(h)).length / headings.length;
}

function scoreSynthesisFidelity(output: string): number {
  const parsed = parsePlanDebateSynthesis(output);
  let score = 0;
  if (parsed.rulings.length > 0) score += 0.2;
  if (parsed.unresolved.length > 0) score += 0.2;
  if (parsed.evidence.length > 0) score += 0.2;
  if (parsed.confidence.length > 0) score += 0.2;
  if (parsed.verdicts.length > 0) score += 0.1;
  if (parsed.plan.trim().length > 0) score += 0.1;
  return score;
}

function scoreActionability(evalCase: EvalCase, output: string): number {
  if (evalCase.expectedActions.length === 0) return 1;
  return countPresent(output, evalCase.expectedActions) / evalCase.expectedActions.length;
}

function average(scores: number[]): number {
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function evaluate(evalCase: EvalCase, output: string) {
  return {
    evidenceCoverage: scoreEvidenceCoverage(evalCase, output),
    conflictDetection: scoreConflictDetection(output),
    synthesisFidelity: scoreSynthesisFidelity(output),
    actionability: scoreActionability(evalCase, output),
  };
}

describe("PlanDebate prompt smoke test (model-free)", () => {
  function buildRoles(strategy: "legacy" | "structured"): PlanDebateRoleProposal[] {
    if (strategy === "legacy") {
      return [
        { name: "explorer", brief: "map the code", seat: 1 },
        { name: "code-reviewer", brief: "find the risk", seat: 1 },
        { name: "fixer", brief: "implement the change", seat: 1 },
      ];
    }
    return [
      {
        name: "explorer",
        brief: "map affected code",
        seat: 1,
        mission: "map affected code",
        evidence_pack: ["call graph", "changed files"],
      },
      {
        name: "code-reviewer",
        brief: "assess risk",
        seat: 1,
        mission: "assess risk",
        evidence_pack: ["test coverage", "breaking-change surface"],
      },
      {
        name: "fixer",
        brief: "implement safely",
        seat: 1,
        mission: "implement safely",
        evidence_pack: ["migration script", "rollback plan"],
      },
    ];
  }

  it("renders structured prompts with the expected section headings", () => {
    const run = runForRoles(buildRoles("structured"), FIXTURES[0].requirement);
    const draftPrompt = planDebateBrief(run, { phase: "draft", role: "explorer", seat: 1 });
    expect(draftPrompt).toContain("MISSION");
    expect(draftPrompt).toContain("EVIDENCE PACK");

    const critiquePrompt = planDebateBrief(run, { phase: "critique", role: "explorer", seat: 1 });
    expect(critiquePrompt).toContain("FACTUAL_CONFLICTS");
    expect(critiquePrompt).toContain("SOUND_ITEMS");

    const integratePrompt = planDebateBrief(run, { phase: "integrate", role: "explorer", seat: 1 });
    expect(integratePrompt).toContain("RULINGS");
    expect(integratePrompt).toContain("UNRESOLVED_CONFLICTS");
    expect(integratePrompt).toContain("PLAN");
  });

  it("renders legacy prompts without structured headings", () => {
    const run = runForRoles(buildRoles("legacy"), FIXTURES[0].requirement);
    const critiquePrompt = planDebateBrief(run, { phase: "critique", role: "explorer", seat: 1 });
    expect(critiquePrompt).not.toContain("FACTUAL_CONFLICTS");
    expect(critiquePrompt).toContain("object to what is wrong");

    const integratePrompt = planDebateBrief(run, { phase: "integrate", role: "explorer", seat: 1 });
    expect(integratePrompt).not.toContain("RULINGS");
    expect(integratePrompt).toContain("VERDICTS");
  });

  it("parser extracts structured sections from well-formed mock output", () => {
    const evalCase = FIXTURES[0];
    const output = newMultiOutput(evalCase, buildRoles("structured"));
    const parsed = parsePlanDebateSynthesis(output);
    expect(parsed.rulings.length).toBeGreaterThan(0);
    expect(parsed.unresolved.length).toBeGreaterThan(0);
    expect(parsed.evidence.length).toBeGreaterThan(0);
    expect(parsed.confidence.length).toBeGreaterThan(0);
    expect(parsed.verdicts.some((v) => v.verdict === "adopted")).toBe(true);
    expect(parsed.plan.trim().length).toBeGreaterThan(0);
  });

  it("parser ignores headings inside fenced blocks and body text", () => {
    const report = [
      "VERDICTS",
      "- adopted | item | source",
      "\`\`\`report",
      "PLAN",
      "# fake plan inside fence",
      "\`\`\`",
      "The PLAN is to migrate in phases.",
      "PLAN",
      "# real plan",
    ].join("\n");
    const parsed = parsePlanDebateSynthesis(report);
    expect(parsed.plan).toBe("# real plan");
    expect(parsed.verdicts).toHaveLength(1);
  });

  it("logs deterministic scores for manual inspection only", () => {
    const table: Record<string, { single: number; oldMulti: number; newMulti: number }> = {};
    for (const evalCase of FIXTURES) {
      const single = evaluate(evalCase, singleOutput(evalCase, buildRoles("legacy")));
      const oldMulti = evaluate(evalCase, oldMultiOutput(evalCase, buildRoles("legacy")));
      const newMulti = evaluate(evalCase, newMultiOutput(evalCase, buildRoles("structured")));
      table[evalCase.id] = {
        single: average([single.evidenceCoverage, single.conflictDetection, single.synthesisFidelity, single.actionability]),
        oldMulti: average([oldMulti.evidenceCoverage, oldMulti.conflictDetection, oldMulti.synthesisFidelity, oldMulti.actionability]),
        newMulti: average([newMulti.evidenceCoverage, newMulti.conflictDetection, newMulti.synthesisFidelity, newMulti.actionability]),
      };
    }
    // Scores are logged for manual inspection only. They are not assertions
    // because the mock model follows instructions literally; the judge therefore
    // measures prompt clarity, not real model quality.
    // eslint-disable-next-line no-console
    console.table(table);
  });
});
