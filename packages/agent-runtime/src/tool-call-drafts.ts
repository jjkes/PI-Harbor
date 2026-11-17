/**
 * Live previews of tool calls while the model streams their arguments.
 *
 * pi-ai assigns a progressively parsed object to each `toolCall` block's
 * `arguments` as the provider streams, and pi-agent-core forwards every step as
 * `message_update`. The tracker turns those snapshots into `tool_draft` events
 * (small appends, never the whole value again) so the transcript can show the
 * call as it is written, the way the pi TUI does. It never touches execution:
 * a tool still runs once, after `message_end`, with the final arguments that
 * `tool_start` carries.
 */

import {
  diffToolDraftArgs,
  snapshotToolDraftArgs,
  type AgentEvent,
} from "@pi-harbor/shared";

export type ToolDraftAgentEvent = Extract<AgentEvent, { type: "tool_draft" }>;

/** The part of pi-ai's `AssistantMessageEvent` the tracker reads. */
export type ToolDraftStreamEvent = { type: string; contentIndex?: number };

type Draft = {
  toolCallId: string;
  toolName: string;
  messageId: string;
  /** Last argument snapshot sent; `undefined` before the first argument. */
  previous: unknown;
  /** False once the arguments outgrew the snapshot budget. */
  previewing: boolean;
  complete: boolean;
};

type ToolCallBlock = { id: string; name: string; arguments: unknown };

function toolCallBlock(part: unknown): ToolCallBlock | undefined {
  if (!part || typeof part !== "object") return undefined;
  const block = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
  if (block.type !== "toolCall") return undefined;
  // Some adapters learn the id or name a chunk later; nothing is shown until
  // both exist, so a draft is always keyed the way `tool_start` will be.
  if (typeof block.id !== "string" || !block.id) return undefined;
  if (typeof block.name !== "string" || !block.name) return undefined;
  return { id: block.id, name: block.name, arguments: block.arguments };
}

function toolCallIds(content: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(content)) return ids;
  for (const part of content) {
    const block = toolCallBlock(part);
    if (block) ids.add(block.id);
  }
  return ids;
}

/**
 * Whether pi-agent-core executes the tool calls of a settled response. Its loop
 * skips them for exactly these stop reasons; every other call reaches
 * `tool_execution_start`, so its draft can wait for `tool_start`.
 */
export function toolCallsWillExecute(stopReason: unknown): boolean {
  return stopReason !== "error" && stopReason !== "aborted";
}

/** The tool-call drafts of one streaming assistant response. */
export class ToolCallDraftTracker {
  private readonly drafts = new Map<string, Draft>();
  private closed = false;

  /**
   * Start a response. Drafts that an earlier attempt left open (its end never
   * arrived) are discarded first, so no row outlives the attempt behind it.
   */
  begin(): ToolDraftAgentEvent[] {
    const leftovers = this.discardAll();
    this.closed = false;
    return leftovers;
  }

  /**
   * Read one `message_update`. Call it synchronously from the event handler:
   * pi keeps mutating the same message objects after the event is delivered.
   */
  observe(
    messageId: string,
    content: unknown,
    streamEvent?: ToolDraftStreamEvent,
  ): ToolDraftAgentEvent[] {
    if (this.closed || !Array.isArray(content)) return [];
    const events: ToolDraftAgentEvent[] = [];
    for (const part of content) {
      const block = toolCallBlock(part);
      if (!block) continue;
      const known = this.drafts.get(block.id);
      if (known?.complete) continue;
      const draft: Draft = known ?? {
        toolCallId: block.id,
        toolName: block.name,
        messageId,
        previous: undefined,
        previewing: true,
        complete: false,
      };
      const isNew = !known;
      if (isNew) this.drafts.set(block.id, draft);
      let changes: ReturnType<typeof diffToolDraftArgs> = [];
      if (draft.previewing) {
        const next = snapshotToolDraftArgs(block.arguments);
        if (next === undefined && block.arguments !== undefined) {
          // Too large to preview: keep the row (name and target already sent)
          // and let it settle; the final arguments arrive with `tool_start`.
          draft.previewing = false;
        } else {
          changes = diffToolDraftArgs(draft.previous, next);
          draft.previous = next;
        }
      }
      if (isNew || changes.length > 0) {
        events.push({ ...this.identity(draft), phase: "streaming", changes });
      }
    }
    if (streamEvent?.type === "toolcall_end" && typeof streamEvent.contentIndex === "number") {
      const block = toolCallBlock(content[streamEvent.contentIndex]);
      const draft = block ? this.drafts.get(block.id) : undefined;
      if (draft && !draft.complete) {
        draft.complete = true;
        events.push({ ...this.identity(draft), phase: "complete" });
      }
    }
    return events;
  }

  /**
   * The response settled. When its calls will execute, every draft whose id is
   * among the final calls is complete and waits for `tool_start`; a draft the
   * provider re-keyed, and every draft of a failed or aborted response, is
   * discarded.
   */
  settle(finalContent: unknown, willExecute: boolean): ToolDraftAgentEvent[] {
    if (this.closed) return [];
    this.closed = true;
    const finalIds = willExecute ? toolCallIds(finalContent) : new Set<string>();
    const events: ToolDraftAgentEvent[] = [];
    for (const draft of this.drafts.values()) {
      if (finalIds.has(draft.toolCallId)) {
        if (!draft.complete) events.push({ ...this.identity(draft), phase: "complete" });
      } else {
        events.push({ ...this.identity(draft), phase: "discarded" });
      }
    }
    this.drafts.clear();
    return events;
  }

  /** The response is being thrown away (for a retry): discard every draft. */
  discardAll(): ToolDraftAgentEvent[] {
    this.closed = true;
    const events: ToolDraftAgentEvent[] = [];
    for (const draft of this.drafts.values()) {
      events.push({ ...this.identity(draft), phase: "discarded" });
    }
    this.drafts.clear();
    return events;
  }

  private identity(draft: Draft): Pick<ToolDraftAgentEvent, "type" | "toolCallId" | "toolName" | "messageId"> {
    return {
      type: "tool_draft",
      toolCallId: draft.toolCallId,
      toolName: draft.toolName,
      messageId: draft.messageId,
    };
  }
}
