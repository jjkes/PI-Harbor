/**
 * Pi 1.4.0 moved request identity into pi-ai: `User-Agent` and the provider
 * attribution headers now come from a `ClientIdentity` and are merged below
 * `Model.headers` and per-request headers. Desktop keeps its own identity, so
 * this contract pins the merge order that keeps `x-opencode-client`,
 * `x-opencode-session`, and Desktop's `User-Agent` authoritative, and pins
 * that a request without an identity carries no attribution at all.
 */
import { PI_ATTRIBUTION, normalizeContext } from "@earendil-works/pi-ai";
import type { Model, StreamOptions } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import type { Agent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { DesktopAgentRuntime } from "./runtime.js";

const model = {
  id: "glm-5.3-flash",
  name: "GLM-5.3-Flash",
  api: "openai-completions",
  provider: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as Model<"openai-completions">;

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

function reply(): Response {
  return new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function requestHeaders(
  options: Omit<StreamOptions, "fetch">,
  target: Model<"openai-completions"> = model,
): Promise<Headers> {
  let captured: Headers | undefined;
  const events = stream(target, context, {
    apiKey: "sk-fixture",
    maxRetries: 0,
    ...options,
    fetch: async (_url, init) => {
      captured = new Headers(init?.headers);
      return reply();
    },
  });
  await events.result();
  if (!captured) throw new Error("The adapter never issued a request");
  return captured;
}

describe("Pi 1.4 client identity contracts through the adapter", () => {
  it("keeps Desktop's identity headers over pi-ai attribution defaults", async () => {
    const headers = await requestHeaders({
      identity: { attribution: PI_ATTRIBUTION },
      sessionId: "pi-ai-affinity",
      headers: {
        "x-opencode-client": "pi-harbor",
        "x-opencode-session": "desktop-session",
        "User-Agent": "pi-harbor/0.0.0",
      },
    });
    expect(headers.get("x-opencode-client")).toBe("pi-harbor");
    expect(headers.get("x-opencode-session")).toBe("desktop-session");
    expect(headers.get("user-agent")).toBe("pi-harbor/0.0.0");
  });

  it("leaves attribution off and uses pi-ai's own User-Agent without an identity", async () => {
    const headers = await requestHeaders({});
    expect(headers.get("x-opencode-client")).toBeNull();
    expect(headers.get("x-opencode-session")).toBeNull();
    expect(headers.get("user-agent")).toMatch(/^pi\/\d+\.\d+\.\d+ \(/);
  });

  it("keeps model-level headers above the identity defaults", async () => {
    const withModelHeaders = {
      ...model,
      headers: { "x-opencode-client": "model-level" },
    } as Model<"openai-completions">;
    const identityOptions = { identity: { attribution: PI_ATTRIBUTION } };
    expect((await requestHeaders(identityOptions, withModelHeaders)).get("x-opencode-client"))
      .toBe("model-level");
    expect(
      (await requestHeaders(
        { ...identityOptions, headers: { "x-opencode-client": "pi-harbor" } },
        withModelHeaders,
      )).get("x-opencode-client"),
    ).toBe("pi-harbor");
  });
});

type Request = {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
};

function toolReply(id: string, args: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {
    tool_calls: [{ index: 0, id, type: "function", function: { name: "Write", arguments: args } }],
  }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function finalReply(): Response {
  return new Response('data: {"choices":[{"index":0,"delta":{"content":"Saved."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
    headers: { "content-type": "text/event-stream" },
  });
}

function fixture() {
  const executions: unknown[] = [];
  const requests: Request[] = [];
  const runtime = new DesktopAgentRuntime({
    sessionId: "pi-1.4-fixture", mode: "agent", thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    provider: {
      id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "fixture",
      baseUrl: "http://localhost/v1", supportsReasoning: false, supportedThinkingLevels: ["off"],
    },
    host: {
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "tools.execute") {
          executions.push(params);
          return { ok: true, content: { path: "saved.txt", bytes: 6 } } as T;
        }
        return undefined as T;
      },
    },
    onEvent: () => {},
  });
  const agent = (runtime as unknown as { agent: Agent }).agent;
  const respond = (reply: (round: number) => Response) => {
    agent.streamFunction = (model, context) => stream(model as Model<"openai-completions">, context, {
      apiKey: "fixture", maxRetries: 0,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        if (requests.length > 3) throw new Error("Unexpected extra model request");
        return reply(requests.length);
      },
    });
  };
  return { runtime, executions, requests, respond, agent };
}

describe("Pi 1.4 tool-call contracts through Desktop", () => {
  it("rejects malformed final JSON before Host execution and accepts a corrected call", async () => {
    const { runtime, executions, requests, respond, agent } = fixture();
    const malformed = '{"path":"wrong.txt","content":"partial",';
    respond((round) => round === 1 ? toolReply("bad-call", malformed)
      : round === 2 ? toolReply("good-call", '{"path":"saved.txt","content":"ready"}')
      : finalReply());
    try {
      await runtime.prompt("Save the file.", "user", "turn");
      expect(executions).toEqual([expect.objectContaining({
        toolName: "Write", args: { path: "saved.txt", content: "ready" },
      })]);
      const rejected = requests[1]?.messages.find((message) => message.role === "tool" && message.tool_call_id === "bad-call");
      expect(rejected?.content).toContain(malformed);
      expect(agent.state.messages.at(-1)).toMatchObject({
        role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Saved." }],
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps all fields when a tool string contains a literal invalid Unicode escape", async () => {
    const { runtime, executions, respond } = fixture();
    respond((round) => round === 1
      ? toolReply("latex-call", String.raw`{"content":"\usepackage{amsmath}","path":"saved.txt"}`)
      : finalReply());
    try {
      await runtime.prompt("Save the LaTeX file.", "user", "turn");
      expect(executions).toEqual([expect.objectContaining({
        toolName: "Write", args: { path: "saved.txt", content: String.raw`\usepackage{amsmath}` },
      })]);
    } finally {
      await runtime.dispose();
    }
  });
});
