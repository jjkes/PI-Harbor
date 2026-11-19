# ADR 0350: Session progress reports are read-only snapshots collected outside the turn

- Status: Accepted
- Date: 2026-11-19
- Related: ADR 0175 (no progress card) · ADR 0312 (the TodoDock owns the session
  checklist) · ADR 0346 (BTW read-only side questions) · ADR 0073
  (`session.configure` stays idle-only) · ADR 0041 (host-core owns SQLite) ·
  ADR 0064 (no background request machinery) ·
  [03-runtime/01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) ·
  [03-runtime/04-data-storage](../spec/03-runtime/04-data-storage.md) ·
  [03-runtime/08-error-codes](../spec/03-runtime/08-error-codes.md) ·
  [04-ux/08-component-spec](../spec/04-ux/08-component-spec.md)

## Context

A long session has no cheap answer to "how far along is this?". The transcript
shows what happened; the TodoDock (ADR 0312) shows the agent's own checklist and
may be empty or stale; the live activity labels (ADR 0175, ADR 0198) only name a
phase. ADR 0175 rejected a permanent multi-step progress card because a turn has
no reliable step or percentage model, and nothing since has produced one.

The user asked for a small Composer control that, on demand or on an interval,
takes a snapshot of the session and asks a model for a fixed four-part report:
what is done, what is in progress, what comes next, and roughly how many steps and
how much time remain — with a history that survives a restart.

Three nearby surfaces already exist and none of them is this feature: the TodoDock
is agent-written and never written by anything else; BTW (ADR 0346) is a
free-form side question in a work-panel tab with no persistence; the live activity
labels are quiet phase text, not a report.

## Decision

1. **A core Composer control, not a plugin.** The trigger leads the bottom-left
   toolbar group of the Composer. The plugin outlet
   `ComposerControlSlots side="left"` renders after the mode and permission chips,
   so a plugin cannot own that position. Unlike model-written titles (ADR 0323),
   a report spends tokens only after the user opts in and changes nothing about
   the session, which is the reasoning that kept BTW in core.

2. **One tool-free `completeOneShot` call in Electron main.** The report runs as a
   single provider completion over a bounded digest of the *persisted* transcript,
   using the same credential resolution the plugin `agent.complete` API uses. It
   never loads, seeds, or observes the agent sidecar, so it works for a session
   that has no runtime loaded yet (for example after a restart) and cannot contend
   for the process that runs the main turn. This is the counterpart of ADR 0064:
   no queue, no scheduler, and no background request machinery is reintroduced in
   host-core or the sidecar.

3. **The digest is the only thing that leaves the machine.** Newest window cut at a
   turn boundary, 200 messages, a 6,000-token budget measured with the runtime's
   own estimator, per-message caps, tool results truncated to 240 characters,
   images and binaries replaced, thinking blocks omitted. The digest is never
   shown in the UI and is never stored, so a report cannot leak file contents
   later through the popover.

4. **The fixed format is enforced on the way out, tolerated on the way in.** One
   JSON object with `completed`, `inProgress`, `next`, `remainingSteps`,
   `remainingMinutes`, and `confidence`. The parser strips a code fence, takes the
   outermost object, accepts missing arrays, coerces numeric strings, clamps every
   list and number, and keeps the raw text when it cannot find a shape. An
   unparsed answer is still a stored row with `status: "unparsed"`, because hiding
   it would hide that a model keeps failing the format.

5. **Reports and settings are durable, host-owned rows** (`session_progress_reports`,
   `session_progress_settings`), schema v30 → v31, cascading on session delete,
   pruned to the newest 100 per session inside the insert transaction, idempotent
   per `run_id`. A report that already cost tokens must not disappear on reload.
   SQLite stays host-owned (ADR 0041).

6. **Automatic collection is a renderer timer with a pure decision function.** It
   stops with the window, adds no long-lived resource to main or the sidecar, and
   the whole decision table is unit-testable without a clock. The default is off,
   the default interval is 5 minutes, presets are 1/3/5/10/15/30, an automatic run
   never starts while the window is hidden, and three consecutive failures pause
   it until the user resumes.

7. **The report never writes the session.** No `agent.*`, no sidecar call, no
   `session.configure`, no transcript append, no turn slot, no unread mark, no
   toast, no native notification, and no entry into the per-session keyed
   serializer. The only write method the path calls is
   `progress.reports.append`. The table in the design document is what makes the
   guarantee real; the prompt's "answer only from the digest" line is advisory,
   exactly like BTW's read-only framing.

8. **The model choice is a per-session pair, not a session setting.** A report
   follows the session model by default; an explicit `{ providerId, modelId }` is
   stored in that session's `progress_settings` and never reaches
   `session.configure` (ADR 0073). Reports always request thinking `off` and
   1,200 output tokens, so a report is cheap and fast whatever the session's
   reasoning level is.

9. **No percentage and no progress bar.** The estimate is model-authored prose
   with a confidence badge, a "model estimate, may be off" note, and `null` when
   the digest does not support an estimate. ADR 0175's rejection of a step or
   percentage model still holds; a report is a snapshot, not a meter.

## Consequences

- Five additive invoke channels (`progress/collect`, `progress/cancel`,
  `progress/reports/list`, `progress/settings/get`, `progress/settings/set`) and
  eight `PROGRESS_*` error codes. No event channel: a collection resolves with its
  result, and the invoking renderer is the only consumer.
- A new privacy clause is needed: a built-in desktop feature now sends session
  context to a second model. Egress is explicit in the model view, off by default
  for automatic collection, and limited to the digest.
- Schema v31 is additive; existing sessions get no rows and read documented
  defaults without a write. A downgrade is refused by the `user_version` guard
  rather than mis-reading the new tables.
- The feature is a second consumer of `completeOneShot`, which keeps the plugin
  path's credential, OAuth, and provider-header handling as the single
  implementation.
- The design document records the two implementation deltas found while building:
  a fifth channel (`progress/settings/get`) is required because the popover must
  render the auto-collect state on open without starting a collection, and the
  report-model view lists catalog models directly instead of reusing
  `ComposerModelList`, whose select path configures the session (ADR 0073).

## Alternatives considered

- **A bundled plugin over `agent.complete`.** Cannot take the leading bottom-left
  position.
- **An ephemeral sidecar run seeded from `sideQuestionSnapshot()`, like BTW.**
  Needs a loaded runtime, adds sidecar RPC, and runs in the process that executes
  the main turn.
- **Prompt the session itself, or fork a child session.** Occupies the turn slot
  (ADR 0053), writes the transcript, and creates unread marks (ADR 0107).
- **Renderer memory or `localStorage` for history.** A reload would discard
  reports that already cost tokens, and neither cascades on session delete.
- **A timer in main or the sidecar.** Makes main a second scheduler and
  reintroduces what ADR 0064 removed.
