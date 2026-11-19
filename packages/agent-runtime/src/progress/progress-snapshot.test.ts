import { describe, expect, it } from "vitest";
import type { UiMessage } from "@pi-harbor/shared";
import { PROGRESS_WINDOW_MESSAGES } from "@pi-harbor/shared";
import { buildProgressSnapshot, progressFingerprint } from "./progress-snapshot.js";

function message(id: string, role: UiMessage["role"], content: string, extra: Partial<UiMessage> = {}) {
  return { id, role, content, createdAt: `2026-11-19T10:00:0${id.length % 10}.000Z`, ...extra } as UiMessage;
}

const session = { mode: "agent", permissionMode: "default", providerId: "openai", modelId: "gpt-4.1-mini" };

describe("buildProgressSnapshot", () => {
  it("keeps the session facts and the newest message id", () => {
    const snapshot = buildProgressSnapshot({
      session,
      messages: [message("m1", "user", "hello"), message("m2", "assistant", "hi")],
    });
    expect(snapshot.facts.mode).toBe("agent");
    expect(snapshot.facts.modelId).toBe("gpt-4.1-mini");
    expect(snapshot.lastMessageId).toBe("m2");
    expect(snapshot.messageCount).toBe(2);
    expect(snapshot.messages).toHaveLength(2);
  });

  it("defaults missing session facts instead of throwing", () => {
    const snapshot = buildProgressSnapshot({ session: {}, messages: [] });
    expect(snapshot.facts.mode).toBe("agent");
    expect(snapshot.facts.permissionMode).toBe("default");
    expect(snapshot.lastMessageId).toBeNull();
    expect(snapshot.messages).toEqual([]);
  });

  it("renders the checklist from the todo snapshot without copying the id", () => {
    const snapshot = buildProgressSnapshot({
      session,
      messages: [message("m1", "user", "hello")],
      todos: { revision: 4, todos: [{ content: "write the test", status: "in_progress", priority: "high" }] },
    });
    expect(snapshot.checklist).toEqual([{ content: "write the test", status: "in_progress" }]);
    expect(snapshot.todosRevision).toBe(4);
  });

  it("bounds the window to the newest messages", () => {
    const messages = Array.from({ length: PROGRESS_WINDOW_MESSAGES + 25 }, (_, index) =>
      message(`m${index}`, index % 2 === 0 ? "user" : "assistant", `line ${index}`),
    );
    const snapshot = buildProgressSnapshot({ session, messages });
    expect(snapshot.messages).toHaveLength(PROGRESS_WINDOW_MESSAGES);
    expect(snapshot.messages[0]?.content).toBe(`line ${messages.length - PROGRESS_WINDOW_MESSAGES}`);
    expect(snapshot.messageCount).toBe(messages.length);
  });

  it("extends the window backwards so a tool result keeps its call", () => {
    const messages = Array.from({ length: PROGRESS_WINDOW_MESSAGES + 3 }, (_, index) =>
      message(`m${index}`, "tool", `result ${index}`, { toolName: "tools.bash" }),
    );
    const snapshot = buildProgressSnapshot({ session, messages });
    // Every row is a tool row, so the window walks back to the first message.
    expect(snapshot.messages).toHaveLength(messages.length);
    expect(snapshot.messages[0]?.id).toBe("m0");
  });

  it("extends the window backwards when its first row is an orphaned tool result", () => {
    const filler = Array.from({ length: PROGRESS_WINDOW_MESSAGES - 1 }, (_, index) =>
      message(`f${index}`, "assistant", `filler ${index}`),
    );
    const messages = [
      message("call", "assistant", "", { toolName: "tools.bash", toolCallId: "c1" }),
      message("result", "tool", "done", { toolName: "tools.bash", toolCallId: "c1" }),
      ...filler,
    ];
    const snapshot = buildProgressSnapshot({ session, messages });
    // A plain window would start at "result"; the call comes back with it.
    expect(snapshot.messages[0]?.id).toBe("call");
    expect(snapshot.messages).toHaveLength(messages.length);
  });

  it("does not mutate the messages it receives", () => {
    const messages = [message("m1", "user", "hello")];
    const frozen = JSON.stringify(messages);
    buildProgressSnapshot({ session, messages });
    expect(JSON.stringify(messages)).toBe(frozen);
  });
});

describe("progressFingerprint", () => {
  it("is stable for the same snapshot keys", () => {
    const keys = { lastMessageId: "m2", messageCount: 2, todosRevision: 0 };
    expect(progressFingerprint(keys)).toBe(progressFingerprint({ ...keys }));
    expect(progressFingerprint(keys)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes when the session, the count, or the checklist moves", () => {
    const base = { lastMessageId: "m2", messageCount: 2, todosRevision: 0 };
    expect(progressFingerprint({ ...base, lastMessageId: "m3" })).not.toBe(progressFingerprint(base));
    expect(progressFingerprint({ ...base, messageCount: 3 })).not.toBe(progressFingerprint(base));
    expect(progressFingerprint({ ...base, todosRevision: 1 })).not.toBe(progressFingerprint(base));
  });

  it("is different for an empty and a populated placeholder", () => {
    expect(progressFingerprint({ lastMessageId: null, messageCount: 0, todosRevision: 0 })).not.toBe(
      progressFingerprint({ lastMessageId: "", messageCount: 0, todosRevision: 0 }),
    );
  });
});
