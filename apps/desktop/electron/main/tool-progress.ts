/**
 * Live progress of one desktop-dispatched tool call (D682).
 *
 * A plugin tool and an MCP server tool both execute in Electron main, so this
 * process is the only one that can see what they produce while they run. Each
 * report is coalesced here — one frame per interval, bounded in size — and sent
 * to host-core, which owns the call's identity and forwards it to the runtime
 * as a display-only `tools.output` frame. The call's result is still the single
 * `plugins.resolveExecution` answer: nothing here can change what the model
 * receives.
 */

/** Merge window for a tool's own reports; matches the shell notifier's pace. */
export const TOOL_PROGRESS_INTERVAL_MS = 100;

/** Most text one coalesced frame carries before it is sent early. */
export const TOOL_PROGRESS_MAX_CHUNK_CHARS = 16 * 1024;

/** Most text one call keeps waiting between frames. */
const MAX_PENDING_CHARS = 64 * 1024;

export type ToolProgressReporter = {
  /** Append one report's text; it reaches the frame on the next flush. */
  push: (text: string) => void;
  /** Send whatever is pending now (used when the call settles). */
  flush: () => void;
  /** Drop the pending text and cancel the timer. */
  dispose: () => void;
};

export type ToolProgressOptions = {
  send: (chunk: string) => void;
  intervalMs?: number;
  schedule?: (flush: () => void, delayMs: number) => () => void;
};

function defaultSchedule(flush: () => void, delayMs: number): () => void {
  const timer = setTimeout(flush, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * Build one call's reporter.
 *
 * Text is only trimmed when it outgrows the pending budget: a progress frame is
 * a preview, and the call's result is what the row settles into, so the oldest
 * text of an over-cap burst is the least valuable part of it.
 */
export function createToolProgressReporter(
  options: ToolProgressOptions,
): ToolProgressReporter {
  const intervalMs = options.intervalMs ?? TOOL_PROGRESS_INTERVAL_MS;
  const schedule = options.schedule ?? defaultSchedule;
  let pending = "";
  let cancelTimer: (() => void) | null = null;
  let disposed = false;

  const flush = () => {
    cancelTimer?.();
    cancelTimer = null;
    if (disposed || pending === "") return;
    const chunk = pending;
    pending = "";
    options.send(chunk);
  };

  return {
    push(text: string) {
      if (disposed || text === "") return;
      pending += text;
      if (pending.length > MAX_PENDING_CHARS) {
        pending = pending.slice(pending.length - MAX_PENDING_CHARS);
      }
      if (pending.length >= TOOL_PROGRESS_MAX_CHUNK_CHARS) {
        flush();
        return;
      }
      if (!cancelTimer) cancelTimer = schedule(flush, intervalMs);
    },
    flush,
    dispose() {
      disposed = true;
      pending = "";
      cancelTimer?.();
      cancelTimer = null;
    },
  };
}

/**
 * Text for one MCP `notifications/progress` frame.
 *
 * The spec lets a server send a counter, a message, or both. Only what a reader
 * can use is shown: a message verbatim, otherwise the counter. A frame carrying
 * neither contributes nothing rather than a line of JSON noise.
 */
export function mcpProgressText(update: unknown): string {
  if (!update || typeof update !== "object" || Array.isArray(update)) return "";
  const record = update as {
    progress?: unknown;
    total?: unknown;
    message?: unknown;
  };
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (message) return message;
  const progress = typeof record.progress === "number" ? record.progress : null;
  const total = typeof record.total === "number" ? record.total : null;
  if (progress === null) return "";
  return total === null ? String(progress) : `${progress}/${total}`;
}
