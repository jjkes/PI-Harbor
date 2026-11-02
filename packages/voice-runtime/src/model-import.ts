import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { mkdir, rename, rm } from "node:fs/promises";
import { findModel } from "./model-catalog.js";
import { modelDownloadUrl, MODEL_HUB_URLS } from "./model-downloader.js";
import type { ModelInfo } from "./types.js";

/** Absolute http(s) URLs a user can paste to fetch this model manually. */
export function modelManualDownloadUrls(info: ModelInfo): string[] {
  return MODEL_HUB_URLS.map((hub) => modelDownloadUrl(info, hub));
}

export interface ModelImportManager {
  /** Currently known state; an active download is a reason to refuse. */
  getState(modelId: string): { status?: string } | undefined;
  /** Unload the model if it is loaded before replacing its file. */
  deleteModel(modelId: string): Promise<void>;
}

/**
 * Install a model file the user downloaded elsewhere.
 *
 * Only the exact pinned size and SHA-256 are accepted, so a manual import
 * cannot put arbitrary bytes where the runtime will load them. Bytes stream
 * into `<cacheDir>/<id>/<file>.import.part` and are renamed into place only on
 * a checksum match, which also discards an interrupted download of the same
 * model. An already installed model is unloaded first.
 */
export async function importModelFile(
  manager: ModelImportManager,
  modelId: string,
  filePath: string,
  options: {
    cacheDir: string;
    /** Test seam: defaults to the pinned catalog entry for `modelId`. */
    info?: ModelInfo;
  },
): Promise<{ installed: true; path: string }> {
  const info = options.info ?? findModel(modelId);
  if (!info) throw new Error(`Unknown model: ${modelId}`);
  if (manager.getState(modelId)?.status === "downloading") {
    throw new Error("A download for this model is already in progress");
  }
  // Unloading also drops a stale state; a failure to replace the file later
  // simply leaves the model not downloaded instead of pointing at old bytes.
  await manager.deleteModel(modelId);

  const modelDir = path.join(options.cacheDir, info.id);
  const target = path.join(modelDir, info.hfFilename);
  await mkdir(modelDir, { recursive: true });
  const staging = path.join(modelDir, `${info.hfFilename}.import.part`);

  const hash = createHash("sha256");
  let total = 0;
  const source = createReadStream(filePath);
  const sink = createWriteStream(staging, { flags: "w" });
  let sinkError: unknown = null;
  const sinkFailure = new Promise<never>((_, reject) => {
    sink.on("error", (error) => {
      sinkError = error;
      reject(error);
    });
  });
  sinkFailure.catch(() => undefined);
  const sinkClosed = new Promise<void>((resolve) => sink.once("close", () => resolve()));

  let verified = false;
  try {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
      total += (chunk as Buffer).byteLength;
      if (!sink.write(chunk)) await Promise.race([once(sink, "drain"), sinkFailure]);
    }
    sink.end();
    await Promise.race([sinkClosed, sinkFailure]);
    if (sinkError !== null) throw sinkError;
    if (total !== info.sizeBytes) {
      throw new Error(
        `Wrong model file: expected ${info.sizeBytes} bytes for ${info.hfFilename}, got ${total}`,
      );
    }
    if (hash.digest("hex") !== info.sha256) {
      throw new Error(`The file does not match the pinned ${info.name} model`);
    }
    await rename(staging, target);
    // An import completes the model, so an interrupted download no longer
    // needs its partial file.
    await rm(`${target}.part`, { force: true });
    verified = true;
    return { installed: true, path: target };
  } finally {
    if (!verified) {
      source.destroy();
      sink.destroy();
      await sinkClosed;
      await rm(staging, { force: true }).catch(() => undefined);
    }
  }
}
