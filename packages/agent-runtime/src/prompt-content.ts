/**
 * The user prompt as the model receives it: prompt and attachment types, the
 * text with referenced conversations appended, and inline image placement.
 * Shared by live prompts and by restoring persisted user rows.
 */
import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";
import {
  splitInlineContent,
  type AgentPromptAttachment,
  type MessageAttachment,
  type SessionMessageOrigin,
} from "@pi-harbor/shared";

export type RuntimePromptAttachment = Omit<AgentPromptAttachment, "kind"> & {
  /**
   * `session` is written by Electron main for a resolved
   * `pi-harbor://session/<id>` reference; the renderer never sends it.
   */
  kind: AgentPromptAttachment["kind"] | "session";
  /** Base64 payload is transient and only crosses the sidecar for this turn. */
  data?: string;
  /** Bounded excerpt of a referenced conversation (`kind: "session"`). */
  text?: string;
};

export type RuntimePrompt = {
  text: string;
  /** Explicit user selection, resolved against the host-provided tool catalog. */
  mcpServerIds?: string[];
  mcpToolNames?: string[];
  sessionMessage?: SessionMessageOrigin;
  attachments?: RuntimePromptAttachment[];
};

/**
 * The user's own words plus one quoted block per referenced conversation. The
 * visible prompt is never rewritten: references are additive, and the model
 * must receive this text — a reference accounted for by compaction but absent
 * from the provider request would be context the user never got.
 */
function promptText(input: RuntimePrompt): string {
  const references = (input.attachments ?? [])
    .map((attachment) => sessionReferenceBlock(attachment))
    .filter((block): block is string => block !== null);
  return references.length
    ? `${input.text}\n\n${references.join("\n\n")}`.trim()
    : input.text;
}

/** One provider image block for an attachment whose bytes crossed this turn. */
function promptImageBlock(attachment: RuntimePromptAttachment): ImageContent {
  return {
    type: "image" as const,
    data: attachment.data!,
    mimeType: attachment.mimeType || "image/png",
  };
}

/** Attachments carrying image bytes this call may inline for the model. */
function promptImages(input: RuntimePrompt): RuntimePromptAttachment[] {
  return (input.attachments ?? []).filter(
    (attachment) =>
      attachment.kind === "image" &&
      typeof attachment.data === "string" &&
      attachment.data.length > 0,
  );
}

/**
 * The prompt the model receives. An image the user placed between words carries
 * the `@path` the Composer serialized, so it becomes a block at that position
 * instead of following every text block (the pre-placement behavior, which is
 * still what an image without an `inlinePath` gets).
 */
export function promptContent(input: string | RuntimePrompt): UserMessage["content"] {
  if (typeof input === "string") return input;
  const text = promptText(input);
  const images = promptImages(input);
  if (!images.length) return text;
  const { parts, trailing } = splitInlineContent(text, images);
  const blocks: Array<{ type: "text"; text: string } | ImageContent> = parts.flatMap(
    (part): Array<{ type: "text"; text: string } | ImageContent> =>
      part.kind === "text"
        ? part.text
          ? [{ type: "text" as const, text: part.text }]
          : []
        : [promptImageBlock(part.attachment)],
  );
  blocks.push(...trailing.map(promptImageBlock));
  return blocks;
}

export function runtimeAttachmentFromMessage(
  attachment: MessageAttachment,
  data?: string,
): RuntimePromptAttachment {
  return {
    path: attachment.ref,
    name: attachment.name,
    kind: attachment.kind,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    ...(attachment.text ? { text: attachment.text } : {}),
    // Recorded placement: the message content names this image at that spot, so
    // the restored prompt keeps the block there too.
    ...(attachment.inlinePath ? { inlinePath: attachment.inlinePath } : {}),
    ...(data ? { data } : {}),
  };
}

/** Attribute-safe text: a session title may contain quotes or angle brackets. */
function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * A referenced conversation travels with the user's message as one delimited
 * block: it is quoted context, not the user's own words (a session link in the
 * draft produced it), so the model reads it as reference material.
 */
export function sessionReferenceBlock(attachment: RuntimePromptAttachment): string | null {
  const text = attachment.text?.trim();
  if (!text) return null;
  const title = escapeAttribute(attachment.name || attachment.path);
  return `<session_reference name="${title}" session="${escapeAttribute(attachment.path)}">\n${text}\n</session_reference>`;
}
