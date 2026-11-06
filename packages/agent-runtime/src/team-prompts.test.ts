import { describe, expect, it } from "vitest";
import {
  MAX_NESTED_DELEGATIONS_PER_DELEGATE,
  SUBAGENT_FILE_WRITING_TOOLS,
  SUBAGENT_MUTATING_TOOLS,
  subagentAccessLevel,
  type SubagentAccessLevel,
  type SubagentDefinition,
} from "@pi-harbor/shared";
import { composeSubagentSystemPrompt } from "./subagent.js";
import { teamTaskDescription, type TeamTaskCatalogEntry } from "./team-policy.js";
import {
  TEAM_ACCESS_LABELS,
  TEAM_MODE_GUIDANCE,
  teamTaskSentences,
} from "./team-prompts.js";

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

/**
 * Split prompt text into comparable sentences. Bullet prefixes, list markers
 * and surrounding whitespace are dropped so that two surfaces stating the same
 * rule in the same words are recognised regardless of layout.
 */
function sentences(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("##") && !line.startsWith("- "))
    .join(" ")
    .split(/(?<=[.;:])\s+/)
    .map((sentence) => sentence.replace(/^[-*\s]+/, "").trim())
    .filter((sentence) => sentence.length > 20);
}

describe("Team prompt layering", () => {
  const entries: TeamTaskCatalogEntry[] = [
    { definition: definition("reader", ["Read"]) },
  ];

  it.each([
    { scopeDepth: 0 as const, prompt: TEAM_MODE_GUIDANCE, level: "L0" },
    {
      scopeDepth: 1 as const,
      prompt: composeSubagentSystemPrompt({
        definition: definition("member", ["Read"]),
        allowDelegation: true,
        teamMember: true,
      }),
      level: "L1",
    },
  ])(
    "states no rule twice across $level's system prompt and Task description",
    ({ scopeDepth, prompt }) => {
      const taskSentences = new Set(
        teamTaskSentences(scopeDepth).flatMap(sentences),
      );
      const repeated = sentences(prompt).filter((sentence) =>
        taskSentences.has(sentence),
      );

      expect(repeated).toEqual([]);
      expect(taskSentences.size).toBeGreaterThan(0);
    },
  );
  it.each([
    {
      scopeDepth: 0 as const,
      // Each phrase is a rule the coordinator's system prompt owns.
      owned: [
        "own the result",
        "review pass",
        "brief is self-contained",
        "briefs are self-contained",
        "stay within",
        "out-of-scope",
        "only the members the Task tool lists",
        "access level",
      ],
    },
    {
      scopeDepth: 1 as const,
      owned: [
        "own the result",
        "check a sub-member's report",
        "stay within",
        "out-of-scope",
      ],
    },
  ])(
    "leaves L$scopeDepth's own rules out of its Task description",
    ({ scopeDepth, owned }) => {
      const taskText = teamTaskSentences(scopeDepth).join("\n");
      for (const phrase of owned) {
        expect(taskText.toLowerCase()).not.toContain(phrase);
      }
    },
  );

  it("keeps the roster formatting out of the Task prose", () => {
    for (const scopeDepth of [0, 1] as const) {
      const taskText = teamTaskSentences(scopeDepth).join("\n");
      expect(taskText).not.toContain("Available ");
      expect(taskText).not.toContain("Model:");
      expect(taskText).not.toContain("(tools:");
    }
  });

  it("keeps the roster out of every system prompt", () => {
    const member = composeSubagentSystemPrompt({
      definition: definition("member", ["Read"]),
      allowDelegation: true,
      teamMember: true,
    });

    for (const prompt of [TEAM_MODE_GUIDANCE, member]) {
      expect(prompt).not.toContain("reader");
      expect(prompt).not.toContain("Available");
      expect(prompt).not.toContain("Model:");
    }
    expect(teamTaskDescription(0, entries)).toContain("- reader (");
  });

  it("uses one term per concept", () => {
    const texts = [
      TEAM_MODE_GUIDANCE,
      ...teamTaskSentences(0),
      ...teamTaskSentences(1),
      composeSubagentSystemPrompt({
        definition: definition("member", ["Read"]),
        allowDelegation: true,
        teamMember: true,
      }),
    ].join("\n");

    expect(texts).not.toContain("delegate (");
    expect(texts).not.toMatch(/\bsubagents?\b/);
    expect(texts).not.toMatch(/\bdelegates\b/);
    expect(TEAM_MODE_GUIDANCE).toContain("You are the coordinator");
  });

  it("describes Task's real background semantics", () => {
    const l0 = teamTaskSentences(0).join(" ");

    expect(l0).toContain("The call returns as soon as it starts");
    expect(l0).toContain(
      "members started in separate messages still run at the same time",
    );
    expect(l0).toContain("only save round trips");
    expect(l0).toContain("mixes Task with any other tool");
    expect(l0).not.toContain("To run delegates concurrently, emit several");
  });

  it("tells the coordinator what to do when Task is denied", () => {
    expect(TEAM_MODE_GUIDANCE).toContain("When the current mode denies the Task tools");
    expect(TEAM_MODE_GUIDANCE).toContain("submit the plan or goal");
  });

  it("keeps a narrow exception for work not worth delegating", () => {
    expect(TEAM_MODE_GUIDANCE).toContain(
      "briefing a member would cost more than the change is worth",
    );
  });

  it("states the fixed structure with the shared limit", () => {
    expect(TEAM_MODE_GUIDANCE).toContain(
      `at most ${MAX_NESTED_DELEGATIONS_PER_DELEGATE} sub-members per run`,
    );
    expect(TEAM_MODE_GUIDANCE).toContain(
      "a read-only member may start only read-only members",
    );
  });

  it("does not tell a member it can reach the user", () => {
    const l1 = teamTaskSentences(1).join(" ");
    const member = composeSubagentSystemPrompt({
      definition: definition("member", ["Read"]),
      allowDelegation: true,
      teamMember: true,
    });

    expect(l1).not.toContain("talk to the user");
    expect(l1).not.toContain("the user");
    expect(member).toContain("You cannot see the user or ask questions");
  });

  it("omits resume guidance below the coordinator", () => {
    expect(teamTaskSentences(0).join(" ")).toContain("`resume`");
    expect(teamTaskSentences(1).join(" ")).not.toContain("resume");
  });
});

describe("TEAM_ACCESS_LABELS", () => {
  it.each([
    { tools: ["Read", "Glob", "Grep"], level: "read-only" as const },
    { tools: ["Read", "Bash"], level: "commands" as const },
    { tools: ["Read", "Edit"], level: "writes-files" as const },
    { tools: ["Read", "Write"], level: "writes-files" as const },
    { tools: ["Read", "Bash", "Write"], level: "writes-files" as const },
  ])("labels $tools as $level", ({ tools, level }) => {
    expect(subagentAccessLevel(definition("member", tools))).toBe(level);
    expect(TEAM_ACCESS_LABELS[level]).toBeTruthy();
  });

  it("covers every access level with distinct wording", () => {
    const levels: SubagentAccessLevel[] = [
      "read-only",
      "commands",
      "writes-files",
    ];
    const labels = levels.map((level) => TEAM_ACCESS_LABELS[level]);

    expect(new Set(labels).size).toBe(levels.length);
    expect(Object.keys(TEAM_ACCESS_LABELS).sort()).toEqual([...levels].sort());
  });

  it("never denies that a command-running member can change files", () => {
    // Bash can write (`>`, `sed -i`), and `subagentCanMutate` counts it, so a
    // label here may not promise that the member leaves files untouched.
    expect(TEAM_ACCESS_LABELS.commands).not.toMatch(/no files|writes no|read-only/);
    expect(TEAM_ACCESS_LABELS.commands).toContain("change files");
    expect(TEAM_MODE_GUIDANCE).not.toContain("writes no files");
    expect(TEAM_MODE_GUIDANCE).not.toMatch(/two file-writing members/);
  });

  it("applies the same-files rule to every member that can change files", () => {
    expect(TEAM_MODE_GUIDANCE).toContain(
      "never give the same files to two members that can change them at the same time",
    );
    expect(TEAM_MODE_GUIDANCE).toContain("takes no path write lock");
    expect(TEAM_MODE_GUIDANCE).toContain("merged back when it completes");
  });

  it("derives levels only from the runtime's own tool sets", () => {
    expect([...SUBAGENT_MUTATING_TOOLS].sort()).toEqual([
      "Bash",
      "Edit",
      "Write",
    ]);
    expect([...SUBAGENT_FILE_WRITING_TOOLS].sort()).toEqual(["Edit", "Write"]);
    for (const tool of SUBAGENT_FILE_WRITING_TOOLS) {
      expect(SUBAGENT_MUTATING_TOOLS).toContain(tool);
    }
  });
});
