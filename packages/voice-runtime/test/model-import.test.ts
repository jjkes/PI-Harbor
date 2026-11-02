import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importModelFile } from "../src/model-import.js";
import type { ModelInfo } from "../src/types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "voice-model-import-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BYTES = new Uint8Array(8192).map((_, index) => index % 251);

function testModel(): ModelInfo {
  return {
    id: "test-model",
    kind: "transcription",
    name: "Test",
    description: "Test model",
    languages: ["en"],
    sizeBytes: BYTES.length,
    hfRepo: "test/repo",
    hfFilename: "model.gguf",
    sha256: createHash("sha256").update(BYTES).digest("hex"),
    supportsStreaming: false,
    recommended: false,
  };
}

function manager() {
  const deleted: string[] = [];
  const state = { status: "not-downloaded" };
  return {
    deleted,
    state,
    getState: () => state,
    deleteModel: async (id: string) => {
      deleted.push(id);
      state.status = "not-downloaded";
    },
  };
}

describe("importModelFile", () => {
  it("installs the exact pinned file and drops an interrupted download", async () => {
    const info = testModel();
    const cacheDir = path.join(dir, "cache");
    const source = path.join(dir, "source.gguf");
    await writeFile(source, BYTES);
    // A leftover .part from an interrupted download is cleared on import.
    await mkdir(path.join(cacheDir, info.id), { recursive: true });
    await writeFile(path.join(cacheDir, info.id, "model.gguf.part"), new Uint8Array(4));
    const mgr = manager();
    const result = await importModelFile(mgr, "test-model", source, { cacheDir, info });
    assert.equal(result.installed, true);
    const target = path.join(cacheDir, info.id, info.hfFilename);
    assert.equal((await readFile(target)).byteLength, BYTES.length);
    assert.deepEqual(mgr.deleted, ["test-model"]);
    assert.deepEqual(await readdir(path.join(cacheDir, info.id)), [info.hfFilename]);
  });

  it("refuses a file whose size does not match the catalog", async () => {
    const info = testModel();
    const source = path.join(dir, "small.gguf");
    await writeFile(source, new Uint8Array(16));
    await expect(
      importModelFile(manager(), "test-model", source, {
        cacheDir: path.join(dir, "cache"),
        info,
      }),
    ).rejects.toThrow(/expected .* bytes/);
  });

  it("refuses a file whose checksum does not match the catalog", async () => {
    const info = testModel();
    const source = path.join(dir, "wrong.gguf");
    await writeFile(source, new Uint8Array(info.sizeBytes).fill(1));
    await expect(
      importModelFile(manager(), "test-model", source, {
        cacheDir: path.join(dir, "cache"),
        info,
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("refuses to import while a download is in progress", async () => {
    const mgr = manager();
    mgr.state.status = "downloading";
    await expect(
      importModelFile(mgr, "test-model", path.join(dir, "x.gguf"), {
        cacheDir: path.join(dir, "cache"),
        info: testModel(),
      }),
    ).rejects.toThrow(/already in progress/);
  });

  it("rejects an unknown model id", async () => {
    await expect(
      importModelFile(manager(), "no-such-model", path.join(dir, "x.gguf"), {
        cacheDir: path.join(dir, "cache"),
      }),
    ).rejects.toThrow(/Unknown model/);
  });
});
