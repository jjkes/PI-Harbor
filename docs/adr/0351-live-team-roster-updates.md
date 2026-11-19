# ADR 0351: A stored Team roster change reaches the turn that is running

- Status: Accepted
- Date: 2026-11-19
- Deciders: PI-Desktop maintainers
- Related: ADR 0062, ADR 0279, ADR 0337, ADR 0338, ADR 0339, ADR 0343
- Amends: ADR 0338 §5 (roster and launch), ADR 0339 §3 (member sheet) and §5
  (launch composition), ADR 0343 (card and Batch model writes)

## Context

Team member settings are session-only and are stored by host-core on every edit,
revision-checked (ADR 0339 §4). Main reads that snapshot once per launch,
composes the effective roster from it, and hands the result to the runtime with
the prompt (ADR 0339 §5). The runtime then keeps that snapshot for as long as it
lives; the reuse match retires it only at the next prompt, when the stored
revision no longer matches (ADR 0338 §5).

That made a mid-turn edit invisible to the turn that was already running. A user
who switched a member's model while the main model was still replying saw the new
model only on the next message: every `Task` of the running turn still started
the member on the old pin, even though the edit was already stored and the member
card already showed the new one. Two sources of truth disagreed for the rest of
the turn.

The runtime cannot re-resolve the roster itself: credentials, the models.dev
catalog, vendor-account bindings, and the distinct-pinned-provider cap all live in
Electron main (ADR 0062, ADR 0339 §5). Rebuilding the runtime mid-turn is not an
option either — a turn owns its Agent, transcript and tool declarations.

## Decision

### 1. Main pushes the recomposed roster to a runtime that is already replying

`session.team.set` keeps its existing contract: host-core stores the update and
returns the new revision, and that reply is what the renderer sees. After the
write, Main asks the session's sidecar for its status. Only a runtime that reports
`isRunning` receives a push; an idle runtime needs none, because the next prompt
already carries the stored roster through the reuse match and retires the runtime
when the revision differs.

The push is `agent.updateDelegationLaunch` with the same fields a launch sends:
`subagents`, `subagentProviders`, `subagentModelKeys`, and `team` (or the opt-in
key list when Team is off). Main composes them with the one helper the launch also
uses (`resolveDelegationLaunchState`), so a pushed state cannot drift from a fresh
launch. The push is best effort: a failure is logged and never fails the update,
because the stored configuration stays the source of truth and the next launch
applies it.

### 2. The push replaces the whole delegation snapshot, not one field

`applyDelegationLaunch` swaps the roster, the pinned providers, the `Task.model`
opt-ins and the Team switches in one step, recomposes the base system prompt (the
delegation paragraph depends on the roster being non-empty) and rebuilds the tool
catalog. The `Task` description, the provider a new delegate starts on, and the
reuse match therefore describe the same revision. Applying only a model pin would
leave tools, thinking level and gates on the old revision and add a second code
path for "the same roster, half applied".

Nothing already running is touched: a delegate keeps the binding, transcript and
tool set it was launched with (ADR 0279), and a settled report is never rewritten.
Only a start observes the new state.

### 3. A mid-turn push may add credentials, never withdraw them

Vendor-account provider rows are bound to a session per launch, and the sidecar
refuses a row that is not bound. The push merges its rows into that set instead of
replacing it, so a member switched to a vendor-account model becomes usable
immediately while a delegate that is already running on another vendor account
keeps signing its requests. The next launch still replaces the set as before.

## Consequences

- A member's model, tools, thinking level, on/off switch, and the two quality
  gates apply to the next `Task` of the current turn. The member sheet no longer
  says "from the next message".
- Tool declarations can change in the middle of a turn. That is the existing
  mechanism for a tool-set change (`getToolStateChanges` appends a declaration
  message), and the system prompt is recomposed through the same section diff a
  mode switch uses, so an unchanged roster rewrites nothing (ADR 0337).
- The reuse match stays clean: after the push, `team.revision`, the roster and the
  provider map already equal what the next prompt sends, so the runtime is not
  retired for a change it has already applied.
- A member edited mid-turn can leave the catalog between two `Task` calls. That is
  the requested meaning of "switching a member off does not stop running
  members": the next start fails as an unknown subagent (ADR 0339 §7).
- One extra status read and, only while a turn runs, one roster composition per
  Team write. Neither touches MCP refresh, skills, instructions or the prompt.

## Alternatives

- **Rebuild the runtime on every roster write.** Loses the turn — Agent,
  transcript and running delegates — for a settings edit.
- **Let the runtime ask Main for the roster at spawn time.** Correct, but every
  `Task` pays a round trip while the catalog the model reads is still the one from
  launch; the push keeps prompt, tool description and start in agreement.
- **Have the runtime read `session.team.get` and resolve credentials itself.**
  Duplicates Main's credential, catalog and vendor-binding logic in the sidecar and
  crosses the ownership boundary of ADR 0062.
