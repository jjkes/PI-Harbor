/**
 * The generated images a session's transcript already holds.
 *
 * Images are produced by the agent's `GenerateImages` tool, so this is a read of
 * the tool rows rather than a second image pipeline: the work-panel gallery and
 * anything else that needs the session's outputs derive them the same way.
 */
import type { UiMessage } from "@pi-harbor/shared";
import type { GeneratedImageRef } from "../features/chat/transcript/GeneratedImageThumbnail";
import { toolResultPayload } from "./tool-presentation";

export type GeneratedSessionImage = GeneratedImageRef & {
  /** The prompt that asked for this batch, when the call carried one. */
  prompt: string;
  /** Stable list key: one call may produce several images at the same index. */
  key: string;
};

/** The first prompt of a `GenerateImages` call, which is what the batch was for. */
function promptOf(message: UiMessage): string {
  const args = message.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const items = (args as { items?: unknown }).items;
  if (!Array.isArray(items)) return "";
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const prompt = (item as { prompt?: unknown }).prompt;
    if (typeof prompt === "string" && prompt.trim()) return prompt.trim();
  }
  return "";
}

/**
 * Every succeeded image this session generated, in transcript order.
 *
 * A failed result is dropped rather than drawn as a broken tile: its error is
 * already reported in the turn that produced it, with the code that says why.
 */
export function generatedSessionImages(
  messages: readonly UiMessage[],
): GeneratedSessionImage[] {
  const images: GeneratedSessionImage[] = [];
  for (const message of messages) {
    if (message.toolName !== "GenerateImages") continue;
    const payload = toolResultPayload(message);
    if (!payload || typeof payload !== "object") continue;
    const record = payload as Record<string, unknown>;
    if (record.kind !== "generated-images" || !Array.isArray(record.results)) continue;
    const prompt = promptOf(message);
    record.results.forEach((raw, index) => {
      if (!raw || typeof raw !== "object") return;
      const item = raw as Record<string, unknown>;
      if (item.status !== "succeeded" || typeof item.path !== "string") return;
      images.push({
        path: item.path,
        index,
        ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
        prompt,
        key: `${message.id}:${index}`,
      });
    });
  }
  return images;
}

/**
 * The transcript's images followed by the ones the panel itself asked for.
 *
 * The transcript is the record of what the agent produced, so it comes first;
 * a panel run that lands on a path the transcript already holds is the same
 * image and is not listed twice. Everything else keeps its own order.
 */
export function mergeGeneratedImages(
  transcriptImages: readonly GeneratedSessionImage[],
  generatedImages: readonly GeneratedSessionImage[],
): GeneratedSessionImage[] {
  const merged = [...transcriptImages];
  const seen = new Set(transcriptImages.map((image) => image.path));
  for (const image of generatedImages) {
    if (seen.has(image.path)) continue;
    seen.add(image.path);
    merged.push(image);
  }
  return merged;
}

/**
 * The images a renderer-requested batch returned, as gallery entries.
 *
 * The result is the image tool's own content, passed back untouched, so the
 * read is the same one `generatedSessionImages` does for a tool row: succeeded
 * outputs with a real path become tiles, and a batch with none becomes nothing.
 * A panel run has no tool row behind it, so the tile keys off the path.
 */
export function generatedImagesFromResult(
  content: unknown,
  prompt: string,
): GeneratedSessionImage[] {
  if (!content || typeof content !== "object" || Array.isArray(content)) return [];
  const record = content as Record<string, unknown>;
  if (record.kind !== "generated-images" || !Array.isArray(record.results)) return [];
  const images: GeneratedSessionImage[] = [];
  record.results.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const item = raw as Record<string, unknown>;
    if (item.status !== "succeeded" || typeof item.path !== "string") return;
    images.push({
      path: item.path,
      index,
      ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
      prompt,
      key: `generated:${item.path}`,
    });
  });
  return images;
}
