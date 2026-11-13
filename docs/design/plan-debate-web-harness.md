# Plan-debate web harness

A local, browser-only verification page for the work panel's plan-debate tab
(`apps/desktop/src/components/workpanel/PlanDebateTab.tsx`). It exists so the
panel can be opened, switched between fixture states, and inspected in a normal
browser, without a project, a host-core sidecar, an agent run, or Electron
itself.

It is **not a product surface**. It is not bundled, not packaged, and no module
under `src/` imports it.

> **This is a verification harness with mocked IPC.** Everything the panel reads
> over `window.piDesktop` is a fixture. A bug reproduced here is a rendering
> bug — a bad shape, a mis-derived phase, a missing control, a locale gap. A
> host bug, an IPC-contract bug, a persistence bug, or a runtime-scheduling bug
> **cannot** be reproduced here, because none of those layers are running.

## Running it

```bash
pnpm --filter @pi-harbor/desktop web
```

Then open <http://127.0.0.1:5199/>. The server binds IPv4 loopback on port 5199
and fails loudly if the port is taken, so two harnesses never share a URL.

The page renders the real component with the real app store, the real
`@pi-harbor/i18n` catalogs and the real renderer stylesheet. Only the preload
bridge is replaced.

## The page

The bar above the panel is debug chrome (plain buttons, not product UI):

| Control | Effect |
| --- | --- |
| `transcript-only` | the live transcript rows only; the artifacts channel answers `{ rounds: [] }` |
| `disk-only` | an empty transcript; the round is drawn entirely from the artifacts channel |
| `merged` | the transcript has lost its draft rows, the artifacts channel restores them |
| `empty-round` | a roster was proposed and nothing started: the start control, no seat |
| `round-2-pending` | round 1 complete plus a round 2 roster nobody started |
| `en` / `zh-CN` | switches the i18n language the panel translates with |
| `remount panel` | re-mounts the component, which re-runs its artifacts read |

Switching a fixture reseeds the store and bumps the panel's remount key, so the
component re-reads its artifacts exactly as an opened tab does. The bar also
prints the last IPC channels the mock answered, which is how you can tell what
the panel actually asked for.

## Fixtures

`apps/desktop/web/fixtures.ts` — each builder names the production reader it
mirrors, so a reader change surfaces here as a shape that no longer matches.

| Fixture | Mirrors | What it proves |
| --- | --- | --- |
| `proposalRow` (`PlanDebate` tool row) | `proposalFromPayload` in `src/features/plan-debate/plan-debate-view.ts` | the roster, the requirement and the rationale are read from the tool payload, not from stored state |
| `seatRow` (`Task` tool row ×9) | `nodeFromPayload` in the same module | 4 drafts (2 settled with `debateReport`, 2 `running`), 4 critiques (complete / failed with an error / complete / complete) and 1 integrator render as one timeline; a failed seat names its reason |
| `ROUND_ONE_SEATS` integrate report | `parseMergedPlan` in the same module | the `## VERDICTS` / `## PLAN` blocks split into a merged plan plus adopted/rejected verdict rows |
| `diskRound` | `readRound` in `electron/main/ipc/plan-debate-artifacts-ipc.ts` — the shape the `pi-harbor/plan-debate/artifacts` channel returns, assembled from `round-<N>.json`, one `.md` per seat and `merged.md` | a round without transcript rows is still drawn, marked "Recovered from disk", with the roster and its briefs read back from the index and each seat's `startedAt`/`completedAt` — so every recovered seat and phase shows a real span, never `0s` |
| `transcriptFor("merged")` | the panel's own disk read (`planDebateViewWithArtifacts`) | drafts that aged out of the transcript window come back from disk with their reports and their spans; disk outranks a row that still says `running` |

The mock bridge (`apps/desktop/web/mock-bridge.ts`) answers exactly two
channels:

- `pi-harbor/plan-debate/artifacts` → the current fixture;
- `pi-harbor/plan-debate/start` → a no-op `started: false`, so pressing
  "Start debate" cannot mutate a fixture.

Every other channel answers `ok: false` with
`HARNESS_MOCK_UNIMPLEMENTED` and the channel name. That is a typed refusal, not
a throw: the panel's own error path renders it inline (for example
"Hand off to team mode" reports that `pi-harbor/session/team/get` is not
stubbed), which is also a useful demonstration that the error surface works.

## What the harness cannot supply

- **The hand-off to team mode.** It calls `teamService.setEnabled` and
  `sendPrompt`; team mode's channels are not mocked, so the button ends in its
  inline error. Choosing a plan *does* enable the button
  (`data-plan-debate-handoff="ready"`), which is the rendering fact worth
  checking here.
- **Re-debate.** It sends a prompt; the harness logs it and accepts it, but no
  round 3 appears, because nothing produces the next round's rows.
- **Live delegation statuses.** The seam that fuses the panel with the subagent
  dock (`useSessionDelegations`) runs on the seeded transcript, and its
  statuses agree with the rows because the fixtures declare them. Runtime
  events (`on(...)`) are no-ops.
- **A project.** No project path, no debate directory, no file system: the disk
  path is exercised through the mocked channel only.

## Files

| Path | Role |
| --- | --- |
| `apps/desktop/web/index.html` | the harness page |
| `apps/desktop/web/main.tsx` | React root, i18n init, store seeding, the debug bar |
| `apps/desktop/web/install.ts` | installs the mock bridge before any renderer module is evaluated |
| `apps/desktop/web/mock-bridge.ts` | the fake `window.piDesktop` |
| `apps/desktop/web/fixtures.ts` | the transcript, disk and session fixtures |
| `apps/desktop/web/harness.css` | chrome for the debug page only |
| `apps/desktop/vite.web.config.ts` | Vite config: root `web/`, port 5199, renderer aliases, no electron-vite |

`web/**` and `vite.web.config.ts` are in the desktop `tsconfig.json` include, so
the harness is type-checked against the component it draws. They are **not** in
the electron-vite build inputs, so `pnpm build:js`, `pnpm build` and `pnpm pack`
are unaffected, and electron-builder ships `out/**` only — nothing from `web/`
reaches a release.
