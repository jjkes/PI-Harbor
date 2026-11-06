import { describe, expect, it } from "vitest";
import { hostToolResultContent } from "./host-tool-result.js";

describe("hostToolResultContent", () => {
  it("passes plain text through", () => {
    expect(hostToolResultContent("line one", false)).toEqual({
      text: "line one",
      imageBlocks: [],
      details: "line one",
    });
  });

  it("renders text blocks and keeps images only for vision models", () => {
    const blocks = [
      { type: "text", text: "caption" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ];
    expect(hostToolResultContent(blocks, false)).toEqual({
      text: "caption",
      imageBlocks: [],
      details: { blocks, imageCount: 0 },
    });
    expect(hostToolResultContent(blocks, true).imageBlocks).toEqual([
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
  });

  it("falls back to JSON without inline bytes for MCP content without text", () => {
    const raw = { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] };
    const result = hostToolResultContent(raw, false);
    expect(result.text).toContain("image/png");
    expect(result.text).not.toContain("AAAA");
    expect(result.details).toEqual({ ...raw, imageCount: 0 });
  });

  it("uses the text of an image result and keeps the bytes out of details", () => {
    const raw = {
      path: "shot.png",
      text: "1 image",
      images: [{ data: "AAAA", mimeType: "image/png" }],
    };
    expect(hostToolResultContent(raw, true)).toEqual({
      text: "1 image",
      imageBlocks: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      details: { path: "shot.png", text: "1 image", imageCount: 1 },
    });
  });

  it("stringifies any other shape", () => {
    expect(hostToolResultContent({ files: ["a.ts"] }, false).text).toBe(
      JSON.stringify({ files: ["a.ts"] }, null, 2),
    );
  });
});
