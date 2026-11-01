# Unreleased changes

- Restore local Dictation. With Settings → Voice → Dictation enabled, a
  Composer microphone records, transcribes on this device, and inserts a
  draft that is never sent automatically. Filler words are removed by
  default; an optional bundled local model (Qwen3-1.7B, run in its own
  process) also drops self-corrections and repetition, and "Restore
  original" brings back the recognizer text. Models download from
  huggingface.co through the app network proxy and are verified against
  pinned SHA-256 hashes. Recording again after a finished dictation works,
  and cancelling during transcription no longer reports an error.
- Upgrade the Pi agent, model adapters, native-session SDK, and MCP client from
  1.3.0 to 1.4.0. Rebase the Desktop compatibility patches, keep Desktop's own
  client identity and provider headers authoritative over pi-ai's attribution
  defaults, and send pi-ai's detailed client `User-Agent` on Anthropic token
  requests.
- Report the bundled Pi kernel version in Settings → Info beside the app, host,
  and protocol versions. The value is read from the pinned
  `@earendil-works/pi-*` package at build time, so it follows the dependency
  instead of a hand-maintained constant.
- Choose the execution model at plan and goal approval. The approval bar adds a
  model and thinking-level picker beside the permission mode, remembers the last
  choice, and commits it to the session before the execution turn starts, so a
  strong model can plan and a cheaper one can implement.
- Show the session's subagents in the composer dock. The main conversation
  renders one summary line per Task activity part; activating it opens a live
  Main → L1 → L2 tree for the loaded session, with running delegates first, L2
  in dispatch order to the right of its caller, and a resumed delegate as one
  node. Each node opens its delegate's work-panel tab or stops it. The dock
  mounts for any active session; Todo and background tasks still require local
  tools, while the Subagent page can read a remote session's loaded Task rows.
- Add per-session Team mode. Switch it on from the composer's mode menu or the
  `toggleTeamMode` shortcut, where it combines with Agent, Plan, or Goal. In a
  local draft, the first Team choice creates the session and opens the dock's
  Subagent page without sending a message. The page's Members popover switches
  session members and opens their session-only model, reasoning, and tools
  sheet; role management remains in Settings. Team with no delegations shows
  an empty-state hint. With Team on, the main agent delegates first and can
  call only the members that are on. Nested delegation is structurally capped
  at L2, uses owner-scoped lifecycle tools and subtree stops, and leaves
  Team-disabled behavior unchanged. Team configuration and nested history
  persist across restart; remote-project drafts, Remote sessions, and Native
  Pi sessions cannot enable a local Team roster.
- Name the executing Goal in the composer dock. While an approved Goal is
  queued or running, a line above the dock's header shows its title and
  state, stays visible while the dock is collapsed, and opens the goal
  contract; it leaves when the run ends.
- Stop the composer dock from counting background tasks it no longer lists.
  Finished commands the dock never saw running, commands whose post-exit
  window closed, and removed rows no longer leave a tab, a count, a badge, or
  an empty dock behind.
