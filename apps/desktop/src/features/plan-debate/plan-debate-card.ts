/**
 * The debate as one compact card in the conversation.
 *
 * The work-panel tab draws the whole round; this card draws the one line a
 * reader needs beside the transcript: which round exists, what it is doing now,
 * how far that phase has got, and the plan on offer. Everything is derived from
 * the same round view the panel reads — phase rows come from
 * `planDebatePhaseStatuses` and the choosable plans from `planDebateChoices` —
 * so the card and the tab cannot disagree about a round.
 *
 * Pure: no React, no storage, no clock. A null round is no card at all, which
 * is why the caller can render it unconditionally in plan mode.
 */
import {
  planDebateChoices,
  type PlanDebatePhase,
  type PlanDebatePhaseName,
  type PlanDebatePhaseStatus,
  type PlanDebateSelection,
} from "./plan-debate-machine";
import {
  planDebatePhaseStatuses,
  type PlanDebateRoundView,
} from "./plan-debate-view";

/** The phase the card names, as its own small record. */
export type PlanDebateCardPhase = {
  name: PlanDebatePhaseName;
  status: PlanDebatePhaseStatus;
};

/** A phase that has delegates: how many of them have settled, out of how many. */
export type PlanDebateCardProgress = {
  phase: "drafting" | "critiquing";
  done: number;
  total: number;
};

/** The plan the card shows: the user's choice, or what the round offers. */
export type PlanDebateCardPlan = {
  source: "merged" | "draft" | "suggestion";
  /** The drafting role, when the plan is a draft rather than the merge. */
  role: string | null;
  /** The plan's first readable line, decoration stripped. */
  title: string;
};

export type PlanDebateCardView = {
  round: number;
  phase: PlanDebateCardPhase;
  progress: PlanDebateCardProgress | null;
  plan: PlanDebateCardPlan | null;
};

/** Markdown decoration a plan's first line may open with. */
const LEADING_DECORATION = /^[\s#>*_`~-]+/;
/** A card is one line; a heading longer than this is clipped, not wrapped. */
const MAX_TITLE_LENGTH = 120;

/**
 * The plan's first line, without the heading or list marker in front of it.
 * A document whose lines are all decoration contributes no title.
 */
export function planTitleLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(LEADING_DECORATION, "").trim();
    if (cleaned === "") continue;
    return cleaned.length > MAX_TITLE_LENGTH
      ? `${cleaned.slice(0, MAX_TITLE_LENGTH - 1)}…`
      : cleaned;
  }
  return "";
}

/**
 * The phase the round has reached: the first one that has not completed, in
 * timeline order. A round in review stays on `reviewing` because choosing is
 * what completes it, and a round whose drafting failed stays on `drafting` —
 * the card reports the round's frontier rather than guessing at progress.
 */
function frontierPhase(round: PlanDebateRoundView): PlanDebatePhase {
  const phases = planDebatePhaseStatuses(round);
  const reached = phases.find((phase) => phase.status !== "complete");
  return reached ?? phases[phases.length - 1] ?? { name: "proposing", status: "pending" };
}

/** How far the phase's own delegates have got. Other phases have no count. */
function progressOf(
  round: PlanDebateRoundView,
  name: PlanDebatePhaseName,
): PlanDebateCardProgress | null {
  if (name !== "drafting" && name !== "critiquing") return null;
  const nodes = name === "drafting" ? round.drafts : round.critiques;
  // The roster is how many delegates the round promised; a row that arrived
  // before the proposal row still counts as one, so the total never undershoots
  // the rows already drawn.
  const total = Math.max(round.roles.length, nodes.length);
  if (total === 0) return null;
  const done = nodes.filter((node) => node.status !== "running").length;
  return { phase: name, done, total };
}

/** The plan the card names: the user's choice first, then what is on offer. */
function planOf(
  round: PlanDebateRoundView,
  selection: PlanDebateSelection | null,
): PlanDebateCardPlan | null {
  const choices = planDebateChoices(round.state);
  const mergedText = choices.merged && round.merged !== null ? round.merged.text : "";
  const chosen = selection !== null && selection.round === round.round ? selection : null;

  if (chosen !== null && chosen.kind === "merged") {
    const title = planTitleLine(mergedText);
    if (title !== "") return { source: "merged", role: null, title };
  }
  if (chosen !== null && chosen.kind === "draft") {
    const draft = choices.drafts.find((item) => item.role === chosen.role);
    const title = draft ? planTitleLine(draft.text) : "";
    if (draft && title !== "") return { source: "draft", role: draft.role, title };
  }
  if (chosen !== null && chosen.kind === "suggestion") {
    const title = planTitleLine(chosen.text);
    if (title !== "") return { source: "suggestion", role: null, title };
  }
  // Nothing chosen yet: the merged plan is the round's answer, a draft the
  // stopgap it grew from. Both are still the plan a reader can open today.
  const mergedTitle = planTitleLine(mergedText);
  if (mergedTitle !== "") return { source: "merged", role: null, title: mergedTitle };
  const first = choices.drafts[0];
  const firstTitle = first ? planTitleLine(first.text) : "";
  if (first && firstTitle !== "") return { source: "draft", role: first.role, title: firstTitle };
  return null;
}

/**
 * The card for the round on screen, or null when the session has no round.
 * The caller decides where the card goes; this decides whether it exists.
 */
export function planDebateCard(
  round: PlanDebateRoundView | null,
  selection: PlanDebateSelection | null = null,
): PlanDebateCardView | null {
  if (round === null) return null;
  const phase = frontierPhase(round);
  return {
    round: round.round,
    phase: { name: phase.name, status: phase.status },
    progress: progressOf(round, phase.name),
    plan: planOf(round, selection),
  };
}
