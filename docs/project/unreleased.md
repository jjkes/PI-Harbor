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
