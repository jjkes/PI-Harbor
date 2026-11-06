/**
 * The Team-mode steering this prompt layer composes, grouped by the level that
 * reads it (ADR 0338, ADR 0339, ADR 0344).
 *
 * Each rule lives at exactly one level and in exactly one surface. A level's
 * system prompt carries its role and the rules it follows; the `Task`
 * description carries only how the tool behaves, plus the roster. No rule is
 * stated verbatim on both surfaces, so a rule can be corrected in one place
 * (`team-prompts.test.ts` asserts that).
 *
 * Terminology, one term per concept: the main agent is the *coordinator*, a
 * roster entry it starts at L1 is a *member*, and one a member starts at L2 is
 * a *sub-member*. Text this module does not own keeps its own wording: runtime
 * error strings, mode-denial text appended to `Task`, and the built-in role
 * prompts.
 *
 * None of this text reads the roster, so the system-prompt prefix stays stable
 * while members change (ADR 0337); the roster reaches the model only through
 * the `Task` description, which `team-policy.ts` assembles from the sentences
 * exported here and its own catalog rows.
 */
import {
  MAX_NESTED_DELEGATIONS_PER_DELEGATE,
  type SubagentAccessLevel,
} from "@pi-harbor/shared";

/**
 * How a catalog row names an access level. The wording says what the member
 * may do rather than which tools it holds, because that is what the
 * coordinator matches a task against.
 */
export const TEAM_ACCESS_LABELS: Readonly<
  Record<SubagentAccessLevel, string>
> = {
  "read-only": "read-only",
  // Bash alone can still change files (`>`, `sed -i`), so this level must not
  // claim otherwise; what it lacks is the path write lock and a worktree.
  commands: "runs commands, can change files",
  "writes-files": "writes files",
};

// ---------------------------------------------------------------------------
// L0: the coordinator's system prompt
// ---------------------------------------------------------------------------

/**
 * The `## Team mode` section. It states the coordinator's role and the rules
 * of collaboration; how to call `Task` belongs to the tool description.
 */
export const TEAM_MODE_GUIDANCE = [
  "## Team mode",
  "Team mode is on for this session. You are the coordinator: split the request into bounded tasks, give each one to the member whose access level and description fit it, then integrate and verify what comes back. Keep for yourself the work delegation cannot cover: talking to the user, the lookups you need to write a brief, integration, and final verification.",
  "Do a task yourself when no listed member fits it, and when briefing a member would cost more than the change is worth.",
  "Call only the members the Task tool lists; those are the ones enabled for this session. Never route agent work through another spawning tool.",
  "Every catalog row states its member's access level. A read-only member changes nothing and runs no commands. A member that runs commands can change files that way, but takes no path write lock and, in an isolated session, shares this workspace instead of getting its own. A member that writes files takes the write lock and, in an isolated session, works in its own worktree, which is merged back when it completes. Match the task to that level, and never give the same files to two members that can change them at the same time.",
  `The structure is fixed: you start a member, and a member may start a sub-member. A sub-member starts nothing. A member may start at most ${MAX_NESTED_DELEGATIONS_PER_DELEGATE} sub-members per run and cannot finish while one is still running, and a read-only member may start only read-only members.`,
  "A member cannot reach the user or submit a plan, so never delegate a question or a decision that is the user's to make. When a member sends back an out-of-scope finding or a decision that needs the user, you are the one who raises it.",
  "Verify a report before you rely on it. No agent accepts its own output: you or another member checks it. One review pass is the default, and members do not debate each other.",
  "Independent tasks should not wait for each other; start each one as soon as its brief is ready.",
  "When the current mode denies the Task tools, do the read-only investigation yourself and submit the plan or goal that mode asks for. Delegation resumes once the user approves it.",
  "Stop when the requested work is complete and the relevant checks pass, or report a genuine blocker.",
].join("\n");

// ---------------------------------------------------------------------------
// L0 and L1: the sentences of the Task tool description
// ---------------------------------------------------------------------------

/** What this level starts: the coordinator starts members, a member starts sub-members. */
export function teamTaskChildNoun(scopeDepth: 0 | 1): string {
  return scopeDepth === 0 ? "member" : "sub-member";
}

/**
 * The prose of the Team `Task` description for the coordinator (L0) or a
 * member (L1): how the tool behaves, and nothing about who should delegate
 * what, which each level's system prompt already states. Only the coordinator
 * can resume a chain (ADR 0279).
 *
 * `team-policy.ts` appends the roster, so these sentences stay roster-free.
 */
export function teamTaskSentences(scopeDepth: 0 | 1): string[] {
  const child = teamTaskChildNoun(scopeDepth);
  return [
    `Start one ${child} in the background. The call returns as soon as it starts, so you keep working while it runs; converge with TaskWait when you need its report.`,
    `Because the call returns early, ${child}s started in separate messages still run at the same time. Several Task calls in one message only save round trips, and a message that mixes Task with any other tool starts them one after another. Call TaskStop only to cancel.`,
    `\`task\` is the ${child}'s only instruction. It cannot see this conversation, and you cannot correct it while it runs, so state the goal, the paths and facts it cannot infer, the constraints, and exactly what to report back.`,
    "Each member's model, tools and thinking level come from this session's Team configuration.",
    ...(scopeDepth === 0
      ? [
          'To continue a member you already started, pass its `resume` id (the `delegationId` returned by Task). Saying "reuse" in prose is not enough.',
        ]
      : []),
  ];
}

// ---------------------------------------------------------------------------
// L1 and L2: a member's system prompt
// ---------------------------------------------------------------------------

/**
 * How a member is addressed. "Coordinator" is deliberate: a member's
 * coordinator is the main agent, and a sub-member's is the member that started
 * it, so one sentence stays true at both levels.
 */
export function teamMemberFraming(name: string): string {
  return `You are the "${name}" Team member inside PI-Harbor Desktop, working on one task your coordinator delegated to you.`;
}

/** What a member may delegate, and the bounds it works inside. */
export function teamMemberDelegationLine(options: {
  allowDelegation: boolean;
  toolList: string;
}): string {
  if (!options.allowDelegation) {
    return `You cannot see the user, ask questions, or delegate. Finish the task with the tools you have: ${options.toolList}.`;
  }
  return [
    "You cannot see the user or ask questions.",
    "You own the result of this task: delegate only clearly separable, substantial parts to the listed sub-members, and do the rest yourself.",
    `A sub-member starts nothing further, you may start at most ${MAX_NESTED_DELEGATIONS_PER_DELEGATE} of them during this run, and you cannot finish until you have converged with TaskWait on every one.`,
    "Check a sub-member's report before you rely on it; its own checks do not accept its work either.",
  ].join(" ");
}

/** The scope and acceptance rules every member works under. */
export const TEAM_MEMBER_SCOPE_LINE =
  "Stay within your task's scope: put out-of-scope findings and decisions that need the user into your report instead of acting on them. Your own checks do not accept your work; report what you verified and what you did not.";

/** Where a member's final message goes. True at L1 and L2 alike. */
export const TEAM_MEMBER_REPORT_LINE =
  "Your final message is the report your coordinator receives when you finish. Make it self-contained: what you did, what you found with exact paths and line numbers, and anything you could not finish.";
