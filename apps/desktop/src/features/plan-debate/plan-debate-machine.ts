/**
 * The debate a plan is drafted through, as data.
 *
 * One round is: every role drafts, every role reads the other drafts and
 * objects, one integrator merges drafts and objections into a single plan, the
 * user chooses, and the chosen plan becomes the team's first task. A re-debate
 * starts a new round from the user's objection about the result; the previous
 * round is kept exactly as it finished, because the timeline is evidence and
 * evidence that can change is not evidence.
 *
 * This module is pure: no timers, no storage, no React. Callers pass `now`, so
 * a phase's elapsed time is a function of two numbers and a reload repaints the
 * same timeline.
 */

/** Phases in the order a round runs them. */
export const PLAN_DEBATE_PHASES = [
  "proposing",
  "drafting",
  "critiquing",
  "integrating",
  "reviewing",
  "handingoff",
] as const;

export type PlanDebatePhaseName = (typeof PLAN_DEBATE_PHASES)[number];

export type PlanDebatePhaseStatus =
  | "pending"
  | "running"
  | "complete"
  | "failed"
  | "stopped";

/** A role the planner proposed: a real catalog handle and why it is in. */
export type PlanDebateRole = {
  name: string;
  brief: string;
  /** Which occurrence of `name` this seat is: peers of one specialty share it. */
  seat: number;
};

/**
 * A seat's display handle: the plain catalog name for the first seat, and
 * `name #2` for the peers that debate beside it.
 *
 * The runtime writes the same text into the transcript (`debateRole` holds the
 * handle and `debateSeat` the number); keep the shape in step with
 * `debateSeatHandle` in the agent runtime's `plan-debate`.
 */
export function debateSeatHandle(name: string, seat: number): string {
  return seat > 1 ? `${name} #${seat}` : name;
}

/** How many roles a debate may run — the planner proposes inside this window. */
export const PLAN_DEBATE_MIN_ROLES = 3;
export const PLAN_DEBATE_MAX_ROLES = 5;

export type PlanDebatePhase = {
  name: PlanDebatePhaseName;
  status: PlanDebatePhaseStatus;
  /** Milliseconds since the epoch; absent until the phase has run. */
  startedAt?: number;
  completedAt?: number;
  /** Why the phase failed or was stopped, when it did. */
  error?: string;
};

/** One role's contribution to a round: its draft, or its objections. */
export type PlanDebateContribution = {
  role: string;
  status: Exclude<PlanDebatePhaseStatus, "pending">;
  /** The document the delegate produced, once it has one. */
  text: string;
  startedAt?: number;
  completedAt?: number;
  error?: string;
};

/** One line of the merged plan: what happened to a draft or objection. */
export type PlanDebateVerdict = {
  /** The draft or objection being judged. */
  item: string;
  verdict: "adopted" | "rejected";
  /** Which role or draft the item came from. */
  source: string;
};

/**
 * How the round's plan was produced. A round that failed before integrating
 * can still be judged on drafts alone, so this records which artifact the
 * selection points at rather than assuming the merged plan exists.
 */
export type PlanDebateMergedPlan = {
  text: string;
  verdicts: PlanDebateVerdict[];
};

/** What the user chose to carry forward. */
export type PlanDebateSelection =
  | { kind: "draft"; round: number; role: string }
  | { kind: "merged"; round: number }
  // The user's own words, written in the panel instead of a generated plan:
  // only the user ever chooses, never the model.
  | { kind: "suggestion"; round: number; text: string };

export type PlanDebateRound = {
  round: number;
  /** The user's requirement for this round; on a re-debate, their objection. */
  constraint: string;
  /** True when this round was started by a re-debate. */
  redebate: boolean;
  roles: PlanDebateRole[];
  phases: PlanDebatePhase[];
  drafts: PlanDebateContribution[];
  objections: PlanDebateContribution[];
  merged: PlanDebateMergedPlan | null;
  createdAt: number;
};

export type PlanDebateState = {
  /** Finished rounds, oldest first; the last one is the round on screen. */
  rounds: PlanDebateRound[];
  /** The plan the user picked, if any. Cleared when a new round starts. */
  selection: PlanDebateSelection | null;
  /**
   * The round whose plan was carried into team mode, and when.
   *
   * Handing a plan over is the one step a reload could repeat, so the record
   * lives beside the selection instead of in a component: the panel's button
   * reads it, and one round is handed off once.
   */
  handoff: PlanDebateHandoff | null;
};

/** A handoff that already happened: the round, and when it was sent. */
export type PlanDebateHandoff = {
  round: number;
  at: number;
};

export function idlePlanDebateState(): PlanDebateState {
  return { rounds: [], selection: null, handoff: null };
}

function freshPhases(): PlanDebatePhase[] {
  return PLAN_DEBATE_PHASES.map((name) => ({ name, status: "pending" as const }));
}

export function currentPlanDebateRound(state: PlanDebateState): PlanDebateRound | null {
  return state.rounds.length > 0 ? state.rounds[state.rounds.length - 1] : null;
}

export function planDebatePhase(
  round: PlanDebateRound,
  name: PlanDebatePhaseName,
): PlanDebatePhase {
  return round.phases.find((phase) => phase.name === name) ?? { name, status: "pending" };
}

/** Milliseconds a phase has taken: still running counts against `now`. */
export function planDebateElapsed(phase: PlanDebatePhase, now: number): number {
  if (phase.startedAt === undefined) return 0;
  return Math.max(0, (phase.completedAt ?? now) - phase.startedAt);
}

/**
 * Copy the newest round through `change`, then the state. Rounds are replaced,
 * never mutated, so a finished round can be held by reference as history.
 */
function withCurrentRound(
  state: PlanDebateState,
  change: (round: PlanDebateRound) => PlanDebateRound,
): PlanDebateState {
  const current = currentPlanDebateRound(state);
  if (!current) return state;
  return {
    ...state,
    rounds: [...state.rounds.slice(0, -1), change(current)],
  };
}

/** Move one phase to `status`, stamping the matching timestamps. */
function setPhase(
  round: PlanDebateRound,
  name: PlanDebatePhaseName,
  status: PlanDebatePhaseStatus,
  at: number,
  error?: string,
): PlanDebateRound {
  return {
    ...round,
    phases: round.phases.map((phase) => {
      if (phase.name !== name) return phase;
      if (status === "running") {
        return { name, status, startedAt: at, ...(error ? { error } : {}) };
      }
      return {
        ...phase,
        status,
        completedAt: at,
        ...(error ? { error } : {}),
      };
    }),
  };
}

/**
 * Start a round with the roles the planner proposed. A round after the first
 * carries the user's objection as its constraint, which is why the caller says
 * `redebate` rather than the machine guessing from the round number.
 */
export function startPlanDebateRound(
  state: PlanDebateState,
  input: { roles: readonly PlanDebateRole[]; constraint: string; redebate?: boolean; now: number },
): PlanDebateState {
  const round: PlanDebateRound = {
    round: (currentPlanDebateRound(state)?.round ?? 0) + 1,
    constraint: input.constraint,
    redebate: input.redebate === true,
    roles: input.roles.map((role) => ({
      name: role.name,
      brief: role.brief,
      seat: role.seat,
    })),
    phases: freshPhases(),
    drafts: [],
    objections: [],
    merged: null,
    createdAt: input.now,
  };
  return {
    // Going forward drops a choice made in the previous round: keeping it would
    // let a stale plan be handed off while a new round is still running.
    selection: null,
    // A handoff already made stays on the record: the new round's plan has not
    // been handed over, and the old one did happen.
    handoff: state.handoff,
    rounds: [...state.rounds, round],
  };
}

/** The proposal phase is the only one that can move the roster. */
export function beginPhase(
  state: PlanDebateState,
  name: PlanDebatePhaseName,
  now: number,
): PlanDebateState {
  return withCurrentRound(state, (round) => setPhase(round, name, "running", now));
}

export function completePhase(
  state: PlanDebateState,
  name: PlanDebatePhaseName,
  now: number,
): PlanDebateState {
  return withCurrentRound(state, (round) => setPhase(round, name, "complete", now));
}

export function failPhase(
  state: PlanDebateState,
  name: PlanDebatePhaseName,
  error: string,
  now: number,
): PlanDebateState {
  return withCurrentRound(state, (round) => setPhase(round, name, "failed", now, error));
}

export function stopPhase(
  state: PlanDebateState,
  name: PlanDebatePhaseName,
  now: number,
): PlanDebateState {
  return withCurrentRound(state, (round) => setPhase(round, name, "stopped", now));
}

/** Replace one role's contribution, keeping the round's order stable. */
function upsertContribution(
  list: readonly PlanDebateContribution[],
  next: PlanDebateContribution,
): PlanDebateContribution[] {
  const index = list.findIndex((item) => item.role === next.role);
  if (index < 0) return [...list, next];
  return list.map((item, position) => (position === index ? next : item));
}

/**
 * Record one role's finished draft. A delegate that failed is recorded as
 * failed and the round carries on: a debate with three of four drafts is still
 * a debate, while aborting would lose the work that did come back.
 */
export function recordDraft(
  state: PlanDebateState,
  draft: PlanDebateContribution,
): PlanDebateState {
  return withCurrentRound(state, (round) => ({
    ...round,
    drafts: upsertContribution(round.drafts, draft),
  }));
}

export function recordObjection(
  state: PlanDebateState,
  objection: PlanDebateContribution,
): PlanDebateState {
  return withCurrentRound(state, (round) => ({
    ...round,
    objections: upsertContribution(round.objections, objection),
  }));
}

export function setMergedPlan(
  state: PlanDebateState,
  merged: PlanDebateMergedPlan | null,
): PlanDebateState {
  return withCurrentRound(state, (round) => ({ ...round, merged }));
}

/** Drafts a reader can actually open: a failed role contributes nothing. */
export function readableDrafts(round: PlanDebateRound): PlanDebateContribution[] {
  return round.drafts.filter((draft) => draft.status === "complete" && draft.text.trim() !== "");
}

/**
 * Whether drafting may close. A round whose every draft failed has nothing to
 * critique, so it is a failed round, not a finished one.
 */
export function draftingSettled(round: PlanDebateRound): "complete" | "failed" | "running" {
  const running = round.drafts.some((draft) => draft.status === "running");
  if (running) return "running";
  return readableDrafts(round).length > 0 ? "complete" : "failed";
}

/** The artifacts a round's timeline can link to, in phase order. */
export function planDebateArtifacts(round: PlanDebateRound): {
  drafts: PlanDebateContribution[];
  objections: PlanDebateContribution[];
  merged: PlanDebateMergedPlan | null;
} {
  return { drafts: round.drafts, objections: round.objections, merged: round.merged };
}

/** The choice is only available once the round has something to choose from. */
export function planDebateChoices(round: PlanDebateRound): {
  drafts: PlanDebateContribution[];
  merged: boolean;
} {
  return {
    drafts: readableDrafts(round),
    merged: Boolean(round.merged && round.merged.text.trim() !== ""),
  };
}

export function choosePlan(
  state: PlanDebateState,
  selection: PlanDebateSelection | null,
): PlanDebateState {
  if (!selection) return { ...state, selection: null };
  const round = state.rounds.find((item) => item.round === selection.round);
  if (!round) return state;
  if (selection.kind === "merged") {
    if (!planDebateChoices(round).merged) return state;
  } else if (selection.kind === "suggestion") {
    if (selection.text.trim() === "") return state;
  } else if (!readableDrafts(round).some((draft) => draft.role === selection.role)) {
    return state;
  }
  return { ...state, selection };
}

/**
 * Handing a plan to team mode is the one irreversible step, so it needs a plan
 * the user actually chose in a round that reached review, and a round that has
 * not already been handed over.
 */
export function canHandoff(state: PlanDebateState): boolean {
  if (!state.selection) return false;
  const round = state.rounds.find((item) => item.round === state.selection?.round);
  if (!round) return false;
  // One handoff per round: the button is idempotent because this record is the
  // gate, not because the click handler remembers.
  if (state.handoff?.round === state.selection.round) return false;
  const reviewing = planDebatePhase(round, "reviewing").status;
  return reviewing === "running" || reviewing === "complete";
}

/** The round already carried into team mode, when there is one. */
export function planDebateHandoffRound(state: PlanDebateState): number | null {
  return state.handoff?.round ?? null;
}

/**
 * Record that the chosen plan was handed to team mode. A state that cannot be
 * handed off is returned unchanged, so a raced double click writes once.
 */
export function markPlanDebateHandoff(state: PlanDebateState, at: number): PlanDebateState {
  if (!canHandoff(state) || !state.selection) return state;
  return { ...state, handoff: { round: state.selection.round, at } };
}

/**
 * Restart the whole debate from the user's objection about the last result.
 *
 * It is a new round rather than an edit: the previous round keeps its phases,
 * drafts and verdicts untouched, and the objection becomes the new round's
 * constraint so every role drafts against it.
 */
export function redebatePlan(
  state: PlanDebateState,
  input: { objection: string; now: number },
): PlanDebateState {
  const previous = currentPlanDebateRound(state);
  if (!previous) return state;
  return startPlanDebateRound(state, {
    // The roster is the planner's proposal, so a re-debate reuses it rather
    // than inventing roles; the panel can still swap them before starting.
    roles: previous.roles,
    constraint: input.objection,
    redebate: true,
    now: input.now,
  });
}

/* -------------------------------------------------------------------------- */
/* Snapshot                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What the renderer keeps per session so a reload repaints the timeline. It is
 * a bounded snapshot, not the transcript: the documents live in the plan
 * artifact and the delegate transcripts, and this is what points at them.
 */
export const PLAN_DEBATE_SNAPSHOT_VERSION = 1;

export type PlanDebateSnapshot = {
  version: typeof PLAN_DEBATE_SNAPSHOT_VERSION;
  state: PlanDebateState;
};

export function toPlanDebateSnapshot(state: PlanDebateState): PlanDebateSnapshot {
  // A copy, because the snapshot outlives this call: a caller that stores it
  // and a caller still drawing the live state must not share arrays.
  return { version: PLAN_DEBATE_SNAPSHOT_VERSION, state: structuredClone(state) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored snapshot is untrusted: every field is checked before it is drawn. */
export function fromPlanDebateSnapshot(value: unknown): PlanDebateState | null {
  if (!isRecord(value)) return null;
  if (value.version !== PLAN_DEBATE_SNAPSHOT_VERSION) return null;
  const state = value.state;
  if (!isRecord(state) || !Array.isArray(state.rounds)) return null;
  const rounds = state.rounds.filter(isRecord).map(restoreRound);
  if (rounds.some((round) => round === null)) return null;
  return {
    rounds: rounds as PlanDebateRound[],
    selection: restoreSelection(state.selection),
    handoff: restoreHandoff(state.handoff),
  };
}

/** A handoff record is restored only when both numbers are real. */
function restoreHandoff(value: unknown): PlanDebateHandoff | null {
  if (!isRecord(value)) return null;
  if (typeof value.round !== "number" || typeof value.at !== "number") return null;
  return { round: value.round, at: value.at };
}

function restoreSelection(value: unknown): PlanDebateSelection | null {
  if (!isRecord(value)) return null;
  const round = typeof value.round === "number" ? value.round : null;
  if (round === null) return null;
  if (value.kind === "merged") return { kind: "merged", round };
  if (value.kind === "suggestion" && typeof value.text === "string" && value.text.trim() !== "") {
    return { kind: "suggestion", round, text: value.text };
  }
  if (value.kind === "draft" && typeof value.role === "string") {
    return { kind: "draft", round, role: value.role };
  }
  return null;
}

function restoreContribution(value: unknown): PlanDebateContribution | null {
  if (!isRecord(value) || typeof value.role !== "string") return null;
  const status = value.status;
  if (
    status !== "running" &&
    status !== "complete" &&
    status !== "failed" &&
    status !== "stopped"
  ) {
    return null;
  }
  return {
    role: value.role,
    status,
    text: typeof value.text === "string" ? value.text : "",
    ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.completedAt === "number" ? { completedAt: value.completedAt } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

function restoreRound(value: unknown): PlanDebateRound | null {
  if (!isRecord(value)) return null;
  if (typeof value.round !== "number") return null;
  const roles: PlanDebateRole[] = Array.isArray(value.roles)
    ? value.roles.flatMap((role) => {
        if (!isRecord(role)) return [];
        if (typeof role.name !== "string" || typeof role.brief !== "string") return [];
        // A snapshot written before seats existed is one seat of each role.
        return [
          {
            name: role.name,
            brief: role.brief,
            seat: typeof role.seat === "number" && role.seat >= 1 ? role.seat : 1,
          },
        ];
      })
    : [];
  if (roles.length !== (Array.isArray(value.roles) ? value.roles.length : 0)) return null;
  const phases: PlanDebatePhase[] = [];
  for (const name of PLAN_DEBATE_PHASES) {
    const stored = Array.isArray(value.phases)
      ? value.phases.find((phase) => isRecord(phase) && phase.name === name)
      : undefined;
    const status = isRecord(stored) ? stored.status : "pending";
    if (
      status !== "pending" &&
      status !== "running" &&
      status !== "complete" &&
      status !== "failed" &&
      status !== "stopped"
    ) {
      return null;
    }
    phases.push({
      name,
      status,
      ...(isRecord(stored) && typeof stored.startedAt === "number"
        ? { startedAt: stored.startedAt }
        : {}),
      ...(isRecord(stored) && typeof stored.completedAt === "number"
        ? { completedAt: stored.completedAt }
        : {}),
      ...(isRecord(stored) && typeof stored.error === "string" ? { error: stored.error } : {}),
    });
  }
  const contributions = (list: unknown): PlanDebateContribution[] => {
    if (!Array.isArray(list)) return [];
    const restored = list.map(restoreContribution);
    return restored.every((item): item is PlanDebateContribution => item !== null)
      ? restored
      : [];
  };
  const merged = isRecord(value.merged) && typeof value.merged.text === "string"
    ? {
        text: value.merged.text,
        verdicts: Array.isArray(value.merged.verdicts)
          ? value.merged.verdicts.filter(
              (item): item is PlanDebateVerdict =>
                isRecord(item) &&
                typeof item.item === "string" &&
                typeof item.source === "string" &&
                (item.verdict === "adopted" || item.verdict === "rejected"),
            )
          : [],
      }
    : null;
  return {
    round: value.round,
    constraint: typeof value.constraint === "string" ? value.constraint : "",
    redebate: value.redebate === true,
    roles,
    phases,
    drafts: contributions(value.drafts),
    objections: contributions(value.objections),
    merged,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
  };
}
