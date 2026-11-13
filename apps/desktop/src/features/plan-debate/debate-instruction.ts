/**
 * The folded instruction a plan-debate launch appends to the user's requirement.
 *
 * The launch is one message: the user's words plus the framing that names the
 * `PlanDebate` tool. The transcript must not show that framing as raw markup in
 * the bubble, so the same module owns both halves — the block the prompt writes
 * and the split the transcript row reads — and the two cannot drift apart.
 *
 * Pure and model-free: the same text always splits the same way.
 */

/** Summary line the launch prompt writes; the reader keys on this wording. */
export const DEBATE_INSTRUCTION_SUMMARY = "辩论指示 / Debate instruction";

/**
 * What the launch prompt asks the model to do, under that summary.
 *
 * The `intent: "start"` discriminator is the whole point of this being the
 * renderer's own text: the tool opens a round only when the user's gesture
 * carries it, so the button's framing is what makes the round a user action.
 */
export const DEBATE_INSTRUCTION_BODY = [
  "Run a plan debate for this requirement before any implementation.",
  'Call the PlanDebate tool now with `intent: "start"` and this requirement so the roster is proposed to the user. The user asked for this round by pressing the debate button, which is what that intent means. Nothing drafts until the user confirms the roster in the debate panel — tell the user the roster is ready for their start, and when it has run, report the chosen plan.',
].join("\n");

const SUMMARY_MATCH = /辩论|debate\s+instruction/i;
const DETAILS_BLOCK = /<details\b[^>]*>([\s\S]*?)<\/details\s*>/gi;
const SUMMARY_TAG = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i;

export type DebateInstructionSplit = {
  /** What the user typed — the bubble text. */
  body: string;
  /** The folded framing, when this message carried one. */
  instruction?: string;
};

/** The `<details>` block for one instruction, in the prompt's exact shape. */
export function debateInstructionBlock(instruction: string): string {
  return [
    "<details>",
    `<summary>${DEBATE_INSTRUCTION_SUMMARY}</summary>`,
    "",
    instruction.trim(),
    "",
    "</details>",
  ].join("\n");
}

/**
 * A launch message again: the requirement, then the framed instruction.
 *
 * Editing a message edits only what the user wrote, so the resend has to put the
 * framing back — this is the inverse of `splitDebateInstruction`.
 */
export function joinDebateInstruction(body: string, instruction: string): string {
  const text = body.trim();
  const block = debateInstructionBlock(instruction);
  return text ? `${text}\n\n${block}` : block;
}

/**
 * Separate a launch message into the bubble text and its folded instruction.
 *
 * Tolerates a leading/trailing blank line, more than one block (the first
 * debate framing is taken, the rest stay in the body), an unterminated block,
 * and the word 辩论 on its own with no block — the last three are the user's own
 * text and come back untouched.
 */
export function splitDebateInstruction(text: string): DebateInstructionSplit {
  const source = typeof text === "string" ? text : "";
  DETAILS_BLOCK.lastIndex = 0;
  for (
    let match = DETAILS_BLOCK.exec(source);
    match;
    match = DETAILS_BLOCK.exec(source)
  ) {
    const inner = match[1];
    const summary = SUMMARY_TAG.exec(inner);
    if (!summary || !SUMMARY_MATCH.test(summary[1])) continue;
    // The block is ours from here on, even if its body came out empty: leaving
    // it in place would put raw markup back in the bubble.
    const instruction = inner.slice(summary.index + summary[0].length).trim();
    const body = (
      source.slice(0, match.index) + source.slice(match.index + match[0].length)
    )
      // The block took a paragraph break with it; keep one, not a gap.
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return instruction ? { body, instruction } : { body };
  }
  return { body: source };
}
