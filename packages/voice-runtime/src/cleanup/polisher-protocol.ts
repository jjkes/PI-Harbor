/**
 * Messages between the app and the isolated cleanup-model worker
 * (polisher-worker.ts). Every request carries the model path, so a restarted
 * worker needs no setup handshake.
 */
export type PolisherRequest =
  | { type: "prepare"; id: number; modelPath: string }
  | { type: "polish"; id: number; modelPath: string; text: string }
  | { type: "abort"; id: number };

export type PolisherResponse =
  | { type: "result"; id: number; ok: true; text?: string }
  | { type: "result"; id: number; ok: false; error: string; aborted?: boolean };

/**
 * Transport to one worker process. Electron Main adapts `utilityProcess`;
 * tests and scripts adapt `child_process.fork`.
 */
export interface PolisherChannel {
  postMessage(message: PolisherRequest): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isPolisherRequest(value: unknown): value is PolisherRequest {
  if (!isRecord(value) || typeof value.id !== "number" || !Number.isSafeInteger(value.id)) {
    return false;
  }
  const hasModelPath = typeof value.modelPath === "string" && value.modelPath.length > 0;
  switch (value.type) {
    case "abort":
      return true;
    case "prepare":
      return hasModelPath;
    case "polish":
      return hasModelPath && typeof value.text === "string";
    default:
      return false;
  }
}

export function isPolisherResponse(value: unknown): value is PolisherResponse {
  if (!isRecord(value) || value.type !== "result" || typeof value.id !== "number") return false;
  if (value.ok === true) return value.text === undefined || typeof value.text === "string";
  return value.ok === false && typeof value.error === "string";
}
