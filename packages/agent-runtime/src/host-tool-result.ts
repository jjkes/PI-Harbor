/**
 * Model-visible content for a live host tool result.
 *
 * The session's tool executor and the read-only BTW executor (ADR 0344) turn a
 * host `tools.execute` result into the same text and image blocks, so a side
 * question sees a tool result exactly as the main session would.
 */

import { isRecord } from "./agent-messages.js";
import { hostContentBlockText } from "./tool-result-content.js";

export type HostToolImageBlock = { type: "image"; data: string; mimeType: string };

export type HostToolResultContent = {
  text: string;
  imageBlocks: HostToolImageBlock[];
  details: unknown;
};

/**
 * JSON text fallback for a host result that produced no text blocks. Image
 * `data` and resource `blob` bytes stay off the text channel; type, mimeType,
 * and uri remain so the model still sees what was attached.
 */
function withoutInlineBinary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => withoutInlineBinary(entry));
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "data" && value.type === "image") continue;
    if (key === "resource" && value.type === "resource" && isRecord(entry)) {
      const resource: Record<string, unknown> = {};
      for (const [resourceKey, resourceValue] of Object.entries(entry)) {
        if (resourceKey === "blob") continue;
        resource[resourceKey] = withoutInlineBinary(resourceValue);
      }
      next.resource = resource;
      continue;
    }
    next[key] = withoutInlineBinary(entry);
  }
  return next;
}

/**
 * Text, image blocks, and details for one host tool result. Image blocks are
 * kept only when the model accepts images (`vision`).
 */
export function hostToolResultContent(
  rawContent: unknown,
  vision: boolean,
): HostToolResultContent {
  const imageBlocks: HostToolImageBlock[] = [];
  let text: string;
  let details: unknown = rawContent;
  // Collect image blocks from a content-block array; only well-formed
  // image entries ({ type, data, mimeType }) are accepted.
  const collectImageBlocks = (blocks: unknown[]): void => {
    for (const block of blocks) {
      if (
        isRecord(block) &&
        block.type === "image" &&
        typeof block.data === "string" &&
        typeof block.mimeType === "string"
      ) {
        if (vision) {
          imageBlocks.push({
            type: "image",
            data: block.data,
            mimeType: block.mimeType,
          });
        }
      }
    }
  };
  if (typeof rawContent === "string") {
    text = rawContent;
  } else if (Array.isArray(rawContent)) {
    // Plugin tools may return a bare content-block array
    // ([{ type: "text" }, { type: "image" }]); render the text blocks
    // and hand images to the model instead of stringifying (#1360).
    const textParts: string[] = [];
    for (const block of rawContent) {
      const blockText = hostContentBlockText(block);
      if (blockText !== undefined) textParts.push(blockText);
    }
    collectImageBlocks(rawContent);
    text =
      textParts.join("\n") ||
      JSON.stringify(withoutInlineBinary(rawContent), null, 2);
    details = { blocks: rawContent, imageCount: imageBlocks.length };
  } else if (isRecord(rawContent) && Array.isArray(rawContent.content)) {
    // MCP tools return `content: [{ type: "image" | "text", ... }]`.
    const contentBlocks = rawContent.content;
    const textParts: string[] = [];
    for (const block of contentBlocks) {
      const blockText = hostContentBlockText(block);
      if (blockText !== undefined) textParts.push(blockText);
    }
    collectImageBlocks(contentBlocks);
    text =
      textParts.join("\n") ||
      JSON.stringify(withoutInlineBinary(rawContent), null, 2);
    details = { ...rawContent, imageCount: imageBlocks.length };
  } else if (isRecord(rawContent) && Array.isArray(rawContent.images)) {
    text =
      typeof rawContent.text === "string"
        ? rawContent.text
        : JSON.stringify(
            { ...rawContent, images: undefined },
            null,
            2,
          );
    for (const image of rawContent.images) {
      if (
        !isRecord(image) ||
        typeof image.data !== "string" ||
        typeof image.mimeType !== "string"
      ) {
        continue;
      }
      if (vision) {
        imageBlocks.push({
          type: "image",
          data: image.data,
          mimeType: image.mimeType,
        });
      }
    }
    const { images: _images, ...rest } = rawContent;
    details = {
      ...rest,
      ...(typeof rawContent.path === "string" ? { path: rawContent.path } : {}),
      imageCount: imageBlocks.length,
    };
  } else {
    text = JSON.stringify(rawContent, null, 2);
  }
  return { text, imageBlocks, details };
}
