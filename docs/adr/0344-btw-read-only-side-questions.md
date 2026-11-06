# ADR 0344: Read-only BTW side questions about a session

- Status: Accepted
- Date: 2026-11-06
- Deciders: PI-Desktop maintainers
- Related: [ADR 0106](0106-core-five-builtin-commands.md) ·
  [ADR 0334](0334-openai-fast-mode.md) · [ADR 0268](0268-remove-quotes-annotations-and-side-chats.md) ·
  [ADR 0028](0028-session-scoped-work-panel-contexts.md) ·
  [04-ux/04-builtin-commands](../spec/04-ux/04-builtin-commands.md) ·
  [03-runtime/03-tools-and-permissions](../spec/03-runtime/03-tools-and-permissions.md) ·
  [06-delivery/04-e2e-test-plan](../spec/06-delivery/04-e2e-test-plan.md) · D680

## Context

Asking a question about a running conversation currently means either typing it
into the main turn, where it steers the agent, or starting another session,
which loses the context. ADR 0268 removed the earlier message-quote and side-chat
feature precisely because a second writable conversation duplicated the main
session's authority. What users still ask for is narrower: read the main
conversation and answer a question about it, without writing anything.

`/btw` fills that gap: a slash command that opens a read-only side-question tab
in the work panel, seeded from a snapshot of the main session's model-visible
context, and restricted to read tools.

## Decision

1. **`/btw` is a builtin and a work-panel tab.** `builtin.session.btw`
   (`/btw`) opens or focuses a per-session `btw` tab. `/btw <question>` also
   asks that question. The composer handles it after its send gate and before
   slash dispatch, so the steer shortcut cannot send a side question into the
   main turn. Remote sessions keep their existing behavior — slash dispatch does
   not run there, so `/btw …` stays ordinary prompt text.
2. **Only local desktop sessions qualify.** `btwAvailableFor` is a shared,
   fail-closed helper over both signals `isRemoteSession` reads: `source` must be
   `desktop` (a missing value normalizes to it) and the id must not start with
   `remote:` or `native-pi:`. Electron Main is authoritative; the renderer uses
   the same helper so it never offers a command Main would refuse.
3. **A side question is an ephemeral run, not a session.** Each question builds
   one pi-agent-core `Agent` seeded from a snapshot of the main session's
   `agent.state.messages` through the same `nextRequestDeclarations` the next
   main request would use, plus the main session's declared tools, provider,
   model, thinking level, and reason identity. The prefix is therefore identical
   to the main request; the restriction is applied at execution time, never by
   rewriting the transcript. Nothing is persisted and no session row is created
   (Q3).
4. **Read-only is enforced twice.** The runtime's tool gate admits only `Read`,
   `Glob`, and `Grep` and denies anything else with `TOOL_DISABLED_IN_READ_ONLY`
   before any host call. Host-core additionally accepts an optional
   `accessProfile: "read-only"` on `tools.execute`: it admits the same three
   tools inside the session's contained roots, denies every other tool, refuses
   anything that widens scope (`fileBatchTicket`, `delegationId`,
   `permissionScope`, `runInBackground`) with `INVALID_PARAMS`, never prompts for
   a decision, and records `accessProfile` in the audit payload. External paths
   are denied with `EXTERNAL_PATH_DISABLED_IN_READ_ONLY`. A caller that omits
   the profile keeps today's behavior.
5. **The UI is a thread in renderer memory.** A standalone `features/chat/btw`
   store, keyed by main session id and deliberately not a slice of
   `app-store.ts`, holds the turns, tool rows, usage, per-answer baseline, and
   draft. A pure reducer folds `BtwEventEnvelope`s and ignores unknown runs,
   superseded runs, and `seq <= lastSeq`.
6. **Staleness is computed in the renderer.** `started` carries
   `providerId`, `modelId`, and `mainTurnRunning`, not a context revision. At
   send time the renderer records the settled message count, the last settled
   message id, the compaction count, and whether the main turn was running; the
   answer footer compares that baseline against the live transcript and says
   whether the main conversation gained messages, was compacted, or was already
   mid-turn when the question was asked.
7. **One run per session, with a small tool budget.** A second question while
   one runs is refused in the UI and by `BTW_BUSY`. Tool rounds are counted per
   assistant message: past 8 the call is soft-denied with
   `BTW_TOOL_BUDGET_EXHAUSTED`, and at 10 the run ends with that code while
   keeping the partial answer.
8. **Own IPC, own lifecycle.** `pi-harbor/btw/ask`, `pi-harbor/btw/abort`, and the
   `pi-harbor/btw/event/message` event are separate from the agent channels, so
   the main transcript reducers, the runtime's active-tool tracking, and the
   outbox never see them. Main keeps a run registry: closing the tab, deleting
   the session, a renderer reload or crash, and app quit abort the run; a sidecar
   exit ends the active runs with `BTW_RUNTIME_EXITED`. A session archive does
   **not** abort, because Main has no archive event.

## Alternatives

- **A second real session (side chat).** Rejected: it duplicates session
  authority, needs persistence and a launcher, and is what ADR 0268 removed.
- **A restricted mode of the main session.** Rejected: a run that must not
  change the main turn cannot share that turn's agent, abort, or queue state.
- **Prompt-only restriction (no host profile).** Rejected: the prompt is advice,
  not a boundary; a model that calls `Write` would still reach the host.
- **Give the profile to `tools.workspaceExecute` too.** Not done: that is the
  paired-host runner, and the profile is enforced where the tool call is
  admitted. Documented as a known scope edge rather than a silent gap.

## Consequences

- A side question spends tokens like a prompt but never mutates the session, its
  files, or its persisted totals; usage is shown per answer only (Q5).
- BTW reuses the main session's provider/model/thinking level (Q6), so the shared
  prefix fits the same window; a snapshot that cannot fit even after trimming
  BTW history fails with `BTW_CONTEXT_FULL`, which asks the user to compact.
- No automatic provider retry: a retriable failure shows an error row with
  Retry, so a stale snapshot is never silently re-asked.
- Fast mode is not applied to BTW. Extension `transformContext` handlers are not
  applied either: the side question sees the model-visible request, not another
  extension's rewrite of it.
- Creating a runtime for a session that has none is serialized per session with
  a keyed serializer shared by prompt, compact, and BTW, because sidecar requests
  interleave across an `await`.
- The new builtin is additive; the registry grows from six to seven entries and
  no id ADR 0106 removed is reused.
