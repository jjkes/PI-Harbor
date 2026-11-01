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
