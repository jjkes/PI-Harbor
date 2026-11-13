/**
 * A debate round, written where the user can read it after the transcript has
 * moved on.
 *
 * The transcript is a window — the panel reads the last hundred rows — and one
 * debate produces fifteen of them, so the drafts of a round fall out of the
 * window while its critiques are still in it. The panel then draws a draft seat
 * as "still drafting" forever, and a reload cannot read the round at all. The
 * files here are the durable copy: one directory per round under
 * `<projectPath>/.pi-harbor/debate/`, one Markdown file per settled seat, and a
 * small index that names them. The transcript stays the live source; these
 * files are what survives it.
 *
 * Two rules are the whole module:
 *
 * 1. A role never becomes a path. Handles come from a per-project catalog, so
 *    they may be CJK, may contain slashes, may be `..`. A file name is derived
 *    from a restricted alphabet and the rest is dropped, so a file name can only
 *    ever be a plain name inside the round's own directory.
 * 2. Persistence never fails a delegate. A round that ran is a round the user
 *    paid for; a disk error is logged once and the settlement continues, because
 *    a missing file is recoverable and a failed turn is not.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { PlanDebatePhase, PlanDebateOutcome } from "./plan-debate-driver.js";

/** The project-relative home of a session's debate artifacts. */
export const PLAN_DEBATE_ARTIFACT_ROOT = [".pi-harbor", "debate"] as const;

/** The index schema this writer produces; a reader may find an older one. */
export const PLAN_DEBATE_INDEX_VERSION = 1;

/** The integrator's merged plan, inside the round directory. */
export const PLAN_DEBATE_MERGED_FILE = "merged.md";

/** Longest slug kept from a role handle before it is cut. */
const MAX_SLUG_CHARS = 48;

/** One roster seat, as the round index records it before any delegate runs. */
export type PlanDebateRosterRole = { name: string; brief: string; seat: number };

/** The roster and requirement a round starts with. */
export type PlanDebateArtifactRoster = {
  round: number;
  requirement: string;
  roles: readonly PlanDebateRosterRole[];
};

/** One settled seat in the round index: the file name, never the text. */
export type PlanDebateArtifactSeat = {
  phase: PlanDebatePhase;
  role: string;
  seat: number;
  status: PlanDebateOutcome;
  delegationId: string;
  startedAt?: number;
  completedAt?: number;
  reportFile?: string;
  error?: string;
};

/** `round-<N>.json`: the round's roster, its settled seats and its outcome. */
export type PlanDebateRoundIndex = {
  version: number;
  round: number;
  requirement: string;
  startedAt?: number;
  completedAt?: number;
  stoppedAt?: number;
  /**
   * The roster the round started with. The transcript's proposal row is the
   * live copy; this one survives the row, so a reload keeps the briefs a round
   * was debated under instead of drawing every seat with an empty one.
   */
  roles?: PlanDebateRosterRole[];
  seats: PlanDebateArtifactSeat[];
  mergedFile?: string;
  failure?: { code: string; message: string };
};

/** One settlement, as the runtime knows it when a seat answers. */
export type PlanDebateArtifactSettlement = {
  round: number;
  requirement: string;
  phase: PlanDebatePhase;
  role: string;
  seat: number;
  outcome: PlanDebateOutcome;
  delegationId: string;
  /** The delegate's own conclusion; empty for a seat that produced none. */
  report: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  /**
   * The round's terminal failure, when this settlement is the one that ended
   * the round without a plan. The index carries it so a reopened round says why
   * it stopped instead of looking merely unfinished.
   */
  failure?: { code: string; message: string };
  /** Whether this settlement closed the round, with a plan or without one. */
  roundEnded?: boolean;
};

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * A role handle as a file-name stem, or `""` when nothing ASCII survived.
 *
 * `ui-架构` becomes `ui`, `a/b` becomes `a-b`, `../etc` becomes `etc`, and a
 * handle that is CJK only becomes nothing at all: a transliteration would be a
 * guess about a name the user owns, and a hash alone tells them nothing. The
 * caller writes `<phase>-seat<seat>.md` for that case and keeps the original
 * handle in the index, so the panel still shows the role the user recognises.
 */
export function debateRoleSlug(role: string): string {
  return role
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/, "");
}

/**
 * One seat's report file: `<phase>-<slug>[-<seat>].md`, or
 * `<phase>-seat<seat>.md` when the handle has no ASCII to keep.
 *
 * `taken` holds the names the round's other seats already own. Two different
 * roles can collapse to one stem (`frontend-architect` and `frontend architect`,
 * or two CJK handles that both reduce to nothing), so the second one is told
 * apart by the hash of its handle rather than overwriting the first.
 */
export function debateSeatFile(
  phase: PlanDebatePhase,
  role: string,
  seat: number,
  taken: ReadonlySet<string> = new Set<string>(),
): string {
  const slug = debateRoleSlug(role);
  const stem =
    slug === ""
      ? `${phase}-seat${seat}.md`
      : `${phase}-${slug}${seat > 1 ? `-${seat}` : ""}.md`;
  return taken.has(stem) ? `${stem.slice(0, -3)}-${shortHash(role)}.md` : stem;
}

/** The round directory: `<projectPath>/.pi-harbor/debate/round-<N>`. */
export function planDebateRoundDirectory(projectPath: string, round: number): string {
  const root = resolve(projectPath, ...PLAN_DEBATE_ARTIFACT_ROOT);
  const directory = resolve(root, `round-${round}`);
  // A round number is an integer by construction; the check is what makes the
  // "never write outside the debate root" promise hold even if it is not.
  if (!Number.isInteger(round) || round < 1) {
    throw new Error(`invalid debate round: ${String(round)}`);
  }
  const rel = relative(root, directory);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`debate round ${round} resolves outside the artifact root`);
  }
  return directory;
}

/**
 * Remove one round's durable files. A missing round is already deleted; every
 * other filesystem failure stays visible to the user instead of looking like a
 * successful delete.
 */
export async function removePlanDebateRound(
  projectPath: string,
  round: number,
): Promise<{ ok: boolean; round: number; errorCode?: string; message?: string }> {
  try {
    await rm(planDebateRoundDirectory(projectPath, round), { recursive: true, force: true });
    return { ok: true, round };
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown };
    if (candidate.code === "ENOENT") return { ok: true, round };
    return {
      ok: false,
      round,
      errorCode: typeof candidate.code === "string" ? candidate.code : "PLAN_DEBATE_DELETE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isPhase(value: unknown): value is PlanDebatePhase {
  return value === "draft" || value === "critique" || value === "integrate";
}

function isOutcome(value: unknown): value is PlanDebateOutcome {
  return value === "complete" || value === "failed" || value === "stopped";
}

function seatKey(seat: Pick<PlanDebateArtifactSeat, "phase" | "role" | "seat">): string {
  return `${seat.phase}:${seat.role}#${seat.seat}`;
}
/**
 * The index's roster, as a reader can trust it: a role needs a name, and its
 * brief and seat are optional because an index written before the roster was
 * persisted has neither.
 */
function parseRosterRoles(value: unknown): PlanDebateRosterRole[] {
  const roles: PlanDebateRosterRole[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (!isRecord(entry)) continue;
    const name = text(entry.name);
    if (name === undefined) continue;
    const brief = typeof entry.brief === "string" ? entry.brief : "";
    const seat = finiteNumber(entry.seat);
    roles.push({ name, brief, seat: seat !== undefined && seat >= 1 ? seat : 1 });
  }
  return roles;
}

/**
 * Read a round index this writer (or an older one, or a person) produced.
 *
 * Every field is re-checked because the file is on disk and a hand-edited or
 * half-written index is data, not trust. A malformed file is treated as absent:
 * the round is rewritten from the settlement that is arriving right now.
 */
export function parsePlanDebateRoundIndex(raw: string, round: number): PlanDebateRoundIndex | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const seats: PlanDebateArtifactSeat[] = [];
  for (const entry of Array.isArray(parsed.seats) ? parsed.seats : []) {
    if (!isRecord(entry)) continue;
    const phase = entry.phase;
    const role = text(entry.role);
    const seat = finiteNumber(entry.seat);
    const status = entry.status;
    const delegationId = text(entry.delegationId);
    if (!isPhase(phase) || role === undefined || seat === undefined || seat < 1) continue;
    if (!isOutcome(status) || delegationId === undefined) continue;
    const startedAt = finiteNumber(entry.startedAt);
    const completedAt = finiteNumber(entry.completedAt);
    const reportFile = text(entry.reportFile);
    const error = text(entry.error);
    seats.push({
      phase,
      role,
      seat,
      status,
      delegationId,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(reportFile !== undefined ? { reportFile } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }
  const requirement = typeof parsed.requirement === "string" ? parsed.requirement : "";
  const startedAt = finiteNumber(parsed.startedAt);
  const completedAt = finiteNumber(parsed.completedAt);
  const stoppedAt = finiteNumber(parsed.stoppedAt);
  const mergedFile = text(parsed.mergedFile);
  const roles = parseRosterRoles(parsed.roles);
  const failureRecord = isRecord(parsed.failure) ? parsed.failure : null;
  const failure =
    failureRecord && typeof failureRecord.code === "string" && typeof failureRecord.message === "string"
      ? { code: failureRecord.code, message: failureRecord.message }
      : undefined;
  return {
    version: PLAN_DEBATE_INDEX_VERSION,
    round,
    requirement,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    ...(roles.length > 0 ? { roles } : {}),
    seats,
    ...(mergedFile !== undefined ? { mergedFile } : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
}

/**
 * The writer for one session's rounds.
 *
 * Writes are serialized per round and never reject: a settlement is recorded
 * once, and the caller awaits only to know the files are on disk (tests do,
 * the runtime does not). One disk failure is logged once — a broken project
 * directory would otherwise print a line per seat.
 */
export class PlanDebateArtifactWriter {
  private readonly projectPath: string;
  private readonly log: (message: string) => void;
  private readonly pending = new Map<number, Promise<void>>();
  private readonly deletedRounds = new Set<number>();
  private warned = false;

  constructor(projectPath: string, log?: (message: string) => void) {
    this.projectPath = projectPath;
    this.log = log ?? ((message) => process.stderr.write(`${message}\n`));
  }

  /** A deleted round stays deleted even if an older settlement arrives late. */
  markDeleted(round: number): void {
    this.deletedRounds.add(round);
  }

  /** Wait for writes already queued for one round, without writing anything. */
  async drain(round: number): Promise<void> {
    await this.pending.get(round);
  }

  /** Record one settled seat. The returned promise never rejects. */
  record(settlement: PlanDebateArtifactSettlement): Promise<void> {
    if (this.deletedRounds.has(settlement.round)) return Promise.resolve();
    const previous = this.pending.get(settlement.round) ?? Promise.resolve();
    // `catch` on the previous pass so one failure cannot skip the next write;
    // the write itself already absorbs its own error.
    const next = previous.catch(() => undefined).then(() => this.write(settlement));
    this.pending.set(settlement.round, next);
    return next;
  }

  /**
   * Record the roster a round starts with. The returned promise never rejects.
   *
   * Called once, before the first seat is dispatched, so `round-<N>.json`
   * names who debated and what each seat was briefed with even after the
   * transcript's proposal row has aged out of the window. A roster write that
   * fails costs the briefs, never the round: the settlements still land.
   */
  recordRoster(roster: PlanDebateArtifactRoster): Promise<void> {
    if (this.deletedRounds.has(roster.round)) return Promise.resolve();
    const previous = this.pending.get(roster.round) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.writeRoster(roster));
    this.pending.set(roster.round, next);
    return next;
  }

  /**
   * Record that the user ended the debate round, stamping the round's index
   * with a `stoppedAt` timestamp and persisting the change to disk.
   * This is used when the user closes a round from the panel.
   *
   * If the round has no artifact index (e.g. it was proposed but never started),
   * this method is a no‑op.
   */
  async recordStopped(round: number, stoppedAt = Date.now()): Promise<void> {
    if (this.deletedRounds.has(round)) return;
    const previous = this.pending.get(round) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.writeStopped(round, stoppedAt));
    this.pending.set(round, next);
    return next;
  }

  private async writeStopped(round: number, stoppedAt: number): Promise<void> {
    if (this.deletedRounds.has(round)) return;
    try {
      const directory = planDebateRoundDirectory(this.projectPath, round);
      const indexPath = join(directory, `round-${round}.json`);
      const existing = await this.readIndex(indexPath, round);
      if (!existing || this.deletedRounds.has(round)) return;
      const next = { ...existing, stoppedAt: existing.stoppedAt ?? stoppedAt };
      await this.writeFileAtomic(indexPath, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(
        `[agent-runtime] plan debate stopped stamp failed (project=${this.projectPath}): ${String(error)}\n`,
      );
    }
  }
  private reportFailure(error: unknown, settlement: PlanDebateArtifactSettlement): void {
    if (this.warned) return;
    this.warned = true;
    const reason = error instanceof Error ? error.message : String(error);
    this.log(
      `[agent-runtime] plan debate artifacts not written (session round=${settlement.round} phase=${settlement.phase} role=${settlement.role}): ${reason}; the round continues`,
    );
  }

  private reportRosterFailure(error: unknown, roster: PlanDebateArtifactRoster): void {
    if (this.warned) return;
    this.warned = true;
    const reason = error instanceof Error ? error.message : String(error);
    this.log(
      `[agent-runtime] plan debate roster not written (session round=${roster.round}): ${reason}; the round continues`,
    );
  }

  private async writeRoster(roster: PlanDebateArtifactRoster): Promise<void> {
    if (this.deletedRounds.has(roster.round)) return;
    try {
      const directory = planDebateRoundDirectory(this.projectPath, roster.round);
      await mkdir(directory, { recursive: true });
      const indexPath = join(directory, `round-${roster.round}.json`);
      const existing = await this.readIndex(indexPath, roster.round);
      const roles = roster.roles.map((role) => ({
        name: role.name,
        brief: typeof role.brief === "string" ? role.brief : "",
        seat: Number.isInteger(role.seat) && role.seat >= 1 ? role.seat : 1,
      }));
      const next: PlanDebateRoundIndex = {
        version: PLAN_DEBATE_INDEX_VERSION,
        round: roster.round,
        requirement: roster.requirement || existing?.requirement || "",
        startedAt: existing?.startedAt ?? Date.now(),
        ...(existing?.completedAt !== undefined ? { completedAt: existing.completedAt } : {}),
        ...(existing?.stoppedAt !== undefined ? { stoppedAt: existing.stoppedAt } : {}),
        roles,
        seats: existing?.seats ?? [],
        ...(existing?.mergedFile !== undefined ? { mergedFile: existing.mergedFile } : {}),
        ...(existing?.failure !== undefined ? { failure: existing.failure } : {}),
      };
      if (this.deletedRounds.has(roster.round)) return;
      await this.writeFileAtomic(indexPath, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      this.reportRosterFailure(error, roster);
    }
  }
  private async write(settlement: PlanDebateArtifactSettlement): Promise<void> {
    if (settlement.delegationId === "" || this.deletedRounds.has(settlement.round)) return;
    try {
      const directory = planDebateRoundDirectory(this.projectPath, settlement.round);
      await mkdir(directory, { recursive: true });
      const indexPath = join(directory, `round-${settlement.round}.json`);
      const existing = await this.readIndex(indexPath, settlement.round);
      const next = await this.merge(directory, existing, settlement);
      if (this.deletedRounds.has(settlement.round)) return;
      await this.writeFileAtomic(indexPath, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      this.reportFailure(error, settlement);
    }
  }

  private async readIndex(path: string, round: number): Promise<PlanDebateRoundIndex | null> {
    try {
      return parsePlanDebateRoundIndex(await readFile(path, "utf8"), round);
    } catch {
      // A missing index is the normal first settlement of a round.
      return null;
    }
  }

  /** The index with this settlement applied, plus the files it names. */
  private async merge(
    directory: string,
    existing: PlanDebateRoundIndex | null,
    settlement: PlanDebateArtifactSettlement,
  ): Promise<PlanDebateRoundIndex> {
    const report = settlement.report.trim() === "" ? undefined : settlement.report;
    const previousSeats = existing?.seats ?? [];
    // The names the other seats already own, so a slug collision cannot make
    // this seat overwrite an existing report.
    const taken = new Set<string>();
    for (const seat of previousSeats) {
      if (seatKey(seat) === seatKey(settlement)) continue;
      if (seat.reportFile !== undefined) taken.add(seat.reportFile);
    }
    const reportFile =
      report === undefined ? undefined : debateSeatFile(settlement.phase, settlement.role, settlement.seat, taken);
    if (report !== undefined && reportFile !== undefined) {
      await writeFile(join(directory, reportFile), `${report}\n`, "utf8");
    }
    const startedAt =
      settlement.startedAt ?? existing?.startedAt ?? settlement.completedAt ?? Date.now();
    const entry: PlanDebateArtifactSeat = {
      phase: settlement.phase,
      role: settlement.role,
      seat: settlement.seat,
      status: settlement.outcome,
      delegationId: settlement.delegationId,
      ...(settlement.startedAt !== undefined ? { startedAt: settlement.startedAt } : {}),
      ...(settlement.completedAt !== undefined ? { completedAt: settlement.completedAt } : {}),
      ...(reportFile !== undefined ? { reportFile } : {}),
      ...(settlement.error !== undefined ? { error: settlement.error } : {}),
    };
    const seats = previousSeats.some((seat) => seatKey(seat) === seatKey(entry))
      ? previousSeats.map((seat) => (seatKey(seat) === seatKey(entry) ? entry : seat))
      : [...previousSeats, entry];

    let mergedFile = existing?.mergedFile;
    if (settlement.phase === "integrate" && report !== undefined) {
      await writeFile(join(directory, PLAN_DEBATE_MERGED_FILE), `${report}\n`, "utf8");
      mergedFile = PLAN_DEBATE_MERGED_FILE;
    }
    const finished = settlement.roundEnded === true || settlement.failure !== undefined;
    return {
      version: PLAN_DEBATE_INDEX_VERSION,
      round: settlement.round,
      // A settlement from an already-ended in-memory round may no longer know
      // its requirement. The durable roster remains the authoritative copy.
      requirement: settlement.requirement || existing?.requirement || "",
      startedAt: Math.min(startedAt, existing?.startedAt ?? startedAt),
      // The round's own end is stamped once; a later settlement cannot move it.
      ...(finished ? { completedAt: existing?.completedAt ?? settlement.completedAt ?? Date.now() } : {}),
      ...(existing?.completedAt !== undefined && !finished ? { completedAt: existing.completedAt } : {}),
      ...(existing?.stoppedAt !== undefined ? { stoppedAt: existing.stoppedAt } : {}),
      // The roster is written when the round starts and never rewritten by a
      // settlement: a settlement names one seat, not the roster it came from.
      ...(existing?.roles !== undefined ? { roles: existing.roles } : {}),
      seats,
      ...(mergedFile !== undefined ? { mergedFile } : {}),
      ...(settlement.failure !== undefined ? { failure: settlement.failure } : {}),
    };
  }

  /** Write-then-rename: a reader never sees half an index. */
  private async writeFileAtomic(path: string, contents: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, path);
  }
}
