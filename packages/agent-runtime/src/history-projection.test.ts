import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { UiMessage } from "@pi-harbor/shared";
import {
  projectHistoryContextEntries,
  projectHistoryEntries,
  type HistoryProjectionBinding,
} from "./history-projection.js";
import { readSystemMessage } from "./system-transcript-journal.js";

const at = (second: number) => `2026-11-05T00:00:${String(second).padStart(2, "0")}.000Z`;
const restoreSystem = (row: UiMessage) => readSystemMessage(row.modelSystem?.messageJson);
const prompt = { role: "system", content: "Base prompt", timestamp: 1 };
const system = (id: string, second: number, beforeMessageId: string): UiMessage => ({
  id, role: "system", content: "", createdAt: at(second),
  modelSystem: { version: 1, messageJson: JSON.stringify(prompt), beforeMessageId },
});
const assistant = (id: string, extra: Partial<UiMessage>): UiMessage =>
  ({ id, role: "assistant", content: "", createdAt: at(10), ...extra });
const toolRow = (id: string, extra: Partial<UiMessage> = {}): UiMessage =>
  ({ id, role: "tool", content: "", createdAt: at(20), toolCallId: id, toolName: "Read", ...extra });

/** Every survival rule of the projection, each on its own row. */
const history: UiMessage[] = [
  { id: "u1", role: "user", content: "Hello", createdAt: at(1) },
  system("s1", 0, "u1"),
  // Identical system state recorded twice is restored once.
  system("s1-again", 2, "u1"),
  { id: "u-blank", role: "user", content: "  \n", createdAt: at(2) },
  { id: "u-image", role: "user", content: "", createdAt: at(3),
    attachments: [{ kind: "image", name: "a.png", ref: "a.png", mimeType: "image/png", data: "iVBORw0K" }] },
  { id: "u-unhydrated", role: "user", content: "", createdAt: at(4),
    attachments: [{ kind: "image", name: "b.png", ref: "b.png", mimeType: "image/png" }] },
  assistant("a-failed", { content: "Partial", status: "error" }),
  assistant("a-blank", { content: "   " }),
  assistant("a-placeholder", { thinking: "[reasoning not retained for this turn]" }),
  // A zero-length signed block still carries the provider's signature.
  assistant("a-signed", { thinking: "", providerReplay: { version: 1, blocks: [{ type: "thinking", length: 0, signature: "sig" }] } }),
  assistant("a-search", { hostedSearch: { status: "completed", rounds: [], replay: [{
    type: "hostedSearch", phase: "web_search_call", blockId: "ws_1",
    wire: { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "q" } },
  }] } }),
  // A turn with no content of its own is kept: the next tool row puts its call on it.
  assistant("a-call", {}),
  toolRow("t-kept"),
  // Not a well-formed call; it keeps the carrier for the rows that follow.
  toolRow("t-invalid", { toolName: "" }),
  toolRow("t-delegate", { parentToolCallId: "task-1" }),
  { id: "u2", role: "user", content: "Again", createdAt: at(30) },
  toolRow("t-orphan"),
  toolRow("t-orphan-2"),
];

const bindings: HistoryProjectionBinding[] = [
  { api: "openai-completions", accountProviderId: "", modelProvider: "", modelId: "", requiresReasoningContentOnAssistantMessages: false },
  { api: "openai-completions", accountProviderId: "deepseek", modelProvider: "deepseek", modelId: "deepseek-reasoner", requiresReasoningContentOnAssistantMessages: true },
  { api: "anthropic-messages", accountProviderId: "local", modelProvider: "anthropic", modelId: "claude-fixture", requiresReasoningContentOnAssistantMessages: false },
];
const layout = (binding: HistoryProjectionBinding) =>
  projectHistoryEntries(history, binding, restoreSystem).map((entry) => [entry.id, entry.message.role]);

describe("projectHistoryEntries", () => {
  it("keeps the same entries in the same order under every provider binding", () => {
    const expected = [
      ["s1", "system"], ["u1", "user"], ["u-image", "user"], ["a-signed", "assistant"], ["a-search", "assistant"],
      ["a-call", "assistant"], ["t-kept", "toolResult"], ["u2", "user"],
      ["t-orphan:carrier", "assistant"], ["t-orphan", "toolResult"], ["t-orphan-2", "toolResult"],
    ];
    for (const binding of bindings) expect(layout(binding)).toEqual(expected);
  });

  it("uses the binding only to label restored assistants", () => {
    const carrier = (binding: HistoryProjectionBinding) => projectHistoryEntries(history, binding, restoreSystem)
      .find((entry) => entry.id === "t-orphan:carrier")?.message as AssistantMessage;
    expect(carrier(bindings[1])).toMatchObject({ provider: "deepseek", model: "deepseek-reasoner" });
    expect(carrier(bindings[2])).toMatchObject({ api: "anthropic-messages", provider: "anthropic", model: "claude-fixture" });
  });
});

describe("projectHistoryContextEntries", () => {
  it("returns the runtime's layout with each system entry's own recording time", () => {
    const entries = projectHistoryContextEntries(history, restoreSystem);
    expect(entries.map((entry) => entry.id)).toEqual(layout(bindings[0]).map(([id]) => id));
    expect(entries[0]).toEqual({ id: "s1", system: { message: prompt, createdAt: at(0) } });
    expect(entries.slice(1).every((entry) => entry.system === undefined)).toBe(true);
  });

  it("throws on a malformed system row, as the runtime's restore does", () => {
    const broken: UiMessage = { ...system("bad", 5, "u1"), modelSystem: { version: 1, messageJson: "{" } };
    expect(() => projectHistoryContextEntries([...history, broken], restoreSystem)).toThrow();
  });
});
