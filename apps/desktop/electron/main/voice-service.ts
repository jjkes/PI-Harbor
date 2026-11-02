/**
 * VoiceService — orchestrates local Dictation in the Electron main process.
 *
 * Lazily loads @pi-harbor/voice-runtime on first use so that Voice disabled
 * means zero import overhead at startup. The recognizer (transcribe-cpp) runs
 * here. The optional cleanup model runs in its own utility process: its ggml
 * build collides with transcribe-cpp's in one process (see spawnPolisherWorker).
 */
import { IPC } from "@pi-harbor/shared";
import { BrowserWindow, dialog, net, utilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { onConfirmedQuit } from "./bootstrap/confirmed-quit";
import { PvRecorderBackend, checkMicrophonePermission, requestMicrophonePermission } from "./audio-backend";
import { getModuleDirectory } from "./module-path";
import { configurePackagedTranscribeLibrary } from "./voice-native-paths";
import type { Logger } from "./logger";
import type {
  AudioCaptureFactory,
  AudioInputDevice,
  ModelState,
  PolisherChannel,
  VoiceResult,
  VoiceSettings,
  VoiceState,
} from "@pi-harbor/voice-runtime";

// Lazy-loaded runtime classes
type VoiceControllerT = import("@pi-harbor/voice-runtime").VoiceController;
type TranscriptionEngineT = import("@pi-harbor/voice-runtime").TranscriptionEngine;
type ModelManagerT = import("@pi-harbor/voice-runtime").ModelManager;
type TranscriptCleanerT = import("@pi-harbor/voice-runtime").TranscriptCleaner;

// The recommended whisper-large-v3-turbo weights alone hold ~1.5 GiB of
// main-process memory once loaded, and transcription buffers sit on top of
// that. Unloading after a quiet spell keeps an idle app from pinning that
// memory forever (issue #1528); the model reloads from disk in a few seconds
// on the next recording. The same timer ends the cleanup worker (~1.7 GB).
const MODEL_IDLE_UNLOAD_MS = 10 * 60 * 1000;

// Phases in which no recording or transcription can be in flight, so the
// loaded model is safe to drop.
const TERMINAL_VOICE_PHASES = new Set(["idle", "done", "error"]);

/**
 * Fork the cleanup-model worker (out/main/voice-polisher-worker.js).
 * node-llama-cpp and transcribe-cpp ship different ggml builds under the same
 * dylib install name; loading both in one process crashed with SIGSEGV, so
 * the cleanup model never loads in Main. A worker crash only fails the
 * in-flight cleanup, which falls back to the rule-based text.
 */
function spawnPolisherWorker(): PolisherChannel {
  const child = utilityProcess.fork(
    join(getModuleDirectory(import.meta.url), "voice-polisher-worker.js"),
    [],
    { serviceName: "Dictation cleanup" },
  );
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => {
      child.on("message", listener);
    },
    onExit: (listener) => {
      child.on("exit", listener);
    },
    kill: () => {
      child.kill();
    },
  };
}

export type VoiceServiceOptions = {
  /**
   * Comma-separated hub origins for model downloads (`PI_VOICE_MODEL_HUB`).
   * Parsed when the runtime loads, so Voice off keeps importing nothing.
   */
  modelHubOverride?: string;
  /** NDJSON logger from Main; download failures are recorded here. */
  logger?: Pick<Logger, "log">;
};

export class VoiceService {
  private controller: VoiceControllerT | null = null;
  private engine: TranscriptionEngineT | null = null;
  private modelManager: ModelManagerT | null = null;
  private cleaner: TranscriptCleanerT | null = null;
  private cleanupModelId: string | null = null;
  private runtimeLoading: Promise<void> | null = null;
  private captureFactory: AudioCaptureFactory;
  private settings: VoiceSettings;
  private disposed = false;
  private releaseMicrophoneLease: (() => void) | null = null;
  private modelIdleUnloadTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly modelCacheDir: string,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly acquireMicrophoneLease: (token: string) => () => void = () => () => undefined,
    private readonly options: VoiceServiceOptions = {},
  ) {
    this.captureFactory = new PvRecorderBackend();
    // Will be overridden from app settings
    this.settings = {
      enabled: false,
      deviceId: null,
      languages: ["zh", "en"],
      chineseVariant: "simplified",
      modelId: "",
      cleanupMode: "rules",
    };
  }

  // ---- Settings ----

  updateSettings(patch: Partial<VoiceSettings>): void {
    const leavingLlm =
      this.settings.cleanupMode === "llm" &&
      patch.cleanupMode !== undefined &&
      patch.cleanupMode !== "llm";
    this.settings = { ...this.settings, ...patch };
    // The cleanup worker cannot run in any other mode; give its memory back.
    if (leavingLlm) this.releaseCleaner();
  }

  getSettings(): VoiceSettings {
    return { ...this.settings };
  }

  // ---- Lazy initialization ----

  /** Single-flight: concurrent callers share one runtime. */
  private ensureRuntime(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("VoiceService is disposed"));
    if (this.controller) return Promise.resolve();
    this.runtimeLoading ??= this.loadRuntime().finally(() => {
      this.runtimeLoading = null;
    });
    return this.runtimeLoading;
  }

  private async loadRuntime(): Promise<void> {
    // koffi cannot dlopen a library inside app.asar; point transcribe-cpp at
    // the unpacked copy before the runtime first imports it.
    configurePackagedTranscribeLibrary(app.isPackaged, process.resourcesPath);

    const {
      VoiceController,
      TranscriptionEngine,
      ModelManager,
      TranscriptCleaner,
      ProcessPolisher,
      getCleanupModel,
      parseModelHubUrls,
    } = await import("@pi-harbor/voice-runtime");
    if (this.disposed || this.controller) return;
    const hubUrls = parseModelHubUrls(this.options.modelHubOverride);

    // net.fetch uses Chromium's network stack, so the app's proxy setting
    // applies; hubUrls adds the reachable mirror behind the pinned origin.
    const modelManager = new ModelManager(this.modelCacheDir, {
      fetch: (url, init) => net.fetch(url, init),
      ...(hubUrls.length ? { hubUrls } : {}),
    });
    const cleanupModelId = getCleanupModel().id;
    const cleaner = new TranscriptCleaner({
      resolveModelPath: () => modelManager.getLocalPath(cleanupModelId),
      createPolisher: (modelPath) => new ProcessPolisher(spawnPolisherWorker, modelPath),
    });
    const engine = new TranscriptionEngine(modelManager);
    const controller = new VoiceController(engine, this.captureFactory, () => this.settings, cleaner);

    // Forward state changes to renderer
    controller.on("stateChange", (state: VoiceState) => {
      this.sendToRenderer(IPC.event.voiceStateChanged, state);
      if (TERMINAL_VOICE_PHASES.has(state.phase)) {
        this.releaseCurrentMicrophoneLease();
        this.scheduleModelIdleUnload();
      }
    });
    controller.on("partialError", (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.options.logger?.log(
        "app",
        "diagnostics",
        "warn",
        "voice dictation live preview failed",
        { event: "voice.dictation.partial-failed", code: "partial-failed", data: { detail } },
      );
    });

    this.modelManager = modelManager;
    this.engine = engine;
    this.cleaner = cleaner;
    this.cleanupModelId = cleanupModelId;
    this.controller = controller;
  }

  /**
   * Drop the loaded model and end the cleanup worker after
   * MODEL_IDLE_UNLOAD_MS without a recording. The timer is cancelled whenever
   * a new recording starts and re-checked against the live phase before
   * unloading, so an in-flight recording is never interrupted.
   */
  private scheduleModelIdleUnload(): void {
    if (this.disposed || !this.controller) return;
    this.cancelModelIdleUnload();
    this.modelIdleUnloadTimer = setTimeout(() => {
      this.modelIdleUnloadTimer = null;
      if (this.disposed) return;
      const phase = this.controller?.state.phase;
      if (!phase || !TERMINAL_VOICE_PHASES.has(phase)) return;
      try {
        this.modelManager?.unload();
      } catch {
        // Best-effort trim; the model reloads on next use either way.
      }
      this.releaseCleaner();
    }, MODEL_IDLE_UNLOAD_MS);
    this.modelIdleUnloadTimer.unref?.();
  }

  private cancelModelIdleUnload(): void {
    if (this.modelIdleUnloadTimer) {
      clearTimeout(this.modelIdleUnloadTimer);
      this.modelIdleUnloadTimer = null;
    }
  }

  /** Ends the cleanup worker, if any; the next `llm` cleanup starts a new one. */
  private releaseCleaner(): void {
    this.cleaner?.unload().catch(() => undefined);
  }

  // ---- Recording lifecycle ----

  async start(overrides?: Partial<VoiceSettings>): Promise<void> {
    if (this.disposed) throw new Error("VoiceService is disposed");

    this.cancelModelIdleUnload();

    try {
      if (overrides) {
        this.updateSettings(overrides);
      }

      await this.ensureRuntime();
      const controller = this.controller;
      if (!controller) throw new Error("VoiceService is disposed");
      this.releaseCurrentMicrophoneLease();
      this.releaseMicrophoneLease = this.acquireMicrophoneLease(randomUUID());
      await controller.start();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "start-failed";
      this.options.logger?.log(
        "app",
        "diagnostics",
        "error",
        "voice dictation start failed",
        { event: "voice.dictation.start-failed", code, data: { detail } },
      );
      this.releaseCurrentMicrophoneLease();
      // A rejected start may leave the controller in a terminal phase without
      // emitting stateChange; do not strand the pending idle unload.
      this.scheduleModelIdleUnload();
      throw error;
    }
  }

  /** Resolves null when the recording was cancelled before it finished. */
  async stop(): Promise<VoiceResult | null> {
    if (!this.controller) throw new Error("Voice not started");
    try {
      return await this.controller.stop();
    } finally {
      this.releaseCurrentMicrophoneLease();
    }
  }

  cancel(): void {
    this.controller?.cancel();
    this.releaseCurrentMicrophoneLease();
    // Cancelling from an idle phase emits no stateChange, so schedule here
    // too; scheduling twice is harmless.
    this.scheduleModelIdleUnload();
  }

  getState(): VoiceState {
    return (
      this.controller?.state ?? {
        phase: "idle" as const,
        durationSeconds: 0,
        volumeLevel: 0,
      }
    );
  }

  // ---- Devices ----

  async getDevices(): Promise<AudioInputDevice[]> {
    return this.captureFactory.getDevices();
  }

  // ---- Models ----

  /** Settings lists the catalog before any recording; this loads no model. */
  async getModels(): Promise<ModelState[]> {
    if (this.disposed) return [];
    await this.ensureRuntime();
    return this.modelManager?.getAllStates() ?? [];
  }

  async downloadModel(modelId: string): Promise<void> {
    await this.ensureRuntime();
    const modelManager = this.modelManager;
    if (!modelManager) return;
    try {
      for await (const progress of modelManager.download(modelId)) {
        this.sendToRenderer(IPC.event.voiceModelProgress, { modelId, progress });
      }
    } catch (error) {
      // A cancelled download already reports its own state; only a real
      // failure is worth a log line and a diagnostic message for the user.
      const message = error instanceof Error ? error.message : String(error);
      if (!/abort/i.test(message)) {
        this.options.logger?.log(
          "app",
          "diagnostics",
          "error",
          `voice model download failed: ${modelId}`,
          { event: "voice.model.download-failed", code: "download-failed", data: { detail: message } },
        );
      }
      throw error;
    }
  }
  /**
   * Ask the user for a model file and install it after verifying it against the
   * catalog's pinned size and checksum.
   */
  async importModel(modelId: string): Promise<{ canceled?: boolean; path?: string }> {
    await this.ensureRuntime();
    const modelManager = this.modelManager;
    if (!modelManager) return { canceled: true };
    const result = await dialog.showOpenDialog({
      title: "Import model",
      properties: ["openFile"],
      filters: [{ name: "Model file", extensions: ["gguf", "bin"] }],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    const file = result.filePaths[0]!;
    const path = await modelManager.importFile(modelId, file);
    this.options.logger?.log("app", "diagnostics", "info", `voice model imported: ${modelId}`, {
      event: "voice.model.imported",
      data: { path },
    });
    return { path };
  }

  async deleteModel(modelId: string): Promise<void> {
    if (modelId === this.cleanupModelId) await this.cleaner?.unload();
    await this.modelManager?.deleteModel(modelId);
  }

  // ---- Permissions ----

  async checkPermission(): Promise<"granted" | "denied" | "undetermined"> {
    return checkMicrophonePermission();
  }

  async requestPermission(): Promise<boolean> {
    return requestMicrophonePermission();
  }

  // ---- Lifecycle ----

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelModelIdleUnload();
    this.controller?.dispose();
    this.releaseCurrentMicrophoneLease();
    this.modelManager?.cancelDownloads();
    this.releaseCleaner();
    void this.engine?.shutdown();
    this.controller = null;
    this.engine = null;
    this.modelManager = null;
    this.cleaner = null;
  }

  // ---- IPC helpers ----

  private sendToRenderer(channel: string, data: unknown): void {
    try {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    } catch {
      // Window may be closing
    }
  }

  private releaseCurrentMicrophoneLease(): void {
    this.releaseMicrophoneLease?.();
    this.releaseMicrophoneLease = null;
  }
}

export function createVoiceService(
  modelCacheDir: string,
  getWindow: () => BrowserWindow | null,
  acquireMicrophoneLease?: (token: string) => () => void,
  options: VoiceServiceOptions = {},
): VoiceService {
  const service = new VoiceService(modelCacheDir, getWindow, acquireMicrophoneLease, options);
  // A cancelled quit keeps the app running, so disposal waits for a committed
  // quit instead of the cancellable `before-quit`.
  onConfirmedQuit(() => service.dispose());
  return service;
}
