import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { type AppError, type BtwEventEnvelope, ErrorCodes } from "@pi-harbor/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelConfigFromPi } from "../model-capabilities.js";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "../runtime.js";
import { BtwService, type BtwSnapshotSource } from "./btw-service.js";
import type { BtwHostCaller } from "./btw-tool-gate.js";

function flashProvider(): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((model) => model.id === "deepseek-flash")!;
  return { id: "flash-fixture", name: "Flash", modelId: model.id, baseUrl: model.baseUrl,
    apiKey: "fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: modelConfigFromPi(model) };
}

type Payload = { tools?: unknown[]; messages: { role: string; content?: unknown }[] };
/** A scripted provider reply: answer text, or one tool call. */
type Reply = string | { name: string; args?: Record<string, unknown> };

/** OpenAI-compatible SSE endpoint; only the network edge is faked. */
async function wireProvider(replies: Reply[], beforeReply?: (index: number) => Promise<void>) {
  const requests: Payload[] = [];
  const arrivals: Array<() => void> = [];
  const fetch = globalThis.fetch;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const index = requests.length;
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    for (const resolve of arrivals.splice(0)) resolve();
    await beforeReply?.(index);
    const reply = replies.shift() ?? "Done.";
    const delta = typeof reply === "string"
      ? { role: "assistant", content: reply }
      : { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function",
          function: { name: reply.name, arguments: JSON.stringify(reply.args ?? {}) } }] };
    const finish = typeof reply === "string" ? "stop" : "tool_calls";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  vi.stubGlobal("fetch", ((_url, init) => fetch(`http://127.0.0.1:${address.port}`, init)) satisfies typeof fetch);
  return {
    requests,
    nextRequest: () => new Promise<void>((resolve) => arrivals.push(resolve)),
    close: async () => {
      vi.unstubAllGlobals();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function mainRuntime(sessionId: string) {
  const hostCalls: string[] = [];
  const runtime = new DesktopAgentRuntime({
    sessionId, mode: "agent", provider: flashProvider(), thinkingLevel: "off", history: [], pluginTools: [],
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(method: string): Promise<T> => {
      hostCalls.push(method);
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      return undefined as T;
    } },
    onEvent: () => undefined,
  });
  return { runtime, hostCalls };
}

function btwHarness(runtimeFor: (sessionId: string) => Promise<BtwSnapshotSource>) {
  const envelopes: BtwEventEnvelope[] = [];
  const hostCalls: { method: string; params: unknown }[] = [];
  const waiters = new Map<string, (envelope: BtwEventEnvelope) => void>();
  const host: BtwHostCaller = {
    call: <T,>(method: string, params?: unknown): Promise<T> => {
      hostCalls.push({ method, params });
      return Promise.resolve({ ok: true, content: "README: run pnpm build." } as T);
    },
  };
  const service = new BtwService({
    runtimeFor: (sessionId) => runtimeFor(sessionId),
    host,
    notify: (envelope) => {
      envelopes.push(envelope);
      if (envelope.event.type === "done" || envelope.event.type === "error") {
        waiters.get(envelope.runId)?.(envelope);
      }
    },
    classifyError: (error): AppError => ({
      code: typeof error === "object" && error !== null && "errorCode" in error
        && typeof error.errorCode === "string" ? error.errorCode : "TEST_ERROR",
      message: error instanceof Error ? error.message : String(error),
      retriable: false,
    }),
  });
  const ask = (runId: string, question: string) => {
    const settled = new Promise<BtwEventEnvelope>((resolve) => waiters.set(runId, resolve));
    service.ask({ runId, sessionId: "main-session", question, history: [] });
    return settled;
  };
  return { service, envelopes, hostCalls, ask };
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

afterEach(() => vi.unstubAllGlobals());

describe("BtwService with a real main runtime and an HTTP/SSE provider", () => {
  it("answers from the main snapshot and reads only through the read-only host profile", async () => {
    const wire = await wireProvider(["Done.", { name: "Read", args: { path: "README.md" } }, "Use pnpm build."]);
    const main = mainRuntime("main-session");
    try {
      await main.runtime.prompt("Explain the build.", "user-1", "turn-user-1");
      const mainHostCalls = main.hostCalls.length;
      const before = main.runtime.sideQuestionSnapshot().messages;
      const btw = btwHarness(async () => main.runtime);

      const end = await btw.ask("run-1", "How do I build?");

      expect(end.event).toEqual({ type: "done", stopReason: "stop" });
      const events = btw.envelopes.map((envelope) => envelope.event);
      expect(events[0]).toMatchObject({ type: "started", providerId: "flash-fixture", mainTurnRunning: false });
      expect(btw.envelopes.map((envelope) => envelope.seq)).toEqual(events.map((_, index) => index));
      expect(events).toContainEqual(expect.objectContaining({ type: "tool_start", toolName: "Read" }));
      expect(events).toContainEqual(expect.objectContaining({ type: "tool_end", ok: true }));
      const answer = events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : [])).join("");
      expect(answer).toBe("Use pnpm build.");

      // Host-core sees one read-only call under a namespaced id and no main turn.
      expect(btw.hostCalls).toHaveLength(1);
      expect(btw.hostCalls[0]).toMatchObject({
        method: "tools.execute",
        params: {
          sessionId: "main-session",
          toolName: "Read",
          args: { path: "README.md" },
          mode: "agent",
          accessProfile: "read-only",
          toolCallId: expect.stringMatching(/^btw:run-1:/),
        },
      });
      expect(btw.hostCalls[0]?.params).not.toHaveProperty("turnId");

      // The main runtime made no host call and its context is unchanged.
      expect(main.hostCalls).toHaveLength(mainHostCalls);
      expect(main.runtime.sideQuestionSnapshot().messages).toEqual(before);

      // The side request starts with the main request unchanged (prefix parity).
      expect(wire.requests).toHaveLength(3);
      const [mainRequest, btwRequest] = wire.requests;
      expect(btwRequest?.tools).toEqual(mainRequest?.tools);
      expect(btwRequest?.messages.slice(0, mainRequest?.messages.length)).toEqual(mainRequest?.messages);
      expect(btwRequest?.messages.at(-1)).toMatchObject({ role: "user" });
      expect(JSON.stringify(btwRequest?.messages.at(-1))).toContain("How do I build?");
    } finally {
      await wire.close();
    }
  });

  it("blocks a write before it reaches the host and still answers", async () => {
    const wire = await wireProvider([
      "Done.",
      { name: "Write", args: { path: "x.txt", content: "no" } },
      "I can only read.",
    ]);
    const main = mainRuntime("main-session");
    try {
      await main.runtime.prompt("Explain the build.", "user-1", "turn-user-1");
      const btw = btwHarness(async () => main.runtime);
      const end = await btw.ask("run-2", "Write x.txt for me.");
      expect(end.event).toEqual({ type: "done", stopReason: "stop" });
      expect(btw.envelopes.map((envelope) => envelope.event)).toContainEqual(
        expect.objectContaining({ type: "tool_end", ok: false, errorCode: ErrorCodes.TOOL_DISABLED_IN_READ_ONLY }),
      );
      expect(btw.hostCalls).toEqual([]);
    } finally {
      await wire.close();
    }
  });

  it("rejects a second question while one runs, stops on abort, and frees the session", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wire = await wireProvider(["Done.", "Too late.", "Second answer."], (index) =>
      index === 1 ? gate : Promise.resolve(),
    );
    const main = mainRuntime("main-session");
    try {
      await main.runtime.prompt("Explain the build.", "user-1", "turn-user-1");
      const btw = btwHarness(async () => main.runtime);
      const arrived = wire.nextRequest();
      const first = btw.ask("run-3", "First?");
      await arrived;

      const busy = thrown(() =>
        btw.service.ask({ runId: "run-4", sessionId: "main-session", question: "Again?", history: [] }),
      );
      expect(busy).toMatchObject({ errorCode: ErrorCodes.BTW_BUSY });
      expect(btw.service.abort({ runId: "run-3" })).toEqual({ aborted: true });
      expect((await first).event).toEqual({ type: "done", stopReason: "aborted" });

      release();
      const second = await btw.ask("run-5", "Third?");
      expect(second.event).toEqual({ type: "done", stopReason: "stop" });
    } finally {
      release();
      await wire.close();
    }
  });

  it("rejects a malformed request before any work starts", () => {
    let created = false;
    const btw = btwHarness(async () => {
      created = true;
      throw new Error("unreachable");
    });
    const rejected = thrown(() =>
      btw.service.ask({ runId: "not a run id!", sessionId: "main-session", question: "Q?", history: [] }),
    );
    expect(rejected).toMatchObject({ errorCode: ErrorCodes.INVALID_ARGUMENT });
    expect(created).toBe(false);
    expect(btw.envelopes).toEqual([]);
  });

  it("reports a runtime that cannot be created as the run's error", async () => {
    const btw = btwHarness(async () => {
      throw Object.assign(new Error("model/provider not configured"), { errorCode: "MODEL_NOT_CONFIGURED" });
    });
    const end = await btw.ask("run-6", "Q?");
    expect(end.event).toMatchObject({ type: "error", error: { code: "MODEL_NOT_CONFIGURED" } });
    expect(btw.envelopes).toHaveLength(1);
  });

  it("fails closed when the main context cannot be copied", async () => {
    const btw = btwHarness(async () => ({
      sideQuestionSnapshot: () => {
        throw new DOMException("could not be cloned", "DataCloneError");
      },
    }));
    const end = await btw.ask("run-7", "Q?");
    expect(end.event).toMatchObject({ type: "error", error: { code: ErrorCodes.BTW_CONTEXT_UNAVAILABLE } });
  });
});
