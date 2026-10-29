---
title: Team mode
description: Build a per-session subagent roster, lock member models, and inspect bounded nested delegation.
---

# Team mode

Team mode gives one local Desktop conversation a selected subagent roster and a
live delegation graph. It also permits one additional, strictly bounded level
of delegation: the Main agent (L0) can start an L1 member, and that L1 can
start an L2 member. L2 never receives delegation tools.

Remote and Native Pi conversations are not eligible. With Team mode off,
existing sessions keep their previous single-level behavior.

## Enable and edit the roster

Use **Team mode** in the conversation top bar, or the configurable
`toggleTeamMode` shortcut (Ctrl/Cmd+Shift+T by default). The first enable seeds
all currently enabled subagent definitions in catalog order. Disabling Team
mode keeps the roster for the next enable.

Open the roster manager to add or remove members. Each member card has its own
model selector:

- **Definition default** keeps the definition's pin and ordinary fallbacks, or
  inherits the session model when the definition is unpinned.
- An explicit card choice locks that provider/model and clears definition
  fallbacks. The calling agent cannot override it through `Task.model`.

Only roster members are schedulable. Missing, disabled, unresolvable, or
over-budget members are excluded at launch with diagnostics. An intentionally
empty roster leaves the Main agent working alone.

Roster and enabled edits save immediately but apply to the next message. They
do not rewrite a running turn's catalog or stop its existing delegates.

## Follow and control the work

The graph shows actual delegations, not merely roster cards. It displays Main
→ L1 → L2 with each node's model, status, duration, and nested count. Turn
arrows browse loaded history; **Back to live** returns to the latest turn.

Select a node to open its existing subagent work-panel tab. Keyboard users can
move through the tree with the arrow keys and Home/End, then press Enter or
Space. A running node's **Stop** cancels that node's complete subtree.

L1 reports are delivered to L0 only after its own children have reported back.
The graph and the roster are rebuilt from the persisted transcript and session
configuration after restart. A failed Task call that never started an agent is
not drawn as a delegation node.

For safety and cost control:

- at most two delegation levels are allowed, independent of model instructions;
- one L1 can start at most four children per run;
- the existing session-wide limit of 10 running delegates counts all depths;
- a read-only L1 can start only read-only members.

## Adjust the layout

The Team panel sits to the left of the transcript and Composer. The
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
