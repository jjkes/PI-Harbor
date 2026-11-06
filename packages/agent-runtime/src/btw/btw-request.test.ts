import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  appendBtwBlock,
  BTW_PENDING_TOOL_RESULT,
  btwBlockText,
  buildBtwRequest,
  closeUnansweredToolCalls,
} from "./btw-request.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "fixture",
    usage,
    stopReason,
    timestamp: 2,
  };
}

function toolResult(toolCallId: string, toolName: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: "done" }],
    isError: false,
    timestamp: 3,
  };
}

const user: UserMessage = { role: "user", content: "Fix the build", timestamp: 1 };

describe("closeUnansweredToolCalls", () => {
  it("closes only the calls of a trailing tool-use turn that have no result yet", () => {
    const messages: AgentMessage[] = [
      user,
      assistant(
        [
          { type: "toolCall", id: "c1", name: "Read", arguments: { path: "a.ts" } },
          { type: "toolCall", id: "c2", name: "Grep", arguments: { pattern: "x" } },
        ],
        "toolUse",
      ),
      toolResult("c1", "Read"),
    ];
    const closed = closeUnansweredToolCalls(messages);
    expect(closed.slice(0, 3)).toEqual(messages);
    expect(closed).toHaveLength(4);
    expect(closed[3]).toMatchObject({
      role: "toolResult",
      toolCallId: "c2",
      toolName: "Grep",
      content: [{ type: "text", text: BTW_PENDING_TOOL_RESULT }],
    });
    expect(messages).toHaveLength(3);
  });

  it("leaves finished, failed, and aborted turns unchanged", () => {
    for (const stopReason of ["stop", "error", "aborted"] as const) {
      const messages: AgentMessage[] = [
        user,
        assistant([{ type: "toolCall", id: "c1", name: "Read", arguments: {} }], stopReason),
      ];
      expect(closeUnansweredToolCalls(messages)).toEqual(messages);
    }
  });
});

describe("appendBtwBlock", () => {
  it("adds a user message after an assistant turn", () => {
    const messages: AgentMessage[] = [user, assistant([{ type: "text", text: "Done." }], "stop")];
    const next = appendBtwBlock(messages, "BTW block");
    expect(next).toHaveLength(3);
    expect(next.slice(0, 2)).toEqual(messages);
    expect(next[2]).toMatchObject({ role: "user", content: [{ type: "text", text: "BTW block" }] });
    expect(messages).toHaveLength(2);
  });

  it("merges into a trailing user message so roles still alternate", () => {
    const next = appendBtwBlock([user], "BTW block");
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "Fix the build" },
        { type: "text", text: "BTW block" },
      ],
    });
    expect(user.content).toBe("Fix the build");
  });
});

describe("btwBlockText", () => {
  it("puts earlier turns before the new question and notes a running main turn", () => {
    const text = btwBlockText("Why?", [{ question: "What?", answer: "This." }], false);
    expect(text).toContain("This.");
    expect(text.indexOf("What?")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("What?")).toBeLessThan(text.lastIndexOf("Why?"));
    expect(btwBlockText("Why?", [], true)).not.toBe(btwBlockText("Why?", [], false));
  });
});

describe("buildBtwRequest", () => {
  const messages: AgentMessage[] = [user, assistant([{ type: "text", text: "Done." }], "stop")];
  const history = [
    { question: "old question", answer: "old answer" },
    { question: "new question", answer: "new answer" },
  ];
  const text = (request: { messages: AgentMessage[] } | undefined) =>
    JSON.stringify(request?.messages ?? []);

  it("keeps the main context as the prefix and the whole thread when it fits", () => {
    const request = buildBtwRequest({
      messages,
      question: "Why?",
      history,
      mainTurnRunning: false,
      fits: () => true,
    });
    expect(request?.messages.slice(0, 2)).toEqual(messages);
    expect(text(request)).toContain("old question");
    expect(text(request)).toContain("new question");
  });

  it("drops the oldest BTW turns first", () => {
    const request = buildBtwRequest({
      messages,
      question: "Why?",
      history,
      mainTurnRunning: false,
      fits: (candidate) => !JSON.stringify(candidate).includes("old question"),
    });
    expect(text(request)).toContain("new question");
    expect(text(request)).not.toContain("old question");
  });

  it("gives up when even the bare question does not fit", () => {
    expect(
      buildBtwRequest({ messages, question: "Why?", history, mainTurnRunning: false, fits: () => false }),
    ).toBeUndefined();
  });
});
