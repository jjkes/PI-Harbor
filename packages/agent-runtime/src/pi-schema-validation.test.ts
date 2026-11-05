/**
 * Pi 1.5.0 moved tool argument validation to `@earendil-works/pi-schema`.
 * `validateToolArguments` now coerces plain JSON Schema the same way it coerced
 * TypeBox schemas before (numeric strings become numbers, a single value wraps
 * into an array), and validation failures use pi-schema's message format
 * instead of TypeBox's. These contracts pin the behavior Desktop's fixed tools,
 * MCP tools, and extension tools all rely on.
 */
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

function toolWith(parameters: unknown): AgentTool {
  return { name: "fx", description: "fx", parameters } as unknown as AgentTool;
}

function call(args: ToolCall["arguments"]): ToolCall {
  return { id: "c1", name: "fx", type: "toolCall", arguments: args };
}

describe("pi-schema tool argument validation (Pi 1.5.0)", () => {
  it("coerces numeric strings and single values for plain JSON Schema tools", () => {
    const tool = toolWith({
      type: "object",
      properties: {
        limit: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["limit"],
    });
    const args = validateToolArguments(tool, call({ limit: "42", tags: "one" }));
    expect(args).toEqual({ limit: 42, tags: ["one"] });
  });

  it("coerces TypeBox-built schemas the same way", () => {
    const tool = toolWith(Type.Object({ limit: Type.Number(), tag: Type.Optional(Type.String()) }));
    const args = validateToolArguments(tool, call({ limit: "7" }));
    expect(args).toEqual({ limit: 7 });
  });

  it("reports pi-schema style validation errors", () => {
    const tool = toolWith({
      type: "object",
      properties: { limit: { type: "number" } },
      required: ["limit"],
    });
    expect(() => validateToolArguments(tool, call({ limit: "not-a-number" }))).toThrowError(
      /expected number|limit/i,
    );
  });

  it("keeps a dangling $ref local to its own value instead of failing the whole call", () => {
    const tool = toolWith({
      type: "object",
      properties: { data: { $ref: "#/definitions/missing" } },
    });
    // No required properties: an object without `data` still validates.
    expect(validateToolArguments(tool, call({}))).toEqual({});
  });
});
