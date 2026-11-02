import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ModelInfo } from "./types.js";

/** Minimal fetch shape. Electron Main passes `net.fetch` so app proxy settings apply. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface DownloadModelOptions {
  signal?: AbortSignal;
  fetch?: FetchLike;
  /** Use exactly this hub origin instead of the default list. */
  hubUrl?: string;
  /** Ordered hub origins; the first that serves the file wins. */
  hubUrls?: readonly string[];
  /** Time to first response before a source is abandoned; 0 disables it. */
  requestTimeoutMs?: number;
}

/** Hub origin the catalog pins resolve against. */
export const DEFAULT_HUB_URL = "https://huggingface.co";
/**
 * Same repository layout, reachable where `huggingface.co` is not. A network
 * that resets the TLS handshake to the primary still completes here, and the
 * SHA-256 check keeps a mirror from installing different bytes.
 */
export const MIRROR_HUB_URL = "https://hf-mirror.com";

/** Default source order: the pinned origin, then the reachable mirror. */
export const MODEL_HUB_URLS: readonly string[] = [DEFAULT_HUB_URL, MIRROR_HUB_URL];

/** A source answered but cannot serve this file; the next source may. */
const RETRYABLE_STATUS = new Set([408, 425, 429]);

/** Time to first byte. A blocked host otherwise hangs until the OS gives up. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** Progress is reported in 1% steps so a large file does not flood IPC. */
const PROGRESS_STEP = 0.01;

/** A failure that names the source, so the user can see which host refused. */
class SourceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

/**
 * Parse a user-supplied list of hub origins (`a,b`), keeping only http(s)
 * entries. Empty input yields the defaults at the call site.
 */
export function parseModelHubUrls(value: string | null | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const entry of value.split(",")) {
    const trimmed = entry.trim().replace(/\/+$/, "");
    if (!trimmed || seen.has(trimmed)) continue;
    if (!/^https?:\/\/[^/\s]+/i.test(trimmed)) continue;
    seen.add(trimmed);
    urls.push(trimmed);
  }
  return urls;
}

/** Resolve URL of the pinned file on the hub. */
export function modelDownloadUrl(info: ModelInfo, hubUrl = DEFAULT_HUB_URL): string {
  const encode = (value: string) => value.split("/").map(encodeURIComponent).join("/");
  return `${hubUrl.replace(/\/+$/, "")}/${encode(info.hfRepo)}/resolve/main/${encode(info.hfFilename)}`;
}

/** Ordered, de-duplicated origins this download may use. */
function hubCandidates(options: DownloadModelOptions): string[] {
  if (options.hubUrl) return [options.hubUrl.replace(/\/+$/, "")];
  const configured = options.hubUrls?.map((url) => url.replace(/\/+$/, "")).filter(Boolean) ?? [];
  const candidates = configured.length > 0 ? configured : [...MODEL_HUB_URLS];
  return [...new Set(candidates)];
}

/** Size of the resume file, or 0 when there is nothing usable to resume. */
async function resumableBytes(partPath: string, expected: number): Promise<number> {
  try {
    const info = await stat(partPath);
    if (!info.isFile()) return 0;
    if (info.size <= 0 || info.size >= expected) return 0;
    return info.size;
  } catch {
    return 0;
  }
}

/** Hash bytes already on disk so a resumed file is verified as a whole. */
async function hashExisting(hash: ReturnType<typeof createHash>, partPath: string, bytes: number) {
  const stream = createReadStream(partPath, { end: bytes - 1 });
  for await (const chunk of stream) hash.update(chunk as Buffer);
}

function totalFromContentRange(header: string | null): number | null {
  const match = header?.match(/^bytes\s+\d+-\d+\/(\d+)$/i);
  return match ? Number(match[1]) : null;
}

function startFromContentRange(header: string | null): number | null {
  const match = header?.match(/^bytes\s+(\d+)-\d+\/\d+$/i);
  return match ? Number(match[1]) : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}

/**
 * Download a pinned model file into `targetDir`, yielding progress 0–1.
 *
 * Bytes land at `<target>.part` and are renamed into place only after the
 * stream completed and its SHA-256 matched the catalog, so an interrupted or
 * altered download never leaves a file `ModelManager` would treat as
 * finished. A `.part` file is kept across failures and continued with a
 * `Range` request on the next attempt; only a checksum mismatch, which means
 * the bytes themselves are wrong, discards it.
 *
 * Sources are tried in order. A host that resets the connection, times out, or
 * answers with a transient status falls through to the next; a definitive
 * answer such as 404 ends the download instead of repeating it.
 */
export async function* downloadModel(
  info: ModelInfo,
  targetDir: string,
  options: DownloadModelOptions = {},
): AsyncGenerator<number, void, unknown> {
  const { signal, fetch: fetchImpl = globalThis.fetch, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = options;
  if (!SHA256_PATTERN.test(info.sha256)) {
    throw new Error(`Model ${info.id} has no pinned SHA-256`);
  }
  signal?.throwIfAborted();
  await mkdir(targetDir, { recursive: true });

  const targetPath = path.join(targetDir, info.hfFilename);
  const partPath = `${targetPath}.part`;
  const hubs = hubCandidates(options);

  let lastError: unknown = null;
  for (const [index, hub] of hubs.entries()) {
    try {
      yield* transfer(info, {
        url: modelDownloadUrl(info, hub),
        partPath,
        targetPath,
        signal,
        fetchImpl,
        requestTimeoutMs,
      });
      return;
    } catch (error) {
      // Only a source-specific, retryable failure moves on to the next host.
      if (!(error instanceof SourceError) || !error.retryable) throw error;
      lastError = error;
      if (index === hubs.length - 1) throw error;
    }
  }
  throw lastError ?? new Error("Model download failed: no hub is configured");
}

/** One source attempt; continues whatever the `.part` file already holds. */
async function* transfer(
  info: ModelInfo,
  context: {
    url: string;
    partPath: string;
    targetPath: string;
    signal?: AbortSignal;
    fetchImpl: FetchLike;
    requestTimeoutMs: number;
  },
): AsyncGenerator<number, void, unknown> {
  const { url, partPath, targetPath, signal, fetchImpl, requestTimeoutMs } = context;

  /** Issue one request, bounding only the wait for the response head. */
  const send = async (offset: number): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (offset > 0) headers.Range = `bytes=${offset}-`;
    const controller = new AbortController();
    let timedOut = false;
    const timer =
      requestTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, requestTimeoutMs)
        : null;
    const forwardAbort = () => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      return await fetchImpl(url, { signal: controller.signal, headers });
    } catch (error) {
      // A caller cancel is not a source failure: the manager maps it to a
      // cancelled download, and the partial file stays resumable.
      if (signal?.aborted) throw error;
      if (timedOut) {
        throw new SourceError(
          `Model download failed: ${hostOf(url)} did not answer within ${requestTimeoutMs} ms`,
          true,
          error,
        );
      }
      throw new SourceError(
        `Model download failed: ${hostOf(url)} unreachable (${errorMessage(error)})`,
        true,
        error,
      );
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  };

  let resumeFrom = await resumableBytes(partPath, info.sizeBytes);
  let response = await send(resumeFrom);
  // A stale or unreadable range is not fatal: drop it and ask for the whole file.
  if (response.status === 416 && resumeFrom > 0) {
    await response.body?.cancel().catch(() => undefined);
    await rm(partPath, { force: true });
    resumeFrom = 0;
    response = await send(0);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new SourceError(
      `Model download failed: HTTP ${response.status} from ${hostOf(url)}`,
      RETRYABLE_STATUS.has(response.status) || response.status >= 500,
    );
  }
  if (!response.body) {
    throw new SourceError(`Model download failed: no response body from ${hostOf(url)}`, true);
  }

  // The server may ignore the range and send the whole file; a `206` that
  // starts somewhere else cannot be appended either, so both restart.
  const resumed =
    resumeFrom > 0 && response.status === 206 && startFromContentRange(response.headers.get("content-range")) === resumeFrom;
  if (!resumed) resumeFrom = 0;
  const total =
    totalFromContentRange(response.headers.get("content-range")) ||
    Number(response.headers.get("content-length")) ||
    info.sizeBytes;

  const hash = createHash("sha256");
  if (resumeFrom > 0) await hashExisting(hash, partPath, resumeFrom);

  const reader = response.body.getReader();
  const writer = createWriteStream(partPath, { flags: resumeFrom > 0 ? "a" : "w" });
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
  // and before discarding a failed download; both fail with EBUSY/EPERM on
  // Windows while the handle is still open.
  const writerClosed = new Promise<void>((resolve) => {
    writer.once("close", () => resolve());
  });

  let received = 0;
  let reported = total > 0 ? resumeFrom / total : 0;
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
      const progress = Math.min((resumeFrom + received) / total, 0.99);
      if (progress - reported >= PROGRESS_STEP) {
        reported = progress;
        yield progress;
      }
    }
    writer.end();
    await Promise.race([writerClosed, writeFailure]);
    if (writeError !== null) throw writeError;
    if (hash.digest("hex") !== info.sha256) {
      // The bytes are wrong, so resuming from them would keep producing the
      // same mismatch: discard them and let the next attempt start clean.
      await rm(partPath, { force: true });
      // A mismatch is not a source problem: the mirror would serve the same
      // pinned bytes, so the download stops instead of retrying.
      throw new SourceError(
        `Model download failed: checksum mismatch for ${info.hfFilename}`,
        false,
      );
    }
    await rename(partPath, targetPath);
    completed = true;
    yield 1;
  } catch (error) {
    // A source that drops mid-stream is retryable against the next host; a
    // write failure or a caller abort is not a source problem.
    if (writeError !== null || signal?.aborted || error instanceof SourceError) throw error;
    throw new SourceError(
      `Model download failed: ${hostOf(url)} interrupted (${errorMessage(error)})`,
      true,
      error,
    );
  } finally {
    if (!completed) {
      // A sink error can win the race while reader.read() is still pending;
      // cancel the response so a failed write does not keep downloading.
      await reader.cancel().catch(() => undefined);
      if (writeError === null) {
        // Flush what the file already accepted so the next attempt resumes
        // from those bytes instead of starting over.
        writer.end();
      } else {
        writer.destroy();
      }
      await Promise.race([writerClosed, writeFailure]).catch(() => undefined);
    }
  }
}

/** Host of a download URL, used to name the source in failures. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
