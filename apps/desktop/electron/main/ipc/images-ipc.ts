import { randomUUID } from "node:crypto";
import {
  IMAGE_BATCH_TIMEOUT_MS,
  IPC,
  imageGenerationPrompts,
  type ImageGenerateResult,
  type ImageGenerationItem,
} from "@pi-harbor/shared";
import type { IpcMainInvokeEvent } from "electron";
import type { LocalToolHandler } from "../agent-sidecar";
import type { IpcRegistrar } from "./types";

/**
 * One renderer-requested image batch: the user asks for images directly, with
 * no model turn in between. Main only validates the request and hands it to the
 * runtime's own `GenerateImages` handler, so a user-requested batch and a
 * model-requested one run the very same code path — same host calls, same
 * timeout, same result shape. The renderer gets the handler's value unchanged.
 */
export type ImagesIpcDependencies = {
  registrar: Pick<IpcRegistrar, "handleWithEvent">;
  /** The runtime's live `GenerateImages` handler; null before it is wired. */
  getActiveTool: () => LocalToolHandler | null;
};

/**
 * The batch bound the runtime already applies to an image tool call, mirroring
 * `runLocalTool` in `@pi-harbor/host-runtime` so a long multi-image batch is
 * not cut short here before the runtime itself gives up.
 */
const REQUEST_TIMEOUT_MS = IMAGE_BATCH_TIMEOUT_MS + 130_000;

function failure(errorCode: string, message: string): ImageGenerateResult {
  return {
    ok: false,
    errorCode,
    content: { kind: "image-generation-error", errorCode, message },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate and run one renderer-requested batch. Never throws for a bad request
 * or a runtime that is not up: the renderer renders the typed result instead.
 */
export async function handleImagesGenerate(
  raw: unknown,
  getActiveTool: () => LocalToolHandler | null,
): Promise<ImageGenerateResult> {
  const record: Record<string, unknown> | undefined =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const sessionId = typeof record?.sessionId === "string" ? record.sessionId.trim() : "";
  if (!sessionId) return failure("INVALID_ARGUMENT", "sessionId is required");
  let items: ImageGenerationItem[];
  try {
    // The shared validator decides what a batch may contain; it throws on a bad
    // item list rather than silently dropping entries.
    imageGenerationPrompts(raw);
    items = record?.items as ImageGenerationItem[];
  } catch (error) {
    return failure("INVALID_ARGUMENT", messageOf(error));
  }
  // No runtime yet (startup, restart, shutdown) is a state, not a crash.
  const handler = getActiveTool();
  if (!handler) {
    return failure("HOST_UNAVAILABLE", "The agent runtime is not available.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await handler({
      sessionId,
      // There is no model tool call behind this request, so the call id is ours.
      toolCallId: `images-generate-${randomUUID()}`,
      args: { items },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function registerImagesIpc({
  registrar,
  getActiveTool,
}: ImagesIpcDependencies): void {
  registrar.handleWithEvent(
    IPC.invoke.imagesGenerate,
    async (_event: IpcMainInvokeEvent, raw: unknown): Promise<ImageGenerateResult> =>
      handleImagesGenerate(raw, getActiveTool),
  );
}
