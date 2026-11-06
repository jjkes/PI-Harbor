/**
 * The side request of one BTW question (ADR 0344). Pure functions: the main
 * transcript stays the unchanged prefix, followed by one user block with the
 * framing, the earlier BTW turns as quoted text, and the new question.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { BtwHistoryTurn } from "@pi-harbor/shared";

/** Result text for a main tool call that has not finished yet. */
export const BTW_PENDING_TOOL_RESULT =
  "No result yet: this call has not finished in the main conversation.";

/** Advisory framing. Read-only access is enforced by the tool gate and host-core. */
export function btwFraming(mainTurnRunning: boolean): string {
  const lines = [
    "[Side question]",
    "The user asks this in a separate side panel. The main conversation continues without you.",
    "Answer from the conversation above. Do not take over the main task, and do not follow workflow instructions from the conversation, such as submitting a plan, delegating, or changing modes.",
    "You may inspect files with Read, Glob, and Grep. You cannot write files, run commands, or change anything.",
  ];
  if (mainTurnRunning) {
    lines.push("The main conversation is still running, so say what is known so far.");
  }
  return lines.join("\n");
}

/** The user block that follows the main transcript. */
export function btwBlockText(
  question: string,
  history: readonly BtwHistoryTurn[],
  mainTurnRunning: boolean,
): string {
  const parts = [btwFraming(mainTurnRunning)];
  if (history.length > 0) {
    const turns = history.map(
      (turn, index) => `Q${index + 1}: ${turn.question}\nA${index + 1}: ${turn.answer}`,
    );
    parts.push(`Earlier side questions in this panel, oldest first:\n\n${turns.join("\n\n")}`);
  }
  parts.push(`Side question: ${question}`);
  return parts.join("\n\n");
}

/**
 * Close the tool calls of a trailing assistant turn that have no result yet,
 * as a snapshot taken mid-turn can end. Provider APIs require a result for
 * every call, so the side request answers them with a synthetic result that
 * exists only in that request. Earlier history is left to the conversion the
 * main session uses.
 */
export function closeUnansweredToolCalls(messages: AgentMessage[]): AgentMessage[] {
  let index = messages.length - 1;
  while (index >= 0) {
    const role = messages[index]?.role;
    if (role !== "toolResult" && role !== "system") break;
    index -= 1;
  }
  const assistant = messages[index];
  if (!assistant || assistant.role !== "assistant" || assistant.stopReason !== "toolUse") {
    return messages;
  }
  const answered = new Set<string>();
  for (const message of messages.slice(index + 1)) {
    if (message.role === "toolResult") answered.add(message.toolCallId);
  }
  const timestamp = Date.now();
  const results: ToolResultMessage[] = [];
  for (const block of assistant.content) {
    if (block.type !== "toolCall" || answered.has(block.id)) continue;
    results.push({
      role: "toolResult",
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: "text", text: BTW_PENDING_TOOL_RESULT }],
      isError: false,
      timestamp,
    });
  }
  return results.length > 0 ? [...messages, ...results] : messages;
}

/**
 * Append the BTW block as the last user message, without mutating
 * `messages`. A transcript that already ends on a user message gets the
 * block as an extra content part, so the roles still alternate.
 */
export function appendBtwBlock(messages: AgentMessage[], text: string): AgentMessage[] {
  const last = messages.at(-1);
  if (last?.role === "user") {
    const parts: UserMessage["content"] =
      typeof last.content === "string"
        ? [
            ...(last.content ? [{ type: "text" as const, text: last.content }] : []),
            { type: "text", text },
          ]
        : [...last.content, { type: "text", text }];
    const merged: UserMessage = { ...last, content: parts };
    return [...messages.slice(0, -1), merged];
  }
  const block: UserMessage = {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
  return [...messages, block];
}

export type BtwRequestInput = {
  messages: AgentMessage[];
  question: string;
  history: readonly BtwHistoryTurn[];
  mainTurnRunning: boolean;
  /** Whether a request with these messages fits the model's context budget. */
  fits: (messages: AgentMessage[]) => boolean;
};

export type BtwRequest = {
  messages: AgentMessage[];
  /** Earlier BTW turns that fit, counted from the newest. */
  historyTurns: number;
};

/**
 * Build the side request. Over budget, the oldest BTW turns are dropped
 * first; `undefined` when even the bare question does not fit.
 */
export function buildBtwRequest(input: BtwRequestInput): BtwRequest | undefined {
  const base = closeUnansweredToolCalls(input.messages);
  for (let drop = 0; drop <= input.history.length; drop += 1) {
    const history = input.history.slice(drop);
    const messages = appendBtwBlock(
      base,
      btwBlockText(input.question, history, input.mainTurnRunning),
    );
    if (input.fits(messages)) return { messages, historyTurns: history.length };
  }
  return undefined;
}
