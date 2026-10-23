# Privacy Policy

**Effective date: 2026-10-23**

This policy describes how **PI-Subagent Desktop** handles information. This
distribution is an independent fork of
[PI-Desktop](https://github.com/vastsa/PI-Desktop); the upstream project
publishes its own policy, which does not describe this build.

It is not legal advice. Anyone redistributing a further modified build, or
running an additional hosted service for it, is responsible for the notices that
service needs.

## 1. What stays on your machine

- No account is required.
- Projects, sessions, settings, transcripts, logs, and crash dumps are stored
  locally. Crash minidumps are not uploaded: this build starts the crash
  reporter with upload disabled.
- API keys and OAuth credentials are stored in the local encrypted secret store
  (AES-256-GCM with a key held by the operating system's keychain).
- There is no telemetry or product-analytics pipeline in this distribution.

## 2. What can leave your machine

Only what you configure or invoke:

- **Model providers.** Prompts, files you attach, and tool results go to the
  provider, gateway, or local model server you configured. That provider's
  policy governs it.
- **Plugins and MCP servers** you install or enable act with your permissions and
  can make their own network requests.
- **This fork's GitHub repository**, for exactly three things: the plugin catalog
  at `marketplace/catalog.json`, update checks against this repository's
  releases, and a bug report you choose to open. Requests carry the ordinary
  metadata of any HTTPS request; the plugin install flow can send an
  anonymised device identifier to a plugin center — this distribution configures
  no center, so no such request is made.
- **Nothing else.** This build does not contact the upstream project's
  infrastructure: `plugins.aiuo.net`, its plugin catalogue, its review service,
  and its update feed are all unused.

## 3. Documentation site

The upstream documentation site is a separate static service run by the upstream
project and is not operated for this fork. A locally built `docs/` site is
static; if you deploy it, you are responsible for its notices.

## 4. Changes

Material changes to this policy will be recorded in `CHANGES.md` with the date
they take effect.

## 5. Contact

Open an issue at <https://github.com/jjkes/pi-subagent-desktop/issues> for
privacy questions about this distribution.
