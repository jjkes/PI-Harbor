import { describe, expect, it } from "vitest";
import type { SubagentDefinition } from "@pi-harbor/shared";
import { collapseRepeatedSentences, validatePlanDebateRoles } from "./plan-debate.js";

/*
 * A model can degenerate into writing one sentence over and over. The panel
 * prints `brief` verbatim, so whatever the model writes is what the user reads:
 * the roster must store a collapsed, bounded brief instead.
 */

const CATALOG = [
  { name: "code-reviewer", description: "Own the review risks." },
  { name: "explorer", description: "Map the code before anyone drafts." },
  { name: "ui-architect", description: "Own the layout and the states." },
] as SubagentDefinition[];

const SENTENCE =
  "已完成条件：四项问题均有明确建议，区分事实/假设，并给出可验收的架构决策。";

/** A valid three-seat roster with the seat under test carrying `extra` fields. */
function roster(extra: Record<string, unknown>) {
  return {
    roles: [
      { name: "code-reviewer", brief: "own the risks", ...extra },
      { name: "explorer", brief: "map the code" },
      { name: "ui-architect", brief: "own the layout" },
    ],
  };
}

describe("collapseRepeatedSentences", () => {
  it("collapses consecutive identical sentences into one", () => {
    expect(collapseRepeatedSentences(SENTENCE.repeat(4))).toBe(SENTENCE);
  });

  it("keeps distinct sentences, their order and their spacing", () => {
    expect(collapseRepeatedSentences("First. Second. Third.")).toBe("First. Second. Third.");
    expect(collapseRepeatedSentences("第一句。第二句。")).toBe("第一句。第二句。");
  });

  it("leaves text without sentence punctuation alone", () => {
    expect(collapseRepeatedSentences("own the risks")).toBe("own the risks");
  });
});

describe("validatePlanDebateRoles", () => {
  it("stores a collapsed brief instead of the repeated one", () => {
    const validation = validatePlanDebateRoles(roster({ brief: SENTENCE.repeat(12) }), CATALOG);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.roles[0].brief).toBe(SENTENCE);
  });

  it("cuts a brief that is long without repeating", () => {
    const validation = validatePlanDebateRoles(roster({ brief: "长".repeat(500) }), CATALOG);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.roles[0].brief.length).toBe(401);
    expect(validation.roles[0].brief.endsWith("…")).toBe(true);
  });

  it("drops exact duplicate entries from a criteria list and keeps the rest", () => {
    const validation = validatePlanDebateRoles(
      roster({ done_criteria: ["a criterion", "a criterion", " another criterion "] }),
      CATALOG,
    );
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.roles[0].done_criteria).toEqual(["a criterion", "another criterion"]);
  });

  it("collapses a repeated mission so the structured brief stays readable", () => {
    const validation = validatePlanDebateRoles(roster({ mission: SENTENCE.repeat(6) }), CATALOG);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.roles[0].mission).toBe(SENTENCE);
  });
});

describe("a roster the model wrote without briefs", () => {
  it("falls back to the subagent's own description instead of failing the round", () => {
    const validation = validatePlanDebateRoles(
      { roles: [{ name: "code-reviewer" }, { name: "explorer" }, { name: "ui-architect" }] },
      CATALOG,
    );
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.roles[0].brief).toBe("Own the review risks.");
    expect(validation.roles[2].brief).toBe("Own the layout and the states.");
  });

  it("still refuses, and says why, when even the catalog has no description", () => {
    const bare = [
      { name: "code-reviewer" },
      { name: "explorer" },
      { name: "ui-architect" },
    ] as SubagentDefinition[];
    const validation = validatePlanDebateRoles(
      { roles: [{ name: "code-reviewer" }, { name: "explorer" }, { name: "ui-architect" }] },
      bare,
    );
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.message).toContain("no description to fall back on");
  });

  it("still refuses two seats of one role that share a fallback brief", () => {
    const validation = validatePlanDebateRoles(
      { roles: [{ name: "code-reviewer" }, { name: "code-reviewer" }, { name: "explorer" }] },
      CATALOG,
    );
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.message).toContain("repeats another code-reviewer angle");
  });
});
