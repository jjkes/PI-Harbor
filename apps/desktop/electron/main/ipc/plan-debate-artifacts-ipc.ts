import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  IPC,
  type PlanDebateArtifactsResult,
  type PlanDebateArtifactSeat,
  type PlanDebateArtifactPhase,
  type PlanDebateArtifactRole,
  type PlanDebateArtifactStatus,
  type PlanDebateRoundArtifacts,
} from "@pi-harbor/shared";
import type { IpcRegistrar } from "./types";

/**
 * Plan-debate artifacts are what the runtime already wrote under
 * `<projectPath>/.pi-harbor/debate/round-<N>/`: one `.md` report per settled
 * seat, the integrator's `merged.md`, and the round's own `round-<N>.json`
 * index. Disk is additive here — the transcript stays the fallback. An absent
 * debate root is genuinely empty; resolution and read failures reject so the
 * panel can retain its last good cache instead of mistaking failure for empty.
 */
export type PlanDebateArtifactsIpcDependencies = {
  registrar: Pick<IpcRegistrar, "handle">;
  /** The session's project, from main's own map or the host; null when unknown. */
  getProjectPath: (sessionId: string) => Promise<string | null>;
};

/** Per-report character cap; a longer report is cut, not treated as unreadable. */
export const MAX_ARTIFACT_REPORT_CHARS = 20_000;

/** How many trailing rounds one read returns; older rounds stay on disk. */
export const MAX_ARTIFACT_ROUNDS = 20;

/** A round directory is exactly `round-<digits>`; anything else is not ours. */
const ROUND_DIRECTORY = /^round-(\d+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function isPhase(value: unknown): value is PlanDebateArtifactPhase {
  return value === "draft" || value === "critique" || value === "integrate";
}

function isStatus(value: unknown): value is PlanDebateArtifactStatus {
  return value === "complete" || value === "failed" || value === "stopped";
}

/** A non-empty string after trimming; the original text is kept verbatim. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function debateRoot(projectPath: string | null | undefined): string | null {
  const root = typeof projectPath === "string" ? projectPath.trim() : "";
  return root ? resolve(root, ".pi-harbor", "debate") : null;
}

function wantedRound(request: unknown): number | undefined {
  return isRecord(request) ? positiveInteger(request.round) : undefined;
}

/**
 * The index is untrusted: an older, partial or hand-written file must only cost
 * us entries, so a path is used only when it stays inside the round directory.
 * `relative` answers "" for the directory itself and a leading ".." (or an
 * absolute path) for an escape, which are exactly the cases we drop.
 */
function containedPath(roundDir: string, fileName: string): string | null {
  const resolved = resolve(roundDir, fileName);
  const inside = relative(roundDir, resolved);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return null;
  return resolved;
}

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/** A missing report is reportless; every other report read failure is fatal. */
async function readReport(path: string): Promise<string | null> {
  try {
    const text = await readText(path);
    return text.slice(0, MAX_ARTIFACT_REPORT_CHARS);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function readSeat(
  raw: unknown,
  roundDir: string,
): Promise<PlanDebateArtifactSeat | null> {
  if (!isRecord(raw)) return null;
  const role = nonEmptyString(raw.role);
  const delegationId = nonEmptyString(raw.delegationId);
  const seat = positiveInteger(raw.seat);
  if (!role || !delegationId || seat === undefined) return null;
  if (!isPhase(raw.phase) || !isStatus(raw.status)) return null;
  const artifact: PlanDebateArtifactSeat = {
    phase: raw.phase,
    role,
    seat,
    status: raw.status,
    delegationId,
  };
  const startedAt = finiteNumber(raw.startedAt);
  if (startedAt !== undefined) artifact.startedAt = startedAt;
  const completedAt = finiteNumber(raw.completedAt);
  if (completedAt !== undefined) artifact.completedAt = completedAt;
  const error = typeof raw.error === "string" ? raw.error : undefined;
  if (error !== undefined) artifact.error = error;
  const reportFile = nonEmptyString(raw.reportFile);
  const reportPath = reportFile ? containedPath(roundDir, reportFile) : null;
  const report = reportPath ? await readReport(reportPath) : null;
  if (report !== null) artifact.report = report;
  return artifact;
}

function readFailure(value: unknown): { code?: string; message?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const code = typeof value.code === "string" ? value.code : undefined;
  const message = typeof value.message === "string" ? value.message : undefined;
  if (code === undefined && message === undefined) return undefined;
  return { ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) };
}

/**
 * The index's roster, as the panel draws it. A role needs a name to be
 * drawable; its brief and seat are optional because an index written before the
 * roster was persisted has neither, and such a round still has to render.
 */
function readRoles(value: unknown): PlanDebateArtifactRole[] {
  const roles: PlanDebateArtifactRole[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (!isRecord(entry)) continue;
    const name = nonEmptyString(entry.name);
    if (!name) continue;
    roles.push({
      name,
      brief: typeof entry.brief === "string" ? entry.brief : "",
      seat: positiveInteger(entry.seat) ?? 1,
    });
  }
  return roles;
}

/**
 * One round. Its index is authoritative: a missing, unreadable or malformed
 * index fails the whole refresh rather than silently returning a partial list.
 */
async function readRound(round: number, roundDir: string): Promise<PlanDebateRoundArtifacts> {
  const indexText = await readText(resolve(roundDir, `round-${round}.json`));
  let parsed: unknown;
  try {
    parsed = JSON.parse(indexText);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot parse plan-debate round ${round} index: ${reason}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Plan-debate round ${round} index is not an object`);
  }
  const seats: PlanDebateArtifactSeat[] = [];
  if (Array.isArray(parsed.seats)) {
    // Index order is the round's own order; a bad seat is dropped, not fatal.
    for (const entry of parsed.seats) {
      const seat = await readSeat(entry, roundDir);
      if (seat) seats.push(seat);
    }
  }
  const roles = readRoles(parsed.roles);
  const artifacts: PlanDebateRoundArtifacts = {
    version: finiteNumber(parsed.version) ?? 1,
    round,
    requirement: typeof parsed.requirement === "string" ? parsed.requirement : "",
    seats,
  };
  // Omitted when the index carries no roster: an older round then renders from
  // its seats alone instead of growing an empty list it never had.
  if (roles.length > 0) artifacts.roles = roles;
  const startedAt = finiteNumber(parsed.startedAt);
  if (startedAt !== undefined) artifacts.startedAt = startedAt;
  const completedAt = finiteNumber(parsed.completedAt);
  if (completedAt !== undefined) artifacts.completedAt = completedAt;
  const stoppedAt = finiteNumber(parsed.stoppedAt);
  if (stoppedAt !== undefined) artifacts.stoppedAt = stoppedAt;
  const failure = readFailure(parsed.failure);
  if (failure !== undefined) artifacts.failure = failure;
  const mergedFile = nonEmptyString(parsed.mergedFile);
  const mergedPath = mergedFile ? containedPath(roundDir, mergedFile) : null;
  const merged = mergedPath ? await readReport(mergedPath) : null;
  if (merged !== null) artifacts.merged = merged;
  return artifacts;
}

/** Direct `round-<digits>` children of the debate root, ascending; none if absent. */
async function listRounds(root: string): Promise<{ round: number; dir: string }[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const rounds: { round: number; dir: string }[] = [];
  for (const entry of entries) {
    // Symlinks are not followed here: only a real directory is a round.
    if (!entry.isDirectory()) continue;
    const match = ROUND_DIRECTORY.exec(entry.name);
    if (!match) continue;
    const round = Number(match[1]);
    if (!Number.isSafeInteger(round)) continue;
    rounds.push({ round, dir: resolve(root, entry.name) });
  }
  rounds.sort((a, b) => a.round - b.round);
  return rounds;
}

/**
 * Read one session's plan-debate rounds back off disk. Only an absent debate
 * root is an empty successful read; project, directory and round failures
 * reject so callers cannot confuse them with an authoritative empty list.
 */
export async function readPlanDebateArtifacts(
  projectPath: string | null | undefined,
  request: unknown,
): Promise<PlanDebateArtifactsResult> {
  const root = debateRoot(projectPath);
  if (!root) throw new Error("A local project path is required to read plan-debate artifacts");
  const wanted = wantedRound(request);
  const candidates = (await listRounds(root)).filter(
    (entry) => wanted === undefined || entry.round === wanted,
  );
  // Keep the newest rounds: the panel only ever shows the tail of the pipeline.
  const kept = candidates.slice(Math.max(0, candidates.length - MAX_ARTIFACT_ROUNDS));
  const rounds: PlanDebateRoundArtifacts[] = [];
  for (const entry of kept) {
    rounds.push(await readRound(entry.round, entry.dir));
  }
  return { rounds };
}

export function registerPlanDebateArtifactsIpc({
  registrar,
  getProjectPath,
}: PlanDebateArtifactsIpcDependencies): void {
  registrar.handle(IPC.invoke.planDebateArtifacts, async (raw: unknown): Promise<PlanDebateArtifactsResult> => {
    const sessionId = isRecord(raw) ? nonEmptyString(raw.sessionId) : undefined;
    if (!sessionId) throw new Error("sessionId is required to read plan-debate artifacts");
    // Host/project resolution is part of the read's authority. Never turn a
    // rejected lookup or an unresolved project into an apparently empty disk.
    const projectPath = await getProjectPath(sessionId);
    return readPlanDebateArtifacts(projectPath, raw);
  });
}
