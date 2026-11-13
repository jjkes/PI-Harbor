/**
 * A stand-in for the Electron preload bridge (`window.piDesktop`) so the
 * plan-debate panel can be drawn in a normal browser.
 *
 * The real surface is declared in `src/lib/api.ts` (`Window.piDesktop`) and the
 * real values come from `electron/preload/index.ts`. Only the two channels the
 * panel actually calls are answered with fixtures:
 *
 *   - `pi-harbor/plan-debate/artifacts` → the scenario's disk rounds
 *     (`electron/main/ipc/plan-debate-artifacts-ipc.ts`);
 *   - `pi-harbor/plan-debate/start` → a fake "started" answer that changes
 *     nothing (`electron/main/ipc/agent-ipc.ts:709` forwards it to the agent).
 *
 * Everything else answers `ok: false` with a typed refusal. That is deliberate:
 * the mock never throws, returns an enumerated error instead, and therefore
 * cannot pretend a host call worked. A channel this harness does not know about
 * is a channel the harness does not cover — the browser console says so.
 */
import {
  err,
  IPC,
  ok,
  type PlanDebateArtifactsResult,
  type PlanDebateRoundArtifacts,
  type PlanDebateStartResult,
  type Result,
} from "@pi-harbor/shared";

/** The rounds the artifacts channel answers with, set by the page's switcher. */
let artifacts: readonly PlanDebateRoundArtifacts[] = [];

/** Every channel the harness answered, newest first, for the debug bar. */
const calls: string[] = [];

const MAX_LOGGED_CALLS = 8;

export function setMockArtifacts(next: readonly PlanDebateRoundArtifacts[]): void {
  artifacts = next;
}

/** The channels requested since the page loaded, newest first. */
export function mockCallLog(): readonly string[] {
  return calls;
}

function roundOf(args: readonly unknown[]): number {
  const request = args[0];
  if (typeof request === "object" && request !== null) {
    const round = (request as { round?: unknown }).round;
    if (typeof round === "number") return round;
  }
  return 1;
}

function answer(channel: string, args: readonly unknown[]): Result<unknown> {
  if (channel === IPC.invoke.planDebateArtifacts) {
    const result: PlanDebateArtifactsResult = { rounds: [...artifacts] };
    return ok(result);
  }
  if (channel === IPC.invoke.planDebateStart) {
    // The panel reads `ok` and nothing else; a start the runtime would no-op is
    // answered as a no-op too, so no fixture is mutated by clicking.
    const result: PlanDebateStartResult = {
      ok: true,
      started: false,
      round: roundOf(args),
      delegationIds: [],
    };
    return ok(result);
  }
  return err(
    "HARNESS_MOCK_UNIMPLEMENTED",
    `${channel} is not stubbed by the plan-debate web harness`,
  );
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  calls.unshift(channel);
  if (calls.length > MAX_LOGGED_CALLS) calls.length = MAX_LOGGED_CALLS;
  // The cast is the boundary itself: fixtures are typed per channel above, and
  // the caller's `T` is whatever it is reading. Nothing crosses back untyped.
  return answer(channel, args) as Result<T>;
}

/**
 * Install the fake bridge. Call before the first render: `src/lib/api.ts` reads
 * `window.piDesktop` at call time, but the app store is created at import time.
 */
export function installHarnessBridge(): void {
  window.piDesktop = {
    invoke,
    // No main process, so no events: every subscription is a no-op unsubscriber.
    on: () => () => {},
    channels: IPC,
    platform: "darwin",
    locale: "en",
    getDroppedFilePath: () => null,
  };
}
