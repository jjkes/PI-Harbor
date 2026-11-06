# Pi 1.5.0 adoption

## Scope

Upgrade all five direct Pi dependencies from 1.4.0 to exactly 1.5.0: Agent
Runtime's `pi-agent-core`, `pi-ai`, and `pi-coding-agent`, and Desktop's `pi-ai`
and `pi-mcp`. Release-group packages (`pi-codemode`, `pi-telemetry`, `pi-tui`)
follow through the lockfile. The release adds one package to the group,
`@earendil-works/pi-schema`, which `pi-ai` and `pi-agent-core` now depend on.
No Host protocol, database schema, persisted provider endpoint, permission
policy, extension `VERSION` marker, or storage ownership changes.

Official release notes: [Pi 1.5.0](https://github.com/earendil-works/pi/releases/tag/v1.5.0),
[pi-ai changelog](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/CHANGELOG.md),
[pi-agent-core changelog](https://github.com/earendil-works/pi/blob/v1.5.0/packages/agent/CHANGELOG.md),
and [pi-coding-agent changelog](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/CHANGELOG.md).

## Compatibility work

### Tool schemas and TypeBox

- Pi 1.5.0 validates tool arguments with `@earendil-works/pi-schema` instead of
  TypeBox, and `pi-ai` no longer re-exports `Type` (`typebox` is only a
  development dependency of `pi-ai` now; `utils/typebox-helpers` is gone).
  Thirteen Agent Runtime files that imported `Type` from `@earendil-works/pi-ai`
  import it from `typebox`, which Agent Runtime already pins at the version
  `pi-coding-agent` uses. The schemas themselves are unchanged JSON Schema.
- `validateToolArguments` now coerces plain JSON Schema the same way it coerced
  TypeBox schemas (numeric strings to numbers, a single value into an array),
  so MCP, plugin, and extension tools get the coercion Desktop's fixed tools
  already had. The model sees pi-schema's validation messages
  (`- limit: expected number, got string`) instead of TypeBox's. No Desktop
  code or test matched on the old TypeBox wording.
- `pi-schema-validation.test.ts` pins coercion for plain and TypeBox schemas,
  the pi-schema error format, and that a dangling `$ref` rejects only its own
  value.

### Trusted-extension `pi-ai` view

- Extensions that import `Type`, `Static`, or `StringEnum` from
  `@earendil-works/pi-ai` would break once `pi-ai` stopped re-exporting
  TypeBox. `extensions/loader.ts` now resolves `@earendil-works/pi-ai`,
  `@earendil-works/pi-ai/compat`, and their `@mariozechner/*` aliases to an
  extension view that mirrors upstream's own
  `pi-coding-agent/dist/core/extensions/pi-ai-extension-view.js`: the `pi-ai`
  compat entry point, TypeBox's `Type`, and a `StringEnum` built with
  `Type.Unsafe`, so `Type.Object({ op: StringEnum([...]) })` keeps inferring.
- `runner.test.ts` loads an extension that builds its tool schema from that
  view, checks the provider-facing `{ type: "string", enum }` shape, and runs
  the tool.

### Patch rebase

The three pnpm patches were re-applied hunk by hunk to the published 1.5.0
tarballs. Each keeps the same file set as 1.4.0 (`pi-ai` 23 files,
`pi-agent-core` 2, `pi-coding-agent` 8) and passes `node --check`.

- `pi-ai`: upstream moved streaming scratch state off content blocks
  (`openBlocks` and `ToolCallArgumentsStream` in Anthropic Messages, slot input
  state in OpenAI Responses) and removed the catch-block loops that deleted
  `index`, `partialJson`, and `customInput`. Desktop's
  `preparingRequest` → `asLocalRequestError` → `errorDetails` projection now
  opens each of those catch blocks instead of preceding the removed loop.
  Anthropic hosted search is ported onto `openBlocks`: the streamed
  `server_tool_use` query JSON lives in a holder on the open-block entry, so no
  hostedSearch block carries `index` or `inputJson` on partials, the final
  message, or an error message, and the old stop-time cleanup branch is gone.
  The `?? ""` delta guards and `citations_delta` collection are kept. In
  `openai-responses-shared.js` the 1.4.0 guard on `partialJson += delta` moves
  to `ToolCallArgumentsStream.append(event.delta ?? "")`: upstream's
  `append(undefined)` throws, so without the guard a proxy that omits `delta`
  fails the whole stream. `responses-missing-delta.test.ts` fails without the
  guard and passes with it. `requiresNonEmptyReasoningReplay` is declared with
  pi-schema builders (`opt(bool(...))`) now that `compat-schema.js` no longer
  uses TypeBox. The trailing export block in `index.js`/`index.d.ts` and the
  Azure `streamSimple` wrapper drifted with context only.
- `pi-agent-core`: `handleRunFailure` drifted with context; the
  `errorDetails` projection is unchanged.
- `pi-coding-agent`: `branch-summarization.d.ts` keeps upstream's new
  `ThinkingLevel` import and adds `Api`. The tool-result image degradation
  hunk was re-applied by hand. The model threading through compaction,
  estimates, and bug-report context is unchanged.

### Bundle size and `undici`

`pi-coding-agent` 1.5.0 moves `undici` from 8.10.2 to 8.12.3. Agent Runtime
pinned 8.10.2 directly, so the sidecar entry bundled both copies and grew from
about 324 KB to 871 KB, failing the 500 KiB entry budget in
`agent-runtime-bundle-package.test.mjs`. Agent Runtime now pins 8.12.3, the
same alignment rule as `0c64b6c99 perf(agent-runtime): shrink sidecar bundle`,
and the entry is back to 323,871 bytes.

### Gates, tests, and fixtures

- `check-pi-dependencies.mjs`, `check-pi-patches.mjs`, and
  `pi-patch-hash.test.mjs` target 1.5.0, and the exact release-age exclusions
  list all eight 1.5.0 release-group packages, including `pi-schema`.
- `pi-client-identity.test.ts` and `native-pi-session.test.ts` compare
  the identity version with `PI_AI_VERSION` instead of a `1.4.0` literal.
- The hosted-search E2E fake host answers `tools.fileBatchCapabilities` with
  `{ version: 1, supported: false }`, matching the unit-test hosts. The base
  revision's batch planner already probes that RPC at startup; the offline
  fixture had no case for it, so every scenario threw before reaching a
  provider request.

## Adopted upstream behavior

- Tool argument validation and coercion through `pi-schema`, described above,
  apply to every tool Desktop declares, including MCP and extension tools.
- Providers parse each streamed tool-call delta once through the new
  `utils/streaming-json.js` `ToolCallArgumentsStream` instead of re-parsing the
  accumulated arguments, which removes the CPU and memory growth on large
  streamed tool calls (#9265). Desktop's provider path goes through these
  adapters.
- Gemini tool schemas convert `const` to a single-value `enum` in
  `google-shared.js` (#11308).
- Native Pi sessions run `pi-coding-agent`'s `AgentSession`, so its fixes reach
  that path: `session-manager.js` drops an entry from memory when persisting it
  fails (#11460), and `image-resize-core.js` prefers the smaller of PNG and
  JPEG (#11551).
- Other adapter fixes in the release notes (for example #11091, #10063, and
  #11415) ship in the pinned packages. This upgrade did not trace them to a
  changed code path in the published tarballs, so it makes no claim about
  their effect on Desktop.

## Desktop parity work

Two Desktop-owned implementations had defects that Pi 1.5.0 fixed only in its
own code, so the upstream fixes cannot reach them. This change ports the
behavior:

- `ToolSearch` (`runtime.ts` `findDeferredTools`) ranks through
  `tool-search-terms.ts`: NFKC and lowercase on both the query and the catalog,
  the legacy separators plus `、` and `。`, and `Intl.Segmenter` word
  segmentation for CJK and Thai queries (pi #11331, #10816). An ASCII query
  against an ASCII catalog ranks exactly as before;
  `tool-search-terms.test.ts` compares the two algorithms.
- Trusted-extension `pi.exec()` (`extensions/managed-exec.ts`) decodes each
  stream with a `StringDecoder`, so a multibyte character split across chunks
  survives (pi #11312). At `maxBuffer` it never splits a surrogate pair, keeps
  a contiguous prefix, and reports `truncated: true`, the additive field pi's
  1.5.0 result also carries. A trailing incomplete sequence still becomes
  U+FFFD, and the process is still not stopped at the cap.

## Explicitly unchanged

- The coding-agent shim and its `VERSION` marker are unchanged; it does not
  add `keyText()`/`keyHint()` or other TUI render helpers.
- Provider retry policy stays Desktop-owned (`provider-retry.ts`). Chat model
  metadata stays owned by models.dev (ADR 0133); Pi's models.dev v2 catalog,
  GPT-6.1 Terra entries, and the new CLI default OpenAI model do not change
  Desktop's model list or saved bindings.
- CLI-only surfaces Desktop does not use: extension update changelogs,
  `PI_SELF_UPDATE_COMMAND`, device-code login prompts, `/model` and `/resume`
  search, HTML export, TUI rendering and terminal fixes, and the removed
  `sandbox/` example.
- No persisted format, RPC, Plugin SDK, or permission contract changes.
  Existing user data needs no migration.

## Follow-ups handled in this branch

The upgrade surfaced defects outside its own scope. Each is fixed here:

- `biome.json` excluded `**/.pi/**`, which also matched a worktree under
  `.pi/worktree/`, so `pnpm lint:biome` processed no files there. The
  exclusion is now anchored as `!.pi/**`: the primary checkout still skips
  nested worktrees, and lint runs inside one.
- `macos-release-verification.test.mjs` and
  `plugin-prompt-enhancement-migration.test.mjs` built paths with
  `new URL(...).pathname`, which stays percent-encoded and failed in a
  checkout whose path contains non-ASCII characters. They now use
  `fileURLToPath` and pass the URL itself to `register`.
- `04-e2e-test-plan.md` (English and zh-CN) had two
  `E2E-PI-140-kernel-upgrade` sections; each language now has one.
- `packages/host-runtime/src/turn-events.test.ts` had merge-conflict markers
  committed by `526b72701 chore(sync): merge upstream PI-Desktop through
  0ba8cfd57`. The markers and the duplicated import are removed.
- `pnpm docs:check` failed on the base revision. The zh-CN web-access security
  page, the zh-CN IPC §17 and security README rows, and the `spec/NAV.md`
  entry are added.
- The 1.4-specific test name `pi-upstream-1.4-identity.test.ts` is now
  `pi-client-identity.test.ts`, and the specs that cite it are updated.

## Fresh-release policy and patch identity

The eight Pi 1.5.0 release-group packages carry exact-version release-age
exclusions; do not widen them to package names or ranges. The lockfile records
the canonical patch hashes for all three patched packages;
`check:pi-dependencies`, `check:pi-patches`, and their fixture tests verify exact
pins, mappings, installed instances, and audited declarations.

## Validation

- Task candidate: the uncommitted working tree on
  `9f693dfade89f8647a73acd0764d13f7c351d471`. Base main: `origin/main` at the
  same commit (2026-11-02). The tree also carries this branch's project-
  workspace plan-file fix and session context viewer. These results apply to
  that tree; the committed head and the PR integration candidate need their
  own runs.
- Environment: macOS arm64, Node 26.10.0, pnpm 12.8.1. `pnpm install` ran in
  the worktree because this change updates Pi itself. Electron 43.6.0 was
  APFS-cloned from the primary checkout, and E2E reused the primary checkout's
  release `pi-harbor-host-core`; no Rust source, persistence, or Host contract
  changed. No real provider, credential, or live service was used.
- Gates: `pnpm build:js`, Agent Runtime and Desktop typecheck, `pnpm lint`
  (135 files), `pnpm docs:check` (88 pairs, 619 pages),
  `check:pi-dependencies`, `check:pi-patches`, `pi-patch-hash.test.mjs` (7/7),
  `check:release-docs`, and `check:agent-policy` passed.
- Unit and integration: Agent Runtime 125 files / 1,784 tests, shared
  110 / 1,420, host-runtime 23 / 164, and i18n 3 / 31 passed. Desktop passed
  4,925 of 4,928 tests with 3 skipped and no failures, run from the
  non-ASCII worktree path. The sidecar bundle-size test passes after the
  `undici` alignment.
- `responses-missing-delta.test.ts` was run against the installed package with
  the `?? ""` guard temporarily removed; it failed with stop reason `error`, and
  passed again after the file was restored to its patched hash.
- E2E: `test:e2e:hosted-search` 10/10 scenarios, `e2e-fixed-tool-declarations`
  4/4, `test:e2e:trusted-extensions` 57/57, `test:e2e:plan-ui` 6 passed (the
  optional live-provider case skipped), and `test:e2e:project-workspace-ui`
  68 checks passed, each with isolated temporary state.
- Independent review (read-only architect pass) confirmed each patch applies
  cleanly to a pristine 1.5.0 tree and produces the installed bytes, every
  patched `.js` passes `node --check` with resolvable relative imports, and the
  1.4.0 and 1.5.0 patch deltas match except for the documented upstream
  migrations. Its findings were the dropped Responses delta guard, now restored
  with a regression test, and three empty `@earendil-works/pi-ai` imports, now
  removed.

## Rollback

Roll back the direct manifests (including Agent Runtime's `undici` pin), the
lockfile, exact release-age exclusions, the three patch files, version gates,
the extension `pi-ai` view, the `typebox` imports, tests, the E2E fixture, and
the synchronized specs together. Never mix a patched 1.4.0 package with the
1.5.0 release group. Existing user data needs no migration.
