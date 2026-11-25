import { describe, expect, it } from "vitest";
import { ORPHAN_TOOL_OUTPUT, repairOrphanToolCalls, withToolPairingOptions } from "./tool-pairing.js";

const call = (id: string) => ({ type: "function_call", id: `fc_${id}`, call_id: id, name: "Bash", arguments: "{}" });
const output = (id: string) => ({ type: "function_call_output", call_id: id, output: "ok" });

describe("repairOrphanToolCalls (Responses)", () => {
  it("answers a call whose result never landed", () => {
    // The exact shape the gateway rejects: assistant(tool_calls) then nothing.
    const payload = { model: "m", input: [{ role: "user", content: "hi" }, call("Bash:374"), call("Bash:375")] };
    const repaired = repairOrphanToolCalls(payload) as { input: unknown[] };
    expect(repaired.input).toEqual([
      { role: "user", content: "hi" },
      call("Bash:374"),
      { type: "function_call_output", call_id: "Bash:374", output: ORPHAN_TOOL_OUTPUT },
      call("Bash:375"),
      { type: "function_call_output", call_id: "Bash:375", output: ORPHAN_TOOL_OUTPUT },
    ]);
  });

  it("leaves a fully paired input untouched, including its identity", () => {
    const payload = { input: [call("a"), output("a"), { role: "user", content: "next" }] };
    expect(repairOrphanToolCalls(payload)).toBe(payload);
  });

  it("only fills the call that is missing a result", () => {
    const payload = { input: [call("a"), output("a"), call("b")] };
    const repaired = repairOrphanToolCalls(payload) as { input: unknown[] };
    expect(repaired.input.filter((item) => (item as { type?: string }).type === "function_call_output"))
      .toEqual([output("a"), { type: "function_call_output", call_id: "b", output: ORPHAN_TOOL_OUTPUT }]);
  });

  it("pulls a result that preceded its call to sit right after it", () => {
    const payload = { input: [output("a"), call("a")] };
    const repaired = repairOrphanToolCalls(payload) as { input: unknown[] };
    expect(repaired.input).toEqual([call("a"), output("a")]);
  });

  it("moves an assistant message out from between a call and its result", () => {
    // Measured against CCH's upstream: a `message` item between the call and its
    // output splits the pair when the gateway folds the flat input into chat
    // messages, and the whole request is rejected. The output must come first.
    const between = { type: "message", role: "assistant", content: [{ type: "output_text", text: "running", annotations: [] }], status: "completed", id: "msg_running" };
    const payload = { input: [call("a"), between, output("a")] };
    const repaired = repairOrphanToolCalls(payload) as { input: unknown[] };
    expect(repaired.input).toEqual([call("a"), output("a"), between]);
  });

  it("drops an assistant message whose text is exactly empty", () => {
    // Measured: an empty `output_text` is a hard 400 ("text content is empty"),
    // while a single space is accepted. Only exact emptiness is dropped.
    const empty = { type: "message", role: "assistant", content: [{ type: "output_text", text: "", annotations: [] }], status: "completed", id: "msg_empty" };
    const payload = { input: [{ role: "user", content: "hi" }, empty, { role: "user", content: "go on" }] };
    const repaired = repairOrphanToolCalls(payload) as { input: unknown[] };
    expect(repaired.input).toEqual([{ role: "user", content: "hi" }, { role: "user", content: "go on" }]);
  });

  it("keeps a whitespace-only message, which the gateway accepts", () => {
    const space = { type: "message", role: "assistant", content: [{ type: "output_text", text: " ", annotations: [] }], status: "completed", id: "msg_space" };
    const payload = { input: [{ role: "user", content: "hi" }, space] };
    expect(repairOrphanToolCalls(payload)).toBe(payload);
  });

  it("drops an empty message and still keeps its tool pair adjacent", () => {
    const empty = { type: "message", role: "assistant", content: [{ type: "output_text", text: "", annotations: [] }], status: "completed", id: "msg_e" };
    const payload = { input: [{ role: "user", content: "hi" }, empty, call("a"), empty, output("a")] };
    const repaired = repairOrphanToolCalls(payload) as { input: unknown[] };
    expect(repaired.input).toEqual([{ role: "user", content: "hi" }, call("a"), output("a")]);
  });
});

describe("repairOrphanToolCalls (Chat Completions)", () => {
  it("inserts the tool message the assistant's tool_calls require", () => {
    const payload = {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [{ id: "Bash:1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
        { role: "user", content: "again" },
      ],
    };
    const repaired = repairOrphanToolCalls(payload) as { messages: unknown[] };
    expect(repaired.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "Bash:1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "Bash:1", content: ORPHAN_TOOL_OUTPUT },
      { role: "user", content: "again" },
    ]);
  });

  it("leaves a paired conversation untouched", () => {
    const payload = {
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "Bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "a", content: "ok" },
      ],
    };
    expect(repairOrphanToolCalls(payload)).toBe(payload);
  });
});

describe("repairOrphanToolCalls (other payloads)", () => {
  it("returns anything that is not a request body unchanged", () => {
    for (const value of [null, undefined, 42, "text", [], { model: "m" }]) {
      expect(repairOrphanToolCalls(value)).toBe(value);
    }
  });
});

describe("withToolPairingOptions", () => {
  it("repairs after the caller's own hook, even when it replaced the payload", async () => {
    const replaced = { input: [{ type: "function_call", call_id: "Bash:9", name: "Bash", arguments: "{}" }] };
    const options = withToolPairingOptions({ onPayload: async () => replaced } as never);
    const result = (await options.onPayload?.({ input: [] }, {} as never)) as { input: unknown[] };
    expect(result.input).toHaveLength(2);
    expect(result.input[1]).toEqual({ type: "function_call_output", call_id: "Bash:9", output: ORPHAN_TOOL_OUTPUT });
  });

  it("passes a payload with nothing to repair straight through", async () => {
    const payload = { input: [{ role: "user", content: "hi" }] };
    const options = withToolPairingOptions({} as never);
    expect(await options.onPayload?.(payload, {} as never)).toBe(payload);
  });
});
