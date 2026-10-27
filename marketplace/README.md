# Plugin catalog

`catalog.json` in this directory is the **official plugin channel**: the client
reads it from

```text
https://gitlab.jjkets.top/jjkets/pi-harbor/-/raw/main/marketplace/catalog.json
```

(see `OFFICIAL_CHANNEL_CATALOG_URL` in `crates/host-core/src/plugins/marketplace.rs`).

There is no plugin center behind this catalog. The client therefore:

- takes every package URL from the catalog entry itself, and
- shows no reviews, because reviews need a center.

## Authoring an entry

1. Package the plugin with the devkit CLI:

   ```bash
   pnpm pi-plugin pack examples/plugins/hello
   ```

   The result is `dist/demo.hello-0.2.0.piplug` — an **uncompressed** archive, as
   the installer requires.

2. Publish the file. Either commit it under `marketplace/packages/` or attach it
   to a GitHub release, then use that absolute URL. Allowed package hosts are
   `github.com`, `githubusercontent.com`, and `cnb.cool`
   (`PACKAGE_HOST_ALLOWLIST` in `crates/host-core/src/plugins/validation.rs`).

3. Add the entry to `catalog.json` with the file's real digest:

   ```bash
   shasum -a 256 <file>.piplug
   ```

4. Validate before pushing:

   ```bash
   node scripts/check-marketplace-catalog.mjs
   ```

## Schema notes

- `schemaVersion` 1 is fine; 2 adds provenance, review verdicts, yank state, and
  a declared `artifactBaseUrl`.
- Relative package URLs resolve against the catalog's own directory; absolute
  URLs win. This catalog uses absolute URLs so it can point at release assets.
- A remote catalog with an empty `plugins` array is rejected by the host
  (`PLUGIN_MARKET_INVALID: remote catalog has no plugins`). Until you publish a
  release tag that carries this file, the app keeps using the bundled offline
  catalog and shows the marketplace as unreachable.
