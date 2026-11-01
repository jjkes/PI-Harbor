---
title: Team mode
description: Turn on a team of subagents for one conversation, set each member up for the session, and inspect bounded nested delegation.
---

# Team mode

Team mode turns one local Desktop conversation into a team. The Main agent
(L0) splits your request into bounded tasks, delegates them to the members you
switch on, and checks their reports. One more, strictly bounded level of
delegation is allowed: an L1 member can start an L2 member, and L2 never
receives delegation tools.

Remote and Native Pi conversations cannot enable a local Team roster, and a
remote-project draft does not offer Team. With Team mode off, sessions keep
their previous single-level behavior.

## Turn Team on

Open the mode menu under the composer, the chip that shows Agent, Plan, or
Goal, and choose **Team**. The configurable `toggleTeamMode` shortcut
(Ctrl/Cmd+Shift+T by default) does the same. Team combines with any of the
three modes, and the chip shows a small Team badge while it is on.

Choosing Team in a local draft creates the session immediately; no first
message is needed. The composer dock opens on its **Subagent** page. If you
leave without sending a message, the empty session remains in the sidebar.

The first time Team is turned on in a conversation, every subagent role that is
enabled in Settings is switched on. Turning Team off keeps the members and their
settings for the next time.

## Choose members

On the dock's Subagent page, **Members n/m** reports the number of members
switched on for this session against the number of roles enabled in Settings.
Its popover lists every subagent role defined in **Settings → Subagents**,
including Settings-disabled roles at the end. Click a row to switch that member
for this conversation. **Enable all** and **Disable all** change every eligible
row; Enable all skips roles disabled in Settings.

Roles are created, edited, and deleted in Settings, not in the popover. A role
disabled in Settings stays listed, dimmed, with its switch disabled. A role
created later starts switched off in existing Team conversations. **Manage
roles in Settings** opens Settings → Subagents.

## Set a member up for this conversation

Select a row's pencil to open its member sheet. **Role settings** shows the role
as Settings defines it: description, instructions, model, reasoning, tools,
and, for built-in roles, the permission scope. **Edit role in Settings** opens
Settings → Subagents.

**This session only** changes the member for this conversation:

- **Model:** follow the role, or choose a provider/model. A chosen model also
  clears the role's fallback models, and the Main agent cannot override it.
- **Reasoning:** follow the role, or choose a level. The level is still capped
  by what the model supports.
- **Tools:** follow the role, or choose a custom set of tools, optionally with
  **Inherit parent tools**. Granting a write tool makes the member
  write-capable for this conversation, and the sheet says so.

Changed fields are marked **Modified**, and **Reset to role defaults** clears
them. These settings never change the role or other conversations, and a
member keeps them while it is switched off. Changes to members and their
settings save immediately and apply from the next message. They do not stop
members that are already running. Escape closes the sheet and returns focus to
the Members button.

A member that is off, disabled in Settings, unresolvable, or over the provider
budget cannot be called. With no member on, the Main agent works alone.

## How the Main agent works with the team

With Team on, the Main agent delegates by default. It works directly only on
questions for you, the lookups it needs to write a brief, integrating reports,
and final verification. It calls only the members that are on, gives each a
self-contained brief, runs independent tasks in parallel, and has each report
checked by itself or another member, because a member never accepts its own
output. Members stay within the requested scope and return decisions that need
you to the Main agent. Other agent-spawning tools, such as the Session
Orchestrator's `SessionTask`, are unavailable to the Main agent while Team is
on.

## Follow and control the work

Each Task fan-out in the conversation has one summary line with its aggregate
state, counts, and elapsed time. Select the summary to open the composer dock
on Subagent; its stop control remains independent.

The dock draws one live tree over the loaded session, not a separate graph per
turn. It displays Main → L1 → L2, with L2 to the right of the L1 that called
it. Each node shows its model, status, duration, and step count. Select a node
to open or activate its existing subagent work-panel tab. A running node's
**Stop** cancels that node's complete subtree, and **Stop all subagents** is in
the toolbar. The tree has no per-turn pager, arrow-key node navigation, token
usage, or L1 subtree folding.

Below 520px of dock-container width, Main moves above the tree while L2 stays
to the right of L1; scroll the panel horizontally when needed. Delegations
outside the loaded transcript range do not appear until their rows are loaded.
Remote sessions can use the same Subagent page when their loaded Task rows are
present and attributable, without gaining a local Team roster or the local Todo
and background-task sides.

L1 reports are delivered to L0 only after its own children have reported back.
The tree and member settings are rebuilt from the persisted transcript and
session configuration after restart.

For safety and cost control:

- at most two delegation levels are allowed, independent of model instructions;
- one L1 can start at most four children per run;
- the existing session-wide limit of 10 running delegates counts all depths;
- a read-only L1 can start only read-only members.

[中文说明](/zh-CN/guide/team-mode)
