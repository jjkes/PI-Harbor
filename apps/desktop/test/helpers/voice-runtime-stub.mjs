/**
 * Controllable stand-in for `@pi-harbor/voice-runtime`, loaded in place of
 * the real package by helpers/voice-service-stubs-hook.mjs. Exposes the
 * value exports audio-backend.ts imports plus the classes VoiceService
 * lazily instantiates, with observability for the lifecycle tests:
 * `StubVoiceController.last` keeps the most recent instance so a test can
 * drive `stateChange` events, `StubVoiceController.created` counts runtime
 * constructions, `StubModelManager.unloadCalls` counts model unloads, and
 * `StubTranscriptCleaner.last.unloadCalls` counts releases of the
 * cleanup-model worker.
 */
import { EventEmitter } from "node:events";

export const CAPTURE_SAMPLE_RATE = 16000;
export const FRAME_LENGTH = 512;
export const CLEANUP_MODEL_ID = "qwen3-1.7b";
export function getCleanupModel() {
  return { id: CLEANUP_MODEL_ID, kind: "cleanup" };
}
export function convertFrames() {
  return new Float32Array(0);
}

export class StubModelManager {
  constructor(cacheDir, options = {}) {
    this.cacheDir = cacheDir;
    this.options = options;
    this.unloadCalls = 0;
    this.cancelDownloadCalls = 0;
  }
  unload() {
    this.unloadCalls += 1;
  }
  cancelDownloads() {
    this.cancelDownloadCalls += 1;
  }
  getAllStates() {
    return [];
  }
  getState() {
    return undefined;
  }
  getLocalPath() {
    return null;
  }
  isDownloaded() {
    return false;
  }
  getLoadedModelId() {
    return null;
  }
  async *download() {
    yield 1;
  }
  async deleteModel() {}
}

export class StubTranscriptionEngine {
  constructor(modelManager) {
    this.modelManager = modelManager;
  }
  async transcribe() {
    return { text: "", language: "" };
  }
  async shutdown() {}
}

export class StubTranscriptCleaner {
  static last = null;

  constructor(options) {
    this.options = options;
    this.unloadCalls = 0;
    StubTranscriptCleaner.last = this;
  }
  async clean(raw) {
    return { text: raw, cleanup: { mode: "rules", applied: "rules" } };
  }
  prewarm() {}
  async unload() {
    this.unloadCalls += 1;
  }
}

export class StubProcessPolisher {
  constructor(spawn, modelPath) {
    this.spawn = spawn;
    this.modelPath = modelPath;
  }
  async prepare() {}
  async polish() {
    return "";
  }
  async unload() {}
}

export class StubVoiceController extends EventEmitter {
  static last = null;
  static created = 0;

  constructor(engine, captureFactory, getSettings, cleaner) {
    super();
    StubVoiceController.created += 1;
    this.engine = engine;
    this.modelManager = engine.modelManager;
    this.cleaner = cleaner;
    this.state = { phase: "idle", durationSeconds: 0, volumeLevel: 0 };
    StubVoiceController.last = this;
  }

  async start() {
    this.setPhase("listening");
  }

  async stop() {
    this.setPhase("done");
    return {
      text: "",
      rawText: "",
      cleanup: { mode: "rules", applied: "rules" },
      speechSeconds: 0,
      transcribeSeconds: 0,
      language: "en",
    };
  }

  cancel() {
    this.setPhase("idle");
  }

  dispose() {
    this.setPhase("idle");
  }

  setPhase(phase) {
    this.state = { ...this.state, phase };
    this.emit("stateChange", this.state);
  }
}

// VoiceService destructures the canonical names out of its dynamic import.
export {
  StubModelManager as ModelManager,
  StubProcessPolisher as ProcessPolisher,
  StubTranscriptCleaner as TranscriptCleaner,
  StubTranscriptionEngine as TranscriptionEngine,
  StubVoiceController as VoiceController,
};
