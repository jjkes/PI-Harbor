# Pi 1.4.0 adoption

## Scope

Upgrade all five direct Pi dependencies from 1.3.0 to exactly 1.4.0: Agent
Runtime's `pi-agent-core`, `pi-ai`, and `pi-coding-agent`, and Desktop's `pi-ai`
and `pi-mcp`. Release-group packages (`pi-codemode`, `pi-telemetry`, `pi-tui`)
follow through the lockfile. No Host protocol, database schema, persisted
provider endpoint, permission policy, extension VERSION marker, or storage
ownership changes.

Official release notes: [1.4.0](https://github.com/earendil-works/pi/releases/tag/v1.4.0).

## Compatibility work

- Rebase all three pnpm patches against the published 1.4.0 tarballs.
  `pi-agent-core` and `pi-coding-agent` reapply untouched. In `pi-ai`, 18 files
  reapply cleanly and five drift with upstream context changes that keep the
  same intent: the trailing export block in `index.js`/`index.d.ts`,
  `streamSimple` changing from `};` to `});` in the two Responses adapters, the
  `errorDetails?.message ??` provider-error projection, and the hosted-search
  message validation call in `convertResponsesMessages`.
- Follow upstream's client identity for the Anthropic OAuth token request. The
  1.3.0 patch added the removed `utils/pi-user-agent.js`; 1.4.0 replaces it with
  `formatUserAgent()` from `utils/identity.js`, so login and refresh now send
  `pi/<version> (<platform>; <runtime>; <arch>)` instead of
  `pi (<platform> <release>; <arch>)`. `anthropic-oauth-retry.test.mjs` asserts
  the product prefix rather than the old literal shape.

## Adopted upstream behavior

- `pi-ai` now owns request identity: `User-Agent` and provider attribution
  headers come from a `ClientIdentity` and are merged below `Model.headers` and
  per-request headers. Desktop passes no identity on its own provider path, so
  it sends no attribution header at all, and its explicit `x-opencode-client`,
  `x-opencode-session`, and `User-Agent` remain authoritative. Native Pi
  sessions inherit the coding agent's identity (attribution only while install
  telemetry is enabled); Desktop's per-request headers still win there.
  `pi-upstream-1.4-contract.test.ts` pins that merge order.
- Native compaction and branch summaries now use the model's output limit
  instead of a fixed cap, and `compaction.reserveTokens` only decides when
  compaction starts. Desktop's own summary serializer in
  `pi-runtime-compaction-summary.ts` is unchanged and keeps its own budgeting.

## Explicitly unchanged

Desktop still owns its model/endpoint projection, retry policy, MCP ownership,
compaction triggering, and transcript capability projection. Behavior that 1.4.0
leaves alone, or that Desktop does not project:

- The five transport capability keys in
  `packages/agent-runtime/src/transcript-compat.ts` are unchanged, and
  provider-native effort replay on `AssistantMessage` stays unprojected.
- `samplingParams`, `samplingParamsByThinkingLevel`, `promptCache`, and
  `inputLimits` remain carried but not forwarded into the streaming `Model`
  built at `packages/agent-runtime/src/provider-binding.ts`.
- The Kimi For Coding preset keeps Anthropic Messages at
  `https://api.kimi.com/coding`; rewriting saved rows would change transport for
  existing users. OpenRouter keeps the models.dev catalogue route and OpenCode
  Go keeps its `/zen` route.
- Codemode classifier image input, the generated Models Configuration reference,
  the codemode worker queue and `PI_CODEMODE_MAX_WORKERS`, Rex terminal support,
  and the changed default models (GitHub Copilot, NVIDIA, Xiaomi, Grok thinking
  levels) are CLI surfaces Desktop does not use. Chat metadata remains owned by
  models.dev, not Pi sibling defaults.
- The `ToolCall.argumentsError` field added in 1.3.0 is still not consumed;
  Desktop's adapter guard classifies malformed tool-argument JSON before Host
  execution.

## Fresh-release policy and patch identity

The seven Pi 1.4.0 release-group packages carry exact-version release-age
exclusions; do not widen them to package names or ranges. The lockfile records
the canonical patch hashes for all three patched packages;
`check:pi-dependencies`, `check:pi-patches`, and their fixture tests verify exact
pins, mappings, installed instances, and audited declarations.

## Validation

Task candidate: this change on task base
`f3416e575` (`origin/main` at candidate preparation).

- Dependency and patch gates: `node scripts/check-pi-dependencies.mjs`,
  `node scripts/check-pi-patches.mjs`, and the 7 patch-gate fixture tests passed
  against the installed 1.4.0 instances.
- Patch integrity: every patched JavaScript file passes `node --check`, all
  relative imports inside the three patched packages resolve, and each patch
  applies cleanly to a pristine 1.4.0 tarball.
- `pnpm build:js`, `pnpm lint`, the workspace typecheck, `pnpm check:release-docs`,
  `pnpm check:agent-policy`, and `pnpm docs:check` passed. The first build
  attempt failed on the stale `pi-user-agent.js` import (see Compatibility
  work) and the first typecheck attempt rejected the new contract test's model
  type; both passed after those fixes.
- Agent Runtime: 107 files / 1,495 tests passed, including the new
  `pi-upstream-1.4-contract.test.ts`.
- Desktop: 4,423 tests, 4,420 passed, 3 platform skips. The other nine workspace
  packages passed in full (266 test files). pi-host passed 61 / 1 skip when its
  packaging fixture was given a relocatable Node.
- Protocol smoke passed 23 checks; 2 live-model checks were skipped without
  credentials. Hosted-search bundle E2E passed all 8 scenarios with bundle
  SHA-256 `4f3e1ed3fbaeb9c75c10ad9bf1351acc75930de6fc502267412def8e6007458a`;
  isolated Electron trusted-extension E2E passed 57/57, and the
  provider-api-style renderer probe passed all 28 English/Chinese scenarios.
- Run-to-run noise on this shared machine, recorded rather than masked: one
  desktop run failed a 20 ms remote-MCP connect budget under load (passes 3/3
  in isolation), one recursive run timed out inside unrelated npm/signing/plugin
  suites, and two Electron launches were refused by macOS with
  `sandbox_extension_issue_file_to_process` before the same suites passed. The
  pi-host packaging fixture cannot copy this machine's Homebrew Node because
  that binary needs its adjacent `libnode.147.dylib`; it passes under a
  relocatable Node. None of these touch the changed files.
- Environment: macOS arm64, Node 26.10.0, pnpm 12.8.1, existing debug Host
  binary, pnpm store, and Electron reused. The worktree reused the primary
  checkout's dependency tree by APFS clone and ran `pnpm install` only because
  this change updates Pi itself.
- No real-provider, paid API, installed-app, or user-data tests were authorized.
- Rust checks were not rerun: no Rust source, Cargo dependency, or Host contract
  changed. Host RPC coverage used the existing debug binary.
- PR integration validation is recorded on the pull request.

## Rollback

Roll back direct manifests, lockfile, exact release-age exclusions, patch files,
version gates, and compatibility adaptations together. Never mix a patched
1.3.0 package with the 1.4.0 release group. Existing user data needs no migration.
