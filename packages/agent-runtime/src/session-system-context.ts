import {
  getCurrentSystemPrompt,
  getCurrentTools,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import type { ContextCompactionRecord, SessionContextTool, UiMessage } from "@pi-harbor/shared";
import { orderSystemRows, readSystemMessage } from "./system-transcript-journal.js";

/** The system prompt and tool declarations a session's last model request carried. */
export type ReplayedSystemContext = {
  systemPrompt: string;
  tools: SessionContextTool[];
  /** ISO time of the newest system state the replay used. */
  updatedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a restored row becomes a context entry a checkpoint can anchor on.
 * Mirrors the skip rules of `DesktopAgentRuntime.historyToEntries`; an anchor
 * the runtime drops makes it ignore the checkpoint, so the replay must too.
 * The runtime also drops an assistant whose replayed content ends up empty,
 * which depends on the provider binding and is not reproduced here.
 */
function isContextRow(row: UiMessage): boolean {
  switch (row.role) {
    case "system":
      return Boolean(row.modelSystem);
    case "user":
      return Boolean(row.content?.trim()) || (row.attachments ?? []).some((attachment) => attachment.data);
    case "assistant":
      return !(row.status === "error" || row.isError || row.error);
    case "tool":
      return Boolean(row.toolCallId && row.toolName);
    default:
      return false;
  }
}

/**
 * Replay a session's durable transcript into the system state its last model
 * request carried, for read-only inspection.
 *
 * It follows the runtime's restore order for system state: `orderSystemRows`
 * places the hidden rows, subagent rows never reach the parent's context, and
 * the latest compaction checkpoint whose `throughMessageId` names a surviving
 * entry discards everything up to that anchor. The checkpoint's folded
 * `systemMessageJson`, when it has one, stands in for the discarded system
 * rows; its retained tail never carries system messages. pi-ai then folds the
 * remaining system messages exactly as a request does.
 *
 * A malformed row throws, as it does when the runtime restores the session; a
 * partial fold would misstate what the model saw. Returns null when no system
 * state is recorded: a fresh session, or one whose record predates it.
 */
export function replaySessionSystemContext(
  history: readonly UiMessage[],
  compaction?: ContextCompactionRecord | null,
): ReplayedSystemContext | null {
  const rows = orderSystemRows(history).filter((row) => !row.parentToolCallId && isContextRow(row));
  const messages: SystemMessage[] = [];
  let updatedAt: string | undefined;
  let start = 0;
  if (compaction) {
    // A tool row restored without its assistant gets a synthetic carrier
    // entry; the checkpoint may name that carrier instead of the row.
    const anchor = rows.findIndex((row) =>
      row.id === compaction.throughMessageId || `${row.id}:carrier` === compaction.throughMessageId,
    );
    if (anchor >= 0) {
      start = anchor + 1;
      const checkpointJson = isRecord(compaction.details) ? compaction.details.systemMessageJson : undefined;
      if (checkpointJson !== undefined) {
        messages.push(readSystemMessage(checkpointJson));
        updatedAt = compaction.createdAt;
      }
    }
  }
  for (const row of rows.slice(start)) {
    if (row.role !== "system" || !row.modelSystem) continue;
    messages.push(readSystemMessage(row.modelSystem.messageJson));
    updatedAt = row.createdAt;
  }
  if (messages.length === 0 || updatedAt === undefined) return null;
  return {
    systemPrompt: getCurrentSystemPrompt(messages),
    tools: getCurrentTools(messages).map((tool) => ({
      name: tool.name,
      description: tool.description,
      // `readSystemMessage` validated the declarations as JSON objects.
      parameters: tool.parameters as Record<string, unknown>,
    })),
    updatedAt,
  };
}
