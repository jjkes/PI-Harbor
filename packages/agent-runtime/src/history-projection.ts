/**
 * Rebuild pi-ai context entries from a persisted transcript.
 *
 * `DesktopAgentRuntime` restores a session through `projectHistoryEntries`,
 * and the read-only context viewer replays the same entry layout through
 * `projectHistoryContextEntries`, so the two can never disagree about which
 * rows survive, in what order, and which synthetic carrier ids exist. Which
 * entries survive does not depend on the binding: it only labels assistant
 * metadata and signs DeepSeek thinking.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, SystemMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  formatSessionMessage,
  withoutReasoningReplayPlaceholder,
  type UiMessage,
} from "@pi-harbor/shared";
import { isRecord, timestampMs, toJsonObject, toJsonValue, usageToPi } from "./agent-messages.js";
import { providerReplayToolCallSignatures, restoreAssistantProviderReplay } from "./assistant-provider-replay.js";
import { restoreHostedSearchReplay } from "./hosted-search-replay.js";
import type { MessageEntry } from "./pi-runtime-types.js";
import { promptContent, runtimeAttachmentFromMessage } from "./prompt-content.js";
import { orderSystemRows } from "./system-transcript-journal.js";
import { restoredToolResultContent } from "./tool-result-content.js";

/** What the projection needs from the runtime's provider binding. */
export type HistoryProjectionBinding = Readonly<{
  api: Api;
  /** The local provider account id, to tell account switches apart. */
  accountProviderId: string;
  /** The bound model's vendor identity and id, for restored assistants. */
  modelProvider: string;
  modelId: string;
  /** DeepSeek-style completions replay thinking as `reasoning_content`. */
  requiresReasoningContentOnAssistantMessages: boolean;
}>;

export const TOOL_SEARCH_NAME = "ToolSearch";
/** Stands in for a persisted tool row that never recorded a result. */
export const MISSING_TOOL_RESULT_PLACEHOLDER = "[no tool result recorded]";

function toolNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (name: unknown): name is string =>
          typeof name === "string" && name.length > 0,
      ),
    ),
  ];
}

/** Read canonical and historical activation markers from a ToolSearch row. */
export function toolSearchActivatedNames(
  details: unknown,
  legacyAddedToolNames?: unknown,
): string[] {
  const record = isRecord(details) ? details : undefined;
  const candidates = [
    record?.addedToolNames,
    record?.activated,
    legacyAddedToolNames,
  ];
  for (const candidate of candidates) {
    const names = toolNameList(candidate);
    if (names.length > 0) return names;
  }
  return [];
}

export function isMissingToolResultPlaceholder(
  content: ToolResultMessage["content"],
): boolean {
  return (
    content.length === 1 &&
    content[0].type === "text" &&
    content[0].text === MISSING_TOOL_RESULT_PLACEHOLDER
  );
}

/** Rebuild a pi-ai tool result from a persisted tool row. Rows that never
 * finished (app quit / abort mid-tool) restore as errored results so the
 * model knows the call produced nothing. Exported for tests. */
export function toolResultFromUi(
  m: UiMessage,
  timestamp: number,
): ToolResultMessage {
  const raw: unknown = m.toolResult;
  const blocks = restoredToolResultContent(raw);
  const interrupted = m.toolStatus === "running";
  const rawRecord: Record<string, unknown> | undefined = isRecord(raw)
    ? raw
    : undefined;
  const rawAddedToolNames = rawRecord?.addedToolNames;
  const addedToolNames =
    m.toolName === TOOL_SEARCH_NAME
      ? toolSearchActivatedNames(rawRecord?.details, rawAddedToolNames)
      : toolNameList(rawAddedToolNames);
  if (blocks.length === 0) {
    blocks.push({
      type: "text",
      text: interrupted
        ? "[tool call was interrupted before a result was recorded]"
        : MISSING_TOOL_RESULT_PLACEHOLDER,
    });
  }
  return {
    role: "toolResult",
    toolCallId: m.toolCallId ?? "",
    toolName: m.toolName ?? "",
    content: blocks,
    ...(toJsonValue(rawRecord?.details) !== undefined || addedToolNames.length > 0
      ? {
          details: {
            ...toJsonObject(rawRecord?.details),
            ...(addedToolNames.length > 0 ? { addedToolNames } : {}),
          },
        }
      : {}),
    isError:
      interrupted ||
      m.toolStatus === "error" ||
      m.toolStatus === "denied" ||
      m.isError === true,
    timestamp,
  };
}

/* Rebuild pi-ai messages from the persisted transcript, including tool
 * call/result pairs and hosted-search replay blocks. Tool rows persist
 * toolCallId/toolName/toolArgs and the result (including deferred-tool
 * activation markers). Hosted search persists the adapter's raw content
 * parts on `hostedSearch.replay` so Anthropic/Responses can ground later
 * turns after a restart. Losing either (the pre-D120 tool behavior)
 * collapsed a reseeded session to bare chat text. Failed assistant turns
 * stay transcript-only. */
export function projectHistoryEntries(
  history: readonly UiMessage[],
  binding: HistoryProjectionBinding,
  restoreSystem: (row: UiMessage) => SystemMessage,
): MessageEntry[] {
  const api = binding.api;
  const deepSeekCompletionsReplay = binding.requiresReasoningContentOnAssistantMessages;
  const entries: MessageEntry[] = [];
  const append = (id: string, message: AgentMessage): MessageEntry => {
    const entry: MessageEntry = {
      type: "message",
      id,
      seq: entries.length,
      parentId: entries.at(-1)?.id ?? null,
      timestamp: timestampMs(message.timestamp),
      message,
    };
    entries.push(entry);
    return entry;
  };
  // Tool rows attach their calls to the assistant message that made them
  // (the nearest one above), keeping each call adjacent to its result as
  // the provider APIs require.
  let toolCarrier: AssistantMessage | undefined;
  // Function-call signatures of the carrier's row, restored by call id.
  let carrierToolSignatures = new Map<string, string>();
  for (const m of orderSystemRows(history)) {
    // Subagent rows belong to the transcript and to review, never to the
    // parent's model context (ADR 0062): the parent only ever saw the `Task`
    // report, and replaying a delegate's messages would both contradict that
    // and reintroduce the context cost delegation exists to avoid.
    if (m.parentToolCallId) continue;
    const timestamp = Date.parse(m.createdAt) || Date.now();
    if (m.role === "system" && m.modelSystem) {
      // An update recorded while a tool ran sits between the call and its
      // result. It keeps the carrier: Pi holds the update until the results
      // are written, which is the shape the live request had.
      append(m.id, restoreSystem(m));
    } else if (m.role === "user") {
      toolCarrier = undefined;
      const attachments = (m.attachments ?? []).map((attachment) =>
        runtimeAttachmentFromMessage(
          attachment,
          attachment.data,
        ),
      );
      const content = promptContent({
        text: m.sessionMessage ? formatSessionMessage(m.content, m.sessionMessage) : m.content,
        attachments,
      });
      if (
        !(m.content || "").trim() &&
        !attachments.some((attachment) => attachment.data)
      ) {
        continue;
      }
      append(m.id, { role: "user", content, timestamp });
    } else if (m.role === "assistant") {
      toolCarrier = undefined;
      // Failed provider responses belong in the transcript for diagnosis,
      // but must never become model context on the next turn.
      if (m.status === "error" || m.isError || m.error) continue;
      const content: AssistantMessage["content"] = [];
      // A replay placeholder the model echoed is not its reasoning; sending
      // it back is what kept the model continuing it (#1945).
      const rawThinking = m.thinking ?? "";
      const thinking = withoutReasoningReplayPlaceholder(rawThinking);
      // Signed blocks restore the request the live runtime sent, so a
      // rebuild keeps the provider's prompt cache (#1972). Rows that were
      // cleaned above, or whose text no longer matches, keep the plain path.
      const replayed = thinking === rawThinking
        ? restoreAssistantProviderReplay(m.providerReplay, rawThinking, m.content ?? "")
        : undefined;
      if (replayed) {
        const firstText = replayed.findIndex((block) => block.type === "text");
        const hosted = restoreHostedSearchReplay(m.hostedSearch);
        if (firstText < 0) content.push(...replayed, ...hosted);
        else content.push(...replayed.slice(0, firstText), ...hosted, ...replayed.slice(firstText));
      } else {
        if (thinking.trim()) {
          // Completions DeepSeek replay needs thinkingSignature so convertMessages
          // maps the block to reasoning_content instead of dropping it (#296).
          content.push({
            type: "thinking" as const,
            thinking,
            ...(deepSeekCompletionsReplay
              ? { thinkingSignature: "reasoning_content" as const }
              : {}),
          });
        }
        content.push(...restoreHostedSearchReplay(m.hostedSearch));
        if (m.content?.trim()) {
          content.push({ type: "text" as const, text: m.content });
        }
      }
      // Kept even when empty: a call-only turn has no text of its own and
      // becomes the carrier for the tool rows that follow. Assistants that
      // end up with no content and no calls are dropped at the end.
      const assistant: AssistantMessage = {
        role: "assistant",
        content,
        api,
        // Persisted providerId identifies a local account; Pi compares its
        // vendor identity to decide whether native thinking can be replayed.
        // Keep known account/model switches distinct; legacy rows have no
        // source identity and retain the existing current-model fallback.
        provider: !m.providerId || m.providerId === binding.accountProviderId
          ? binding.modelProvider : m.providerId,
        model: m.modelId || binding.modelId,
        usage: usageToPi(m.usage),
        stopReason: "stop",
        timestamp,
      };
      append(m.id, assistant);
      toolCarrier = assistant;
      carrierToolSignatures = providerReplayToolCallSignatures(m.providerReplay);
    } else if (m.role === "tool") {
      if (!m.toolCallId || !m.toolName) continue;
      if (!toolCarrier) {
        // Tool row whose assistant row was lost (truncated branch):
        // synthesize a carrier so the call/result pair stays well-formed.
        toolCarrier = {
          role: "assistant",
          content: [],
          api,
          provider: binding.modelProvider,
          model: binding.modelId,
          usage: usageToPi(undefined),
          stopReason: "toolUse",
          timestamp,
        };
        append(`${m.id}:carrier`, toolCarrier);
        carrierToolSignatures = new Map();
      }
      const thoughtSignature = carrierToolSignatures.get(m.toolCallId);
      toolCarrier.content.push({
        type: "toolCall",
        id: m.toolCallId,
        name: m.toolName,
        arguments: toJsonObject(m.toolArgs),
        ...(thoughtSignature ? { thoughtSignature } : {}),
      });
      toolCarrier.stopReason = "toolUse";
      append(m.id, toolResultFromUi(m, timestamp));
    }
  }
  return entries.filter(
    (entry) =>
      entry.message.role !== "assistant" || entry.message.content.length > 0,
  );
}

/** A context entry as the viewer needs it: its id, and its system state. */
export type HistoryContextEntry = {
  id: string;
  system?: { message: SystemMessage; createdAt: string };
};

/**
 * Metadata only: survival, order, and carrier ids never depend on it, so the
 * viewer needs no provider binding (a session's provider may be deleted).
 */
const LAYOUT_BINDING: HistoryProjectionBinding = {
  api: "openai-completions",
  accountProviderId: "",
  modelProvider: "",
  modelId: "",
  requiresReasoningContentOnAssistantMessages: false,
};

/**
 * The entry layout the runtime would rebuild from `history`, keeping only ids
 * and system messages. `restoreSystem` parses a system row and throws on a
 * malformed one, exactly as the runtime's restore does.
 */
export function projectHistoryContextEntries(
  history: readonly UiMessage[],
  restoreSystem: (row: UiMessage) => SystemMessage,
): HistoryContextEntry[] {
  // Each system entry is the message `restoreSystem` returned for its row.
  const createdAt = new Map<SystemMessage, string>();
  const restore = (row: UiMessage): SystemMessage => {
    const message = restoreSystem(row);
    createdAt.set(message, row.createdAt);
    return message;
  };
  return projectHistoryEntries(history, LAYOUT_BINDING, restore).map((entry) => {
    if (entry.message.role !== "system") return { id: entry.id };
    const restoredAt = createdAt.get(entry.message);
    if (restoredAt === undefined) throw new Error(`System entry ${entry.id} has no restored row`);
    return { id: entry.id, system: { message: entry.message, createdAt: restoredAt } };
  });
}
