# Unreleased changes

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
- Add per-session Team mode with an editable subagent roster, card-level model
  locks, a responsive live L0 → L1 → L2 graph, and subtree stop controls. Nested
  delegation is structurally capped at L2, uses owner-scoped lifecycle tools,
  and preserves Team-disabled behavior. Team configuration and nested history
  persist across restart; Remote and Native Pi sessions remain ineligible.
