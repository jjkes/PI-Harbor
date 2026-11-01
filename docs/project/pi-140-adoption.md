# Pi 1.4.0 adoption

## Scope

Upgrade all five direct Pi dependencies from 1.3.0 to exactly 1.4.0: Agent
Runtime's `pi-agent-core`, `pi-ai`, and `pi-coding-agent`, and Desktop's `pi-ai`
and `pi-mcp`. Release-group packages (`pi-codemode`, `pi-telemetry`, `pi-tui`)
follow through the lockfile, and the Pi release group stays aligned through the
lockfile and exact release-age exclusions. No Host protocol, database schema,
persisted provider endpoint, permission policy, extension `VERSION` marker, or
storage ownership changes.

Official release notes: [Pi 1.4.0](https://github.com/earendil-works/pi/releases/tag/v1.4.0),
[pi-ai changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/CHANGELOG.md),
[pi-agent-core changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/agent/CHANGELOG.md),
and [pi-coding-agent changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/CHANGELOG.md).

## Compatibility work

- Rebase all three pnpm patches against the published 1.4.0 tarballs.
  `pi-agent-core` and `pi-coding-agent` reapply untouched. In `pi-ai`, 18 files
  reapply cleanly and five drift with upstream context changes that keep the
  same intent: the trailing export block in `index.js`/`index.d.ts`,
  `streamSimple` changing from `};` to `});` in the two Responses adapters, the
  `errorDetails?.message ??` provider-error projection, and the hosted-search
  message validation call in `convertResponsesMessages`.
- Rebasing onto the published 1.4.0 package layouts preserves hosted-search
  streaming, replay and estimation; bounded Anthropic OAuth handling; DeepSeek
  reasoning replay and endpoint-scoped capability; local request errors; and
  model-aware native session context estimation and image degradation.
- Follow upstream's client identity for the Anthropic OAuth token request. The
  1.3.0 patch added the removed `utils/pi-user-agent.js`; 1.4.0 replaces it with
  `formatUserAgent()` from `utils/identity.js`, so login and refresh now send
  `pi/<version> (<platform>; <runtime>; <arch>)` instead of
  `pi (<platform> <release>; <arch>)`. `anthropic-oauth-retry.test.mjs` asserts
  the product prefix rather than the old literal shape.
- Adopt the new pi-ai client identity API at the agent boundary. Agent Runtime
  and subagents explicitly set `attribution: null`, which suppresses the new
  pi-agent-core default attribution headers while retaining pi-ai's detailed,
  versioned `User-Agent`.
- Keep Desktop's native-session and trusted-extension use of `pi-coding-agent`
  behind their existing compatibility seams. Do not expand the extension shim
  or change its legacy `VERSION` marker.
- Native Pi sessions continue to use pi-coding-agent's telemetry preference
  for its SDK-managed attribution headers. The Desktop-owned main and delegated
  agent requests explicitly suppress Pi attribution.
- Keep Desktop-owned endpoint projection, provider retry policy, MCP ownership,
  context projection, compaction, and session persistence unchanged.

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
- Existing user data needs no migration. No persisted format, RPC, Plugin SDK,
  or permission contract changes.
- The Pi 1.4.0 release's model catalog and provider adapter improvements are
  available through the pinned upstream package. Desktop continues to own its
  model catalog overlays and endpoint projection.
- `pi-coding-agent` remains transitional; it is not the normal Desktop agent
  loop, compaction engine, or durable session store.
- The Desktop main and delegated agent identity is fixed at runtime and is not
  persisted with provider/model configuration. Native sessions use the
  pi-coding-agent SDK's install-telemetry setting for its attribution headers.

## Fresh-release policy and patch identity

The seven Pi 1.4.0 release-group packages carry exact-version release-age
exclusions; do not widen them to package names or ranges. The lockfile records
the canonical patch hashes for all three patched packages;
`check:pi-dependencies`, `check:pi-patches`, and their fixture tests verify exact
pins, mappings, installed instances, and audited declarations.

## Validation

### Fork candidate

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

### Upstream candidate

Validation was run from the dedicated request worktree based on
`c014b32060ca2dc7ace4c83f181685a6e0140c78` (`origin/main`, 2026-10-28).

- Task candidate: `b460e75806f433085c4915c6da4ceb57a60dd466`; base main:
  `c014b32060ca2dc7ace4c83f181685a6e0140c78`. Candidate suites:
  `pnpm --filter @pi-desktop/agent-runtime test` (1,556/1,556),
  `pnpm test:e2e:hosted-search` (10/10), and
  `PI_DESKTOP_HOST_BIN=<reused debug host binary> pnpm test:e2e:trusted-extensions`
  (57/57). All three passed. E2E used isolated temporary profiles and fixtures,
  Electron 43.6.0 from the primary checkout, and the existing debug Host binary;
  it used no real provider credentials or live services.
- `pnpm build:js`, Desktop typecheck, lint, and `pnpm docs:check` passed.
- All 111 Agent Runtime test files passed (1,556 tests). The focused 1.4
  identity/contract/runtime/subagent set passed (426 tests).
- Pi dependency and patch gates passed; all 7 patch-hash fixture tests passed.
- Hosted-search E2E passed 10/10 scenarios. Trusted-extension E2E passed 57/57
  using the existing primary-checkout Electron and debug Host binaries with
  isolated fixture state. No real provider or live service was used.
- `pnpm -r --workspace-concurrency=1 --if-present test` completed with 4,550
  Desktop tests passed, 3 skipped, and one failure. The OAuth assertion passes
  in the complete run. The unchanged `composer-deep-file-search-user-path`
  Electron fixture also fails on a detached `origin/main` diagnostic worktree;
  both runs return no rows, with different final assertions. The test and its
  renderer search sources are unchanged by this task.
- Rust checks were not run because no Rust source, persistence, or Host contract
  changed. The trusted-extension E2E reused the existing debug Host binary.

## Rollback

Roll back the direct manifests, lockfile, exact release-age exclusions, the
three patch files, version gates, identity wiring, compatibility adaptations,
tests, and synchronized specs together. Never mix a patched 1.3.0 package with
the 1.4.0 release group. Existing user data needs no migration.
