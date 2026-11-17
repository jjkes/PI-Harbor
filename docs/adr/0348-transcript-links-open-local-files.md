# ADR 0348: A Transcript Link Opens the Local File It Names

- **Status**: Accepted
- **Date**: 2026-11-17
- **Related**: [ADR 0019](0019-work-panel-subsystems.md) ·
  [ADR 0124](0124-temporary-session-scratch-workspace.md) ·
  [ADR 0163](0163-transcript-file-reference-chips.md) ·
  [ADR 0262](0262-chat-file-refs-open-in-the-file-view.md) ·
  [ADR 0263](0263-project-folder-roots-for-plugin-views.md) ·
  [ADR 0264](0264-host-mediated-actions-follow-the-browsed-folder.md) ·
  [04-ux/09-interaction-patterns](../spec/04-ux/09-interaction-patterns.md)

## Context

Completion (ADR 0262) searches the open project, the session's scratch store and
the attachment store, and the read guards (`fs/read`, `fs/open`,
`fs/reveal`) accept exactly those roots (ADR 0019). A reference that named
anything else was refused twice: `fs/resolveRef` answered
`reason: "outside-allowed-roots"`, and the transcript turned that into
"`/tmp/pi-draft-demo.txt` is outside the locations this app can access".

The refusal was honest about the guard but wrong about the user. An agent
writes wherever its task takes it — a draft in `/tmp`, a report in a sibling
checkout, a log in a download folder — and then prints the path. The file is
readable by the app, the user is the person who asked for it, and the click is
the most explicit instruction the app ever gets. Telling that user about an
access boundary they cannot grant is a dead end, not a protection: the only way
forward was to switch to a terminal and `cat` the file.

Widening every root would have been the wrong repair. Relative references are
completed by search, and a search that accepts an arbitrary directory turns a
shorthand into a guess about the whole filesystem. Ordinary reads also run
while a message renders (an inline image, a verified chip), which is content,
not intent.

## Decision

1. **Completion confirms, it does not refuse.** An absolute reference that
   resolves to an existing regular file outside every allowed root completes as
   `root: "local"`, addressed by its absolute path. Nothing else changes: a
   reference that names nothing still matches nothing, relative references are
   still searched inside the roots only (project, primary folder first, then
   session scratch, then attachments), and a remote workspace keeps answering
   its own file protocol, which cannot reach a path outside its root.

2. **The user's own open records a grant.** `fs/resolveRef` takes
   `open: true` for a reference the user is acting on — a click, a copy of its
   path, a reveal. That call confirms the file and remembers its canonical
   path. Verification during render passes no flag, so painting a transcript
   never widens what the app may read.

3. **The read guards accept a granted file.** `fs/read` serves a granted file
   before its root containment check, and `fs/open` and `fs/reveal` accept one
   after theirs. The grant names one canonical path, not a root: a neighbouring
   file in the same folder, the containing folder itself, and a spelling that
   now resolves somewhere else (a replaced symlink, a moved mount) all stay
   refused. The set is bounded and recency-ordered, and it lives in one process
   run, because a work-panel tab does not outlive it.

4. **One failure message remains true.** A local reference that names no file
   reports itself as missing. `reason: "outside-allowed-roots"` now only comes
   from a remote workspace, where the path is genuinely not on this computer.

## Consequences

- A transcript link, an inline-code path, a tool row's path, and a tool
  result's file list all open a local file wherever the agent wrote it, through
  the same opener and the same addressing (absolute path, host `file:` tab).
- The bundled file view is not used for these files: its project roots are the
  open project, and handing it an unrooted absolute path would show an empty
  tree. The host tab is the surface that can show one file without a tree.
- `.html` references outside the roots open in the host tab (source) by the
  existing rule, which keeps a page in the side browser only when the browser's
  own root contains it; the context menu's "open with default browser" remains
  the way to render such a page.
- Inline images outside the roots are still not previewed in the transcript:
  that read happens on render, so it is content-driven, and it gained no
  grant. Clicking such a reference still opens the image in the host tab.
- Security: the renderer can now ask for one file at a time, and only after the
  user acted on that exact reference. Writes, listing, search, and the plugin
  surfaces are untouched, and a plugin view still cannot reach any of it.

## Alternatives considered

- **Treat every root as open.** Simplest, but it makes shorthand completion
  search the whole filesystem and lets a rendered message read any path.
- **Ask the user for a folder grant per file.** An extra dialog between the
  user and the file they already asked for, on every click.
- **Reveal in the OS instead of opening in the app.** Half an answer: the user
  wanted to read the draft, not to find it.
