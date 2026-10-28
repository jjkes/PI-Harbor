# Unreleased changes

- Upgrade the Pi agent, model adapters, native-session SDK, and MCP client from
  1.3.0 to 1.4.0. Rebase the Desktop compatibility patches, keep Desktop's own
  client identity and provider headers authoritative over pi-ai's attribution
  defaults, and send pi-ai's detailed client `User-Agent` on Anthropic token
  requests.
