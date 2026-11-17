# ADR 0349: Live tool output, and the settled result as its summary

- Status: Accepted
- Date: 2026-11-18
- Related: ADR 0347 (streamed tool-call arguments, the same display-only rule) ·
  [03-runtime/01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) ·
  [04-ux/08-component-spec](../spec/04-ux/08-component-spec.md) ·
  [07-plugins/03-plugin-api](../spec/07-plugins/03-plugin-api.md)

## Context

ADR 0347 made a tool call visible while the model writes its arguments. What the
call then *does* stayed invisible: the transcript shows a running row with a
status and an elapsed clock, and the output appears only when the call returns.
For a build, a migration, a query against a large database, or a plugin that
narrates its own steps, that silence reads as a hang, and the reader cannot tell
a slow call from a stuck one.

Only a command shell had a live path. host-core's notifier streamed its
stdout/stderr over `tools.output`, the runtime turned that into `tool_update`
frames, and the renderer replaced the row's content — but the row only rendered
its body when the user opened it, and `tool_end` overwrote whatever had streamed
with the final result. Every other tool had no live path at all: plugin tools and
MCP server calls run in Electron main, which had no way to report progress it
could see, and the runtime only subscribed to `tools.output` when the tool was
`Bash`.

## Decision

1. **Every tool call can preview its own output, and only its own.** The runtime
   subscribes to `tools.output` for any call, keyed by
   `(sessionId, toolCallId)`; a `commandShellId` in the frame must still match
   the live shell, so a replaced shell's late chunk cannot land in the next call.
   host-core, which dispatches every tool, is the single authority for the frame:
   Electron main reports what the runner can see (a plugin child's
   `ctx.progress`, an MCP server's `notifications/progress` answered on that
   call's `progressToken`) through a new `tools.reportProgress` RPC, and
   host-core refuses any report whose call it is not currently dispatching,
   bounds each chunk, and caps reports per call. A server or plugin that reports
   nothing is indistinguishable from today's behavior.

2. **The preview is display-only, and the model still receives one result.**
   Partial output never becomes tool input, never reaches a provider request, is
   never persisted, and never decides a permission. It is bounded to 64Ki in both
   the runtime and the renderer, keeping both ends with an explicit marker, and
   the row says in its own localized badge when the body it shows was cut.

3. **A call that produced output opens itself and keeps its body.** The row
   derives its disclosure from the live body: the first frame opens it, it stays
   open after the call settles, and an explicit collapse wins for the rest of
   that call. A call that produced nothing stays closed, exactly as before.

4. **The settled result becomes the row's summary, not its body.** A row that
   streamed keeps the output the reader watched. The final payload then supplies
   the outcome the row head states (exit code, truncation, size, duration) and
   anything the stream never delivered — stderr that never arrived, an error
   note — without reprinting the text twice. A reloaded transcript has no live
   body, so it renders the durable result alone.

## Amendment (2026-11-18, D683): the running body is a command window

A live row that looks like a settled row with text in it is still ambiguous: the
reader cannot tell "this is arriving" from "this finished a second ago". So while
a call is running and has produced output, its body is painted as one terminal
surface — a chrome strip with a `$` prompt and the command as written (a
non-command tool shows `›` with its own name and summary) and a pulsing `running`
label, over a plate sunk below the page (`--ds-terminal-bg`, chrome
`--ds-terminal-chrome-bg`, prompt ink `--ds-terminal-prompt-ink`, all theme
tokens so a contributed theme keeps the surface in its palette). The pulse stops
under `prefers-reduced-motion`.

The surface is presentation only: it wraps the same block list, and it is gone
once the call settles, which leaves D227's unframed body as what history shows.
The distinction therefore lives in the row's live state, not in what the row
remembers.

## Consequences

- A long command or a slow remote tool is visible while it runs, in the language
  of a preview: what it has printed, how much, and whether the body was cut.
- The transcript does not gain a second row for a streamed call, and the row the
  reader watched is the row that settles.
- A settled live row can differ from the same row after a reload, because the
  durable result is authoritative; the head's outcome chips state that ending in
  both views.
- The MCP client now opts into progress per call. A server that ignores
  `progressToken` sees the same request it always saw, and a plugin that never
  calls `ctx.progress` is unaffected; both capabilities are optional, so the
  plugin SDK and MCP contracts stay backward compatible.
- Cost stays bounded: one frame per ~100ms per call, chunks capped at both ends
  of the pipeline, and a per-call report budget in host-core.
