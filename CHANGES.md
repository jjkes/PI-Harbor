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
