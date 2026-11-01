import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { ModelInfo } from "./types.js";

/** Minimal fetch shape. Electron Main passes `net.fetch` so app proxy settings apply. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface DownloadModelOptions {
  signal?: AbortSignal;
  fetch?: FetchLike;
  /** Hub origin; defaults to https://huggingface.co. */
  hubUrl?: string;
}

const DEFAULT_HUB_URL = "https://huggingface.co";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** Progress is reported in 1% steps so a large file does not flood IPC. */
const PROGRESS_STEP = 0.01;

/** Resolve URL of the pinned file on the hub. */
export function modelDownloadUrl(info: ModelInfo, hubUrl = DEFAULT_HUB_URL): string {
  const encode = (value: string) => value.split("/").map(encodeURIComponent).join("/");
  return `${hubUrl.replace(/\/+$/, "")}/${encode(info.hfRepo)}/resolve/main/${encode(info.hfFilename)}`;
}

/**
 * Download a pinned model file into `targetDir`, yielding progress 0–1.
 *
 * Bytes land at `<target>.part` and are renamed into place only after the
 * stream completed and its SHA-256 matched the catalog, so an interrupted or
 * altered download never leaves a file `ModelManager` would treat as
 * finished.
 */
export async function* downloadModel(
  info: ModelInfo,
  targetDir: string,
  options: DownloadModelOptions = {},
): AsyncGenerator<number, void, unknown> {
  const { signal, fetch: fetchImpl = globalThis.fetch, hubUrl } = options;
  if (!SHA256_PATTERN.test(info.sha256)) {
    throw new Error(`Model ${info.id} has no pinned SHA-256`);
  }
  signal?.throwIfAborted();
  await mkdir(targetDir, { recursive: true });

  const targetPath = path.join(targetDir, info.hfFilename);
  const partPath = `${targetPath}.part`;

  const response = await fetchImpl(modelDownloadUrl(info, hubUrl), { signal });
  if (!response.ok) {
    throw new Error(`Model download failed: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Model download failed: no response body");
  }

  const total = Number(response.headers.get("content-length")) || info.sizeBytes;
  const reader = response.body.getReader();
  const writer = createWriteStream(partPath);
  // A write error (ENOSPC, EIO, EISDIR) must surface as a failed download,
  // not as an unhandled 'error' event in the Electron main process, where
  // that is an app crash. The rejection races the source reads; the
  // pre-attached catch keeps a rejection nobody awaits from becoming an
  // unhandledRejection.
  let writeError: unknown = null;
  const writeFailure = new Promise<never>((_, reject) => {
    writer.on("error", (error) => {
      writeError = error;
      reject(error);
    });
  });
  writeFailure.catch(() => undefined);
  // 'close' fires on every terminal path (end, destroy, autoClose on error)
  // and means the file handle is released. It is awaited before the rename
  // and before unlinking a failed download; both fail with EBUSY/EPERM on
  // Windows while the handle is still open.
  const writerClosed = new Promise<void>((resolve) => {
    writer.once("close", () => resolve());
  });

  const hash = createHash("sha256");
  let received = 0;
  let reported = 0;
  let completed = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await Promise.race([reader.read(), writeFailure]);
      if (chunk.done) break;
      hash.update(chunk.value);
      received += chunk.value.byteLength;
      if (!writer.write(chunk.value)) {
        await Promise.race([once(writer, "drain"), writeFailure]);
      }
      const progress = Math.min(received / total, 0.99);
      if (progress - reported >= PROGRESS_STEP) {
        reported = progress;
        yield progress;
      }
    }
    writer.end();
    await Promise.race([writerClosed, writeFailure]);
    if (writeError !== null) throw writeError;
    if (hash.digest("hex") !== info.sha256) {
      throw new Error(`Model download failed: checksum mismatch for ${info.hfFilename}`);
    }
    await rename(partPath, targetPath);
    completed = true;
    yield 1;
  } finally {
    if (!completed) {
      // A sink error can win the race while reader.read() is still pending;
      // cancel the response so a failed write does not keep downloading.
      await reader.cancel().catch(() => undefined);
      writer.destroy();
      await writerClosed;
      // The final path is never touched by a failed download.
      await unlink(partPath).catch(() => undefined);
    }
  }
}
