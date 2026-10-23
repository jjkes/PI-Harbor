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
