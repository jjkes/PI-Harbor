import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  PROGRESS_ASSISTANT_CHARS,
  PROGRESS_DIGEST_TOKEN_BUDGET,
  PROGRESS_TOOL_ARG_CHARS,
  PROGRESS_TOOL_RESULT_CHARS,
  PROGRESS_USER_CHARS,
} from "@pi-harbor/shared";
import { estimateTokens } from "../pi-runtime-estimates.js";
import type { ProgressSnapshot, ProgressSnapshotMessage } from "./progress-snapshot.js";

/**
 * The plain-text digest a report is written from (design § 7.2). It is the only
 * thing that leaves the machine for a report, so every field is capped here
 * rather than at the call site.
 */

/**
 * Tokens of one digest line, measured with the runtime's own estimator so the
 * budget means the same thing it means everywhere else.
 */
export function estimateDigestTokens(text: string): number {
  const message: AgentMessage = { role: "user", content: text, timestamp: 0 };
  return estimateTokens(message);
}

/** Collapse whitespace and cap one excerpt to a single line. */
function excerpt(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Argument keys plus a short preview of the first value, never the whole call. */
function describeArgs(args: unknown): string {
  if (typeof args !== "object" || args === null) {
    return typeof args === "string" ? excerpt(args, PROGRESS_TOOL_ARG_CHARS) : "";
  }
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const first = keys[0] ?? "";
  const value = Reflect.get(args, first);
  const preview =
    typeof value === "string"
      ? value
      : value === undefined || value === null
        ? ""
        : JSON.stringify(value) ?? "";
  const joined = excerpt(preview, PROGRESS_TOOL_ARG_CHARS);
  return joined.length > 0 ? `${keys.join(",")} ${joined}` : keys.join(",");
}

/** Result text, with binary payloads replaced instead of embedded. */
function describeResult(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return excerpt(result, PROGRESS_TOOL_RESULT_CHARS);
  if (typeof result === "object") {
    for (const key of ["content", "text", "output", "stdout", "message"]) {
      const value = Reflect.get(result, key);
      if (typeof value === "string" && value.length > 0) {
        return excerpt(value, PROGRESS_TOOL_RESULT_CHARS);
      }
    }
    try {
      return excerpt(JSON.stringify(result), PROGRESS_TOOL_RESULT_CHARS);
    } catch {
      return "<object>";
    }
  }
  return excerpt(String(result), PROGRESS_TOOL_RESULT_CHARS);
}

function messageLine(message: ProgressSnapshotMessage): string {
  if (message.role === "tool") {
    const name = message.toolName ?? "tool";
    const outcome = message.toolStatus === "error" || message.toolStatus === "denied" ? "error" : "ok";
    const body = describeResult(message.toolResult ?? message.content);
    return `T ${name} → ${outcome}: ${body}`.trimEnd();
  }
  if (message.role === "assistant") {
    const parts: string[] = [];
    if (message.content.trim().length > 0) {
      parts.push(`A ${excerpt(message.content, PROGRESS_ASSISTANT_CHARS)}`);
    }
    if (message.toolName) {
      parts.push(`C ${message.toolName}(${describeArgs(message.toolArgs)})`);
    }
    return parts.join("\n");
  }
  if (message.role === "user") {
    return `U ${excerpt(message.content, PROGRESS_USER_CHARS)}`;
  }
  return `S ${excerpt(message.content, PROGRESS_USER_CHARS)}`;
}

const CHECKLIST_MARKERS: Record<string, string> = {
  completed: "[x]",
  in_progress: "[~]",
  pending: "[ ]",
  cancelled: "[-]",
};

type DigestEntry = { text: string; tokens: number; anchor: boolean };

/**
 * Build the budgeted digest. Older entries are dropped first, but the earliest
 * user message in the window survives as the anchor that keeps the report from
 * losing what the session was asked to do.
 */
export function buildProgressDigest(snapshot: ProgressSnapshot): string {
  const header = [
    `session mode=${snapshot.facts.mode} permission=${snapshot.facts.permissionMode} model=${snapshot.facts.providerId}/${snapshot.facts.modelId} messages=${snapshot.facts.totalMessages}`,
    `window ${snapshot.facts.firstMessageAt ?? "-"} .. ${snapshot.facts.lastMessageAt ?? "-"}`,
  ].join("\n");

  const checklist =
    snapshot.checklist.length === 0
      ? "checklist (none)"
      : [
          "checklist",
          ...snapshot.checklist.map(
            (todo) => `${CHECKLIST_MARKERS[todo.status] ?? "[ ]"} ${excerpt(todo.content, 120)}`,
          ),
        ].join("\n");

  let anchorUsed = false;
  const entries: DigestEntry[] = [];
  for (const message of snapshot.messages) {
    const text = messageLine(message);
    if (text.length === 0) continue;
    const anchor = !anchorUsed && message.role === "user";
    if (anchor) anchorUsed = true;
    entries.push({ text, tokens: estimateDigestTokens(text), anchor });
  }

  const fixed = [header, checklist].join("\n\n");
  let total = estimateDigestTokens(fixed);
  for (const entry of entries) total += entry.tokens;

  let first = 0;
  while (total > PROGRESS_DIGEST_TOKEN_BUDGET && entries.length - first > 1) {
    const dropIndex = entries[first]?.anchor === true && entries.length - first > 1 ? first + 1 : first;
    const dropped = entries[dropIndex];
    if (!dropped) break;
    total -= dropped.tokens;
    entries.splice(dropIndex, 1);
    if (dropIndex === first) first = Math.min(first, entries.length - 1);
  }

  const body = entries.map((entry) => entry.text).join("\n");
  return [fixed, "transcript", body].filter((part) => part.length > 0).join("\n\n");
}
