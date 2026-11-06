# ADR 0344: One Team rule, one level, one surface

- Status: Accepted
- Date: 2026-11-02
- Deciders: PI-Desktop maintainers
- Related: ADR 0062, ADR 0089, ADR 0279, ADR 0337, ADR 0338, ADR 0339
- Amends: ADR 0339 §6 (Team-mode steering)

## Context

ADR 0339 §6 gave the main agent a `## Team mode` section and made the Team
`Task` description default to delegation. The wording was spread over three
files: `delegation-guidance.ts` for the main agent's section,
`team-policy.ts` for the `Task` descriptions, and a `teamMember` branch
inside `subagent.ts`'s prompt framing.

Reading that text against the runtime exposed four problems.

1. **Capability was described, not stated.** A catalog row listed only
   `tools:` and a description, so the coordinator inferred reach from tool
   names and from prose the user wrote. Whether a member is read-only depends
   on `SUBAGENT_MUTATING_TOOLS`, and whether it takes the path write lock and
   gets its own worktree in an isolated session depends on
   `PATH_MUTATING_TOOLS`, which is `Edit` and `Write` only. A member holding
   `Bash` and no `Edit` can still change files through the shell, yet it is
   neither read-only nor lock/worktree-isolated, and nothing in the prompt said
   so.
2. **A mode-dependent denial contradicted a persistent instruction.** Plan and
   Goal mode retain the Task family as declarations and reject every call
   (ADR 0062, `mode-tool-access.ts`). The `## Team mode` section demanded
   delegation unconditionally, so in those modes the instructions asked for a
   call the runtime refuses.
3. **The same rule was stated twice per level.** L0's `Task` description
   repeated five sentences of its system-prompt section, and L1's repeated
   what its own prompt said. Both copies go out on every request, and a rule
   corrected in one place left the other stale — which is how (4) happened.
4. **L1 and L2 prompt text was written for L0.** One `Task` sentence was
   shared by both levels, so a member's description told it to "talk to the
   user" while its own system prompt said it cannot see the user. The shared
   framing said a task was "delegated by the main agent" and a report went to
   "the main agent", which is false for an L2 whose coordinator is an L1.

## Decision

### 1. One module owns every Team word, keyed by the level that reads it

`packages/agent-runtime/src/team-prompts.ts` holds the Team steering prose this
prompt layer composes, grouped as
L0 (the coordinator's system prompt), L0 and L1 (the `Task` description
sentences), and L1 and L2 (a member's system prompt). `team-policy.ts` keeps
the policy guards and the roster formatter and assembles a `Task` description
from that level's sentences plus the catalog rows. `subagent.ts` keeps the
non-Team framing byte for byte and takes the Team lines from the module.

The division of labour is fixed:

| Surface | Owns | Does not state |
|---|---|---|
| A level's system prompt | its role, its obligations, the rules of collaboration | how a tool is called, the roster |
| The `Task` description | how the tool behaves, the roster | who should delegate what |

Nothing about delegation policy is restated in a tool description, and no
roster data enters a system prompt, so ADR 0337's stable prefix still holds.
Text this module does not own keeps its own wording and is out of scope:
runtime error strings, the mode-denial note appended to `Task`, and the
built-in role prompts.

### 2. The catalog states the access level the runtime applies

A catalog row reads `- name (access level; tools: …): description Model: id.`
The level is derived by the shared `subagentAccessLevel`, from the same two
tool sets the runtime enforces:

| Level | Derived from | Runtime meaning |
|---|---|---|
| `read-only` | no mutating tool | `subagentCanMutate` is false; cannot start a write-capable member |
| `commands` | `Bash`, no `Edit`/`Write` | can change files through the shell; no path write lock, no worktree of its own |
| `writes-files` | `Edit` or `Write` | takes the write lock; owns a worktree in an isolated session |

`SUBAGENT_FILE_WRITING_TOOLS` is added to the shared contracts for the third
row, mirroring the runtime's `PATH_MUTATING_TOOLS` and `delegateNeedsWorktree`,
so a level cannot be invented that the runtime does not grant. Unresolved
`inherit` stays at the widest level, as `subagentCanMutate` already treats it.
The coordinator's section states what each level means and that the level, not
a description, decides which member fits a task.

Because a command-running member can change files, the coordinator's
same-files rule covers every member that is not read-only, not only the ones
holding `Edit` or `Write`. Two command-running members share the session
checkout with no lock between them, which is exactly the case the rule has to
name.

The row names the model by model id alone. Team `Task` has no `model`
argument (ADR 0338 §5), so a provider id was text the caller could not act on.

### 3. The coordinator section covers the modes that deny Task

The section states that when the current mode denies the Task tools, the
coordinator does the read-only investigation itself and submits the plan or
goal that mode asks for, and that delegation resumes after approval. The
sentence reads no mode and no roster, so the section still depends only on
`team.enabled`; it states the recovery path for a denial instead of branching
on which mode is active.

### 4. A member is addressed through its coordinator

Team framing says "your coordinator delegated to you" and "the report your
coordinator receives". That is exact at both levels: a member's coordinator is
the main agent, and a sub-member's is the member that started it. The `Task`
description names the level's own children — `member` at L0, `sub-member` at
L1 — so concurrency guidance no longer tells a member to talk to a user it
cannot reach. L1 is also told to check a sub-member's report before relying on
it, matching the rule the coordinator already follows.

Terminology is one term per concept throughout: coordinator, member,
sub-member, written without "subagent" or "delegate" in Team text.

### 5. L0 keeps a narrow exception for change not worth a brief

ADR 0339 §6 removed the old "prefer doing the work yourself" wording because
it worked against delegation. It also left no cost floor, so a one-line edit
paid for a brief, a full member context, and a round of waiting. The section
now says to do a task directly when no listed member fits it and when
briefing a member would cost more than the change is worth. Delegation remains
the default for bounded work; the exception covers only work whose brief would
dominate it.

### 6. `Task` concurrency states the real semantics

The old sentence implied that several `Task` calls in one message are what
makes them run in parallel. `Task` starts a background delegate and returns,
so delegates started in separate messages also run at the same time;
same-message fan-out only saves round trips, and a message that mixes `Task`
with any other tool is executed one call at a time. The description now says
that.

## Consequences

- A rule has one home. Correcting Team behaviour means editing one sentence,
  and `team-prompts.test.ts` fails if a rule is restated verbatim on the other
  surface of the same level.
- The catalog grows by roughly one clause per row, and in exchange the
  coordinator no longer guesses capability from tool names or user prose.
- `Bash`-only members are now visibly a separate class. Sessions whose
  "read-only" roles carry `Bash` are labelled `commands`, which is what the
  runtime already granted them; narrowing those roles is a Settings change,
  not a prompt change.
- ADR 0339 §6's "no direct work" reading is superseded by §5 above; its stable
  prefix rule, roster placement, and spawner boundary stand.
- Adding a fourth access level would require a runtime classification change
  and a new ADR; the prompt layer cannot introduce one.

## Alternatives considered

- **Keep the prose in `team-policy.ts` and `subagent.ts`.** Rejected: the
  duplication in (3) is what produced (4); one module per level makes the
  missing invariant visible and testable.
- **Let the coordinator infer capability from tools.** Rejected: it already
  did, and the two-tool-set distinction (lock and worktree versus shell
  access) is not derivable from a tool list without knowing the runtime.
- **Branch the section on the active mode.** Rejected: it would put
  mode-dependent text in a prefix that must depend only on `team.enabled`.
  Stating the recovery path once keeps the prefix stable.
- **Allow read-only members under Plan and Goal.** Rejected: it changes the
  contract-mode guard and, in sessions whose roles all carry `Bash`, would
  allow no member anyway.
- **Give L2 its own wording via a new prompt parameter.** Rejected: "your
  coordinator" is accurate at both levels without new inputs, and the runtime
  call sites did not have to change.
- **Drop the access level and keep the tool list.** Rejected: the tool list is
  already there and did not prevent (1).

## Verification

- `packages/agent-runtime/src/team-prompts.test.ts`: no sentence appears in
  both a level's system prompt and that level's `Task` description; the roster
  appears in no system prompt; one term per concept; Task background
  semantics; the denied-Task recovery path; the narrow exception; the fixed
  structure; `Task` omits resume below L0; every access level is distinct and
  derived from the shared tool sets.
- `packages/agent-runtime/src/team-policy.test.ts`: catalog rows carry the
  level the runtime applies, the model id without a provider id, the L0 and L1
  descriptions.
- `packages/agent-runtime/src/subagent.test.ts` and
  `nested-execution.test.ts`: Team framing and report destination at L1 and
  L2, and the non-Team framing unchanged.
- `pnpm --filter @pi-harbor/agent-runtime test`: 1816 tests pass.
- `pnpm --filter @pi-harbor/shared test`: 1420 tests pass.
