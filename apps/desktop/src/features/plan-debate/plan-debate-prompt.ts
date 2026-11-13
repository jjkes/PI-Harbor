/**
 * The prompt the plan-mode composer's debate button sends.
 *
 * The renderer cannot start a debate: only the runtime runs the `PlanDebate`
 * tool, and only a turn can reach the runtime. So the button's whole job is to
 * make the intent explicit — the requirement the user typed, wrapped in the one
 * instruction that names the tool *and* the `intent: "start"` discriminator the
 * tool requires — and then let the normal composer send path carry it to the
 * model like any other message. Without that discriminator the tool opens no
 * round at all: a debate is the user's gesture, and this button is that gesture.
 *
 * The instruction text is not written here: `debate-instruction` owns both the
 * block this prompt writes and the split the transcript row reads, so the two
 * can never drift apart.
 *
 * Pure and model-free: the same requirement always composes the same prompt,
 * so the button is predictable and the text is testable.
 */
import {
  DEBATE_INSTRUCTION_BODY,
  joinDebateInstruction,
} from "./debate-instruction";

export function planDebateRequest(requirement: string): string {
  // The user's words lead and stay visible; the instruction rides in a
  // collapsible block so the transcript reads as their request first.
  return joinDebateInstruction(requirement, DEBATE_INSTRUCTION_BODY);
}
