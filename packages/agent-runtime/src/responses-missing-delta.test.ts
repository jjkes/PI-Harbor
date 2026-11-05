/**
 * Regression for the Pi 1.5.0 rebase of the pi-ai patch. Pi 1.5.0 streams
 * Responses function-call arguments through `ToolCallArgumentsStream`, whose
 * `append(undefined)` throws. The PI-Desktop patch keeps its 1.4.0 guard, so a
 * proxy that omits `delta` on `response.function_call_arguments.delta` still
 * completes the turn with the call's final arguments instead of failing the
 * whole stream.
 */
import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";

const model: Model<"openai-responses"> = {
  id: "responses-test",
  name: "Responses Test",
  api: "openai-responses",
  provider: "acme",
  baseUrl: "https://api.acme.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

const context = {
  messages: [
    { role: "system", content: "", timestamp: Date.now() },
    { role: "user", content: "read the file", timestamp: Date.now() },
  ],
};

const functionCall = {
  id: "fc_1",
  type: "function_call",
  call_id: "call_1",
  name: "Read",
  arguments: "",
  status: "in_progress",
};

function sseBody(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}

describe("OpenAI Responses function-call deltas without a delta field", () => {
  it("keeps streaming and finishes the tool call from the done item", async () => {
    const finalArguments = JSON.stringify({ path: "README.md" });
    const body = sseBody([
      { type: "response.created", sequence_number: 0, response: { id: "resp_1" } },
      { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: functionCall },
      // A non-conforming proxy drops `delta` from this event.
      { type: "response.function_call_arguments.delta", sequence_number: 2, output_index: 0, item_id: "fc_1" },
      {
        type: "response.output_item.done",
        sequence_number: 3,
        output_index: 0,
        item: { ...functionCall, arguments: finalArguments, status: "completed" },
      },
      {
        type: "response.completed",
        sequence_number: 4,
        response: {
          object: "response",
          id: "resp_1",
          created_at: 1,
          model: "responses-test",
          output: [{ ...functionCall, arguments: finalArguments, status: "completed" }],
          status: "completed",
          usage: {
            input_tokens: 5,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 3,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 8,
          },
        },
      },
    ]);
    const fetchImpl = async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

    const events = stream(model, context as never, { apiKey: "sk-test", fetch: fetchImpl as never });
    const result = await events.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.errorMessage).toBeUndefined();
    const toolCall = result.content.find((block) => block.type === "toolCall");
    expect(toolCall).toMatchObject({ name: "Read", arguments: { path: "README.md" } });
  });
});
