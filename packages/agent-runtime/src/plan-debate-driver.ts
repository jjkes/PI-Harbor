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
import {
  debateSeatHandle,
  planDebateResolveIntegrator,
  planDebateRoleHasStructuredBrief,
  planDebateRoleMission,
  type PlanDebateRoleProposal,
} from "./plan-debate.js";

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
  /** Parsed structured synthesis when this contribution is a readable integrator report. */
  parsedSynthesis?: PlanDebateParsedSynthesis;
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
  /** When this round is a retry/restart of an earlier round, the original round number. */
  sourceRoundId?: number;
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

/** Remove a trailing '#N' seat selector from a role handle. */
function stripSeatSuffix(role: string): string {
  return role.replace(/\s+#\d+$/, "");
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
  /** Handle of the integrating role; its first seat merges. May include '#N' to pick a seat. */
  integratorRole?: string;
  /** Which occurrence of the integrating role merges. Takes precedence over '#N' in `integratorRole`. */
  integratorSeat?: number;
  /** When this round retries an earlier round, the original round number. */
  sourceRoundId?: number;
}): PlanDebateRun {
  let integratorRole: string;
  let integratorSeat: number;
  if (
    input.integratorSeat !== undefined &&
    Number.isInteger(input.integratorSeat) &&
    input.integratorSeat >= 1 &&
    input.integratorRole !== undefined &&
    input.integratorRole !== ""
  ) {
    integratorRole = stripSeatSuffix(input.integratorRole);
    integratorSeat = input.integratorSeat;
  } else {
    const resolved = planDebateResolveIntegrator(input.integratorRole ?? "", input.roles);
    integratorRole = resolved.role;
    integratorSeat = resolved.seat;
  }
  return {
    round: input.round,
    requirement: input.requirement,
    objection: input.objection?.trim() ?? "",
    roles: input.roles,
    integratorRole,
    integratorSeat,
    sourceRoundId: input.sourceRoundId,
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
  const parsedSynthesis =
    input.phase === "integrate" && input.outcome === "complete" && input.report.trim() !== ""
      ? parsePlanDebateSynthesis(input.report)
      : undefined;
  const contribution: PlanDebateContribution = {
    role: key,
    outcome: input.outcome,
    report: input.report,
    ...(parsedSynthesis ? { parsedSynthesis } : {}),
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

/** The parsed synthesis from an integrator contribution, if one was parsed. */
export function planDebateParsedSynthesis(
  contribution: PlanDebateContribution | null | undefined,
): PlanDebateParsedSynthesis | undefined {
  return contribution?.parsedSynthesis;
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

/**
 * Wrap a readable contribution in a labeled code fence so headings inside an
 * untrusted model report cannot leak into the brief structure or be mistaken
 * for the enclosing prompt's own sections.
 */
function fencedReport(handle: string, report: string): string {
  const body = report.trim();
  return `### ${handle}\n\`\`\`report\n${body}\n\`\`\``;
}

function draftsBlock(run: PlanDebateRun): string {
  return roleSeats(run)
    .map((seat) => {
      const handle = planDebateSeatHandle(seat);
      const draft = run.drafts[handle];
      if (isReadable(draft)) return fencedReport(handle, draft?.report ?? "");
      return `### ${handle} — no usable draft (${describeFailure(handle, draft)})`;
    })
    .join("\n\n");
}

function objectionsBlock(run: PlanDebateRun): string {
  return roleSeats(run)
    .map((seat) => {
      const handle = planDebateSeatHandle(seat);
      const critique = run.critiques[handle];
      if (isReadable(critique)) return fencedReport(handle, critique?.report ?? "");
      return `### ${handle} — no usable objections (${describeFailure(handle, critique)})`;
    })
    .join("\n\n");
}

/** Render a structured v2 brief as Markdown sections, or "" for a legacy brief. */
function structuredBriefBlock(role: PlanDebateRoleProposal): string {
  if (!planDebateRoleHasStructuredBrief(role)) return "";
  const sections: string[] = [];
  if (role.mission) sections.push(`MISSION\n${role.mission}`);
  if (role.context_digest) sections.push(`CONTEXT\n${role.context_digest}`);
  if (role.constraints && role.constraints.length > 0) {
    sections.push(`CONSTRAINTS\n${role.constraints.map((c) => `- ${c}`).join("\n")}`);
  }
  if (role.evidence_pack && role.evidence_pack.length > 0) {
    sections.push(`EVIDENCE PACK\n${role.evidence_pack.map((e) => `- ${e}`).join("\n")}`);
  }
  if (role.done_criteria && role.done_criteria.length > 0) {
    sections.push(`DONE CRITERIA\n${role.done_criteria.map((c) => `- ${c}`).join("\n")}`);
  }
  if (role.return_schema) sections.push(`RETURN SCHEMA\n${role.return_schema}`);
  return sections.length === 0 ? "" : sections.join("\n\n");
}

/**
 * Show every seat's evidence pack so a drafting seat stays in its own domain.
 * The current seat is marked; seats without an evidence pack are listed as
 * "general" so the current seat knows not to overreach.
 */
function evidenceDomainsBlock(run: PlanDebateRun, current: RoleSeat): string {
  const lines = ["Evidence domains across seats (stay in yours; do not duplicate another seat's evidence):"];
  for (const seat of roleSeats(run)) {
    const handle = planDebateSeatHandle(seat);
    const role = run.roles.find((r) => r.name === seat.role && r.seat === seat.seat);
    const pack = role?.evidence_pack;
    const marker = seat.role === current.role && seat.seat === current.seat ? " (you)" : "";
    if (pack && pack.length > 0) {
      lines.push(`- ${handle}${marker}: ${pack.join("; ")}`);
    } else if (role) {
      lines.push(`- ${handle}${marker}: general / ${planDebateRoleMission(role).slice(0, 80)}`);
    }
  }
  return lines.join("\n");
}

function draftInstructions(): string {
  return [
    "Write your draft plan for this requirement from your own angle. Be concrete: the order of work, the files or components it touches, how it is verified, and the risks you see.",
    "Do not ask the user anything. Return only the draft plan as Markdown.",
  ].join(" ");
}

function critiqueInstructions(): string {
  return [
    "Every role has drafted. Read all the drafts below and object to what is wrong, missing, or unverifiable — in the other drafts and in your own.",
    "Return your critique in this exact structure. Use every category that applies; leave a category empty only if there is truly nothing to say.",
    "FACTUAL_CONFLICTS",
    "- <draft handle> | <claim> | <why it conflicts with evidence>",
    "APPROACH_CONFLICTS",
    "- <draft handle> | <approach> | <why a different approach is better>",
    "EVIDENCE_GAPS",
    "- <draft handle> | <missing evidence> | <what would close the gap>",
    "SOUND_ITEMS",
    "- <draft handle> | <item> | <why it is sound>",
  ].join("\n");
}

function legacyCritiqueInstructions(): string {
  return [
    "Every role has drafted. Read all the drafts below and object to what is wrong, missing, or unverifiable — in the other drafts and in your own.",
    "Return only your objections as Markdown. Each objection names the draft it targets, what is wrong, and what to do instead. If a draft is sound, say so explicitly instead of inventing an objection.",
  ].join("\n");
}

function legacyIntegratorInstructions(): string {
  return [
    "You are the integrator for this round. Merge the drafts into one plan the user can act on, keeping what is right and rejecting what the objections prove wrong.",
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

function integratorInstructions(): string {
  return [
    "You are the integrator for this round. Merge the drafts into one plan the user can act on, keeping what is right and rejecting what the objections prove wrong. Preserve the evidence and the conflicts; do not smooth over real disagreement.",
    "Return exactly this shape, so the panel can read your verdicts and a future judge can audit the conflicts:",
    "RULINGS",
    "- <conflict> | <your ruling> | <evidence that supports the ruling>",
    "UNRESOLVED_CONFLICTS",
    "- <conflict> | <why it remains unresolved>",
    "EVIDENCE",
    "- <source> | <what it proves>",
    "CONFIDENCE",
    "- <item> | <high/medium/low> | <reason>",
    "VERDICTS",
    "- adopted | <the item> | <the role it came from>",
    "- rejected | <the item or the objection> | <the role it came from>",
    "PLAN",
    "<the merged plan as Markdown>",
  ].join("\n");
}
/**
 * seats of one specialty get their own brief, which is what makes them peers
 * rather than the same argument twice.
 *
 * A v2 structured brief is rendered as explicit sections and evidence domains,
 * so seats cannot silently collapse into the same skeleton with different names.
 */
export function planDebateBrief(run: PlanDebateRun, start: PlanDebateStart): string {
  const seatNumber = start.seat ?? 1;
  const seat = run.roles.find((role) => role.name === start.role && role.seat === seatNumber);
  const handle = debateSeatHandle(start.role, seatNumber);
  const roleSeat: RoleSeat = { role: start.role, seat: seatNumber };
  const mission = seat ? planDebateRoleMission(seat) : "Draft and object from your own specialty.";
  const structured = seat ? structuredBriefBlock(seat) : "";
  const legacyBrief = seat && !planDebateRoleHasStructuredBrief(seat) ? `Your brief for this debate: ${seat.brief.trim()}` : "";
  const header = [
    `You are ${handle}, one voice in a plan debate (round ${run.round}).`,
    requirementBlock(run),
  ];
  if (structured) {
    header.push(structured);
  } else if (legacyBrief) {
    header.push(legacyBrief);
  } else {
    header.push(`Your mission: ${mission}`);
  }
  if (start.phase === "draft") {
    const parts = [...header, draftInstructions()];
    if (seat && planDebateRoleHasStructuredBrief(seat)) {
      parts.splice(parts.length - 1, 0, evidenceDomainsBlock(run, roleSeat));
    }
    return parts.join("\n\n");
  }
  if (start.phase === "critique") {
    const useStructuredCritique = seat !== undefined && planDebateRoleHasStructuredBrief(seat);
    return [
      ...header,
      "Every role has drafted.",
      `## Drafts\n\n${draftsBlock(run)}`,
      useStructuredCritique ? critiqueInstructions() : legacyCritiqueInstructions(),
    ].join("\n\n");
  }
  const integratorRole = run.roles.find(
    (r) => r.name === run.integratorRole && r.seat === run.integratorSeat,
  );
  const useStructuredIntegrator =
    integratorRole !== undefined && planDebateRoleHasStructuredBrief(integratorRole);
  return [
    ...header,
    `You are the integrator for this round (${handle}).`,
    `## Drafts\n\n${draftsBlock(run)}`,
    `## Objections\n\n${objectionsBlock(run)}`,
    useStructuredIntegrator ? integratorInstructions() : legacyIntegratorInstructions(),
  ].join("\n\n");
}

const ADOPTED_TOKENS = new Set(["adopted", "采纳"]);
const REJECTED_TOKENS = new Set(["rejected", "驳回"]);
const LIST_MARKER = /^\s*(?:[-*+•]|\d+[.)])\s*/;

function verdictOf(raw: string): "adopted" | "rejected" | null {
  const token = raw.replace(/[*_`]/g, "").replace(/[：:]+$/, "").trim().toLowerCase();
  if (ADOPTED_TOKENS.has(token)) return "adopted";
  if (REJECTED_TOKENS.has(token)) return "rejected";
  return null;
}

const HEADING_RULINGS = /^(?:#{1,6}\s+)?RULINGS\s*$/i;
const HEADING_UNRESOLVED = /^(?:#{1,6}\s+)?UNRESOLVED_CONFLICTS\s*$/i;
const HEADING_EVIDENCE = /^(?:#{1,6}\s+)?EVIDENCE\s*$/i;
const HEADING_CONFIDENCE = /^(?:#{1,6}\s+)?CONFIDENCE\s*$/i;
const HEADING_VERDICTS = /^(?:#{1,6}\s+)?VERDICTS\s*$/i;
const HEADING_PLAN = /^(?:#{1,6}\s+)?PLAN\s*$/i;

/**
 * Extract the body of one section from a report. Headings inside fenced code
 * blocks are ignored, and a section heading must be a line that contains only
 * the heading (optionally preceded by Markdown heading markers) so body text
 * like "The PLAN is..." is not mistaken for the PLAN section.
 */
function parseSection(report: string, heading: RegExp, stopHeadings: RegExp[]): string {
  const lines = report.split(/\r?\n/);
  let inFence = false;
  let fenceMarker = "";
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (inFence) {
      if (trimmed.startsWith(fenceMarker)) inFence = false;
      continue;
    }
    const fenceMatch = trimmed.match(/^(\`{3,}|~{3,})/);
    if (fenceMatch) {
      inFence = true;
      fenceMarker = fenceMatch[1];
      continue;
    }
    if (start < 0) {
      if (heading.test(trimmed)) start = i;
      continue;
    }
    if (stopHeadings.some((h) => h.test(trimmed))) {
      return lines.slice(start + 1, i).join("\n").trim();
    }
  }
  return start < 0 ? "" : lines.slice(start + 1).join("\n").trim();
}

function parseListSection(report: string, heading: RegExp, stopHeadings: RegExp[]): string[] {
  const body = parseSection(report, heading, stopHeadings);
  return body
    .split("\n")
    .map((line) => line.replace(LIST_MARKER, "").trim())
    .filter((line) => line !== "");
}

export type PlanDebateParsedSynthesis = {
  rulings: string[];
  unresolved: string[];
  evidence: string[];
  confidence: string[];
  verdicts: { verdict: "adopted" | "rejected"; item: string; source: string }[];
  plan: string;
};

/**
 * Parse a structured integrator report into its sections. Unknown / missing
 * sections return empty arrays; the plan is everything after the PLAN heading.
 */
export function parsePlanDebateSynthesis(report: string): PlanDebateParsedSynthesis {
  const lines = report.split(/\r?\n/);

  // Verdicts are between VERDICTS and PLAN, ignoring code fences.
  let inFence = false;
  let fenceMarker = "";
  let verdictsStart = -1;
  let planStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (inFence) {
      if (trimmed.startsWith(fenceMarker)) inFence = false;
      continue;
    }
    const fenceMatch = trimmed.match(/^(\`{3,}|~{3,})/);
    if (fenceMatch) {
      inFence = true;
      fenceMarker = fenceMatch[1];
      continue;
    }
    if (verdictsStart < 0 && HEADING_VERDICTS.test(trimmed)) {
      verdictsStart = i;
      continue;
    }
    if (verdictsStart >= 0 && planStart < 0 && HEADING_PLAN.test(trimmed)) {
      planStart = i;
      break;
    }
  }

  const verdicts: PlanDebateParsedSynthesis["verdicts"] = [];
  if (verdictsStart >= 0) {
    const end = planStart < 0 ? lines.length : planStart;
    for (const line of lines.slice(verdictsStart + 1, end)) {
      const body = line.replace(LIST_MARKER, "").trim();
      if (body === "") continue;
      const separator = body.includes("|") ? "|" : body.includes("：") ? "：" : body.includes(":") ? ":" : null;
      if (separator === null) continue;
      const parts = body.split(separator).map((part) => part.trim());
      const verdict = verdictOf(parts[0] ?? "");
      const item = parts[1] ?? "";
      if (verdict === null || item === "") continue;
      const source = parts.slice(2).join(separator === "|" ? " | " : separator).trim();
      verdicts.push({ verdict, item, source });
    }
  }

  const plan =
    planStart < 0
      ? report.trim()
      : lines.slice(planStart + 1).join("\n").trim();

  return {
    rulings: parseListSection(report, HEADING_RULINGS, [HEADING_UNRESOLVED, HEADING_EVIDENCE, HEADING_CONFIDENCE, HEADING_VERDICTS]),
    unresolved: parseListSection(report, HEADING_UNRESOLVED, [HEADING_EVIDENCE, HEADING_CONFIDENCE, HEADING_VERDICTS]),
    evidence: parseListSection(report, HEADING_EVIDENCE, [HEADING_CONFIDENCE, HEADING_VERDICTS]),
    confidence: parseListSection(report, HEADING_CONFIDENCE, [HEADING_VERDICTS]),
    verdicts,
    plan,
  };
}

/** Short label the topology row of one debate delegate shows. */
export function planDebateLabel(start: PlanDebateStart): string {
  const prefix =
    start.phase === "draft" ? "Draft" : start.phase === "critique" ? "Critique" : "Merge";
  return `${prefix} · ${debateSeatHandle(start.role, start.seat ?? 1)}`;
}
export type { PlanDebateRoleProposal } from "./plan-debate.js";
