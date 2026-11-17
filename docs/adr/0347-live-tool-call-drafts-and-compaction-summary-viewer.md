# ADR 0347: Live tool-call drafts and the compaction summary viewer

- Status: Accepted
- Date: 2026-11-17
- Related: ADR 0064 (the compaction divider this amends) ·
  [03-runtime/01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) ·
  [04-ux/08-component-spec](../spec/04-ux/08-component-spec.md)

## Context

The pi TUI shows a tool card as soon as the model starts streaming a call's
arguments and grows it live, executing once the arguments are complete.
PI-Harbor dropped the partial call: the runtime only forwarded text and
thinking from `message_update`, so a long Write produced no visible row until
`tool_execution_start`. Users read that silence as a hang or an error.

Separately, the compaction divider only exposed the model-written summary
through a native tooltip after a reload: the live `compaction_end` carried a
mark without the summary, and the row had no action.

## Decision

1. **Preview streaming tool calls as `tool_draft` events, display-only.** A
   per-response tracker in the runtime diffs successive partial argument
   snapshots into `set`/`append` changes and coalesces them on the same 16ms
   interval as text deltas, flushing before `tool_start` and lifecycle frames.
   A draft is never persisted and never executed. Execution is unchanged: one
   call, after `message_end`, with the final parsed arguments from
   `tool_start`; permission, mode, and extension hooks never see partial
   arguments. `complete` means written and waiting; `discarded` means the
   attempt failed, was aborted, or is being retried, so no row outlives its
   attempt. Subagent drafts ride the same path with `parentToolCallId`.
   RACP maps `tool_draft` to a non-durable `item.delta`, and a consumer that
   does not know the event ignores it and sees today's transcript.

2. **The compaction divider opens its summary in a dialog.** `compaction_end`
   now carries the checkpoint's model-written `summary` only when the mark is
   a real summary (never for a retained-tail fallback), matching what a
   reload reads from the durable record. A divider with a summary is a
   focusable button that opens a read-only dialog rendering the summary as
   Markdown, with copy, Escape/backdrop/close dismissal, and focus return. A
   fallback or no-summary row stays an inert separator: its recovery notice
   is never presented as a summary.

## Consequences

- A long Write/Edit is visible while it is written, with a live size and an
  expandable preview, instead of appearing only when it runs.
- Draft frames carry only newly streamed text, so a large file does not
  re-send its whole content per chunk (payload stays linear in final size).
- The draft row is the same row that later runs and settles; there is never a
  second row per call, and switching sessions mid-stream leaves no stuck draft.
- Component spec 8.4a and interaction patterns 3A change from "the row has no
  actions" to "a row with a real summary opens a read-only dialog".
- No change to upstream pi packages, the database schema, or execution
  semantics; Pi CLI native sessions, BTW side questions, and paired remote
  sessions are out of scope and behave as before.
