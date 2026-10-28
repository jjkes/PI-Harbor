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
import { describe, expect, it } from "vitest";

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
