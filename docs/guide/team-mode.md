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

Remote and Native Pi conversations are not eligible. With Team mode off,
sessions keep their previous single-level behavior.

## Turn Team on

Open the mode menu under the composer, the chip that shows Agent, Plan, or
Goal, and choose **Team**. The configurable `toggleTeamMode` shortcut
(Ctrl/Cmd+Shift+T by default) does the same. Team combines with any of the
three modes, and the chip shows a small Team badge while it is on. In a new
conversation, the item becomes available after the first message.

Turning Team on shows the Team view to the left of the conversation. In a
narrow window it opens as a drawer, and the panel button in the top bar shows
or hides it again without turning Team off.

The first time Team is turned on in a conversation, every subagent role that is
enabled in Settings is switched on. Turning Team off keeps the members and their
settings for the next time.

## Choose members

The Team view shows one card for every subagent role defined in **Settings →
Subagents**. A card's switch decides whether the Main agent can call that member
in this conversation. Roles are created, edited, and deleted in Settings, not
in the Team view. A role disabled in Settings stays listed, dimmed, with its
switch disabled. A role created later starts switched off in existing Team
conversations.

The heading above the cards shows how many members are on. Select it to
collapse the cards and give the graph more room; the choice is remembered.

## Set a member up for this conversation

Select a card to open its member sheet. **Role settings** shows the role as
Settings defines it: description, instructions, model, reasoning, tools, and,
for built-in roles, the permission scope. **Edit role in Settings** opens
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
members that are already running.

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

The graph shows actual delegations, not the member cards. It displays Main →
L1 → L2 with each node's model, status, duration, and nested count. Turn arrows
browse loaded history; **Back to live** returns to the latest turn.

Select a node to open its existing subagent work-panel tab. Keyboard users can
move through the tree with the arrow keys and Home/End, then press Enter or
Space. A running node's **Stop** cancels that node's complete subtree.

L1 reports are delivered to L0 only after its own children have reported back.
The graph and the member settings are rebuilt from the persisted transcript and
session configuration after restart. A failed Task call that never started an
agent is not drawn as a delegation node.

For safety and cost control:

- at most two delegation levels are allowed, independent of model instructions;
- one L1 can start at most four children per run;
- the existing session-wide limit of 10 running delegates counts all depths;
- a read-only L1 can start only read-only members.

## Adjust the layout

The Team view sits to the left of the transcript and composer. The
conversation keeps at least 450px:

- **716px or more:** an inline, resizable Team panel (320px by default, 260px
  minimum);
- **500–715px:** a 44px rail with a panel opener;
- **below 500px:** the panel leaves the flow and opens as a drawer from the top
  bar.

Drag the separator or use its arrow keys to resize. Your preferred width is
shared across sessions and preserved across restarts; temporary responsive
collapsing does not overwrite it.

[中文说明](/zh-CN/guide/team-mode)
