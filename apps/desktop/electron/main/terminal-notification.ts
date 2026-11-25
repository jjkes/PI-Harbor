/**
 * Normalize terminal notification payloads at the Electron Main boundary.
 *
 * host-core emits `terminal.output` with an `output` field and `terminal.changed`
 * with state `open` / `exitCode`. RACP may emit either `output`/`data` and
 * `open`/`opened`. The renderer consumes `data`, state `opened`, and `code`.
 * This module accepts any of those shapes and emits the renderer shape.
 */

export type TerminalOutputEvent = {
  sessionId: string;
  terminalId: string;
  data: string;
  stream?: "stdout" | "stderr";
};

export type TerminalChangedEvent = {
  sessionId: string;
  terminalId: string;
  state: "opened" | "closed" | "exited";
  code?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function normalizeTerminalOutput(payload: unknown): TerminalOutputEvent | undefined {
  if (!isRecord(payload)) return undefined;
  const sessionId = payload.sessionId;
  const terminalId = payload.terminalId;
  if (typeof sessionId !== "string" || typeof terminalId !== "string") return undefined;
  const data =
    typeof payload.data === "string"
      ? payload.data
      : typeof payload.output === "string"
        ? payload.output
        : "";
  const stream = payload.stream === "stderr" ? "stderr" : "stdout";
  return { sessionId, terminalId, data, stream };
}

export function normalizeTerminalChanged(payload: unknown): TerminalChangedEvent | undefined {
  if (!isRecord(payload)) return undefined;
  const sessionId = payload.sessionId;
  const terminalId = payload.terminalId;
  if (typeof sessionId !== "string" || typeof terminalId !== "string") return undefined;
  const rawState = typeof payload.state === "string" ? payload.state : "";
  const state: TerminalChangedEvent["state"] | undefined =
    rawState === "opened" || rawState === "closed" || rawState === "exited"
      ? rawState
      : rawState === "open"
        ? "opened"
        : undefined;
  if (!state) return undefined;
  const rawExit = payload.exitCode ?? payload.code;
  const code = typeof rawExit === "number" ? rawExit : undefined;
  return { sessionId, terminalId, state, ...(code !== undefined ? { code } : {}) };
}
