# Changes in this fork

This file records every modification this distribution (`pi-subagent-desktop`)
makes to the upstream PI-Desktop source it was forked from, as required by
LGPL-3.0 section 5(a). Dates are the date the change was committed.

Fork point: `vastsa/PI-Desktop` @ `1ddfd7203fe58cd970fc6f929218253369706de7`
(version `0.21.0-beta.7`).

## Unreleased

`Edit` shows a complete line-anchored replacement in its tool description and
explains how to correct mixed patch syntax on the first failure. Rejected
edits leave the target file untouched so the model can retry with corrected
operations.

## 2026-11-18 - Release 0.3.1

This release makes a running tool call observable instead of silent. A call
shows the output it produces while it runs, its arguments appear as a draft row
while the model is still streaming them, and every tool can preview itself —
a plugin tool through the new optional progress callback, an MCP server through
its progress notifications. Partial output is display only: it is never
persisted and never enters a provider request.

A compaction divider that carries a model summary opens that summary in a
read-only dialog. Token metrics move under the composer, and the session ledger
joins the context inspector, so the separate session token panel is gone.

A transcript link to a real file outside every project root opens in the host
file tab instead of reporting an access limit (ADR 0348). A stale line-anchored
`Edit` tag is recovered when the lines it names are still present and unchanged
at one offset, and a second host-core over the same data directory no longer
aborts the first one's live turn.

Every workspace, Cargo, and protocol version surface reads `0.3.1`; the nine
in-app changelog locales and the README release lines name this release.

## 2026-11-18 - Drift recovery for the line-anchored `Edit`

A stale `Edit` tag no longer fails whenever something else wrote the file first.
The host diffs the tagged snapshot against the live file and applies the call
only when every line it names — a range includes its interior lines — is still
present, unchanged, at one single offset; it then remaps the operations onto
live line numbers and warns. Anything the alignment cannot prove still fails
closed with `EDIT_TAG_MISMATCH`, which now also carries the current content at
the anchor lines. Warnings name the cause, so a tag reused after the session's
own write reports a session chain while an outside edit reports an external
change.

## 2026-11-18 - Live tool output while a call runs

A tool call now shows the output it is producing while it runs instead of
staying silent until it returns. A row that produces output opens itself, keeps
scrolling to its newest line, and stays open when the call settles; the settled
row keeps the text the user watched while the final result supplies the head's
outcome chips (exit code, truncation, size, duration). A call that produces no
output behaves exactly as before, and a reloaded transcript shows the stored
result alone.

While it runs, that body is painted as a command window: a chrome strip with the
`$` prompt and the command being executed (a host tool shows its own name and
summary instead) and a pulsing running label, over a plate sunk below the page,
so a live row cannot be mistaken for one that already finished. The surface is
built from theme tokens, honours reduced motion, and disappears when the call
settles — history keeps the unframed output it always had.

Every tool can preview itself, not only a command shell: a plugin tool may call
the new optional `ctx.progress`, and an MCP server's `notifications/progress`
reaches the row too. Both are opt-in — a plugin or server that reports nothing
sees the same behavior and the same result it had before. Partial output is
display-only: it is never persisted, never enters a provider request, and the
model still receives exactly one final tool result. Live bodies are bounded, and
a body cut to its budget says so in the row head.

## 2026-11-13 - Release 0.3.0

This release integrates the app-surface and planning work with the local
development fixes. The conversation topbar switches between Agent, Images,
and Plan views. The Images workbench collects generated images and offers a
direct generation action. The subagent catalog and Team roster accept up to
200 localized roles with search and category filters, while the per-session
concurrency limit remains 10. Project norms are shared by the project's main
agent and subagents alongside the existing repository instruction chain.

Plan mode adds 3–5-role debates with drafts, objections, a merged plan, and
per-item verdicts. Rounds can be reopened with new objections, reloaded from
local artifacts, or deleted together with those artifacts. A selected draft,
merged plan, or user proposal can be handed to Team with extra requirements.
Optional code-review and QA delegations can follow completed subagent work.
Subagent nodes now expose token usage, response rate, queued/running state,
and collapsible rounds and completed nodes.

Team rosters saved by this release use schema v3. Version 0.2.2 does not
recognize that schema and disables such a Team configuration; back up the
configuration before downgrading. The new review/QA flags default to off.

The macOS development bundle is now named `PI-Harbor Dev`, distinct from the
released app in Launchpad and Spotlight. Every workspace, Cargo, and protocol
version surface reads `0.3.0`; the nine in-app changelog locales and README
release lines name this release, and the models.dev catalog was refreshed.

The release workflow still matched the upstream `PI-Desktop-*` artifact names
when it verified the macOS installers, while this distribution packages
`PI-Harbor-Desktop-*`. The macOS build therefore failed after packaging, and
no installer reached the release. The verification now uses this
distribution's artifact names.

## 2026-11-09 - Update feed back on GitHub releases

The application update feed now reads the public GitHub Releases of
`jjkes/PI-Harbor` instead of the private GitLab release page. The generic
GitLab feed could never work for installed builds: the GitLab project is
not anonymously readable, so the check asked for `latest-mac.yml` and
received the GitLab sign-in page, failing YAML parsing on every check
(Settings → software update shows "check updates failed", and scheduled
auto-checks silently fail). Choosing the `github` provider restores the
documented design (ADR 0022 `fixed GitHub Releases feed`) and the fork
checklist (`docs/FORK.md` §3): `.github/workflows/release.yml` already
publishes installers and the `latest*.yml` feeds to the GitHub release
with `softprops/action-gh-release`, so `latest-mac.yml` exists there
today.

Files modified: `apps/desktop/package.json` (`build.publish` →
`{ provider: "github", owner: "jjkes", repo: "PI-Harbor" }`, same values
electron-builder bakes into the packaged `app-update.yml`),
`apps/desktop/resources/app-update.yml` (the Windows ZIP copy of the same
config), `apps/desktop/electron/main/updater.ts` (`RELEASES_URL` now opens
`https://github.com/jjkes/PI-Harbor/releases`), and
`apps/desktop/test/auto-update.test.mjs`. Nothing else changes: the
polling, download, and install logic are untouched.
## 2026-11-08 - App surface switch, renderer image generation

`settings.appMode` adds an app-surface switch at the head of the conversation
topbar: **agent development** or the **image workbench**. It is a renderer
preference only - no session, launch, prompt, model, or permission changes. In
image mode the active session's Images tab is focused, and the diff-review
launcher (the one host-owned development tool) is left out of the work panel's
launcher row. A value this build does not recognize reads as agent mode.

A new invoke channel `pi-harbor/images/generate` lets the Images tab request one
batch itself. It reuses the runtime's single `GenerateImages` handler instance -
same binding, same session-scratch containment, same write rules - and returns a
typed failure (`INVALID_ARGUMENT`, `HOST_UNAVAILABLE`) instead of throwing. No
permission is added and the `GenerateImages` tool gate (`tools.execute`,
`Risk::High`) is untouched: the model gains nothing, and a direct request
requires an explicit press in a local session.


## 2026-11-08 - Generated-image gallery, Team roster search

The work panel gains an **Images** tab: the session's successful
`GenerateImages` outputs in transcript order, each tile carrying the prompt of
the call that produced it, opened in the conversation's own viewer (navigation,
zoom, download, Show in folder). It is a read of the tool rows the session
already holds - no new IPC, no generation path, and no change to the
`tools.execute` permission gate. Failed results stay in the turn that reported
them.

The Team member picker gains a search field. It filters the drawn roster by
handle, role description and the session's model lock; "Enable all",
"Disable all" and the roster-wide model still act on the whole roster, so a
half-typed query can never change a member it hides.

## 2026-11-08 - Team roster capacity, model pickers, localized role names

Team mode can name every role the user defines. The catalog ceiling
(`MAX_SUBAGENT_DEFINITIONS`) and the roster ceiling (`MAX_TEAM_MEMBERS`, in the
shared schema and in host-core's roster validation) rise from 16 to 64,
matching host-core's `MAX_USER_SUBAGENTS`. Settings already accepted 64
documents, while the runtime catalog and the Team roster silently dropped
everything past the sixteenth, so a defined role could not be selected.

Every surface that pins a model for a subagent - the Team member and roster
pickers, the subagent editor, its fallback list, and the member card's
availability status - now excludes image-generation bindings. Those are
configured models but not conversation models, so offering one let the user
save a lock the launch path could never resolve. A pin saved before this change
keeps its label and reads as unavailable instead of disappearing.

Subagent handles are display names: the shared name pattern accepts Unicode
letters and digits with inner separators, matching host-core's `normalize_name`
and the editor's handle preview, so a localized role name is neither rejected
nor silently renamed.

## 2026-11-06 - Read-only BTW side questions

`/btw` opens a per-session, read-only side-question tab in the work panel and
answers from a snapshot of the main conversation's model-visible context, using
the main session's provider, model, and thinking level. The run is ephemeral: it
creates no session row, persists nothing, and cannot write to the session or its
files. Read-only is enforced by the runtime's tool gate and by a new optional
`tools.execute` `accessProfile: "read-only"` in host-core, which admits `Read`,
`Glob`, and `Grep`, refuses every other tool, and refuses scope-widening fields.

The builtin registry grows to seven entries (`builtin.session.btw`, `/btw`), and
the work panel gains a `btw` tab kind. New IPC `btw/ask`, `btw/abort`, and
`btw/event/message` stay separate from the agent channels; the sidecar gains
`btw.ask`, `btw.abort`, and the `btw.event` notification, and two error codes
(`TOOL_DISABLED_IN_READ_ONLY`, `EXTERNAL_PATH_DISABLED_IN_READ_ONLY`) plus the
`BTW_*` family join the shared contract. No database, schema, or persisted-state
change. All strings are catalog-backed in the nine shipped locales. See ADR 0346,
D680, and E2E-1179.

## 2026-11-02 - Release 0.1.1

Version surfaces (every workspace `package.json`, `Cargo.toml`
`[workspace.package]`, the `host-core` entry in `Cargo.lock`, and `APP_VERSION`
in `packages/shared/src/protocol.ts`) now read `0.1.1`. The shipped-locale
in-app changelog (`packages/shared/src/changelog-*.ts`) carries a `0.1.1` entry
in all nine locales, and `README.md` / `README.zh-CN.md` name v0.1.1 as the
published release. That version string also exists upstream: the fork's entry
sits above upstream's historical `0.1.1`, and changelog lookup is newest-first,
so the upstream entry stays unreachable.

`biome.json` now excludes local `.pi`, `.artifacts`, and `worktrees` trees, so
linting no longer reads nested worktree configurations or broken links.
`apps/desktop/resources/models.dev/api.json` was refreshed from models.dev for
this cut.
## 2026-11-02 - Workspace session working directory

New Task and the first home-draft prompt now retain the selected project
workspace binding, including after workspace creation and archive/delete
fallbacks. The conversation topbar exposes the workspace destination before a
draft is persisted; host-owned tool roots and `.pi/plan` artifacts continue to
resolve inside that workspace.

VoiceService's packaged native-library setup now imports Electron's `app`
correctly, dictation model imports expose their in-progress state, and Biome
skips local worktree checkouts and test artifacts instead of reading their
nested configurations or broken links.

Docked file-manager views and plugin filesystem calls now resolve the owning
session's workspace root, including across the plugin parent/child IPC bridge,
instead of displaying or modifying the parent project checkout.

## 2026-10-23 — Initial fork release preparation

### Product identity (all files below were modified 2026-10-23)

| File | Change |
| --- | --- |
| `packages/shared/src/protocol.ts` | `APP_ID` → `top.jjkets.pi-subagent-desktop`; `APP_NAME` → `PI-Subagent Desktop` |
| `apps/desktop/package.json` | New `appId`, `productName`, author, description; every artifact name renamed to `PI-Subagent-Desktop-*`; Windows executable/shortcut, Linux executable, `.desktop` name, deb/rpm `packageName` renamed to `pi-subagent-desktop`; macOS permission strings renamed |
| `apps/desktop/resources/app-update.yml` | Update feed points at `jjkes/pi-subagent-desktop` |
| `apps/desktop/electron/main/updater.ts` | `RELEASES_URL` points at this fork's releases |
| `scripts/dev-electron.mjs`, `scripts/export-linux-asar.mjs` | Development bundle and exported ASAR names use the new product name |

### Decoupling from upstream services

| File | Change |
| --- | --- |
| `crates/host-core/src/plugins/marketplace.rs` | `OFFICIAL_CHANNEL_CATALOG_URL` now points at this repository's `marketplace/catalog.json`; new `PLUGIN_CENTER_HOST` constant (`None`) declares that this distribution runs no plugin center |
| `crates/host-core/src/plugins/resolve.rs` | Download resolve only asks a host that `PLUGIN_CENTER_HOST` names; otherwise installs use the package URL the catalog carries |
| `crates/host-core/src/plugins/reviews.rs` | Review endpoints follow the same rule, so no request leaves for a center this distribution does not run |
| `crates/host-core/src/plugins/marketplace/catalog.rs` | Bundled fallback catalog re-branded |
| `packages/shared/src/github-feedback.ts` | Feedback issues open in this repository |
| `scripts/check-marketplace-catalog.mjs` | Release preflight reads this repository's catalog |

### CI and release

| File | Change |
| --- | --- |
| `.github/workflows/mirror-to-cnb.yml` | Deleted: the CNB mirror published to upstream infrastructure |
| `.github/workflows/release.yml` | `CSC_NAME` is a placeholder; the upstream Developer ID identity is not usable here. Add your own signing secrets before cutting a release |

### Tests and documentation

- Unit tests and packaging tests that asserted the upstream identity, release
  URLs, artifact names, or plugin-center behaviour were updated to the values
  above. Fixture URLs that merely exercise URL building were left untouched.
- `README.upstream.md` and `README.upstream.zh-CN.md` preserve the upstream
  README verbatim for attribution. `README.md` and `README.zh-CN.md` are new.
- `NOTICE` added.
- `SECURITY.md` and `docs/privacy-policy.md` rewritten for this distribution.
- `docs/spec/**` and `docs/adr/**` are upstream design records and are kept
  unedited as history. Where they mention upstream hosts, services, or branding,
  they describe the upstream project, not this distribution.

## 2026-10-27 - Sync with upstream 0.21.0

Upstream `vastsa/PI-Desktop` was merged into this fork through
`5aa253883c4e34fd65d31c434256d424c352bf0b` (version `0.21.0`), covering the
99 upstream commits released after the fork point. The merge commit records
the upstream history, so the changes below are the only places where this
distribution still differs from upstream in those files.

| File | Change |
| --- | --- |
| `apps/desktop/package.json` | Kept this distribution's `desktopName`; took the upstream `version`. Upstream's new `resources/gen-ui` extra resource and `test:e2e:*` scripts are included |
| `packages/shared/src/protocol.ts` | Kept `APP_ID` and `APP_NAME`; took the upstream `APP_VERSION` |
| `package.json`, `Cargo.toml`, `Cargo.lock`, `packages/*/package.json` | Upstream version bump to `0.21.0` |

Identity, update-feed, and plugin-center decoupling constants were re-checked
after the merge and still hold this distribution's values. None of the merged
upstream commits added a brand literal to the renderer, the locales, the
Electron main process, or the scripts, so the re-branding from the initial
fork release still covers every surface upstream touched.

## 2026-10-27 - Renamed to PI-Harbor Desktop

The distribution is now PI-Harbor Desktop. The product name, application id,
npm workspace scope, and host binary changed; persisted identifiers did not.

| Surface | Before | After |
| --- | --- | --- |
| Product name | `PI-Subagent Desktop` | `PI-Harbor Desktop` |
| Application id | `top.jjkets.pi-subagent-desktop` | `top.jjkets.pi-harbor` |
| npm workspace scope | `@pi-desktop/*` | `@pi-harbor/*` |
| Host binary | `pi-desktop-host-core` | `pi-harbor-host-core` |
| Linux desktop entry | `pi-subagent-desktop.desktop` | `pi-harbor.desktop` |
| Artifact names | `PI-Subagent-Desktop-*` | `PI-Harbor-Desktop-*` |
| Development bundle id | `top.jjkets.pi-subagent-desktop.dev` | `top.jjkets.pi-harbor.dev` |
Nothing shares a namespace with the upstream PI-Desktop install: the host keeps
its data in `~/.pi-harbor` (`~/.pi-harbor-dev` for development builds) instead
of `~/.pi-desktop`, the single-instance lock is `.pi-harbor.lock`, session
links use `pi-harbor://`, the transcript-layout cache magic is
`PI-HARBOR-TRANSCRIPT-LAYOUT`, config-sync uses `pi-harbor/...` prefixes and
formats, the IPC channels moved to `pi-harbor/*`, the environment variables
became `PI_HARBOR_*`, and the built-in skill ids became `pi-harbor/<skill>`.
The preload bridge object stays `window.piDesktop` because the plugin SDK
contract names it (`engines.piDesktop`).

The project now lives at `https://gitlab.jjkets.top/jjkets/pi-harbor`. Every
repository URL in this distribution moved with it: the update feed became an
electron-updater `generic` feed reading the newest GitLab release assets
(`.../-/releases/permalink/latest/downloads`), remote-host artifacts resolve
under `.../-/releases/v<version>/downloads`, feedback and plugin-review links
open GitLab issues, and the plugin catalog is served from
`.../-/raw/main/marketplace/catalog.json`. Release assets are still produced by
the GitHub Actions workflows; publishing them to a GitLab release is separate
work, so auto-update and remote-host installation stay inert until a release
pipeline uploads those assets.

## 2026-11-01 - Browser web access

An opt-in HTTPS listener serves the desktop interface to a browser that signs
in with the owner's username and password (ADR 0342,
`docs/spec/05-security/03-web-access-security.md`). It is off by default and is
configured in Settings > Web access.

Files added 2026-11-01: `apps/desktop/electron/main/web-access/*`,
`apps/desktop/electron/main/bootstrap/web-access.ts`,
`apps/desktop/electron/main/ipc/web-access-ipc.ts`,
`apps/desktop/src/lib/web-access/*`,
`apps/desktop/src/features/settings/WebAccessSettingsSection.tsx`,
`packages/shared/src/web-access.ts`, `docs/adr/0342-browser-web-access.md`,
`docs/spec/05-security/03-web-access-security.md`, and their tests.

Files modified 2026-11-01: `apps/desktop/electron/main/index.ts`,
`apps/desktop/electron/main/ipc/register.ts`, `apps/desktop/src/main.tsx`,
`apps/desktop/src/lib/api.ts`, `apps/desktop/src/components/WindowControls.tsx`,
`apps/desktop/src/features/settings/SettingsPage.tsx`,
`packages/shared/src/protocol.ts`, `packages/shared/src/index.ts`, the locale
catalogs in `packages/i18n/src/locales/*`, and the specs they affect.

## 2026-11-01 - Sync with upstream `0ba8cfd57`

Merged 268 upstream commits released after the previous sync point
(`5aa253883`), up to `vastsa/PI-Desktop` `0ba8cfd57`. The merge commit records
the upstream history; the entries below are the places where this distribution
still differs from upstream in the files it touched.

### Kept this distribution's identity

| File | Change |
| --- | --- |
| `pnpm-workspace.yaml`, `package.json`, every `packages/*/package.json` | Kept the `@pi-harbor/*` workspace scope. Upstream code and tests that arrived with the merge import `@pi-harbor/*` |
| `packages/shared/src/protocol.ts` | Kept every `pi-harbor/*` IPC channel, the browser web-access channels, and added upstream's `workPanelTabMenu` channel under the same prefix |
| `apps/desktop/electron/main/ipc/window-ipc.ts`, `apps/desktop/electron/main/bootstrap/remote-hosts.ts`, `apps/desktop/electron/main/gen-ui-document.ts`, `apps/desktop/src/lib/commands.ts`, `apps/desktop/src/lib/assistant-turns.ts`, `apps/desktop/src/components/workpanel/WorkPanel.tsx`, `apps/desktop/src/features/chat/transcript/ChatTranscript.tsx`, `packages/racp/src/host-operations.ts` | Took upstream's new imports and types, kept the `@pi-harbor/*` scope |
| `patches/@earendil-works__pi-ai@1.4.0.patch` | Took upstream's reasoning-replay normalization (#1945) and `serviceTier` plumbing; the provider-presets comment names `@pi-harbor/shared` |
| `apps/desktop/src/components/Sidebar.tsx` | Kept this distribution's Active sessions entry beside upstream's scheduled-tasks switch |
| `apps/desktop/src/components/TaskDock.tsx`, `apps/desktop/src/features/chat/background-tasks/useBackgroundTasks.ts`, `apps/desktop/src/features/chat/background-tasks/useDockView.ts` | Kept this distribution's dock split (view state in `useDockView`) with upstream's listed-row counts; upstream's copy of the same fix is not used |
| `apps/desktop/test/gen-ui-protocol.test.mjs`, `apps/desktop/test/window-menu.test.mjs` | Assertions follow this distribution's `pi-harbor` ids and channels |
| `crates/host-core/src/transcripts/layout.rs`, `scripts/e2e-transcript-cache.mjs` | Cache magic stays `PI-HARBOR-TRANSCRIPT-LAYOUT`, at upstream's version 3 |
| `crates/host-core/src/db.rs`, `crates/host-core/src/db/repositories.rs` | Kept the fork's schema numbering: v26 plan execution model, v27 Team rosters, v28 project workspaces, then upstream's lossless tool-image marker as v29 (`crates/host-core/src/db/tool_image_storage_migration.rs`) and its Fast mode switch as v30 (`crates/host-core/src/db/session_fast_mode_migration.rs`). `SCHEMA_VERSION` is 30 and a v25 or v27 file walks the whole chain in one launch |
| `apps/pi-host/src/host-operations.ts` | The protected data directory defaults to `~/.pi-harbor` |
| `apps/desktop/test/session-list-runtime.test.mjs`, `apps/desktop/test/bounded-history-mutations.test.mjs` | The transpile harnesses also resolve `typebox/value`, which this distribution's session IPC uses for Team validation |
| `apps/desktop/test/fast-mode-session-launch.test.mjs` | The fixture Host answers `session.team.get`, which this distribution's launch path reads |
| `apps/desktop/test/anthropic-oauth-retry.test.mjs` | Keeps the looser `user-agent` assertion for this distribution's client identity |
| `packages/agent-runtime/src/sidecar-plan-execution.test.ts` | The fake runtime implements `firstMismatch`, the contract upstream's sidecar now calls |
| `packages/agent-runtime/src/pi-upstream-1.4-contract.test.ts` | Carries both contracts: this distribution's client-identity merge order and upstream's tool-call handling |
| `apps/desktop/resources/plugins/pi.file-manager/**` | Took upstream's 0.9.1-pi.1 bundle and its provenance record |
| `docs/spec/**`, `docs/zh-CN/spec/**`, `docs/project/unreleased.md`, `docs/spec/08-meta/decisions-log.md` | Kept both sides' entries; schema references follow the v30 chain |

## 2026-11-01 - Version line restarts at 0.1.0

This distribution now numbers its own releases from `0.1.0` instead of
continuing the upstream line. Every version surface follows: the root,
`docs`, and workspace `package.json` files, `Cargo.toml`
`[workspace.package]`, the `host-core` entry in `Cargo.lock`, and
`APP_VERSION` in `packages/shared/src/protocol.ts`. The in-app changelog entry
that carried the accumulated unreleased highlights is now labelled `0.1.0`,
`packages/shared/src/changelog.test.ts` pins it as newest, and both READMEs
declare the `0.1.x` release line. Upstream entries below it stay as the history
they are.
