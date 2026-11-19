import type { ProgressTodoContext, UiMessage } from "@pi-harbor/shared";
import { PROGRESS_WINDOW_MESSAGES } from "@pi-harbor/shared";

/**
 * A normalized snapshot of one session, the only input the digest, prompt, and
 * fingerprint read (design § 7.2). Building it is pure: it never mutates the
 * messages it receives and performs no I/O.
 */

/** Session-level facts the digest states plainly instead of guessing. */
export type ProgressSnapshotFacts = {
  mode: string;
  permissionMode: string;
  providerId: string;
  modelId: string;
  /** `messageEnd` from the bounded `session.get` read, or the window length. */
  totalMessages: number;
  /** ISO timestamps of the oldest and newest message actually included. */
  firstMessageAt: string | null;
  lastMessageAt: string | null;
};

export type ProgressSnapshotMessage = {
  id: string;
  role: UiMessage["role"];
  content: string;
  thinking: string | null;
  createdAt: string;
  toolName: string | null;
  toolCallId: string | null;
  toolArgs: unknown;
  toolResult: unknown;
  toolStatus: string | null;
};

export type ProgressSnapshot = {
  facts: ProgressSnapshotFacts;
  /** Oldest first, already windowed and turn-aligned. */
  messages: ProgressSnapshotMessage[];
  checklist: { content: string; status: string }[];
  /** Newest durable message id; the staleness key (design § 7.4). */
  lastMessageId: string | null;
  messageCount: number;
  todosRevision: number;
};

export type ProgressSnapshotInput = {
  session: {
    mode?: string;
    permissionMode?: string;
    providerId?: string;
    modelId?: string;
  };
  /** Oldest first, as `session.get` returns them. */
  messages: readonly UiMessage[];
  todos?: ProgressTodoContext | null;
  /** Total message count reported by the host when the window was bounded. */
  totalMessages?: number;
};

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const block of value) {
      if (typeof block === "string") parts.push(block);
      else if (typeof block === "object" && block !== null) {
        const text = Reflect.get(block, "text");
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.join("\n");
  }
  if (typeof value === "object" && value !== null) {
    const text = Reflect.get(value, "text");
    if (typeof text === "string") return text;
  }
  return "";
}

/**
 * A tool result is its own message; a window that starts with one leaves a
 * call behind and the model reads half a story. Extend the window backwards
 * while its oldest entry is an orphaned tool row (design § 7.2).
 */
function alignToTurnBoundary(messages: readonly UiMessage[], start: number): number {
  let first = start;
  const limit = messages.length;
  while (first > 0 && first < limit && messages[first]?.role === "tool") {
    first -= 1;
  }
  return first;
}

function normalizeMessage(message: UiMessage): ProgressSnapshotMessage {
  return {
    id: message.id,
    role: message.role,
    content: textOf(message.content),
    thinking: typeof message.thinking === "string" ? message.thinking : null,
    createdAt: message.createdAt,
    toolName: typeof message.toolName === "string" ? message.toolName : null,
    toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : null,
    toolArgs: message.toolArgs ?? null,
    toolResult: message.toolResult ?? null,
    toolStatus: typeof message.toolStatus === "string" ? message.toolStatus : null,
  };
}

/** Normalize a transcript window plus the session checklist into a snapshot. */
export function buildProgressSnapshot(input: ProgressSnapshotInput): ProgressSnapshot {
  const all = input.messages;
  const requestedStart = Math.max(0, all.length - PROGRESS_WINDOW_MESSAGES);
  const start = alignToTurnBoundary(all, requestedStart);
  const messages = all.slice(start).map(normalizeMessage);
  const newest = messages[messages.length - 1] ?? null;
  const oldest = messages[0] ?? null;
  const checklist = (input.todos?.todos ?? []).map((todo) => ({
    content: todo.content,
    status: todo.status,
  }));
  return {
    facts: {
      mode: input.session.mode ?? "agent",
      permissionMode: input.session.permissionMode ?? "default",
      providerId: input.session.providerId ?? "",
      modelId: input.session.modelId ?? "",
      totalMessages: Math.max(input.totalMessages ?? all.length, all.length),
      firstMessageAt: oldest?.createdAt ?? null,
      lastMessageAt: newest?.createdAt ?? null,
    },
    messages,
    checklist,
    lastMessageId: newest?.id ?? null,
    messageCount: all.length,
    todosRevision: input.todos?.revision ?? 0,
  };
}

/** FNV-1a over the snapshot keys; short, stable, and not a security claim. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * What "nothing changed" means for automatic collection (design § 7.4): the
 * newest durable message, the message count, and the checklist revision.
 */
export function progressFingerprint(
  snapshot: Pick<ProgressSnapshot, "lastMessageId" | "messageCount" | "todosRevision">,
): string {
  // A distinct prefix keeps "no message yet" apart from a real id.
  const id = snapshot.lastMessageId === null ? "\u0000" : `\u0001${snapshot.lastMessageId}`;
  return shortHash(`${id}\u0000${snapshot.messageCount}\u0000${snapshot.todosRevision}`);
}
