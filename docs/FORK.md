# Fork maintenance guide

Everything a fork owner still has to supply, and how to keep this branch in
sync with upstream. The mechanical decoupling is already done and recorded in
`CHANGES.md` (repository root); this file is the human checklist.

## 1. Supply your own signing identities

`apps/desktop/package.json` and `.github/workflows/release.yml` no longer carry
the upstream certificate. Before a *published* release:

1. Replace the `CSC_NAME` placeholder in `.github/workflows/release.yml` with
   the common name of your own Developer ID Application certificate
   (`security find-identity -v -p codesigning`).
2. Add these repository secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, and for Windows
   `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` if you sign Windows builds.
3. Local packaging keeps working without any of them.

Until you do this, macOS releases are unsigned and cannot use in-app upgrade.

## 2. Publish the plugin catalog

The client reads its catalog from

```text
https://raw.githubusercontent.com/jjkes/pi-subagent-desktop/main/marketplace/catalog.json
```

- `marketplace/catalog.json` is the listing contract. Every entry needs an
  absolute package URL on an allowlisted host (`github.com`,
  `githubusercontent.com`, `cnb.cool`) and a real `shasum`.
- Package a plugin with the devkit CLI: `pnpm pi-plugin pack <plugin-dir>`.
  Commit the `.piplug` under `marketplace/packages/` or attach it to a GitHub
  release, then point the catalog entry at that URL.
- Validate before publishing: `node scripts/check-marketplace-catalog.mjs`.
- Plugin reviews are unavailable by design: there is no review service. If you
  ever run one, set `PLUGIN_CENTER_HOST` in
  `crates/host-core/src/plugins/marketplace.rs` to its authority
  (`"plugins.your-domain.example"`) and the resolve and review endpoints switch
  back on for that host only.

## 3. Keep the identity coherent

These four values must stay aligned or the app and its packages disagree:

| Where | What |
| --- | --- |
| `packages/shared/src/protocol.ts` | `APP_ID` |
| `apps/desktop/package.json` | `build.appId` (must equal `APP_ID`) |
| `apps/desktop/package.json` | `build.publish.owner` / `repo` |
| `apps/desktop/resources/app-update.yml` | `owner` / `repo` (must equal `build.publish`) |

Renaming the product again means a new data directory: `APP_NAME` drives
Electron's `userData` path, so plan a migration before you ship a rename.

## 4. Before every release, verify the decoupling still holds

```bash
# No upstream service or branding may reappear in shipped code.
grep -rInE "plugins\.aiuo\.net|pi-docs\.aiuo\.net|vastsa/(PI-Desktop|pi-desktop-plugins)" \
  --exclude-dir=node_modules --exclude-dir=.git \
  apps crates packages scripts .github

# The update feed must point at this repository.
grep -i url apps/desktop/resources/app-update.yml
node scripts/check-release-docs.mjs
node scripts/check-marketplace-catalog.mjs
pnpm test
```

Upstream `docs/spec/**` and `docs/adr/**` intentionally still mention upstream
hosts: they are the design record of the project this fork came from.

## 5. Syncing with upstream

```bash
git remote add upstream https://github.com/vastsa/PI-Desktop.git   # once
git fetch upstream
git log --oneline HEAD..upstream/main | head -30                   # what is new
git merge upstream/main                                            # or cherry-pick
```

Conflicts are expected in exactly the files listed in `CHANGES.md` — identity,
endpoints, artifact names, and the tests that pin them. Resolve them toward this
fork's values, never upstream's, and extend `CHANGES.md` with the date and the
files you touched (LGPL-3.0 §5(a)).

Do not merge upstream release branches blindly: upstream's CI publishes to
upstream's repositories and signs with upstream's certificate.

## 6. Still upstream-branded, worth replacing before promoting the fork

- `docs/image/**` — upstream screenshots and logo used by
  `README.upstream.md`, `docs/index.md`, and the VitePress site.
- `docs/.vitepress/**` site title, logo, and `homepage` links.
- `apps/desktop/resources/skills/**` and bundled plugin metadata that carry the
  upstream author string.
- `CONTRIBUTING.md`, `AGENTS.md`, and `CLAUDE.md` describe upstream's process;
  this fork uses its own.

Keeping them is legal (LGPL covers the code and docs, and the docs are
attribution), but a published fork should not present upstream's marks as its
own product identity.
