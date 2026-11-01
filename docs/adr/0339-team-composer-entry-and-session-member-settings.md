# ADR 0339: Team composer entry and session member settings

- Status: Accepted
- Date: 2026-10-29
- Deciders: PI-Desktop maintainers
- Related: ADR 0062, ADR 0246, ADR 0337, ADR 0338
- Amends: ADR 0338 §2 (Team Task steering), ADR 0338 §4 (roster document),
  ADR 0338 §5 (launch composition), and ADR 0338 §7 (agent spawners at L0)
- Amended by: ADR 0343 (draft Team entry, dock-only Team view, member popover,
  and session-wide delegation tree)

## Context

ADR 0338 introduced Team mode before it shipped in a release. Using it showed
three problems.

- **The entry point sat apart from the other modes.** Team was an icon toggle
  in the conversation top bar, while Agent, Plan, and Goal are chosen in the
  composer's mode menu. Turning Team on in a narrow window also left the Team
  view behind a rail.
- **The roster duplicated role management.** Roles are defined in Settings,
  but the Team view also added and removed members and locked models on each
  card. Two places curated the same list, and the cards spent most of the
  panel's height that the call graph needs.
- **The prompts worked against delegation.** With Team on, the main agent
  still received the non-Team `## Delegation` text ("do the work yourself by
  default"), the Team `Task` description said to prefer doing the work
  directly, and the main agent's catalog still contained `SessionTask`, which
  starts agents outside the Team roster.

## Decision

### 1. Team is a composer switch that combines with any mode

The composer mode menu keeps its three `menuitemradio` items. Below a
separator it adds a `menuitemcheckbox` named Team that shows whether Team is
on for the session, together with the `toggleTeamMode` shortcut. Choosing it
runs the same session action as the shortcut. The `Mode` contract is
unchanged: Team combines with Agent, Plan, or Goal. While Team is on, the mode
chip shows a small Team badge and its accessible name says that Team is on.

Before the first message there is no session to switch, so the item is
disabled and explains that Team is available after the first message. Remote
and Native Pi conversations do not show the item, as they did not show the
top-bar toggle. The top-bar Team toggle is removed. The narrow-window drawer
button stays in the top bar; it only shows or hides the Team view and never
switches Team.

Switching Team on records a one-time reveal for that session before the host
answers. `TeamLayout` consumes it once it has measured MainChat: an inline
layout already shows the panel, and a rail or hidden layout opens the drawer.
Switching Team off or a failed switch clears the reveal. The composer item and
the shortcut take the same path.

### 2. Member cards follow the Settings roles and only switch members

The Team view shows one card for every role defined in Settings, built-in and
user-owned. Cards cannot be added, removed, or managed from the Team view, so
the manager sheet is removed. A card shows a status dot, the role name, a
read/write marker, a marker for session settings, and a switch that turns the
member on or off for this session. Opening the card opens the member sheet.

A role disabled in Settings stays listed after the usable roles, dimmed, with
its switch disabled and the status "Disabled in Settings". A role without a
roster entry is an off card, so a role created later starts off in existing
Team sessions. The first enable still seeds every role enabled in Settings, as
ADR 0338 specified.

The card area is compact. A heading row shows a collapse control, the number
of members on out of the total, and the running count. Expanded, the cards
form a grid of about three rows that scrolls within the area. Collapsed, only
the heading row remains and the call graph takes the rest of the panel. The
collapsed state is an app-wide preference stored next to the panel width.

### 3. The member sheet shows the role read-only and edits this session only

The member sheet is a modal dialog. It can open above the narrow-window
drawer, so it claims Escape and Tab before the drawer's focus trap does, and
focus returns to the card that opened it.

The role section is read-only: description, instructions (collapsed by
default; a user-owned role's document is read when the sheet opens, and a late
answer for another role is discarded), model, reasoning, tools, and, for
built-in roles, the permission scope. "Edit role in Settings" opens
Settings → Subagents.

The session section edits the model (the provider-bounded choice the card lock
used), the reasoning level, and the tools: follow the role, or a custom
choice over the assignable tools plus `inherit`, with at least one entry.
Changed fields are marked, and "Reset to role defaults" clears all three. The
section states that its settings apply from the next message, do not change
the role, and do not stop running members. Each edit is stored at once
through the existing optimistic, revision-checked Team service path.

A custom tool choice can make a read-only role write-capable for the session,
and the sheet says so. The card's read/write marker, the write lock, worktree
allocation, and ADR 0338 §6's read-only-starts-read-only rule all follow the
tools after session settings. The permission scope still comes from the role.

### 4. Roster document version 2

`SessionTeamMember` gains optional session settings:

```ts
type SessionTeamMember = {
  agent: string;
  enabled?: boolean; // omitted means on; every version 1 member reads as on
  model?: SubagentModelPin;
  tools?: TeamMemberToolGrant[]; // assignable tools or "inherit", unique, 1..8
  thinkingLevel?: SubagentThinkingLevel;
};
```

The host writes `version: 2` and reads versions 1 and 2. It stores
`enabled: true` as an omitted flag and stores tools with `inherit` first and
the rest in catalog order. Tool names must be on the host's assignable list,
and thinking levels must be valid session thinking levels. An invalid update
is rejected as a whole with `TEAM_ROSTER_INVALID`. The 16-member cap, the
revision rules, and ADR 0338 §4's degrade path for unknown versions are
unchanged. There is no SQL migration; the schema stays at v27.

The renderer edits one member at a time with
`updateMember(session, agent, patch)`, where `null` clears a setting. A
missing entry starts as an off member, an entry that ends up off with no
session settings is removed, and new entries are appended so the Task catalog
keeps its order. Only a roster above the cap loses entries, and then only
entries of roles that no longer exist, oldest first and never the edited one;
otherwise the edit fails with `TEAM_ROSTER_FULL`. An edit that changes nothing
writes nothing. `updateMember` replaces the add, remove, and model-lock
operations.

### 5. Launch composition applies session settings to a copy

Main skips a member whose `enabled` is `false` without a launch diagnostic,
because the user turned it off. For the other members, the shared
`applyTeamMemberSettings` helper is the only place where session settings
meet a role, and it works on a copy:

- A session model replaces the definition's model and clears its fallbacks,
  as the card pin did. The precedence is unchanged: session member model >
  definition pin > session model.
- A tool choice becomes `tools` and `inheritTools`, keeping only assignable
  tools. When no usable entry remains, the role's own tools apply and Main
  records a diagnostic.
- A session thinking level replaces the definition's level, and the existing
  per-model clamp still applies when the member starts.

Source definitions and Markdown are never rewritten. The Task catalog lists
exactly the members that are on for the session, enabled in Settings, and
launchable.

### 6. Team mode steers the main agent toward delegation

The system prompt depends only on `team.enabled`, never on the roster, which
keeps ADR 0337's stable prefix. With Team off, the prompt is byte-identical
to before; the `## Delegation` text moves unchanged into
`delegation-guidance.ts`. With Team on, a `## Team mode` section replaces it,
and the delegation model-override summary is omitted because Team `Task` has
no `model` argument. The roster still appears only in the `Task` description.

The `## Team mode` section makes the main agent a coordinator. It splits the
request into bounded tasks, delegates them to the listed members, and
integrates and verifies their reports. It works directly only on questions
for the user, the brief lookups needed to write a brief, integration, and
final verification, or when no member fits. It calls only the listed members,
matches tasks to each member's tools, and keeps the fixed structure: depth
L0 → L1 → L2, at most four starts per member run, and read-only members
starting only read-only members. Briefs are self-contained, independent tasks
start together and converge with `TaskWait`, work is not duplicated, and two
write-capable members never get the same files at once. Reports are verified;
a member never accepts its own output; one review pass is the default, with
no agent debates. Members stay in scope, and out-of-scope changes and
decisions for the user come back to the main agent.

The L0 Team `Task` description defaults to delegation and no longer says to
prefer doing the work directly. The L1 `Task` description and the Team-only
delegation sentence of the member prompt say that a member owns its result,
delegates only clearly separable and substantial parts, cannot be delegated
to by its sub-members, starts at most four of them per run, and converges with
`TaskWait` on every child before finishing. Team L1 and L2 system prompts add
that a member stays in scope and does not treat its own output as accepted.
Prompts of non-Team subagents are byte-identical.

### 7. The main agent also loses agent spawners outside the registry

With Team on, `rebuildToolCatalog` removes registry-external agent spawners
such as `SessionTask` from the main agent's catalog as well. The ToolSearch
deferred set derives from that catalog, so ToolSearch cannot load them either.
Switching Team off restores them. The member-side filter of ADR 0338 §7
remains as a second guard.

A member that is off for the session, or disabled in Settings, is not in the
catalog. `Task` resolves the definition before `resume`, so a call or a resume
for such a member fails as an unknown subagent without starting an agent loop.

## Implementation and validation

- Shared: `packages/shared/src/team.ts` adds the member fields, their schema,
  `isTeamMemberEnabled`, `teamMemberHasSessionSettings`, `teamMemberToolGrant`,
  and `applyTeamMemberSettings`.
- Host: `session_team` writes roster version 2, reads versions 1 and 2, and
  normalizes and validates the new fields.
- Main: `team-launch.ts` skips switched-off members and applies session
  settings through the shared helper.
- Agent runtime: `delegation-guidance.ts`, the Team `Task` descriptions in
  `team-policy.ts`, the Team-only member prompt wording in `subagent.ts`, and
  the L0 spawner exclusion in `runtime.ts`.
- Renderer: `team-roster-model.ts`, `updateMember` in the Team service, the
  layout store's collapse preference and reveal, `TeamLayout`, the compact
  `TeamRosterStrip` and `TeamMemberCard`, `TeamMemberSheet`,
  `TeamMemberOverrides`, `useComposerTeamMode`, and the composer mode picker.
- Tests cover the shared schema, host normalization and rejection, launch
  composition, prompt byte-identity and the L0 spawner boundary, the roster
  model, the service, the layout store, the composer item and chip, the
  cards and member sheet, and the top bar. `pnpm test:e2e:team-mode` checks
  across processes that a switched-off member is absent from the Task catalog
  while keeping its settings, that session tools, model, and thinking level
  reach the launch copy and the real model requests, that the source
  definition is unchanged, and that the main agent receives `## Team mode`.

## Consequences

- Settings is the only place that defines roles. The Team view switches
  members and tunes them for one session, so the two cannot drift.
- Session settings persist with the session and survive a restart, as card
  locks did, and they never affect other sessions.
- A session tool choice can widen a role's capability for one session. The
  member sheet warns when it does, and every capability rule follows the
  widened tools.
- With Team on, the main agent cannot use `SessionTask`. Users who need it
  switch Team off.
- While the mode chip is disabled, for example during a pending approval, the
  Team item cannot be reached from the menu; the shortcut still works.
- Development builds between ADR 0338 and this change read a version 2 roster
  as unknown and show Team off. Re-enabling Team there writes a version 1
  roster and loses the session settings. No released build contains Team.
- Sessions with Team off keep byte-identical prompts, tools, and subagent
  behavior.

## Alternatives considered

- **Make Team a fourth mode.** Rejected: Team combines with Agent, Plan, and
  Goal, and a fourth value would change the `Mode` contract.
- **Keep adding and removing members in the Team view.** Rejected: it keeps a
  second list of roles that drifts from Settings.
- **Edit role definitions from the Team view.** Rejected: a role edit changes
  every session, which is Settings' job.
- **Put the roster in the system prompt.** Rejected: it would break ADR 0337's
  stable prefix whenever a member is switched.
- **Keep `SessionTask` for the main agent.** Rejected: it starts agents
  outside the roster, the depth limit, and the capability rules.
- **Let session settings expire on restart.** Rejected: card locks already
  persisted, and losing settings on restart would surprise users.
