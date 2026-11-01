# Changes in this fork

This file records every modification this distribution (`pi-subagent-desktop`)
makes to the upstream PI-Desktop source it was forked from, as required by
LGPL-3.0 section 5(a). Dates are the date the change was committed.

Fork point: `vastsa/PI-Desktop` @ `1ddfd7203fe58cd970fc6f929218253369706de7`
(version `0.21.0-beta.7`).

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
