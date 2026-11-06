import { getCurrentSystemPrompt, getCurrentTools, type SystemMessage } from "@earendil-works/pi-ai";
import type { ContextCompactionRecord, SessionContextTool, UiMessage } from "@pi-harbor/shared";
import { projectHistoryContextEntries } from "./history-projection.js";
import { readSystemMessage } from "./system-transcript-journal.js";

/** The system prompt and tool declarations a session's last model request carried. */
export type ReplayedSystemContext = {
  systemPrompt: string;
  tools: SessionContextTool[];
  /** ISO time of the newest system state the replay used. */
  updatedAt: string;
};

/** The parts of a compaction checkpoint the replay reads. */
export type SystemContextCheckpoint = Pick<ContextCompactionRecord, "throughMessageId" | "createdAt" | "details">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Replay a session's durable transcript into the system state its last model
 * request carried, for read-only inspection.
 *
 * The entry layout comes from `projectHistoryContextEntries`, the projection
 * the runtime restores a session through, so the replay keeps exactly the
 * entries the runtime keeps, in its order, with its synthetic carrier ids.
 * The latest checkpoint applies only when its `throughMessageId` names one of
 * those entries; it then discards everything up to that anchor, and its folded
 * `systemMessageJson`, when it has one, stands in for the discarded system
 * rows. Its retained tail never carries system messages. pi-ai then folds the
 * remaining system messages exactly as a request does.
 *
 * One input differs from the runtime's: before it restores a session the
 * sidecar re-hydrates each persisted attachment, adding image bytes or a file
 * path it appends to the row's text. The Host stores none of that, so a user
 * row whose text exists only because of it is not an entry here. A checkpoint
 * anchored on one (an attachment-only prompt) is the one case this replay can
 * place differently.
 *
 * A malformed row throws, as it does when the runtime restores the session; a
 * partial fold would misstate what the model saw. Returns null when no system
 * state is recorded: a fresh session, or one whose record predates it.
 */
export function replaySessionSystemContext(
  history: readonly UiMessage[],
  compaction?: SystemContextCheckpoint | null,
): ReplayedSystemContext | null {
  const entries = projectHistoryContextEntries(history, (row) => readSystemMessage(row.modelSystem?.messageJson));
  const messages: SystemMessage[] = [];
  let updatedAt: string | undefined;
  let start = 0;
  if (compaction) {
    const anchor = entries.findIndex((entry) => entry.id === compaction.throughMessageId);
    if (anchor >= 0) {
      start = anchor + 1;
      const checkpointJson = isRecord(compaction.details) ? compaction.details.systemMessageJson : undefined;
      if (checkpointJson !== undefined) {
        messages.push(readSystemMessage(checkpointJson));
        updatedAt = compaction.createdAt;
      }
    }
  }
  for (const entry of entries.slice(start)) {
    if (!entry.system) continue;
    messages.push(entry.system.message);
    updatedAt = entry.system.createdAt;
  }
  if (messages.length === 0 || updatedAt === undefined) return null;
  return {
    systemPrompt: getCurrentSystemPrompt(messages),
    tools: getCurrentTools(messages).map((tool) => ({
      name: tool.name,
      description: tool.description,
      // `readSystemMessage` validated the declarations as JSON objects.
      parameters: tool.parameters as Record<string, unknown>,
      ...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
    })),
    updatedAt,
  };
}
