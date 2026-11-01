import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadModel, modelDownloadUrl, type FetchLike } from "../src/model-downloader.js";
import type { ModelInfo } from "../src/types.js";

const BYTES = new Uint8Array(4096).map((_, index) => index % 251);

function modelFor(bytes: Uint8Array, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "test-model",
    kind: "transcription",
    name: "Test",
    description: "Test model",
    languages: ["en"],
    sizeBytes: bytes.length,
    hfRepo: "test/repo",
    hfFilename: "model.gguf",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    supportsStreaming: false,
    recommended: false,
    ...overrides,
  };
}

function chunkedBody(bytes: Uint8Array, chunks = 4): ReadableStream<Uint8Array> {
  const size = Math.ceil(bytes.length / chunks);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

function failingBody(first: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(first);
        return;
      }
      controller.error(new Error("connection reset"));
    },
  });
}

function respond(body: ReadableStream<Uint8Array> | null, init: ResponseInit = {}) {
  return vi.fn<FetchLike>(async () => new Response(body, init));
}

async function drain(iterator: AsyncGenerator<number, void, unknown>): Promise<number[]> {
  const seen: number[] = [];
  for await (const progress of iterator) seen.push(progress);
  return seen;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "voice-download-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("modelDownloadUrl", () => {
  it("resolves the pinned file on the hub", () => {
    const info = modelFor(BYTES, { hfRepo: "unsloth/Qwen3-1.7B-GGUF", hfFilename: "Qwen3-1.7B-Q4_K_M.gguf" });
    expect(modelDownloadUrl(info)).toBe(
      "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf",
    );
    expect(modelDownloadUrl(info, "https://mirror.example")).toBe(
      "https://mirror.example/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf",
    );
  });
});

describe("downloadModel", () => {
  it("writes the verified file and leaves no partial file", async () => {
    const info = modelFor(BYTES);
    const fetch = respond(chunkedBody(BYTES), { headers: { "content-length": String(BYTES.length) } });
    const progress = await drain(downloadModel(info, dir, { fetch }));
    expect(await readdir(dir)).toEqual(["model.gguf"]);
    expect(await readFile(path.join(dir, "model.gguf"))).toEqual(Buffer.from(BYTES));
    expect(progress.at(-1)).toBe(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(modelDownloadUrl(info));
  });

  it("rejects a checksum mismatch and removes the partial file", async () => {
    const info = modelFor(BYTES, { sha256: "0".repeat(64) });
    await expect(drain(downloadModel(info, dir, { fetch: respond(chunkedBody(BYTES)) }))).rejects.toThrow(
      /checksum|sha-?256/i,
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects an HTTP error", async () => {
    await expect(
      drain(downloadModel(modelFor(BYTES), dir, { fetch: respond(null, { status: 404 }) })),
    ).rejects.toThrow(/404/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses a model without a pinned checksum", async () => {
    const fetch = respond(chunkedBody(BYTES));
    await expect(drain(downloadModel(modelFor(BYTES, { sha256: "" }), dir, { fetch }))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("removes the partial file when the stream fails mid-way", async () => {
    const fetch = respond(failingBody(BYTES.slice(0, 1024)));
    await expect(drain(downloadModel(modelFor(BYTES), dir, { fetch }))).rejects.toThrow("connection reset");
    expect(await readdir(dir)).toEqual([]);
  });

  it("fails without touching a directory that occupies the partial path", async () => {
    await mkdir(path.join(dir, "model.gguf.part"));
    await expect(drain(downloadModel(modelFor(BYTES), dir, { fetch: respond(chunkedBody(BYTES)) }))).rejects.toThrow();
    expect(existsSync(path.join(dir, "model.gguf"))).toBe(false);
    expect(await readdir(dir)).toEqual(["model.gguf.part"]);
  });

  it("stops and cleans up when aborted", async () => {
    const controller = new AbortController();
    const iterator = downloadModel(modelFor(BYTES), dir, {
      fetch: respond(chunkedBody(BYTES, 64)),
      signal: controller.signal,
    });
    await expect(
      (async () => {
        for await (const _ of iterator) controller.abort();
      })(),
    ).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  it("cleans up when the consumer stops early", async () => {
    const iterator = downloadModel(modelFor(BYTES), dir, { fetch: respond(chunkedBody(BYTES, 64)) });
    for await (const _ of iterator) break;
    expect(await readdir(dir)).toEqual([]);
  });
});
