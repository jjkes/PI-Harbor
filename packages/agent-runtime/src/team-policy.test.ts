import { describe, expect, it } from "vitest";
import {
  MAX_NESTED_DELEGATIONS_PER_DELEGATE,
  type SubagentDefinition,
} from "@pi-harbor/shared";
import {
  SESSION_ORCHESTRATOR_TASK_TOOL_NAME,
  TeamPolicyError,
  assertCanDelegate,
  assertNestedStartAllowed,
  isNonRegistryAgentSpawner,
  nestedCatalogFor,
  teamTaskCatalog,
  teamTaskDescription,
  type TeamTaskCatalogEntry,
} from "./team-policy.js";

function definition(
  name: string,
  tools: readonly string[],
  overrides: Partial<SubagentDefinition> = {},
): SubagentDefinition {
  return {
    name,
    description: `${name} description.`,
    tools: [...tools],
    prompt: `${name} prompt.`,
    source: "builtin",
    ...overrides,
  };
}

function policyError(run: () => unknown): TeamPolicyError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TeamPolicyError);
    return error as TeamPolicyError;
  }
  throw new Error("Expected a Team policy denial.");
}

describe("assertCanDelegate", () => {
  it.each([
    { teamMode: false, scopeDepth: 0, childDepth: 1 },
    { teamMode: false, scopeDepth: 1, childDepth: undefined },
    { teamMode: false, scopeDepth: 2, childDepth: undefined },
    { teamMode: false, scopeDepth: 3, childDepth: undefined },
    { teamMode: true, scopeDepth: 0, childDepth: 1 },
    { teamMode: true, scopeDepth: 1, childDepth: 2 },
    { teamMode: true, scopeDepth: 2, childDepth: undefined },
    { teamMode: true, scopeDepth: 3, childDepth: undefined },
  ])(
    "handles L$scopeDepth with Team mode=$teamMode",
    ({ teamMode, scopeDepth, childDepth }) => {
      if (childDepth !== undefined) {
        expect(assertCanDelegate(scopeDepth, teamMode)).toBe(childDepth);
        return;
      }
      const error = policyError(() => assertCanDelegate(scopeDepth, teamMode));
      expect(error.code).toBe("delegation_depth_exceeded");
      expect(error.message).toContain("delegation_depth_exceeded");
      expect(error.message).toContain("No subagent was started");
    },
  );

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "fails closed for invalid owner depth %s",
    (scopeDepth) => {
      expect(policyError(() => assertCanDelegate(scopeDepth, true)).code).toBe(
        "delegation_depth_exceeded",
      );
    },
  );
});

describe("nestedCatalogFor", () => {
  const reviewer = definition("code-reviewer", ["Read", "Glob", "Grep"]);
  const explorer = definition("explorer", ["Read", "Glob", "Grep", "Bash"]);
  const fixer = definition("fixer", ["Read", "Edit", "Write", "Bash"]);
  const reader = definition("reader", ["Read"]);
  const inherited = definition("inherited", ["Read"], { inheritTools: true });
  const roster = [fixer, reviewer, explorer, reader, inherited];

  it("lets a read-only code-reviewer start only read-only members in roster order", () => {
    expect(
      nestedCatalogFor(reviewer, ["Read", "Glob", "Grep"], roster),
    ).toEqual([reviewer, reader]);
  });

  it.each([
    ["explorer", explorer, ["Read", "Glob", "Grep", "Bash"]],
    ["fixer", fixer, ["Read", "Edit", "Write", "Bash"]],
  ])("does not restrict a mutating %s owner", (_name, owner, resolved) => {
    const catalog = nestedCatalogFor(owner, resolved, roster);
    expect(catalog).toEqual(roster);
    expect(catalog).not.toBe(roster);
  });

  it("classifies the owner by resolved tools rather than its declaration", () => {
    const readOnlyInherit = nestedCatalogFor(inherited, ["Read"], roster);
    expect(readOnlyInherit).toEqual([reviewer, reader]);
    expect(nestedCatalogFor(inherited, ["Read", "Bash"], roster)).toEqual(
      roster,
    );
  });

  it("returns an empty catalog when no member is eligible", () => {
    expect(nestedCatalogFor(reviewer, reviewer.tools, [explorer, fixer])).toEqual(
      [],
    );
    expect(nestedCatalogFor(explorer, explorer.tools, [])).toEqual([]);
  });
});

describe("assertNestedStartAllowed", () => {
  it("allows the first four successful starts without retaining hidden state", () => {
    for (let nestedStarts = 0; nestedStarts < 4; nestedStarts += 1) {
      expect(() => assertNestedStartAllowed(nestedStarts)).not.toThrow();
      expect(() => assertNestedStartAllowed(nestedStarts)).not.toThrow();
    }
    expect(MAX_NESTED_DELEGATIONS_PER_DELEGATE).toBe(4);
  });

  it.each([4, 5, -1, 0.5, Number.NaN])(
    "denies an invalid or exhausted start count %s",
    (nestedStarts) => {
      const error = policyError(() => assertNestedStartAllowed(nestedStarts));
      expect(error.code).toBe("nested_delegation_limit_exceeded");
      expect(error.message).toContain("at most 4");
      expect(error.message).toContain("Finish the remaining work yourself");
    },
  );
});

describe("Team Task catalog and descriptions", () => {
  const entries: TeamTaskCatalogEntry[] = [
    {
      definition: definition("fixer", ["Read", "Edit", "Write"], {
        model: { providerId: "definition", modelId: "fixer-default" },
      }),
      cardModel: { providerId: "card", modelId: "fixer-locked" },
    },
    {
      definition: definition("code-reviewer", ["Read", "Glob", "Grep"], {
        model: { providerId: "definition", modelId: "reviewer-default" },
      }),
    },
    {
      definition: definition("explorer", ["Read", "Glob", "Grep", "Bash"]),
    },
    {
      definition: definition("inherited", ["Read"], { inheritTools: true }),
    },
  ];

  it("renders stable rows in roster order with card/definition/session models", () => {
    const snapshot = structuredClone(entries);
    const expected = [
      "- fixer (tools: Read, Edit, Write): fixer description. Model: card/fixer-locked.",
      "- code-reviewer (tools: Read, Glob, Grep): code-reviewer description. Model: definition/reviewer-default.",
      "- explorer (tools: Read, Glob, Grep, Bash): explorer description. Model: inherits the session model.",
      "- inherited (tools: inherit + Read): inherited description. Model: inherits the session model.",
    ].join("\n");
    expect(teamTaskCatalog(entries)).toBe(expected);
    expect(teamTaskCatalog(entries)).toBe(expected);
    expect(entries).toEqual(snapshot);
    expect(teamTaskCatalog([])).toBe("");
  });

  it("makes L0 delegate by default and keeps resume but no model-override guidance", () => {
    const description = teamTaskDescription(0, entries);
    expect(description).not.toContain("Prefer doing the work yourself");
    expect(description).toContain("delegation is the default");
    expect(description).toContain("Do not delegate anything that needs the user");
    expect(description).toContain("`resume`");
    expect(description).toContain(
      "Each member's model, tools and thinking level come from this session's Team configuration.",
    );
    expect(description).not.toContain("`model`");
    expect(description).not.toContain("Default model");
    expect(description).not.toContain("model override");
    expect(description).not.toContain("Available for AI delegation");
    expect(description.endsWith(`Available subagents:\n${teamTaskCatalog(entries)}`)).toBe(
      true,
    );
  });

  it("makes L1 own its result and states the nested limits and acceptance rules", () => {
    const description = teamTaskDescription(1, entries);
    expect(description).toBe(teamTaskDescription(1, entries));
    expect(description).not.toContain("Prefer doing the work yourself");
    expect(description).not.toContain("delegation is the default");
    expect(description).toContain("You own the result of your task.");
    expect(description).not.toContain("resume");
    expect(description).not.toContain("`model`");
    expect(description).not.toContain("model override");
    expect(description).toContain(
      "Any subagents you start cannot delegate further.",
    );
    expect(description).toContain("at most 4 subagents during this run");
    expect(description).toContain("converged with TaskWait on every one of them");
    expect(description).toContain("Your own checks do not accept your work");
    expect(description).toContain("Do not expand the task's scope");
    expect(description.endsWith(`Available subagents:\n${teamTaskCatalog(entries)}`)).toBe(
      true,
    );
  });
});

describe("isNonRegistryAgentSpawner", () => {
  it("denies the exact Session Orchestrator SessionTask identity", () => {
    expect(SESSION_ORCHESTRATOR_TASK_TOOL_NAME).toBe(
      "plugin_pi_session_orchestrator_SessionTask",
    );
    expect(
      isNonRegistryAgentSpawner(SESSION_ORCHESTRATOR_TASK_TOOL_NAME),
    ).toBe(true);
  });

  it.each([
    "SessionTask",
    "plugin_other_SessionTask",
    "plugin_pi_session_orchestrator_SessionTask_extra",
    "plugin_pi_session_orchestrator_sessiontask",
    "plugin_pi_session_orchestrator",
    "Description text that merely says SessionTask or spawn",
    "Read",
  ])("does not infer a spawner from a different name or text: %s", (name) => {
    expect(isNonRegistryAgentSpawner(name)).toBe(false);
  });
});
