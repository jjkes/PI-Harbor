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
- Show the session's subagents in the composer dock. When a delegation starts,
  a collapsed Subagents side joins Todo and Background tasks above the
  composer; opening it shows the transcript's subagent graph for the whole
  session, with running delegates first and a resumed delegate as one node.
  Each node opens its delegate's work-panel tab or stops it, and the side
  stays for the session. The dock now shows only the selected side's panel,
  so background tasks no longer appear under the checklist.
- Add per-session Team mode. Switch it on from the composer's mode menu, where
  it combines with Agent, Plan, or Goal, and the Team view opens beside the
  conversation, or as a drawer in a narrow window. One compact card per
  Settings role switches that member on or off for the session; its sheet shows
  the role read-only and sets this session's model, reasoning, and tools. With
  Team on, the main agent delegates first and can call only the members that
  are on. A live L0 → L1 → L2 graph has subtree stop controls. Nested
  delegation is structurally capped at L2, uses owner-scoped lifecycle tools,
  and leaves Team-disabled behavior unchanged. Team configuration and nested
  history persist across restart; Remote and Native Pi sessions remain
  ineligible.
