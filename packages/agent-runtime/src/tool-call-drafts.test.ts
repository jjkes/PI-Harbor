import { describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type JsonObject,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  TOOL_DRAFT_GAP,
  applyToolDraftChanges,
  toolDraftPayloadChars,
  type AgentEventEnvelope,
  type CommandShellOption,
  type ContextCompactionRecord,
  type ToolDraftChange,
} from "@pi-harbor/shared";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";
import { SubagentRun } from "./subagent.js";
import { createStreamCoalescer } from "./stream-coalescer.js";
import { ToolCallDraftTracker, type ToolDraftAgentEvent } from "./tool-call-drafts.js";

const provider: RuntimeProviderConfig = {
  id: "local",
  name: "Local",
  baseUrl: "http://127.0.0.1:11434/v1",
  modelId: "local-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};

const commandShell: CommandShellOption = {
  id: "bash",
  label: "Bash",
  dialect: "posix",
  available: true,
  isDefault: true,
};

function assistantMessage(content: unknown[], stopReason = "stop"): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "local",
    model: "local-model",
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 2,
    content,
  } as AssistantMessage;
}

/** Host whose tools succeed immediately; records every `tools.execute`. */
function succeedingHost() {
  const executed: Array<{ toolCallId: string; args: unknown }> = [];
  const call = vi.fn(async (method: string, params: { toolCallId?: string; args?: unknown }) => {
    if (method === "project.instructions.resolve") return { entries: [] };
    if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false };
    if (method === "tools.execute") {
      executed.push({ toolCallId: String(params.toolCallId), args: params.args });
      return { ok: true, content: "written" };
    }
    return undefined;
  });
  return { host: { call, onNotification: vi.fn(() => () => {}) }, executed };
}

type ToolTurn = { id: string; name: string; steps: JsonObject[]; end?: "toolUse" | "aborted" };

/**
 * Provider stream that writes one tool call the way pi-ai adapters do: one
 * `toolCall` block whose `arguments` is reassigned to a fresh partial object
 * per chunk, with a macrotask between chunks so the agent loop observes each.
 * Later turns answer with text.
 */
function streamingToolCall(turns: ToolTurn[]) {
  let turn = 0;
  return () => {
    const script = turns[turn++];
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
      if (!script) {
        const done = assistantMessage([{ type: "text", text: "done" }]);
        stream.push({ type: "start", partial: done });
        stream.push({ type: "done", reason: "stop", message: done });
        stream.end(done);
        return;
      }
      const block: ToolCall = { type: "toolCall", id: script.id, name: script.name, arguments: {} };
      const partial = assistantMessage([block], "toolUse");
      stream.push({ type: "start", partial });
      stream.push({ type: "toolcall_start", contentIndex: 0, partial });
      for (const step of script.steps) {
        await tick();
        block.arguments = step;
        stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "", partial });
      }
      await tick();
      if (script.end === "aborted") {
        const failed = assistantMessage([{ ...block }], "aborted");
        stream.push({ type: "error", reason: "aborted", error: failed });
        stream.end(failed);
        return;
      }
      const final = assistantMessage([{ ...block }], "toolUse");
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial });
      stream.push({ type: "done", reason: "toolUse", message: final });
      stream.end(final);
    })();
    return stream;
  };
}

function createRuntime(onEvent: (envelope: AgentEventEnvelope) => void, host = succeedingHost().host) {
  return new DesktopAgentRuntime({
    host: host as never,
    sessionId: "session-1",
    mode: "agent",
    provider,
    commandShell,
    thinkingLevel: "off",
    projectPath: "/root",
    onEvent,
  });
}

/** Test seam for the provider; the runtime keeps its model collection private. */
function useStream(runtime: DesktopAgentRuntime, streamSimple: () => unknown): void {
  (runtime as unknown as { models: { streamSimple: () => unknown } }).models = { streamSimple };
}

function draftsOf(envelopes: AgentEventEnvelope[], toolCallId: string): ToolDraftAgentEvent[] {
  return envelopes
    .map((envelope) => envelope.event)
    .filter((event): event is ToolDraftAgentEvent =>
      event.type === "tool_draft" && event.toolCallId === toolCallId);
}

describe("tool-call drafts on the session runtime", () => {
  it("previews a streaming Write before tool_start and still executes it once with the final arguments", async () => {
    const envelopes: AgentEventEnvelope[] = [];
    const { host, executed } = succeedingHost();
    const runtime = createRuntime((envelope) => envelopes.push(envelope), host);
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index}\n`);
    const steps: JsonObject[] = [
      { path: "src/" },
      { path: "src/app.ts" },
      ...lines.map((_, index) => ({ path: "src/app.ts", content: lines.slice(0, index + 1).join("") })),
    ];
    const final = steps.at(-1)!;
    useStream(runtime, streamingToolCall([{ id: "write-1", name: "Write", steps }]));
    try {
      await runtime.prompt("Write the file.");
    } finally {
      await runtime.dispose();
    }

    const drafts = draftsOf(envelopes, "write-1");
    const streaming = drafts.filter((draft) => draft.phase === "streaming");
    expect(streaming.length).toBeGreaterThan(1);
    let rebuilt: unknown;
    for (const draft of streaming) {
      rebuilt = applyToolDraftChanges(rebuilt, draft.changes ?? []);
      expect(rebuilt).not.toBe(TOOL_DRAFT_GAP);
    }
    expect(rebuilt).toEqual(final);
    expect(drafts.at(-1)?.phase).toBe("complete");
    expect(drafts.map((draft) => draft.phase)).not.toContain("discarded");

    const types = envelopes.map((envelope) => envelope.event.type);
    const start = envelopes.findIndex((envelope) =>
      envelope.event.type === "tool_start" && envelope.event.toolCallId === "write-1");
    expect(start).toBeGreaterThan(-1);
    let lastDraft = -1;
    envelopes.forEach((envelope, index) => {
      if (envelope.event.type === "tool_draft") lastDraft = index;
    });
    expect(lastDraft).toBeLessThan(start);
    expect(types.filter((type) => type === "tool_start")).toHaveLength(1);
    const startEvent = envelopes[start]!.event;
    expect(startEvent.type === "tool_start" ? startEvent.args : undefined).toEqual(final);
    expect(executed.map((call) => call.toolCallId)).toEqual(["write-1"]);
    expect(executed[0]?.args).toMatchObject({ content: final.content });

    const content = String(final.content);
    const chars = streaming.reduce((total, draft) => total + toolDraftPayloadChars(draft), 0);
    expect(chars).toBeLessThanOrEqual(2 * content.length + 1024 * streaming.length);
  });

  it("discards the drafts of an aborted response and never runs the call", async () => {
    const envelopes: AgentEventEnvelope[] = [];
    const { host, executed } = succeedingHost();
    const runtime = createRuntime((envelope) => envelopes.push(envelope), host);
    useStream(runtime, streamingToolCall([{
      id: "write-aborted",
      name: "Write",
      steps: [{ path: "a.ts" }, { path: "a.ts", content: "partial" }],
      end: "aborted",
    }]));
    try {
      await runtime.prompt("Write the file.").catch(() => undefined);
    } finally {
      await runtime.dispose();
    }
    const phases = draftsOf(envelopes, "write-aborted").map((draft) => draft.phase);
    expect(phases[0]).toBe("streaming");
    expect(phases.at(-1)).toBe("discarded");
    expect(envelopes.some((envelope) => envelope.event.type === "tool_start")).toBe(false);
    expect(executed).toEqual([]);
  });

  it("discards a retried attempt's drafts before the next attempt streams", async () => {
    const envelopes: AgentEventEnvelope[] = [];
    const runtime = createRuntime((envelope) => envelopes.push(envelope));
    const internals = runtime as unknown as {
      handleAgentEvent: (event: unknown) => Promise<void>;
      claimProviderRetry: () => number | undefined;
    };
    vi.spyOn(internals, "claimProviderRetry").mockReturnValueOnce(1);
    const call = (id: string, args: JsonObject): ToolCall => ({ type: "toolCall", id, name: "Write", arguments: args });
    const failed = { ...assistantMessage([call("first", { path: "a.ts" })], "error"), errorMessage: "socket hang up" };
    try {
      await internals.handleAgentEvent({ type: "agent_start" });
      await internals.handleAgentEvent({ type: "message_start", message: assistantMessage([], "toolUse") });
      await internals.handleAgentEvent({ type: "message_update", message: assistantMessage([call("first", { path: "a.ts" })], "toolUse") });
      await internals.handleAgentEvent({ type: "message_end", message: failed });
      await internals.handleAgentEvent({ type: "message_start", message: assistantMessage([], "toolUse") });
      await internals.handleAgentEvent({ type: "message_update", message: assistantMessage([call("second", { path: "b.ts" })], "toolUse") });
    } finally {
      await runtime.dispose();
    }
    expect(internals.claimProviderRetry).toHaveBeenCalled();
    expect(draftsOf(envelopes, "first").map((draft) => draft.phase)).toEqual(["streaming", "discarded"]);
    const discarded = envelopes.findIndex((envelope) =>
      envelope.event.type === "tool_draft" && envelope.event.phase === "discarded");
    const next = envelopes.findIndex((envelope) =>
      envelope.event.type === "tool_draft" && envelope.event.toolCallId === "second");
    expect(discarded).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(discarded);
  });
});

describe("tool-call drafts in a delegate", () => {
  it("tags a delegate's drafts with the Task call that owns it", () => {
    const events: AgentEventEnvelope[] = [];
    const run = new SubagentRun({
      definition: { name: "writer", description: "Write files.", tools: ["Write"], prompt: "Write.", source: "builtin" },
      sessionId: "session-1",
      turnId: "turn-1",
      parentToolCallId: "task-1",
      task: "Write a.ts",
      provider,
      thinkingLevel: "off",
      systemPrompt: "system",
      tools: [],
      onEvent: (envelope) => events.push(envelope),
    });
    const handle = (event: unknown) =>
      (run as unknown as { handleEvent: (event: unknown) => void }).handleEvent(event);
    const call: ToolCall = { type: "toolCall", id: "child-write", name: "Write", arguments: { path: "a.ts" } };
    handle({ type: "message_start", message: assistantMessage([], "toolUse") });
    handle({ type: "message_update", message: assistantMessage([call], "toolUse") });
    handle({ type: "message_end", message: assistantMessage([call], "toolUse") });
    handle({ type: "tool_execution_start", toolCallId: "child-write", toolName: "Write", args: { path: "a.ts" } });

    const drafts = events.filter((envelope) => envelope.event.type === "tool_draft");
    expect(drafts.map((envelope) => (envelope.event.type === "tool_draft" ? envelope.event.phase : ""))).toEqual([
      "streaming",
      "complete",
    ]);
    expect(drafts.every((envelope) => envelope.parentToolCallId === "task-1" && envelope.agentName === "writer")).toBe(true);
    const start = events.findIndex((envelope) => envelope.event.type === "tool_start");
    expect(events.indexOf(drafts.at(-1)!)).toBeLessThan(start);
  });
});

describe("stream coalescer and tool drafts", () => {
  it("merges a call's streaming frames and flushes them before its lifecycle frame and tool_start", () => {
    const emitted: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((item) => emitted.push(item), {
      intervalMs: 16,
      schedule: () => () => {},
    });
    const draft = (phase: ToolDraftAgentEvent["phase"], changes?: ToolDraftChange[]): AgentEventEnvelope => ({
      sessionId: "s1",
      ts: 1,
      event: { type: "tool_draft", toolCallId: "c1", toolName: "Write", messageId: "m1", phase, ...(changes ? { changes } : {}) },
    });
    coalescer.push(draft("streaming", [{ op: "set", path: [], value: { path: "a.ts" } }]));
    coalescer.push(draft("streaming", [{ op: "set", path: ["content"], value: "a" }]));
    coalescer.push(draft("streaming", [{ op: "append", path: ["content"], text: "bc", offset: 1 }]));
    expect(emitted).toEqual([]);
    coalescer.push(draft("complete"));
    coalescer.push({ sessionId: "s1", ts: 2, event: { type: "tool_start", toolCallId: "c1", toolName: "Write", args: {} } });
    expect(emitted.map((item) => item.event.type === "tool_draft" ? item.event.phase : item.event.type)).toEqual([
      "streaming",
      "complete",
      "tool_start",
    ]);
    const merged = emitted[0]!.event;
    expect(merged.type === "tool_draft" ? merged.changes : undefined).toEqual([
      { op: "set", path: [], value: { path: "a.ts" } },
      { op: "set", path: ["content"], value: "abc" },
    ]);
  });
});

describe("compaction_end summary", () => {
  async function endedCompaction(details: Record<string, unknown>, fallback?: "retained_tail") {
    const envelopes: AgentEventEnvelope[] = [];
    const host = { call: vi.fn().mockResolvedValue(undefined), onNotification: vi.fn(() => () => {}) };
    const runtime = createRuntime((envelope) => envelopes.push(envelope), host);
    const checkpoint: ContextCompactionRecord = {
      id: "checkpoint-1",
      summary: "## Goal\nShip the preview.",
      throughMessageId: "user-1",
      tokensBefore: 1_000,
      createdAt: "2026-01-01T00:00:00.000Z",
      details,
    };
    const internals = runtime as unknown as {
      persistCheckpoint: (...args: unknown[]) => Promise<string>;
    };
    try {
      await expect(internals.persistCheckpoint(checkpoint, "manual", false, false, fallback)).resolves.toBe("persisted");
    } finally {
      await runtime.dispose();
    }
    const end = envelopes.map((envelope) => envelope.event).find((event) => event.type === "compaction_end");
    return end?.type === "compaction_end" ? end : undefined;
  }

  it("carries the summary of a real model summary only", async () => {
    expect((await endedCompaction({ generation: 1 }))?.summary).toBe("## Goal\nShip the preview.");
    expect(await endedCompaction({ generation: 1, fallback: "retained_tail" }, "retained_tail")).not.toHaveProperty("summary");
    expect(await endedCompaction({ generation: 1, strategy: "fresh_window" })).not.toHaveProperty("summary");
  });
});

describe("ToolCallDraftTracker", () => {
  it("discards a draft whose id the provider replaced before the response settled", () => {
    const tracker = new ToolCallDraftTracker();
    tracker.begin();
    tracker.observe("m1", [{ type: "toolCall", id: "streamed", name: "Write", arguments: { path: "a.ts" } }]);
    const settled = tracker.settle([{ type: "toolCall", id: "final", name: "Write", arguments: { path: "a.ts" } }], true);
    expect(settled.map((event) => [event.toolCallId, event.phase])).toEqual([["streamed", "discarded"]]);
    expect(tracker.observe("m1", [{ type: "toolCall", id: "late", name: "Write", arguments: {} }])).toEqual([]);
  });

  it("never lets the provider's later in-place mutation change a frame it already produced", () => {
    const tracker = new ToolCallDraftTracker();
    tracker.begin();
    const args: { todos: Array<{ title: string }> } = { todos: [{ title: "a" }] };
    const block = { type: "toolCall", id: "todo", name: "TodoWrite", arguments: args };
    const [first] = tracker.observe("m1", [block]);
    const sent = structuredClone(first!.changes);
    args.todos[0]!.title = "ab";
    args.todos.push({ title: "c" });
    const [second] = tracker.observe("m1", [block]);
    expect(first!.changes).toEqual(sent);
    expect(applyToolDraftChanges(applyToolDraftChanges(undefined, first!.changes ?? []), second!.changes ?? []))
      .toEqual({ todos: [{ title: "ab" }, { title: "c" }] });
  });
});
