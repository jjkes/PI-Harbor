/**
 * The plan-debate driver: one round of proposing, drafting, critiquing and
 * integrating, as data.
 *
 * A `PlanDebate` tool call only *proposes* a roster: it creates the round in
 * `proposing` and starts nothing. Nothing drafts until the user confirms the
 * roster in the panel, which flips the round to `draft` through
 * `startPlanDebate` — the runtime then advances the pipeline the same way a
 * settlement does. That gate is the point: an expensive round of delegates
 * never runs on the model's word alone. The state machine that decides what
 * to start next lives here as pure functions. The runtime owns the delegate
 * executor and the await windows; this module owns the order, the briefs, and
 * the rule that a round ends in exactly one place — either a merged plan or a
 * typed failure.
 *
 * Two invariants are the whole point:
 *
 * 1. Only this driver advances a phase. A settled delegate is recorded here and
 *    can never start another draft, critique, or integrator by itself, so the
 *    pipeline cannot re-enter itself however the settlements interleave.
 * 2. A failed role never aborts the round. Its failure is recorded, reported to
 *    the critics and the integrator as text, and the round carries on with the
 *    work that did come back — only a round with no usable draft at all fails.
 *
 * A seat, not a role, is the unit: a roster may seat the same specialty twice
 * (`frontend-architect` #1 and #2), so every key, document and label is built
 * from `debateSeatHandle(role, seat)` rather than from the role name.
 */
import { debateSeatHandle, type PlanDebateRoleProposal } from "./plan-debate.js";

/** The three phases that spend delegates. The panel's proposal phase costs none. */
export type PlanDebatePhase = "draft" | "critique" | "integrate";

/** Where a run is: waiting for the user's start, one of the phases, or a stop. */
export type PlanDebateStage = "proposing" | PlanDebatePhase | "done" | "failed";

/**
 * A delegate the driver wants started: which phase, and which seat.
 *
 * `seat` is optional so a caller holding only a handle (a hand-written start, an
 * older row) still names a valid seat; an omitted seat is the first one.
 */
export type PlanDebateStart = { phase: PlanDebatePhase; role: string; seat?: number };

/** How a role's run ended. `stopped` is a user stop, not a failure of the plan. */
export type PlanDebateOutcome = "complete" | "failed" | "stopped";

/** One seat's answer for one phase: the document, or why there is none. */
export type PlanDebateContribution = {
  /** The seat's display handle: the role name, or `role #2` for a peer seat. */
  role: string;
  outcome: PlanDebateOutcome;
  report: string;
  error?: string;
};

/**
 * Why a round ended without a plan. Both codes are terminal for one round and
 * name the one thing the model can fix: the roster, or a re-run.
 */
export const PLAN_DEBATE_FAILURE_CODES = ["NO_DRAFTS", "NO_MERGED_PLAN"] as const;
export type PlanDebateFailureCode = (typeof PLAN_DEBATE_FAILURE_CODES)[number];

export type PlanDebateFailure = {
  code: PlanDebateFailureCode;
  message: string;
};

/** One round of a debate, from the roster to the merged plan. */
export type PlanDebateRun = {
  round: number;
  /** The user's requirement for this round. */
  requirement: string;
  /** The user's objection to the previous round, when this round is a re-debate. */
  objection: string;
  roles: readonly PlanDebateRoleProposal[];
  /** The seat that merges the drafts. One seat, never a separate pipeline. */
  integratorRole: string;
  /** Which occurrence of the integrating handle merges. */
  integratorSeat: number;
  stage: PlanDebateStage;
  /**
   * Seats already issued a start, keyed by phase and seat handle. Marking
   * before the await is what makes a concurrent settlement unable to start the
   * same seat twice.
   */
  started: readonly string[];
  /** Settled drafts, keyed by seat handle. A seat missing here is still drafting. */
  drafts: Readonly<Record<string, PlanDebateContribution>>;
  /** Settled critiques, keyed by seat handle. */
  critiques: Readonly<Record<string, PlanDebateContribution>>;
  integrate: PlanDebateContribution | null;
  failure: PlanDebateFailure | null;
};

/** A seat as the driver names it: the handle plus which occurrence it is. */
type RoleSeat = { role: string; seat: number };

/** Every seat of the roster, in speaking order. */
function roleSeats(run: Pick<PlanDebateRun, "roles">): RoleSeat[] {
  return run.roles.map((role) => ({ role: role.name, seat: role.seat }));
}

/** The display handle one seat's document is keyed by. */
export function planDebateSeatHandle(seat: RoleSeat): string {
  return debateSeatHandle(seat.role, seat.seat);
}

/** A start as a seat, defaulting an omitted seat to the first one. */
function seatOf(start: PlanDebateStart): RoleSeat {
  return { role: start.role, seat: start.seat ?? 1 };
}

/** The start key of one seat, so a phase's seats cannot collide. */
function seatKey(phase: PlanDebatePhase, seat: RoleSeat): string {
  return `${phase}:${planDebateSeatHandle(seat)}`;
}

/** A document a reader can actually open: a failed role contributes nothing. */
function isReadable(contribution: PlanDebateContribution | null | undefined): boolean {
  return (
    contribution !== undefined &&
    contribution !== null &&
    contribution.outcome === "complete" &&
    contribution.report.trim() !== ""
  );
}

/** Seats in roster order that the given phase still has to start. */
function unstarted(
  run: PlanDebateRun,
  phase: PlanDebatePhase,
  seats: readonly RoleSeat[],
): PlanDebateStart[] {
  return seats
    .filter((seat) => !run.started.includes(seatKey(phase, seat)))
    .map((seat) => ({ phase, role: seat.role, seat: seat.seat }));
}

/**
 * Start one round. The roster is already validated, so the only decision here
 * is who integrates: the caller may name a seat's handle, and the first seat of
 * the roster is the default because a debate always has at least one.
 */
export function createPlanDebateRun(input: {
  round: number;
  requirement: string;
  objection?: string;
  roles: readonly PlanDebateRoleProposal[];
  /** Handle of the integrating role; its first seat merges. */
  integratorRole?: string;
}): PlanDebateRun {
  const named = input.integratorRole?.trim() ?? "";
  const integrator =
    input.roles.find((role) => named !== "" && role.name === named) ?? input.roles[0];
  return {
    round: input.round,
    requirement: input.requirement,
    objection: input.objection?.trim() ?? "",
    roles: input.roles,
    integratorRole: integrator?.name ?? "",
    integratorSeat: integrator?.seat ?? 1,
    stage: "proposing",
    started: [],
    drafts: {},
    critiques: {},
    integrate: null,
    failure: null,
  };
}

/**
 * The starts the driver may issue right now, in roster order.
 *
 * The caller slices this to the free delegate slots: a debate that needs five
 * drafts while three subagents are already running waits for its own settlements
 * to free capacity, and the driver is called again by every settlement.
 */
/**
 * Start a proposed round: the user's confirmation is the only thing that opens
 * the pipeline. Idempotent by shape: a round that is not waiting for its start
 * — already drafting, already done, already failed — is returned unchanged, so
 * a double click, a retry, or a late start cannot re-issue a seat.
 */
export function startPlanDebate(run: PlanDebateRun): PlanDebateRun {
  if (run.stage !== "proposing" || run.failure) return run;
  return { ...run, stage: "draft" };
}

export function planDebatePendingStarts(run: PlanDebateRun): PlanDebateStart[] {
  if (run.failure || run.stage === "done" || run.stage === "failed") return [];
  // Nothing drafts until the user has confirmed the roster.
  if (run.stage === "proposing") return [];
  const seats = roleSeats(run);
  if (run.stage === "draft") return unstarted(run, "draft", seats);
  if (run.stage === "critique") return unstarted(run, "critique", seats);
  // One integrator, and it starts exactly once: the seat record is the guard.
  const integrator: RoleSeat = { role: run.integratorRole, seat: run.integratorSeat };
  return run.integrate || run.started.includes(seatKey("integrate", integrator))
    ? []
    : [{ phase: "integrate", ...integrator }];
}

/** Reserve a seat before awaiting its start, so no settlement can issue it twice. */
export function planDebateMarkStarted(
  run: PlanDebateRun,
  start: PlanDebateStart,
): PlanDebateRun {
  const key = seatKey(start.phase, seatOf(start));
  if (run.started.includes(key)) return run;
  return { ...run, started: [...run.started, key] };
}

function fail(
  run: PlanDebateRun,
  code: PlanDebateFailureCode,
  message: string,
): PlanDebateRun {
  return { ...run, stage: "failed", failure: { code, message } };
}

/** `role — failed: why`, the one line a brief and a failure share. */
function describeFailure(
  role: string,
  contribution: PlanDebateContribution | undefined,
): string {
  if (!contribution) return `${role} never settled`;
  const reason = contribution.error?.trim() || contribution.outcome;
  return `${role} — ${reason}`;
}

/**
 * Advance the stage when — and only when — the current phase has fully settled.
 *
 * It is idempotent: calling it after every settlement, and again from a capacity
 * check, moves the round at most one phase per call and never restarts one.
 */
export function advancePlanDebate(run: PlanDebateRun): PlanDebateRun {
  if (run.failure || run.stage === "done" || run.stage === "failed") return run;
  // A round waiting for the user's start does not move until they start it.
  if (run.stage === "proposing") return run;
  const seats = roleSeats(run);
  if (run.stage === "draft") {
    if (seats.some((seat) => !run.drafts[planDebateSeatHandle(seat)])) return run;
    const readable = seats.filter((seat) => isReadable(run.drafts[planDebateSeatHandle(seat)]));
    if (readable.length === 0) {
      return fail(
        run,
        "NO_DRAFTS",
        `Plan debate round ${run.round} produced no usable draft: ${seats
          .map((seat) =>
            describeFailure(planDebateSeatHandle(seat), run.drafts[planDebateSeatHandle(seat)]),
          )
          .join("; ")}. Nothing was critiqued or merged. Re-run PlanDebate — a role that failed once may answer on a new round.`,
      );
    }
    return { ...run, stage: "critique" };
  }
  if (run.stage === "critique") {
    if (seats.some((seat) => !run.critiques[planDebateSeatHandle(seat)])) return run;
    // A round where every critic failed still has drafts to merge, so critique
    // failure is reported to the integrator, not fatal.
    return { ...run, stage: "integrate" };
  }
  if (!run.integrate) return run;
  if (!isReadable(run.integrate)) {
    return fail(
      run,
      "NO_MERGED_PLAN",
      `Plan debate round ${run.round} has drafts but no merged plan: ${describeFailure(
        debateSeatHandle(run.integratorRole, run.integratorSeat),
        run.integrate,
      )}. The drafts are still readable; re-run PlanDebate or ask for one merged plan.`,
    );
  }
  return { ...run, stage: "done" };
}

/**
 * Record one settled seat, then advance if that settlement closed a phase.
 *
 * A settlement for a seat the driver did not issue (a refused start, or a
 * delegate from an older round) is recorded the same way: it is evidence about
 * that seat, and dropping it would hang the phase it belongs to.
 */
export function planDebateRecordSettlement(
  run: PlanDebateRun,
  input: {
    phase: PlanDebatePhase;
    role: string;
    /** Omitted by a caller that only knows the handle: the first seat. */
    seat?: number;
    outcome: PlanDebateOutcome;
    report: string;
    error?: string;
  },
): PlanDebateRun {
  const seat: RoleSeat = { role: input.role, seat: input.seat ?? 1 };
  const key = planDebateSeatHandle(seat);
  const contribution: PlanDebateContribution = {
    role: key,
    outcome: input.outcome,
    report: input.report,
    ...(input.error ? { error: input.error } : {}),
  };
  const next: PlanDebateRun =
    input.phase === "draft"
      ? { ...run, drafts: { ...run.drafts, [key]: contribution } }
      : input.phase === "critique"
        ? { ...run, critiques: { ...run.critiques, [key]: contribution } }
        : { ...run, integrate: contribution };
  return advancePlanDebate(next);
}

/** The document a phase produced for one seat, when it produced one. */
export function planDebateDraft(
  run: PlanDebateRun,
  role: string,
  seat = 1,
): PlanDebateContribution | undefined {
  return run.drafts[debateSeatHandle(role, seat)];
}

function requirementBlock(run: PlanDebateRun): string {
  const lines = [`The plan must satisfy this requirement:`, run.requirement.trim() || "(the user's latest request in this conversation)"];
  if (run.objection) {
    lines.push(
      "",
      `This round re-debates the previous plan. The user's objection, which the plan must also satisfy:`,
      run.objection,
    );
  }
  return lines.join("\n");
}

function draftsBlock(run: PlanDebateRun): string {
  return roleSeats(run)
    .map((seat) => {
      const handle = planDebateSeatHandle(seat);
      const draft = run.drafts[handle];
      if (isReadable(draft)) return `### ${handle}\n${draft?.report.trim() ?? ""}`;
      return `### ${handle} — no usable draft (${describeFailure(handle, draft)})`;
    })
    .join("\n\n");
}

function objectionsBlock(run: PlanDebateRun): string {
  return roleSeats(run)
    .map((seat) => {
      const handle = planDebateSeatHandle(seat);
      const critique = run.critiques[handle];
      if (isReadable(critique)) return `### ${handle}\n${critique?.report.trim() ?? ""}`;
      return `### ${handle} — no usable objections (${describeFailure(handle, critique)})`;
    })
    .join("\n\n");
}

/**
 * The complete instruction one debate delegate receives.
 *
 * A delegate cannot see the conversation, so every phase's brief carries what
 * that phase needs as text: the requirement, the drafts, the objections. Two
 * seats of one specialty get their own brief, which is what makes them peers
 * rather than the same argument twice.
 */
export function planDebateBrief(run: PlanDebateRun, start: PlanDebateStart): string {
  const seatNumber = start.seat ?? 1;
  const seat = run.roles.find((role) => role.name === start.role && role.seat === seatNumber);
  const handle = debateSeatHandle(start.role, seatNumber);
  const dissent = seat?.brief.trim() ?? "Draft and object from your own specialty.";
  const header = [
    `You are ${handle}, one voice in a plan debate (round ${run.round}).`,
    requirementBlock(run),
    `Your brief for this debate: ${dissent}`,
  ].join("\n\n");
  if (start.phase === "draft") {
    return [
      header,
      "Write your draft plan for this requirement from your own angle. Be concrete: the order of work, the files or components it touches, how it is verified, and the risks you see. Do not ask the user anything. Return only the draft plan as Markdown.",
    ].join("\n\n");
  }
  if (start.phase === "critique") {
    return [
      header,
      "Every role has drafted. Read all the drafts below and object to what is wrong, missing, or unverifiable — in the other drafts and in your own.",
      `## Drafts\n\n${draftsBlock(run)}`,
      "Return only your objections as Markdown. Each objection names the draft it targets, what is wrong, and what to do instead. If a draft is sound, say so explicitly instead of inventing an objection.",
    ].join("\n\n");
  }
  return [
    header,
    `You are the integrator for this round. Merge the drafts into one plan the user can act on, keeping what is right and rejecting what the objections prove wrong.`,
    `## Drafts\n\n${draftsBlock(run)}`,
    `## Objections\n\n${objectionsBlock(run)}`,
    [
      "Return exactly this shape, so the panel can read your verdicts:",
      "VERDICTS",
      "- adopted | <the item> | <the role it came from>",
      "- rejected | <the item or the objection> | <the role it came from>",
      "PLAN",
      "<the merged plan as Markdown>",
    ].join("\n"),
  ].join("\n\n");
}

/** Short label the topology row of one debate delegate shows. */
export function planDebateLabel(start: PlanDebateStart): string {
  const prefix =
    start.phase === "draft" ? "Draft" : start.phase === "critique" ? "Critique" : "Merge";
  return `${prefix} · ${debateSeatHandle(start.role, start.seat ?? 1)}`;
}
