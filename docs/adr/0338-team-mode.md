# ADR 0338: Team mode: bounded nested delegation and session rosters

- Status: Accepted
- Date: 2026-10-28
- Deciders: PI-Desktop maintainers
- Related: ADR 0062, ADR 0089, ADR 0166, ADR 0237, ADR 0246, ADR 0279,
  ADR 0329, ADR 0337; 2026-10-28 Team Mode design
- Amends: ADR 0062 (delegation depth and presentation), ADR 0089
  (owner-scoped lifecycle tools), ADR 0166 (parent-judged lifetime at L1),
  ADR 0279 (root-only resume and Team model resolution), and ADR 0329
  (nested delegate tool roots and worktree settlement)
- Amended by: ADR 0339 (composer entry, Settings-driven member cards, session
  member settings and roster version 2, delegation-first steering, and the L0
  spawner boundary) and ADR 0340 (dock-only Team presentation, delegation
  summary rows, and the session-wide two-level tree)

## Context

ADR 0062 deliberately made a subagent a bounded worker rather than a second
full session. Later decisions added background lifecycle tools, parent-judged
settlement, resumable root chains, inherited tool catalogs, and isolated
worktrees, but the executable topology remained L0 → L1. A flat delegation
registry and session-wide Task lifecycle tools embody that restriction.

Team mode adds a user-selected, per-session roster and permits exactly one
additional delegation level: the main agent (L0) may start roster members at
L1, and an L1 member may start roster members at L2. The requirement is a hard
structural limit, not a prompt instruction. Nested execution must not let one
owner inspect or control another owner's children, turn a read-only delegate
into a write-capable orchestrator, or bypass the existing worktree and
permission boundaries.

The roster is session data, so renderer local storage is not an acceptable
authority. Model selection also needs an explicit meaning: a model locked on a
Team card is the user's choice for that member and cannot be overridden by the
calling agent or silently replaced by a definition fallback.

This decision is implemented as one additive feature: shared contracts and
schema v27 persistence, Main launch composition and IPC, owner-scoped nested
runtime execution, and the per-session Team panel. Default Team-disabled
sessions retain ADR 0062's topology and contracts. The decision record below
describes final behavior rather than a proposed second agent framework.

## Decision

### 1. Team mode is opt-in per session and preserves the default topology

Team mode is disabled by default. With it disabled, the existing
L0 → L1 behavior, tool schemas, model override rules, lifecycle behavior, and
limits remain unchanged.

With it enabled, the only permitted Desktop-created delegation topology is:

```text
L0 main agent → L1 Team member → L2 Team member
```

L2 never holds delegation tools and can never start another Desktop agent
loop. Depth belongs to the owning runtime scope: L0 has depth 0, and a child
has its owner's depth plus one. It is derived only from in-memory owner
records, never from model output, tool arguments, persisted rows, launch
parameters, plugins, or user settings.

`MAX_DEFAULT_DELEGATION_DEPTH = 1` and `MAX_TEAM_DELEGATION_DEPTH = 2` are
fixed code constants. Launch input may enable Team mode, but cannot supply a
depth or raise either limit.

Independent guards are required at tool construction, Task execution, and
registry creation. A scope that cannot delegate is not expressible as a
nested Task scope; an execution-time assertion rejects invalid calls before
creating a record; and registry creation computes and checks the child depth
again. Contract-mode execution guards still apply. Resume and transcript
rebuild paths must not manufacture a deeper scope. The Team graph validates
owner chains for cycles or excessive depth and reports malformed data rather
than silently re-rooting it.

These limits govern agent loops created by PI-Desktop. A delegate with Bash
can start an external CLI only under the existing shell permission boundary;
such an external process is not made part of the Desktop delegation registry
by this decision.

### 2. Task tools are bound to their owner

The tool names remain `Task`, `TaskWait`, `TaskList`, and `TaskStop`, but their
meaning is scoped to the agent loop that owns them:

| Scope | Team disabled | Team enabled |
|---|---|---|
| L0 | Existing root Task family | Roster-only Task family; no `model` argument |
| L1 | No Task family | Owner-scoped nested Task family; no `model` or `resume` argument |
| L2 | Does not exist | No Task family |

Only roster members appear in a Team catalog. An empty effective catalog
provides no Task family. An L1 may start another instance of its own
definition; depth and start limits, rather than name exclusions, bound that
recursion.

Lifecycle operations see only records owned by the calling scope. An id from
another scope is indistinguishable from an unknown id. Default "all running"
selection likewise means only the caller's children. The explicit user stop
entry point remains different: it may address a delegation at any depth and
stops that node's whole subtree.

Delegation records carry `ownerDelegationId`, `depth`, child ids, and nested
start accounting. Aborting an owner aborts its descendants. Nested records
share the root turn's epoch, and transcript rows retain their existing
`parentToolCallId` attribution; `nestedParentToolCallId` keeps its existing
meaning and does not encode ownership or depth.

The root transcript card continues to show only L0's direct delegates and adds
a nested-count indicator when deeper work exists. An L1 detail view renders
that L1's own Task calls and their L2 fan-out. Neither view invents sibling or
peer-message edges; the displayed owner links come from persisted Task
attribution.

### 3. Parent-judged settlement applies at every owner

ADR 0166's rule is recursive, not root-only. L2 reports are delivered to the
L1 that owns them, while L1 reports continue to L0. Root idle-time delivery
and `TaskList`/`TaskWait` projections consider only root-owned records.

An L1 cannot settle while it has a running child or a settled child whose
report has not been delivered. When its model loop becomes idle with
outstanding children, the runtime waits for changes, supplies the joined
child reports and running heartbeat to that L1, and lets the L1 decide whether
to integrate, start more work within its budget, or stop children. Only an
idle L1 with no outstanding children settles. Stop, abort, or fatal failure
of an owner stops its subtree before its report settles.

As a defensive invariant, a record whose owner has settled while the record
is still running is aborted and diagnosed as an orphan. Conversely, a running
record requires an owner that has not settled.

`MAX_SUBAGENT_CONCURRENCY` remains a fail-fast, per-session cap of 10 running
delegates across all depths; waiting parents continue to occupy their own
slots. `MAX_NESTED_DELEGATIONS_PER_DELEGATE = 4` limits successful nested
starts by one L1 during one run. Rejected or failed starts do not consume that
allowance. There is no blocking semaphore and no new root start cap.

### 4. The host persists one bounded, revisioned roster per session

Schema v27 adds `session_team` additively to schema v26. One row holds the
session's `enabled` flag, a complete `roster_json` document, a host-owned
`revision`, and `updated_at`, keyed by `session_id` with `ON DELETE CASCADE`.
No row means disabled, no members, and revision zero, so existing sessions
need no backfill. Disabling Team mode retains the roster for a later enable.
Fork, copy, import, and configuration sync do not copy Team configuration in
v1; the new session starts disabled.

The roster document has `version: 1` and an ordered `members` array. A member
contains a definition name and an optional `{ providerId, modelId }` card pin.
There are at most 16 members. Names are normalized with
`normalizeSubagentName`, stored in normalized form, and must be unique after
normalization. Model ids are nonempty and bounded. The host validates roster
shape but does not require a name to exist in the independently changing
definition catalog.

`session.team.get({ sessionId })` returns the complete
`SessionTeamConfig`. `session.team.set` accepts optional `enabled` and
`members` replacements plus a required `expectedRevision`. Omitted fields
retain their current values. The host compares the expected revision and
performs the upsert as a compare-and-swap; a stale writer gets
`TEAM_REVISION_STALE` and no part of its update is applied. Every successful
write advances the revision and returns the new complete snapshot. Invalid
rosters fail with `TEAM_ROSTER_INVALID`.

An unknown roster version, unreadable JSON, or an invalid stored roster
degrades to `enabled: false` with an empty member list and a diagnostic while
retaining the stored revision. It never makes the session itself unloadable.
Main validates IPC updates with the shared schema before calling the host,
and the host validates again at its own trust boundary.

### 5. Main composes the launch roster and effective models

For an enabled local Team configuration, Main constructs a launch-only
subagent catalog in roster order. Missing, disabled, malformed,
model-unresolvable, and over-provider-budget members are excluded with launch
diagnostics. Source Markdown and source definition objects are not rewritten.

The effective model precedence is:

```text
Team card pin > definition pin > session model
```

A card pin replaces the effective definition's model and clears its
`fallbackModels`: a user-locked model must not silently degrade. A member
without a card pin retains the definition pin and its ordinary fallbacks;
without either pin it uses the session model. Existing credential resolution
and the distinct-pinned-provider cap still apply.

Team launch input is exactly `team: { enabled: true, revision }`. It carries
no depth or limit field. Main omits `subagentModelKeys` for a Team launch, so
there is no AI-delegation model override catalog. Correspondingly, Team Task
schemas at every depth omit `model`; supplying it is an error, not an ignored
argument. Team launch does not pass `Task.model` override keys at all.

Roster and enabled changes persist immediately but affect the next message.
A running turn retains the roster snapshot and stable tool declarations with
which it started, preserving ADR 0337's prompt-prefix rule. Editing a roster
or disabling Team mode does not implicitly stop running delegates.

### 6. Capability is monotonic through the nested tree

A delegate that cannot mutate the workspace may start only members that also
cannot mutate it. Mutation capability follows the existing
`subagentCanMutate` classification: any of Bash, Edit, or Write is mutating,
and `tools: inherit` is treated as mutating before resolution. The owner is
classified from its resolved launch tools; candidates are classified from
their declarations. If filtering leaves no eligible member, that L1 receives
no nested Task family.

This preserves ADR 0062's rule that mutation rights never flow from parent to
child. In particular, a read-only reviewer that consumed hostile content
cannot launder a destructive instruction through a write-capable sibling.

Every nested tool call still uses `tools.execute` with the existing host
containment, permission modes, hard denies, and definition permission scope.
Team mode adds no host capability and does not relax contract-mode guards.
Worktree allocation remains separate from mutation classification: only
Write and Edit trigger a delegate worktree, never Bash alone.

### 7. Other agent spawners stay outside the Team boundary

The Session Orchestrator plugin's `SessionTask` can create a worker session
outside the Team delegation registry. It is therefore forbidden for Team
delegates at both L1 and L2, including definitions using `tools: inherit` or
`tools: "*"`. Filtering uses plugin/tool identity or the plugin's
session-creation capability, not a localized display string. Any equivalent
spawner outside the registry is subject to the same prohibition.

Nested Task tools are constructed separately for an eligible L1 and never
enter the session's ordinary inheritable catalog. The existing subagent
inherit deny list and assignable set continue to exclude the Task family, so
inheritance cannot smuggle either nested Task tools or `SessionTask` into a
Team delegate. This Team-specific restriction does not change the existing
non-Team `tools: inherit` policy.

### 8. Resume remains root-only, and nested worktrees have one owner

ADR 0279 resume remains available at L0 only while the chain's member is in
the current roster. A removed member cannot be resumed. A resumed run uses
the current effective card/definition/session resolution; when that differs
from the previous binding, lifecycle details record the model change as they
do for an invalid recorded binding. Nested L1 scopes expose no `resume`
argument in v1.

Transcript chain rebuild considers only root-owned Task rows. An L1's nested
Task row is not promoted to a root-resumable chain. L1 history selection may
include its own nested Task result rows, but excludes the L2 rows already
represented by those results. Existing attribution remains sufficient; no
edge table or second lineage field is added.

For isolated sessions, ADR 0329 is extended as follows:

| L2 has Write or Edit | L1 owner has a worktree | L2 tool root | Settlement |
|---|---|---|---|
| no | either | the owner's tool root | none |
| yes | yes | shared owner worktree, routed through the owner key | merged once with the owner after its subtree settles |
| yes | no | a new L2-owned worktree | settled and merged by L2 through the existing delegate path |

An L2 sharing its owner's worktree never settles or merges that worktree. An
L2 without Write/Edit can see its owner's in-progress files. A stopped or
failed L2 with its own worktree retains it under the existing delegate rules,
but v1 offers no nested resume that would automatically reuse it. Non-isolated
sessions keep their current project-root and path-serialization behavior.
The same-message writable-delegation barrier also runs in an L1 loop against
that L1's own Task calls.

### 9. Contract surfaces are additive

The host adds `session.team.get` and `session.team.set`; renderer IPC adds
`IPC.invoke.sessionTeamGet` and `IPC.invoke.sessionTeamUpdate`, both in the
shared preload allowlist. Invalid IPC updates fail before host invocation,
`native-pi:` session configuration is rejected with `INVALID_ARGUMENT`, and
host errors retain their stable codes. v1 has no Team broadcast event; the
writer applies the returned snapshot and another window reloads on focus.

These additions do not change the Plugin SDK, RACP, or the JSON-RPC handshake
version. Schema v27 is an internal host storage migration. Native Pi and
remote sessions do not inherit a local Team roster.

## Implementation and validation

The implementation is split at the existing ownership boundaries:

- shared Team constants/types and IPC error codes;
- host-core `session_team`, schema v27, CAS writes, and Host RPC;
- Main roster/model launch composition, Native Pi rejection, and lineage-aware
  event persistence;
- runtime delegation registry/policy, owner-scoped tools, nested execution,
  L1 report barriers, cascade cancellation, and worktree ownership;
- renderer Team store/service, responsive split layout, roster/model cards,
  and the live graph with nested transcript navigation.

Deterministic runtime integration covers Team-disabled compatibility, depth
construction/execution/registry guards, owner-scoped lifecycle operations,
model rejection, capability monotonicity, spawner exclusion, the L1 settlement
barrier, cascade stop, root-only rebuild/resume, lineage, and all three nested
worktree cases. Host and Main tests cover migration, CAS, validation, roster
filtering, card pins, and provider budgets.

`pnpm test:e2e:team-mode` drives the production Team service, Main IPC, real
Host/SQLite and sidecar with local scripted SSE models through roster editing,
L0 → L1 → L2, rejected L3, live graph projection, subtree stop, and Host
restart. `apps/desktop/test/team-graph-user-path.test.mjs` verifies keyboard
navigation, L2 tab opening, and L1 stop through real Chromium interaction.
These checks use no paid provider. Broader candidate integration and legacy
subagent E2E suites remain required by the delivery policy; their results are
reported with the candidate rather than presumed by this ADR.

## Consequences

- Team mode buys one bounded extra level of context isolation and parallel
  work at the cost of more runtime state and potentially greater token use.
- Owner-scoped tools replace session-wide lifecycle assumptions; consumers
  that intentionally stop or count all delegates must explicitly traverse all
  depths rather than inheriting root-only behavior.
- A small versioned roster document avoids relational queries and preserves
  order, while CAS prevents concurrent windows from silently overwriting each
  other. Unknown future formats fail safe to disabled rather than breaking a
  session.
- Card pins make model cost explicit and deterministic but can make a member
  unavailable when its selected provider or model disappears; exclusion and
  diagnostics are preferable to silent fallback.
- The L1 settlement gate can keep a turn alive while descendants run, just as
  the root gate does today. Orphan cleanup and user-accessible subtree stop
  remain mandatory safety nets.
- Older Team-disabled sessions retain their behavior and require no roster
  rows. Older applications remain subject to the existing schema-version
  refusal policy rather than being asked to interpret v27.

## Alternatives considered

- **Expose depth as a Task argument, launch setting, or prompt rule.** Rejected:
  model-controlled or configurable depth cannot provide a hard ceiling.
- **Introduce a separate `SubTask` tool for L1.** Rejected: ownership belongs
  in tool binding, while a second name would split model guidance and
  transcript recognition without adding containment.
- **Keep one session-wide lifecycle view.** Rejected: L0 could then wait for,
  list, stop, or receive L2 reports that belong to L1.
- **Use a blocking concurrency semaphore.** Rejected: an owner holding a slot
  while waiting for descendants could deadlock; fail-fast caps avoid that
  cycle.
- **Allow read-only L1 agents to start write-capable members.** Rejected: it
  would escalate capability through delegation and defeat ADR 0062.
- **Persist rosters in renderer local storage or a relation/edge table.**
  Rejected: session configuration belongs to host-core and follows session
  deletion; a tiny whole-document roster needs no cross-session queries, and
  transcript attribution already records execution lineage.
- **Apply roster edits immediately within a running turn.** Rejected: it would
  change catalogs and tool declarations mid-turn, destabilize the prompt
  prefix, and give the model inconsistent instructions.
- **Let `SessionTask` remain inheritable in Team delegates.** Rejected: a
  registry-external worker session could run its own Task family and bypass
  the L2 ceiling.
