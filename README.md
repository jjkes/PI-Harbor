# PI-Harbor Desktop

A local-first desktop workspace for AI agents: Electron shell, Rust host core,
the pi agent harness, and user-installable plugins.

This is an **independent fork** of [PI-Desktop](https://github.com/vastsa/PI-Desktop).
It is not affiliated with, endorsed by, or supported by the upstream project.
Bug reports about this fork belong in [this repository's issues](../../issues),
not upstream.

> **Current release line: 0.2.x (Early Preview).** The latest release is
> v0.2.1, published under this repository's Releases; the version counts this
> fork's own numbering from 0.1.0 instead of continuing the upstream line.

## What differs from upstream

- Own application identity: `top.jjkets.pi-harbor`, product name
  *PI-Harbor Desktop*, own artifact names, own installers and desktop entries,
  so installing both this fork and upstream on one machine does not merge their
  data directories.
- Own update feed, own feedback destination, own release pipeline.
- **No plugin center.** The plugin catalog is a static JSON file served from
  this repository (`marketplace/catalog.json`); downloads use the package URL
  the catalog carries, and plugin reviews are unavailable. Upstream's
  `plugins.aiuo.net` endpoints are not contacted.
- macOS builds must be signed and notarized with your own certificate; the
  release workflow ships a placeholder identity and expects your own secrets.

Every change is listed in [CHANGES.md](CHANGES.md).

## Requirements

- Node.js 22+ and pnpm (`corepack enable pnpm`)
- Rust toolchain (stable) — the host core is a native binary
- Platform build tools for the desktop shell (see the upstream developer docs)

## Development

```bash
pnpm install
pnpm build          # JS workspaces + release host-core
pnpm test           # JS tests + cargo test -p host-core
pnpm typecheck
pnpm dev            # run the desktop app
```

Packaging targets mirror upstream: `pnpm --filter @pi-harbor/desktop run
dist:mac | dist:win | dist:linux`. Local packaging works without signing
certificates; a *published* macOS release needs your own Developer ID and
notarization credentials configured as repository secrets.

Design records (architecture, specs, ADRs) live in `docs/`, and the plugin
authoring guide is `docs/plugin-development.md`. Both are inherited from
upstream and describe the shared architecture.

## Fork maintenance notes

`docs/FORK.md` lists what a fork owner still has to supply — signing
certificates, the plugin catalog contents, store listings — and how to keep
pulling upstream changes.

## License

LGPL-3.0-or-later. This distribution is licensed as a whole under the GNU
Lesser General Public License v3.0 or later; see [LICENSE](LICENSE). The
upstream copyright notice, the fork point, and the third-party component
licenses are recorded in [NOTICE](NOTICE); the enumerated changes are in
[CHANGES.md](CHANGES.md). Distributed binaries come with source: this repository
at the matching tag.

"PI-Desktop", the PI-Desktop logo, and the upstream GitHub organisations are the
upstream project's marks. This fork uses its own name, icon, and identifiers, and
claims neither affiliation nor endorsement.
