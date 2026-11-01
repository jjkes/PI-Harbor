# ADR 0340: Move the Team view into the composer dock

- Status: Accepted
- Date: 2026-10-29
- Deciders: PI-Desktop maintainers
- Related: ADR 0062, ADR 0279, ADR 0338, ADR 0339
- Amends: ADR 0338 §2 (delegation presentation) and its renderer Team panel,
  and ADR 0339 §1–3 (composer entry, member cards, and the member sheet)

## Context

ADR 0338 put the Team roster and a live delegation graph in a side panel, and
ADR 0339 moved Team enablement into the composer while making the panel's
member cards follow Settings. That left three presentation surfaces for the
same work: transcript delegation cards, the per-turn Team graph, and the
composer dock's session-wide subagent graph. The side panel also needed its
own width preference, rail, narrow-window drawer, and Topbar button.

The transcript cards consume substantial reading space and duplicate the dock.
The per-turn graph makes running work harder to follow across turns, while its
history navigation, token displays, and subtree folding add a second set of
graph interactions. Team member selection can use the existing dock without
reintroducing role management, which remains in Settings.

Team entry also had an unnecessary draft restriction. A local draft can be
materialized through the same session-creation path used by other composer
configuration actions, so choosing Team need not wait for a first message.

## Decision

### 1. The composer dock is the only Team agent view

The Team agent view lives on the **Subagent** page (the "N subagents" or Team
page) of the shared composer dock, not beside or inside the conversation. The
Team side panel is removed for every session, including its roster strip,
per-turn call graph, resizable width, narrow-window rail and drawer, and the
Topbar drawer button. MainChat no longer splits to accommodate a Team panel.

The dock is mounted for any active session. Todo and background-task sides
retain their local-tools requirement; the Subagent page depends only on the
loaded transcript, so a remote session can display its delegation tree. Team
being on makes that page visible even before the first delegation, with the
Main agent card and an empty-state hint to choose members and send a message.

### 2. The conversation shows one summary line per activity part

Subagent cards no longer appear in the main conversation, regardless of
whether Team is enabled. In grouped and flat display modes and in loaded
history, each activity part containing a `Task` fan-out renders one line
containing its aggregate label, subagent count, finished/total count, elapsed
time, a chevron, and a stop-all button while work is running. Aggregate outcome
changes use a polite live region, which speaks only when that outcome state
changes. Parent tools and lifecycle rows remain outside that delegation group.

Activating the line asks the shared dock to open on its Subagent page. This is
a one-shot dock-reveal request scoped to the session, with a 10-second
lifetime. The dock consumes it once, including when the dock mounts after the
request was made. The summary's stop action remains independent and does not
trigger the reveal.

### 3. One live tree covers the loaded session

The dock draws one tree for the whole loaded session rather than a graph per
turn. Its columns are:

```text
Main agent → L1 delegates started by Main → L2 delegates started by an L1
```

An L2 node is drawn to the right of the L1 that called it, with the first L2
row aligned to its caller's first row. L2 siblings follow in dispatch order.
L1 keeps its existing ordering: running and still-creating delegates first in
dispatch order, then settled delegates newest turn first and in call order
within a turn. A resumed delegate remains one node represented by its latest
call.

L2 status and timing are derived from the owning L1 run's Task and lifecycle
rows. Once that owner has settled, any leftover L2 state that still says
`running` is presented as aborted. A genuine delegate deeper than L2 does not
become an additional node; its owning L2 card carries the existing
depth-anomaly note. A runtime-refused Task call (error or denied, with no
delegation id) does not create or flag a deeper level.

Below 520px of dock-container width, the Main agent moves above the tree. L2
still remains to the right of L1, and the panel scrolls horizontally rather
than moving L2 below its caller. The tree grows from streamed transcript rows
and covers only the loaded transcript range. When the transcript reading range
leaves the live tail, the dock reads the live session instead so a running
delegate does not disappear while the user reads history.

### 4. Dock visuals are compact without changing the work panel

The dock tree uses narrower borders, tighter spacing, and smaller Main, L1,
and L2 cards, scoped to the dock panel. For sessions with local tools, either
L1 or L2 node activation opens or activates the corresponding existing
subagent work-panel tab. Running nodes retain their own stop action, and the
dock toolbar retains **Stop all subagents**. Stopping an L1 cancels its subtree.

The work-panel subagent tab, including its nested delegation cards, is
unchanged. The compact dock treatment does not alter shared transcript or
work-panel card styles.

### 5. Choosing Team in a local draft creates the session

Team remains a composer `menuitemcheckbox` that combines with Agent, Plan, or
Goal and is also available through `toggleTeamMode`. In a local draft,
choosing it no longer requires a first message: the action materializes the
session, enables Team with the existing first-enable roster seeding, and
requests the dock reveal on the Subagent page. Repeated activation while that
sequence is pending does not create another session.

Remote-project drafts do not offer Team, and remote and Native Pi
conversations do not acquire a local Team roster. This supersedes ADR 0339's
"available after the first message" rule. A failed materialization or Team
write reports a toast and withdraws the reveal request; if materialization
already succeeded, the empty session remains. Existing sessions retain
immediate member persistence with changes applying from the next message.

### 6. Member selection uses an anchored dock popover

Team sessions show a **Members n/m** button on the Subagent page toolbar:
`n` counts members enabled for this session and `m` counts roles enabled in
Settings; Settings-disabled roles are excluded from both counts. The button
opens an anchored, single-column popover listing every role from Settings.
Disabled-in-Settings roles remain last, dimmed, and unavailable to switch.
Clicking a row toggles that member for the current session. **Enable all** and
**Disable all** each perform one roster write; Enable all affects only roles
enabled in Settings.

A row's pencil closes the popover and opens the existing session-only member
settings sheet for model, tools, and thinking level. The sheet is portaled to
`document.body` with a backdrop; Escape closes it and focus returns to the
Members button. Role details remain read-only there, and role creation and
editing remain in Settings → Subagents, linked from the popover footer. The
popover's own Escape action likewise closes it and returns focus to Members.

Roster version 2, the member cap, first-enable seeding, serialized optimistic
writes, revision conflicts, and next-message launch semantics are unchanged.

### 7. The old graph's secondary interactions are not carried forward

The dock has no per-turn history pager or graph-internal older-turn loader.
It does not provide arrow-key navigation between nodes, token usage on nodes,
or collapsing an L1 subtree. Ordinary button keyboard activation, node detail
tabs, textual status, stop controls, and reduced-motion behavior remain.

### 8. Existing execution and persistence contracts remain authoritative

This is a renderer presentation and draft-entry decision. It does not change
Team's bounded L0 → L1 → L2 execution policy, owner-scoped tools, model and
capability rules, roster contents, IPC, Host RPC, Rust host-core, persistence,
or Plugin SDK contracts.

## Alternatives considered

- **Keep the Team side panel and add a second dock view.** Rejected: two live
  graphs and two roster surfaces would duplicate status, controls, responsive
  behavior, and accessibility ownership while continuing to consume transcript
  width.
- **Retain per-turn graphs.** Rejected: a session-wide tree keeps running and
  resumed work in one place and avoids making the user page through turns to
  reconstruct current fan-out. The loaded-range boundary is accepted instead.
- **Draw L2 below its L1 caller.** Rejected: a vertical nested layout repeats
  the space problem of the old panel and obscures the fixed Main → L1 → L2
  ownership topology. Horizontal columns preserve the caller relationship at
  both wide and narrow widths.
- **Move member selection entirely into Settings.** Rejected: enabling a
  member is session-scoped and belongs beside the live work, while role
  definition remains global in Settings. The popover keeps those responsibilities
  separate without a permanent roster strip.

## Consequences

- The conversation becomes shorter and has one consistent delegation treatment
  for Team and non-Team sessions. Detailed status and timing now require the
  dock or a subagent work-panel tab rather than an inline card.
- Enabling Team in a draft has an immediate durable effect: it creates and
  configures a session before any prompt is sent.
- A settled L1 can move behind running L1 nodes under the existing ordering,
  carrying its L2 group with it. The first L2 can also introduce a new column;
  neither change alters execution order.
- Remote sessions gain a delegation tree when their loaded transcript contains
  the necessary Task rows, without inheriting local Team enablement or the
  local-tool dock sides.
- Removing the side panel also removes its layout preferences and specialized
  graph interactions. Existing role definitions, member settings, and Team
  execution data remain usable without migration.
- The `.tool-activity-group` card frame, with its `content-visibility` rule and
  collapse styles, existed only for the inline subagent card and is removed
  with it. Ordinary activity groups already rendered through
  `ProcessActivityGroup` and are unchanged.

## Compatibility

No IPC channel, Host RPC method, Rust code, persistence schema, or Plugin SDK
surface changes. In particular, the `session.team` configuration and roster
version 2 document are unchanged. Existing sessions need no data migration.
The old `pi.desktop.teamPanelWidth` and `pi.desktop.teamRosterCollapsed`
localStorage keys are no longer read; leftover values are harmless and need
no cleanup. Team-disabled execution keeps its prior runtime behavior. The
change is limited to renderer composition, draft materialization through
existing session actions, and presentation of already persisted transcript
and Team configuration data.

## Accepted risks

- Choosing Team in a draft that is never sent leaves an empty session in the
  sidebar.
- A first message sent immediately after choosing Team can race the Team write
  and start without the intended Team configuration; no new synchronization
  mechanism is added by this decision.
- The dock draws only the loaded transcript range, so delegations outside that
  range are absent until their rows are loaded.
- Whether remote sessions supply Task rows that this renderer can attribute
  into the same tree is unverified. Remote rendering is therefore conditional
  on those rows being present and attributable; missing rows cannot be
  reconstructed into nodes.
