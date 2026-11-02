import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadModel,
  MIRROR_HUB_URL,
  modelDownloadUrl,
  parseModelHubUrls,
  type FetchLike,
} from "../src/model-downloader.js";
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

  it("names the host and stops after a definitive answer instead of trying the mirror", async () => {
    const fetch = respond(null, { status: 404 });
    await expect(drain(downloadModel(modelFor(BYTES), dir, { fetch }))).rejects.toThrow(
      /404.*huggingface\.co/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses a model without a pinned checksum", async () => {
    const fetch = respond(chunkedBody(BYTES));
    await expect(drain(downloadModel(modelFor(BYTES, { sha256: "" }), dir, { fetch }))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the partial file when the stream fails mid-way, so the next attempt resumes", async () => {
    const fetch = respond(failingBody(BYTES.slice(0, 1024)));
    // One source only: the fallback would otherwise repeat the same failure.
    await expect(
      drain(downloadModel(modelFor(BYTES), dir, { fetch, hubUrl: "https://only.example" })),
    ).rejects.toThrow("connection reset");
    expect(await readdir(dir)).toEqual(["model.gguf.part"]);
    expect((await readFile(path.join(dir, "model.gguf.part"))).byteLength).toBe(1024);
  });

  it("fails without touching a directory that occupies the partial path", async () => {
    await mkdir(path.join(dir, "model.gguf.part"));
    await expect(drain(downloadModel(modelFor(BYTES), dir, { fetch: respond(chunkedBody(BYTES)) }))).rejects.toThrow();
    expect(existsSync(path.join(dir, "model.gguf"))).toBe(false);
    expect(await readdir(dir)).toEqual(["model.gguf.part"]);
  });

  it("stops, keeps the partial file of a cancelled download, and reports abort", async () => {
    const controller = new AbortController();
    const iterator = downloadModel(modelFor(BYTES), dir, {
      fetch: respond(chunkedBody(BYTES, 64)),
      signal: controller.signal,
      hubUrl: "https://only.example",
    });
    await expect(
      (async () => {
        for await (const _ of iterator) controller.abort();
      })(),
    ).rejects.toThrow();
    // A cancel is a pause, not a failure: the bytes stay for the next attempt.
    expect(await readdir(dir)).toEqual(["model.gguf.part"]);
  });

  it("keeps the partial file when the consumer stops early", async () => {
    const iterator = downloadModel(modelFor(BYTES), dir, {
      fetch: respond(chunkedBody(BYTES, 64)),
      hubUrl: "https://only.example",
    });
    for await (const _ of iterator) break;
    expect(await readdir(dir)).toEqual(["model.gguf.part"]);
  });
});

describe("download sources", () => {
  it("falls back to the mirror when the pinned host cannot be reached", async () => {
    const info = modelFor(BYTES);
    const calls: string[] = [];
    const fetch = vi.fn<FetchLike>(async (url) => {
      calls.push(url);
      if (calls.length === 1) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: new Error("ECONNRESET before secure TLS connection"),
        });
      }
      return new Response(chunkedBody(BYTES), {
        headers: { "content-length": String(BYTES.length) },
      });
    });

    const progress = await drain(downloadModel(info, dir, { fetch }));

    expect(calls).toEqual([modelDownloadUrl(info), modelDownloadUrl(info, MIRROR_HUB_URL)]);
    expect(progress.at(-1)).toBe(1);
    expect(await readFile(path.join(dir, "model.gguf"))).toEqual(Buffer.from(BYTES));
  });

  it("keeps the configured order and de-duplicates it", async () => {
    const calls: string[] = [];
    const fetch = vi.fn<FetchLike>(async (url) => {
      calls.push(url);
      return new Response(null, { status: 503 });
    });
    await expect(
      drain(
        downloadModel(modelFor(BYTES), dir, {
          fetch,
          hubUrls: ["https://a.example/", "https://a.example", "https://b.example"],
        }),
      ),
    ).rejects.toThrow(/503.*b\.example/);
    expect(calls.map((url) => new URL(url).host)).toEqual(["a.example", "b.example"]);
  });
});

describe("resumable downloads", () => {
  it("continues a partial file with a Range request and verifies the whole file", async () => {
    const info = modelFor(BYTES);
    await writeFile(path.join(dir, "model.gguf.part"), BYTES.slice(0, 1024));
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=1024-");
      return new Response(chunkedBody(BYTES.slice(1024)), {
        status: 206,
        headers: { "content-range": `bytes 1024-${BYTES.length - 1}/${BYTES.length}` },
      });
    });

    const progress = await drain(
      downloadModel(info, dir, { fetch, hubUrl: "https://only.example" }),
    );

    // The first report already reflects the resumed bytes instead of restarting at 0.
    expect(progress[0]).toBeGreaterThan(0.2);
    expect(progress.at(-1)).toBe(1);
    expect(await readFile(path.join(dir, "model.gguf"))).toEqual(Buffer.from(BYTES));
    expect(await readdir(dir)).toEqual(["model.gguf"]);
  });

  it("restarts from scratch when the source ignores the range", async () => {
    const info = modelFor(BYTES);
    await writeFile(path.join(dir, "model.gguf.part"), new Uint8Array(1024));
    const fetch = vi.fn<FetchLike>(
      async () =>
        new Response(chunkedBody(BYTES), {
          headers: { "content-length": String(BYTES.length) },
        }),
    );

    await drain(downloadModel(info, dir, { fetch, hubUrl: "https://only.example" }));

    expect(await readFile(path.join(dir, "model.gguf"))).toEqual(Buffer.from(BYTES));
  });

  it("drops a range the source rejects and asks for the whole file", async () => {
    const info = modelFor(BYTES);
    await writeFile(path.join(dir, "model.gguf.part"), BYTES.slice(0, 1024));
    const ranges: Array<string | null> = [];
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      const range = new Headers(init?.headers).get("range");
      ranges.push(range);
      if (range) return new Response(null, { status: 416 });
      return new Response(chunkedBody(BYTES), {
        headers: { "content-length": String(BYTES.length) },
      });
    });

    await drain(downloadModel(info, dir, { fetch, hubUrl: "https://only.example" }));

    expect(ranges).toEqual(["bytes=1024-", null]);
    expect(await readFile(path.join(dir, "model.gguf"))).toEqual(Buffer.from(BYTES));
  });
});

describe("parseModelHubUrls", () => {
  it("keeps http(s) origins, trims trailing slashes, and drops duplicates", () => {
    expect(
      parseModelHubUrls(
        "https://a.example/, http://b.example, https://a.example, ftp://c.example, , https://d.example/mirror/",
      ),
    ).toEqual(["https://a.example", "http://b.example", "https://d.example/mirror"]);
    expect(parseModelHubUrls("")).toEqual([]);
    expect(parseModelHubUrls(undefined)).toEqual([]);
  });
});
