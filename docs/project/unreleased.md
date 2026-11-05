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
  1.3.0 to 1.5.0. Rebase the Desktop compatibility patches, keep Desktop's own
  client identity and provider headers authoritative over pi-ai's attribution
  defaults, and send pi-ai's detailed client `User-Agent` on Anthropic token
  requests. Tool arguments are now validated with Pi's schema validator, so MCP,
  plugin, and extension tools get the same numeric-string and single-value
  coercion as built-in tools. Trusted extensions that import `Type` or
  `StringEnum` from `@earendil-works/pi-ai` keep working.
  Desktop's own ToolSearch now matches Chinese, Japanese, and Thai queries
  written without spaces, plus full-width text; English results are unchanged.
  Trusted-extension `pi.exec()` no longer corrupts a multibyte character split
  across output chunks, and reports `truncated` when `maxBuffer` cuts output.
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
- Fixed the composer context ring staying at the pre-compaction figure after
  `/compact` or an automatic compaction until another turn ran (#2015). The
  ring now shows the compacted context's estimated size as soon as the
  checkpoint is installed, and after reopening the session.
- Fixed prompt cache misses after a conversation's agent runtime is rebuilt
  (#1972). Rebuilding happens after a restart or when the thinking level, mode,
  project rules, or model settings change. Assistant replies now keep the
  provider's thinking, reasoning, and Gemini function-call signatures in the
  transcript, so Claude, OpenAI Responses, Gemini, and other reasoning models
  receive the same history as before the rebuild instead of a rewritten one.
- Fixed duplicate `/、` when opening slash commands with a Chinese IME in an
  empty composer. Keep pre-edit text intact and apply the slash alias only
  after composition commits, preserving recovery from a missing end event.
- Add OpenAI Fast mode (#1657). Allow it per model in Settings → Models for a
  ChatGPT subscription or an OpenAI Responses connection, then type `/fast` to
  turn it on for the current conversation. Requests ask for the priority
  service tier, which replies faster and spends plan limits faster or bills
  more per token; the Composer model chip shows a Fast mark while it is on.
- Fixed an older regenerated prompt appearing after the latest reply when its
  branch archive completed outside the loaded history window (#1870). Pager
  acknowledgements now update existing rows without appending historical roots.
- Generate inline visualizations faster. The visualization shell now preloads
  the bundled D3 and a `viz` chart helper layer (container sizing, resize and
  theme redraw, axes, tick overlap, legends, and a declarative `viz.render`
  for bar, line, area, point, heatmap, and donut charts), so model-written
  fragments are shorter. The `visualize` skill asks for a single write
  followed by the reply instead of reading the file back. Fragments written
  under the earlier skill keep rendering. When a fragment's script fails, the
  card now says so and shows the error instead of staying blank, and the
  model's write result flags syntax errors and missing chart containers so it
  can fix them with one edit.
- Fixed cramped inline visualizations. The visualization shell now places a
  fragment in the kit's `#widget` container, which spaces its top-level blocks
  12px apart, and the `visualize` skill asks for the title, controls, chart,
  legend, and captions as top-level blocks instead of one wrapping element.
  Inline controls, block styling, and roots that lay themselves out keep their
  geometry; cards written earlier inside one wrapping element render as before.
