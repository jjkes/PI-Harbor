import { describe, expect, it } from "vitest";
import {
  PROGRESS_ASSISTANT_CHARS,
  PROGRESS_DIGEST_TOKEN_BUDGET,
  PROGRESS_TOOL_RESULT_CHARS,
  PROGRESS_USER_CHARS,
} from "@pi-harbor/shared";
import { buildProgressDigest, estimateDigestTokens } from "./progress-digest.js";
import type { ProgressSnapshot, ProgressSnapshotMessage } from "./progress-snapshot.js";

function entry(
  id: string,
  role: ProgressSnapshotMessage["role"],
  content: string,
  extra: Partial<ProgressSnapshotMessage> = {},
): ProgressSnapshotMessage {
  return {
    id,
    role,
    content,
    thinking: null,
    createdAt: "2026-11-19T10:00:00.000Z",
    toolName: null,
    toolCallId: null,
    toolArgs: null,
    toolResult: null,
    toolStatus: null,
    ...extra,
  };
}

function snapshot(messages: ProgressSnapshotMessage[], checklist: ProgressSnapshot["checklist"] = []) {
  return {
    facts: {
      mode: "agent",
      permissionMode: "default",
      providerId: "openai",
      modelId: "gpt-4.1-mini",
      totalMessages: messages.length,
      firstMessageAt: "2026-11-19T10:00:00.000Z",
      lastMessageAt: "2026-11-19T10:30:00.000Z",
    },
    messages,
    checklist,
    lastMessageId: messages.at(-1)?.id ?? null,
    messageCount: messages.length,
    todosRevision: 0,
  } satisfies ProgressSnapshot;
}

describe("estimateDigestTokens", () => {
  it("counts more tokens for longer text", () => {
    expect(estimateDigestTokens("a")).toBeLessThan(estimateDigestTokens("a".repeat(200)));
  });
});

describe("buildProgressDigest", () => {
  it("states the session facts, the checklist, and the transcript", () => {
    const digest = buildProgressDigest(
      snapshot([entry("m1", "user", "Add a progress report"), entry("m2", "assistant", "On it")], [
        { content: "read the design", status: "completed" },
        { content: "write the module", status: "in_progress" },
      ]),
    );
    expect(digest).toContain("mode=agent");
    expect(digest).toContain("model=openai/gpt-4.1-mini");
    expect(digest).toContain("[x] read the design");
    expect(digest).toContain("[~] write the module");
    expect(digest).toContain("U Add a progress report");
    expect(digest).toContain("A On it");
    expect(digest).toContain("transcript");
  });

  it("says so when the checklist is empty", () => {
    expect(buildProgressDigest(snapshot([entry("m1", "user", "hi")]))).toContain("checklist (none)");
  });

  it("never carries thinking text", () => {
    const digest = buildProgressDigest(
      snapshot([
        entry("m1", "user", "hi"),
        entry("m2", "assistant", "answer", { thinking: "SECRET-REASONING" }),
      ]),
    );
    expect(digest).not.toContain("SECRET-REASONING");
  });

  it("caps user and assistant text", () => {
    const digest = buildProgressDigest(
      snapshot([
        entry("m1", "user", "u".repeat(PROGRESS_USER_CHARS * 3)),
        entry("m2", "assistant", "a".repeat(PROGRESS_ASSISTANT_CHARS * 3)),
      ]),
    );
    const userLine = digest.split("\n").find((line) => line.startsWith("U ")) ?? "";
    const assistantLine = digest.split("\n").find((line) => line.startsWith("A ")) ?? "";
    expect(userLine.length).toBeLessThanOrEqual(PROGRESS_USER_CHARS + 4);
    expect(assistantLine.length).toBeLessThanOrEqual(PROGRESS_ASSISTANT_CHARS + 4);
  });

  it("renders a tool call and its result as one line each and caps the result", () => {
    const digest = buildProgressDigest(
      snapshot([
        entry("m1", "user", "run the tests"),
        entry("m2", "assistant", "", {
          toolName: "tools.bash",
          toolCallId: "c1",
          toolArgs: { command: "pnpm test", timeout: 10 },
        }),
        entry("m3", "tool", "", {
          toolName: "tools.bash",
          toolCallId: "c1",
          toolStatus: "success",
          toolResult: "x".repeat(PROGRESS_TOOL_RESULT_CHARS * 4),
        }),
      ]),
    );
    expect(digest).toContain("C tools.bash(command,timeout pnpm test)");
    expect(digest).toContain("T tools.bash → ok:");
    const toolLine = digest.split("\n").find((line) => line.startsWith("T ")) ?? "";
    expect(toolLine.length).toBeLessThanOrEqual(PROGRESS_TOOL_RESULT_CHARS + 30);
  });

  it("marks a failed tool result as an error", () => {
    const digest = buildProgressDigest(
      snapshot([
        entry("m1", "user", "run"),
        entry("m2", "tool", "", {
          toolName: "tools.bash",
          toolCallId: "c1",
          toolStatus: "error",
          toolResult: "exit code 1",
        }),
      ]),
    );
    expect(digest).toContain("T tools.bash → error: exit code 1");
  });

  it("stays inside the token budget for a large transcript", () => {
    const messages = [
      entry("anchor", "user", "the original request that must survive"),
      ...Array.from({ length: 400 }, (_, index) =>
        entry(`m${index}`, index % 2 === 0 ? "assistant" : "user", "w".repeat(700)),
      ),
    ];
    const digest = buildProgressDigest(snapshot(messages));
    expect(estimateDigestTokens(digest)).toBeLessThanOrEqual(PROGRESS_DIGEST_TOKEN_BUDGET + 40);
  });

  it("keeps the earliest user message, and drops the oldest history first", () => {
    const messages = [
      entry("anchor", "user", "ANCHOR-REQUEST"),
      ...Array.from({ length: 400 }, (_, index) => entry(`m${index}`, "assistant", "w".repeat(700))),
    ];
    const digest = buildProgressDigest(snapshot(messages));
    const transcript = digest.split("\n").filter((line) => /^[UACTS] /.test(line));
    expect(digest).toContain("ANCHOR-REQUEST");
    // The anchor survives, and most of the 400 filler rows are gone.
    expect(transcript[0]).toBe("U ANCHOR-REQUEST");
    expect(transcript.length).toBeLessThan(60);
  });
});
