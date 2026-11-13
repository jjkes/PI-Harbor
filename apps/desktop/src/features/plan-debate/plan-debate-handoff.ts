/**
 * Carrying a chosen plan into team mode, as data.
 *
 * The panel used to ask the machine's `canHandoff` — a gate that also required
 * the round's `reviewing` phase to have started. That phase is derived from the
 * same artifact set the choice comes from, so the two could only disagree when
 * the transcript rows arrived in a different order than the pipeline writes
 * them (a delegate row landing before its proposal row, a settled row replacing
 * its own snapshot): a merged plan was on screen, choosable, and the handoff
 * button stayed greyed with nothing to explain it.
 *
 * The rule that actually matters is the one the user sees: a plan the user
 * chose, in a round that produced it, handed over at most once. That is what
 * this module decides, and it is the only gate the panel uses. `canHandoff`
 * stays in the machine for the state-level tests, but the panel no longer
 * derives its button from a second, stricter reading of the same facts.
 */
import type { PlanDebateHandoff, PlanDebateSelection } from "./plan-debate-machine";
import { planDebateNodeLabel, type PlanDebateRoundView, type PlanDebateView } from "./plan-debate-view";

/** Why the handoff is not available, as the button's own reason. */
export type PlanDebateHandoffBlocked =
  | "no-selection"
  | "no-round"
  | "no-plan"
  | "already-handed-off";

/** The plan text carried into team mode, when it can be carried. */
export type PlanDebateHandoffPlan =
  | { ok: true; round: number; selection: PlanDebateSelection; text: string }
  | { ok: false; reason: PlanDebateHandoffBlocked };

/**
 * The plan text handed to team mode: what was chosen, with file references
 * so the team can read the debate artifacts directly and start working.
 *
 * The coordinator instruction is the point of the handoff: the main agent must
 * delegate the implementation to the team's subagents, not do it itself.
 */
const COORDINATOR_INSTRUCTION = [
  "You are the coordinator, not the implementer. Break this plan into bounded tasks and delegate each one to a team subagent with the Task tool — the team members do the actual work (reading files, editing code, running checks). You only split the work, delegate, track progress, and integrate and verify the results. Do NOT implement the plan yourself.",
].join(" ");

export function planDebateHandoffText(
  round: PlanDebateRoundView,
  choice: PlanDebateSelection,
): string | null {
  const head = `## Plan handed to team mode (round ${round.round})\n\nRequirement: ${round.requirement}\n\n${COORDINATOR_INSTRUCTION}`;
  const artifactDir = `.pi-harbor/debate/round-${round.round}`;
  if (choice.kind === "suggestion") {
    if (choice.text.trim() === "") return null;
    return `${head}\n\nThe user wrote this suggestion in the debate panel:\n\n${choice.text}`;
  }
  if (choice.kind === "merged") {
    if (round.merged === null || round.merged.text.trim() === "") return null;
    const verdicts = round.merged.verdicts.map(
      (verdict) => `- ${verdict.verdict} ${verdict.item} (source: ${verdict.source})`,
    );
    const verdictBlock = verdicts.length > 0 ? `\n\n### Verdicts\n${verdicts.join("\n")}` : "";
    return `${head}\n\n**Primary plan file:** \`${artifactDir}/merged.md\`\n\nRead the plan from the file above and delegate its implementation to the team. The file contains the full merged plan and verdicts from the debate.${verdictBlock}\n\n### Plan content\n\n${round.merged.text}`;
  }
  // Draft: reference the seat's artifact area and include text.
  const draft = round.drafts.find(
    (node) =>
      planDebateNodeLabel(node) === choice.role &&
      node.status === "complete" &&
      node.text.trim() !== "",
  );
  if (!draft) return null;
  return `${head}\n\n**Selected draft:** ${choice.role}\n**Debate artifacts:** \`${artifactDir}/\`\n\nRead the debate artifacts in the directory above for full context, then delegate the implementation to the team based on this draft:\n\n${draft.text}`;
}

/**
 * Whether the chosen plan can be handed over right now, and what would be sent.
 *
 * `handoff` is the round already carried into team mode, as the panel read it
 * from storage: one round is handed over once, which is what makes a second
 * click — or a reload that repaints the button — a disabled control instead of
 * a second task.
 */
export function planDebateHandoffPlan(
  view: PlanDebateView,
  selection: PlanDebateSelection | null,
  handoff: PlanDebateHandoff | null,
): PlanDebateHandoffPlan {
  if (selection === null) return { ok: false, reason: "no-selection" };
  const round = view.rounds.find((item) => item.round === selection.round);
  if (!round) return { ok: false, reason: "no-round" };
  if (handoff !== null && handoff.round === round.round) {
    return { ok: false, reason: "already-handed-off" };
  }
  const text = planDebateHandoffText(round, selection);
  if (text === null) return { ok: false, reason: "no-plan" };
  return { ok: true, round: round.round, selection, text };
}
