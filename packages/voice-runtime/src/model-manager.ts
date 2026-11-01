import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { TranscribeModel } from "transcribe-cpp";
import { findModel, getCatalog } from "./model-catalog.js";
import { downloadModel, type FetchLike } from "./model-downloader.js";
import type { ModelInfo, ModelState } from "./types.js";

export interface ModelManagerOptions {
  /** Network fetch. Electron Main passes `net.fetch` so the app proxy applies. */
  fetch?: FetchLike;
  /** Hub base URL override (tests). */
  hubUrl?: string;
}

/**
 * Manages model discovery, download, loading, and unloading.
 *
 * - Files live at `<cacheDir>/<modelId>/<hfFilename>`; a file only appears
 *   there after its SHA-256 matched the catalog.
 * - Transcription models load through transcribe-cpp (lazy-imported) and only
 *   one is loaded at a time. Cleanup models are tracked on disk only; their
 *   runtime belongs to `TranscriptCleaner`.
 */
export class ModelManager extends EventEmitter {
  private readonly states = new Map<string, ModelState>();
  private readonly downloads = new Map<string, AbortController>();
  private loadedModelId: string | null = null;
  private loadedModel: TranscribeModel | null = null;
  private loading: { modelId: string; promise: Promise<void> } | null = null;
  /** Bumped by every unload so a load that finishes afterwards is discarded. */
  private generation = 0;

  constructor(
    private readonly cacheDir: string,
    private readonly options: ModelManagerOptions = {},
  ) {
    super();
    for (const info of getCatalog()) {
      const localPath = this.modelPath(info);
      const downloaded = existsSync(localPath);
      this.states.set(info.id, {
        info,
        status: downloaded ? "downloaded" : "not-downloaded",
        localPath: downloaded ? localPath : undefined,
      });
    }
  }

  /** Get all known model states. */
  getAllStates(): ModelState[] {
    return [...this.states.values()];
  }

  /** Get a single model state. */
  getState(modelId: string): ModelState | undefined {
    return this.states.get(modelId);
  }

  /** Get the currently loaded transcription model ID. */
  getLoadedModelId(): string | null {
    return this.loadedModelId;
  }

  /** Get the loaded transcription model instance. */
  getLoadedModel(): TranscribeModel | null {
    return this.loadedModel;
  }

  /** True when the verified model file is on disk. */
  isDownloaded(modelId: string): boolean {
    const state = this.states.get(modelId);
    return !!state?.localPath && state.status !== "downloading";
  }

  /** Local path of a downloaded model, or null. */
  getLocalPath(modelId: string): string | null {
    if (!this.isDownloaded(modelId)) return null;
    return this.states.get(modelId)?.localPath ?? null;
  }

  /**
   * Download a model with progress reporting (0–1). One download per model
   * at a time; `deleteModel` and `cancelDownloads` abort it.
   */
  async *download(modelId: string): AsyncGenerator<number, void, unknown> {
    const info = findModel(modelId);
    if (!info) throw new Error(`Unknown model: ${modelId}`);
    if (this.isDownloaded(modelId)) {
      yield 1;
      return;
    }
    if (this.downloads.has(modelId)) throw new Error(`Model is already downloading: ${modelId}`);

    const controller = new AbortController();
    this.downloads.set(modelId, controller);
    this.updateState(modelId, { status: "downloading", downloadProgress: 0, error: undefined });
    let settled = false;
    try {
      for await (const progress of downloadModel(info, this.modelDir(info), {
        signal: controller.signal,
        fetch: this.options.fetch,
        hubUrl: this.options.hubUrl,
      })) {
        this.updateState(modelId, { status: "downloading", downloadProgress: progress });
        yield progress;
      }
      settled = true;
      this.updateState(modelId, {
        status: "downloaded",
        downloadProgress: 1,
        localPath: this.modelPath(info),
      });
      yield 1;
    } catch (error) {
      settled = true;
      if (controller.signal.aborted) {
        this.updateState(modelId, { status: "not-downloaded", downloadProgress: undefined });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.updateState(modelId, { status: "error", downloadProgress: undefined, error: message });
      }
      throw error;
    } finally {
      if (this.downloads.get(modelId) === controller) this.downloads.delete(modelId);
      if (!settled) {
        // The consumer stopped iterating early; abandon the transfer.
        controller.abort();
        this.updateState(modelId, { status: "not-downloaded", downloadProgress: undefined });
      }
    }
  }

  /** Abort every in-flight download (shutdown). */
  cancelDownloads(): void {
    for (const controller of this.downloads.values()) controller.abort();
  }

  /** Delete a model from disk, aborting its download and unloading it first. */
  async deleteModel(modelId: string): Promise<void> {
    const info = findModel(modelId);
    if (!info) throw new Error(`Unknown model: ${modelId}`);
    this.downloads.get(modelId)?.abort();
    if (this.loadedModelId === modelId || this.loading?.modelId === modelId) this.unload();
    await rm(this.modelDir(info), { recursive: true, force: true });
    this.updateState(modelId, {
      status: "not-downloaded",
      localPath: undefined,
      downloadProgress: undefined,
      error: undefined,
    });
  }

  /** Load a downloaded transcription model, unloading any other one. */
  async ensureLoaded(modelId: string): Promise<void> {
    if (this.loadedModelId === modelId && this.loadedModel) return;
    if (this.loading?.modelId === modelId) return this.loading.promise;

    const info = findModel(modelId);
    if (!info) throw new Error(`Unknown model: ${modelId}`);
    if (info.kind !== "transcription") throw new Error(`Not a transcription model: ${modelId}`);
    const localPath = this.getLocalPath(modelId);
    if (!localPath) throw new Error(`Model not downloaded: ${modelId}`);

    this.unload();
    const generation = this.generation;
    const promise = this.load(modelId, localPath, generation);
    this.loading = { modelId, promise };
    try {
      await promise;
    } finally {
      if (this.loading?.promise === promise) this.loading = null;
    }
  }

  /** Unload the current transcription model and discard any pending load. */
  unload(): void {
    this.generation += 1;
    const model = this.loadedModel;
    const modelId = this.loadedModelId;
    this.loadedModel = null;
    this.loadedModelId = null;
    if (model) {
      try {
        model.dispose();
      } catch {
        // Best effort; the native handle is released with the process anyway.
      }
    }
    if (modelId) this.updateState(modelId, { status: "downloaded" });
  }

  private async load(modelId: string, localPath: string, generation: number): Promise<void> {
    this.updateState(modelId, { status: "loading", error: undefined });
    try {
      const { TranscribeModel } = await import("transcribe-cpp");
      const model = await TranscribeModel.load(localPath);
      if (generation !== this.generation) {
        model.dispose();
        this.updateState(modelId, { status: "downloaded" });
        throw new Error("Model load was cancelled");
      }
      this.loadedModel = model;
      this.loadedModelId = modelId;
      this.updateState(modelId, { status: "loaded" });
    } catch (error) {
      if (generation === this.generation) {
        const message = error instanceof Error ? error.message : String(error);
        this.updateState(modelId, { status: "error", error: message });
      }
      throw error;
    }
  }

  private updateState(modelId: string, patch: Partial<ModelState>): void {
    const current = this.states.get(modelId);
    if (!current) return;
    const next: ModelState = { ...current, ...patch };
    this.states.set(modelId, next);
    this.emit("modelStateChanged", modelId, next);
  }

  private modelDir(info: ModelInfo): string {
    return path.join(this.cacheDir, info.id);
  }

  private modelPath(info: ModelInfo): string {
    return path.join(this.modelDir(info), info.hfFilename);
  }
}
