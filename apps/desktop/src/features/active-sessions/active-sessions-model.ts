import type { SessionSummary, UiMessage } from "@pi-harbor/shared";
import { isRemoteSession } from "../../lib/remote-session-safety";
import {
  type InputRequestQueues,
  sessionAwaitsInput,
} from "../../lib/session-input-requests";
import { listableSessions } from "../../lib/session-origin";
import type { ProjectMeta } from "../../lib/sidebar-preferences";
import { normalizeProjectPath } from "../../lib/sidebar-session-groups";
import { sidebarSessionStatus } from "../../lib/sidebar-session-status";

/** Why a session is on the Active sessions page, and how its pane reads. */
export type ActiveSessionStatus = "running" | "permission" | "input";

export type ActiveSessionEntry = {
  session: SessionSummary;
  status: ActiveSessionStatus;
};

export type ActiveSessionInputs = InputRequestQueues & {
  sessions: readonly SessionSummary[];
  runningSessions: Readonly<Record<string, boolean>>;
};

/**
 * The sessions the Active sessions page shows: every listable session that is
 * running or waiting for a permission decision. Status follows the sidebar's
 * precedence (a pending permission outranks a question or plan review, which
 * outranks running), so a session row and its pane never disagree. A session
 * that only waits on a plan review is not running and stays off the page.
 * Automation runs stay on the Scheduled page, as in every other session list.
 *
 * Panes keep a stable order, oldest session first, so a streaming session
 * never reshuffles the grid under the pointer.
 */
export function selectActiveSessions({
  sessions,
  runningSessions,
  ...queues
}: ActiveSessionInputs): ActiveSessionEntry[] {
  const entries: ActiveSessionEntry[] = [];
  for (const session of listableSessions(sessions)) {
    const running = Boolean(runningSessions[session.id]);
    const hasPendingPermission =
      (queues.pendingPermissions[session.id]?.length ?? 0) > 0;
    if (!running && !hasPendingPermission) continue;
    const status = sidebarSessionStatus({
      running,
      selected: false,
      hasPendingPermission,
      awaitingInput: sessionAwaitsInput(queues, session.id),
    });
    if (status === "running" || status === "permission" || status === "input") {
      entries.push({ session, status });
    }
  }
  return entries.sort(
    (a, b) =>
      creationTime(a.session) - creationTime(b.session) ||
      a.session.id.localeCompare(b.session.id),
  );
}

function creationTime(session: SessionSummary): number {
  const time = Date.parse(session.createdAt);
  return Number.isFinite(time) ? time : 0;
}

/**
 * The project a pane names under its title, as the conversation topbar does:
 * a remote session's display label, a local project's sidebar name or its
 * folder name, and nothing for a temporary session.
 */
export function activeSessionProject(
  session: SessionSummary,
  projectMeta: Readonly<Record<string, ProjectMeta>>,
): string | null {
  if (isRemoteSession(session)) {
    return session.remoteWorkspaceLabel || session.remoteHostLabel || null;
  }
  const path = session.projectPath?.trim();
  const key = normalizeProjectPath(path);
  if (!path || !key) return null;
  const name = projectMeta[key]?.name?.trim();
  if (name) return name;
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export type TranscriptPreviewToolStatus = "running" | "success" | "error" | "denied";

export type TranscriptPreviewLine =
  | { id: string; kind: "user"; text: string; from?: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "tool"; toolName: string; status: TranscriptPreviewToolStatus };

/** Rows a pane shows; older rows stay in the conversation. */
export const TRANSCRIPT_PREVIEW_LINE_LIMIT = 12;
/** Characters kept from one row. */
export const TRANSCRIPT_PREVIEW_TEXT_LIMIT = 280;
const ELLIPSIS = "…";

/**
 * The newest top-level transcript rows as compact text, oldest first. Work
 * nested under a delegated tool call stays out, so a pane summarizes the
 * conversation rather than every subagent step.
 */
export function transcriptPreviewLines(
  messages: readonly UiMessage[],
  limit = TRANSCRIPT_PREVIEW_LINE_LIMIT,
): TranscriptPreviewLine[] {
  const lines: TranscriptPreviewLine[] = [];
  for (let index = messages.length - 1; index >= 0 && lines.length < limit; index -= 1) {
    const line = previewLine(messages[index]);
    if (line) lines.push(line);
  }
  return lines.reverse();
}

function previewLine(message: UiMessage): TranscriptPreviewLine | null {
  if (message.modelSystem || message.parentToolCallId || message.nestedParentToolCallId) {
    return null;
  }
  switch (message.role) {
    case "user": {
      const text = clipPreviewText(message.command || message.content, "start");
      if (!text) return null;
      const from = message.sessionMessage?.sourceTitle.trim();
      return from
        ? { id: message.id, kind: "user", text, from }
        : { id: message.id, kind: "user", text };
    }
    case "assistant": {
      const text = clipPreviewText(message.content, "end");
      return text ? { id: message.id, kind: "assistant", text } : null;
    }
    case "tool":
      return message.toolName
        ? { id: message.id, kind: "tool", toolName: message.toolName, status: toolStatus(message) }
        : null;
    default:
      return null;
  }
}

function toolStatus(message: UiMessage): TranscriptPreviewToolStatus {
  if (message.toolStatus) return message.toolStatus;
  if (message.status === "streaming") return "running";
  return message.status === "error" || message.status === "aborted" ? "error" : "success";
}

/**
 * One preview row: whitespace collapsed, at most `limit` characters. A prompt
 * keeps its start; a reply keeps its end, so a streaming answer stays readable
 * as it grows.
 */
export function clipPreviewText(
  value: string,
  keep: "start" | "end",
  limit = TRANSCRIPT_PREVIEW_TEXT_LIMIT,
): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return keep === "start"
    ? `${withoutBrokenEdge(text.slice(0, limit), "end").trimEnd()}${ELLIPSIS}`
    : `${ELLIPSIS}${withoutBrokenEdge(text.slice(-limit), "start").trimStart()}`;
}

/** A cut can split a surrogate pair; drop the orphaned half at that edge. */
function withoutBrokenEdge(text: string, edge: "start" | "end"): string {
  if (edge === "end") {
    const code = text.charCodeAt(text.length - 1);
    return code >= 0xd800 && code <= 0xdbff ? text.slice(0, -1) : text;
  }
  const code = text.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff ? text.slice(1) : text;
}
