import { EventEmitter } from "node:events";
import { cleanTranscript } from "./cleanup/pipeline.js";
import { CAPTURE_SAMPLE_RATE, FRAME_LENGTH } from "./audio-constants.js";
import type { TranscriptCleaner } from "./cleanup/transcript-cleaner.js";
import { convertFrames } from "./pcm-utils.js";
import type { TranscriptionEngine } from "./transcription-engine.js";
import type {
  AudioCapture,
  AudioCaptureFactory,
  VoiceErrorCode,
  VoicePhase,
  VoiceResult,
  VoiceSettings,
  VoiceState,
} from "./types.js";

const INITIAL_STATE: VoiceState = {
  phase: "idle",
  durationSeconds: 0,
  volumeLevel: 0,
};

/** Phases from which a new recording may start. */
const STARTABLE_PHASES = new Set<VoicePhase>(["idle", "ready", "done", "error"]);

/** Pause between live-preview passes; one pass runs at a time. */
const PARTIAL_INTERVAL_MS = 800;
const MIN_PARTIAL_FRAMES = Math.ceil((0.6 * CAPTURE_SAMPLE_RATE) / FRAME_LENGTH);

/** The part of TranscriptCleaner the controller drives. */
export type TranscriptCleanupStage = Pick<TranscriptCleaner, "clean" | "prewarm">;

/** Cleanup without a local model; `llm` mode falls back to rules ("model-missing"). */
const RULES_ONLY_CLEANUP: TranscriptCleanupStage = {
  clean: (raw, request) => cleanTranscript(raw, { ...request, polisher: null }),
  prewarm: () => undefined,
};

/** A failure with a stable category the renderer can localize. */
export class VoiceInputError extends Error {
  constructor(
    readonly code: VoiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VoiceInputError";
  }
}

/**
 * Manages the dictation lifecycle:
 * prepare → start → listen → stop → transcribe → clean up → result.
 *
 * Every await in start/stop re-checks the recording's own abort signal, so a
 * cancelled recording never writes state that belongs to a later one.
 *
 * Events:
 * - "stateChange" (state: VoiceState)
 * - "volumeLevel" (level: number)
 * - "partialError" (error: unknown): live preview failed; recording continues
 */
export class VoiceController extends EventEmitter {
  private _state: VoiceState = { ...INITIAL_STATE };
  private capture: AudioCapture | null = null;
  private frames: Int16Array[] = [];
  private abort: AbortController | null = null;
  private startedAt = 0;
  private disposed = false;
  private partialTimer: ReturnType<typeof setTimeout> | null = null;
  private partialTask: Promise<void> | null = null;
  private partialAbort: AbortController | null = null;
  private partialFramesSeen = 0;
  private partialText = "";
  private partialFailureReported = false;

  constructor(
    private readonly engine: TranscriptionEngine,
    private readonly captureFactory: AudioCaptureFactory,
    private readonly getSettings: () => VoiceSettings,
    private readonly cleaner: TranscriptCleanupStage = RULES_ONLY_CLEANUP,
  ) {
    super();
  }

  get state(): VoiceState {
    return this._state;
  }

  /** Pre-load the selected model for a faster first recording. */
  async prepare(): Promise<void> {
    await this.loadModel(undefined);
  }

  /** Start recording. Loads the model first when needed. */
  async start(): Promise<void> {
    if (this.disposed) throw new Error("Controller is disposed");

    const { phase } = this._state;
    if (!STARTABLE_PHASES.has(phase)) {
      throw new Error(`Cannot start from phase: ${phase}`);
    }

    const settings = this.getSettings();
    const abort = new AbortController();
    this.abort = abort;

    const loaded = this.engine.modelManager.getLoadedModelId() === settings.modelId;
    if (phase !== "ready" || !loaded) {
      try {
        await this.loadModel(abort.signal);
      } catch (error) {
        if (this.abort === abort) this.abort = null;
        throw error;
      }
      if (abort.signal.aborted || this.disposed) return;
    }

    this.setState({ phase: "starting", durationSeconds: 0, volumeLevel: 0 });

    try {
      await this.ensureMicrophonePermission();
      if (abort.signal.aborted) return;

      this.frames = [];
      const capture = this.captureFactory.create(settings.deviceId);
      this.capture = capture;
      capture.onFrame((frame) => {
        if (this.capture === capture) this.onFrame(frame);
      });
      await capture.start();
      if (abort.signal.aborted) {
        // Cancelled while the recorder was opening.
        capture.cancel();
        return;
      }
      this.startedAt = performance.now();
      this.setState({ phase: "listening", durationSeconds: 0, volumeLevel: 0 });
      this.cleaner.prewarm(settings.cleanupMode);
      this.partialFramesSeen = 0;
      this.partialText = "";
      this.partialFailureReported = false;
      this.partialAbort = new AbortController();
      this.schedulePartial(abort);
    } catch (error) {
      if (abort.signal.aborted) return;
      this.cleanup();
      this.fail(error);
      throw error;
    }
  }

  /**
   * Stop recording, transcribe, and clean up the text. Resolves null when the
   * recording was cancelled meanwhile.
   */
  async stop(): Promise<VoiceResult | null> {
    if (this._state.phase !== "listening") {
      throw new Error(`Cannot stop from phase: ${this._state.phase}`);
    }
    const abort = this.abort;
    if (!abort) throw new Error("No active recording");
    const { signal } = abort;

    const settings = this.getSettings();
    const speechSeconds = (performance.now() - this.startedAt) / 1000;
    this.clearPartialTimer();
    this.partialAbort?.abort();
    this.setState({ ...this._state, phase: "transcribing", volumeLevel: 0 });

    try {
      await this.capture?.stop();
      if (signal.aborted) return null;
      // A partial pass may still hold the recognizer; let it leave before the
      // authoritative full-audio pass starts.
      await this.partialTask;
      if (signal.aborted) return null;
      const pcm = convertFrames(this.frames);
      this.frames = [];

      const transcribeStart = performance.now();
      const transcript = await this.engine.transcribe(
        pcm,
        { languages: settings.languages, chineseVariant: settings.chineseVariant },
        signal,
      );
      if (signal.aborted) return null;

      const cleaned = await this.cleaner.clean(transcript.text, {
        mode: settings.cleanupMode,
        languages: settings.languages,
        detectedLanguage: transcript.language,
        signal,
      });
      if (signal.aborted) return null;

      const result: VoiceResult = {
        text: cleaned.text,
        rawText: transcript.text,
        cleanup: cleaned.cleanup,
        speechSeconds,
        transcribeSeconds: (performance.now() - transcribeStart) / 1000,
        language: transcript.language || (settings.languages[0] ?? "en"),
      };
      this.cleanup();
      this.setState({ phase: "done", durationSeconds: speechSeconds, volumeLevel: 0, result });
      return result;
    } catch (error) {
      if (signal.aborted) return null;
      this.cleanup();
      this.fail(error, speechSeconds);
      throw error;
    }
  }

  /** Cancel recording or transcription without producing a result. */
  cancel(): void {
    if (this._state.phase === "idle") return;

    this.setState({ phase: "cancelling", durationSeconds: 0, volumeLevel: 0 });
    this.abort?.abort();
    this.partialAbort?.abort();
    this.clearPartialTimer();
    if (this.capture?.isActive) {
      this.capture.cancel();
    }
    this.cleanup();
    this.setState({ ...INITIAL_STATE });
  }

  /** Release all resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.removeAllListeners();
  }

  private async loadModel(signal: AbortSignal | undefined): Promise<void> {
    if (this.disposed) return;
    const { modelId } = this.getSettings();
    try {
      this.requireModel(modelId);
      this.setState({ phase: "preparing", durationSeconds: 0, volumeLevel: 0 });
      await this.engine.modelManager.ensureLoaded(modelId);
      if (signal?.aborted) return;
      this.setState({ phase: "ready", durationSeconds: 0, volumeLevel: 0 });
    } catch (error) {
      if (signal?.aborted) return;
      this.fail(error);
      throw error;
    }
  }

  private requireModel(modelId: string): void {
    if (!modelId) throw new VoiceInputError("no-model", "No model selected");
    if (!this.engine.modelManager.isDownloaded(modelId)) {
      throw new VoiceInputError("model-not-downloaded", `Model not downloaded: ${modelId}`);
    }
  }

  private async ensureMicrophonePermission(): Promise<void> {
    let status = await this.captureFactory.checkPermission();
    if (status === "undetermined") {
      status = (await this.captureFactory.requestPermission()) ? "granted" : "denied";
    }
    if (status !== "granted") {
      throw new VoiceInputError("microphone-denied", "Microphone access denied");
    }
  }

  /**
   * Run one preview pass after the interval, then schedule the next from the
   * pass's settlement so two transcriptions never share the recognizer.
   */
  private schedulePartial(recording: AbortController): void {
    this.clearPartialTimer();
    const partialAbort = this.partialAbort;
    if (!partialAbort || this.disposed) return;

    this.partialTimer = setTimeout(() => {
      this.partialTimer = null;
      if (this.abort !== recording || this._state.phase !== "listening") return;

      let task: Promise<void>;
      task = this.transcribePartial(recording, partialAbort.signal)
        .catch((error: unknown) => {
          if (partialAbort.signal.aborted || this.disposed) return;
          if (this.partialFailureReported) return;
          this.partialFailureReported = true;
          this.emit("partialError", error);
        })
        .finally(() => {
          if (this.partialTask === task) this.partialTask = null;
          if (this.abort === recording && this._state.phase === "listening") {
            this.schedulePartial(recording);
          }
        });
      this.partialTask = task;
    }, PARTIAL_INTERVAL_MS);
    this.partialTimer.unref?.();
  }

  private async transcribePartial(
    recording: AbortController,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.abort !== recording || this._state.phase !== "listening") return;
    const frameCount = this.frames.length;
    if (frameCount < MIN_PARTIAL_FRAMES || frameCount === this.partialFramesSeen) return;
    this.partialFramesSeen = frameCount;

    const settings = this.getSettings();
    const pcm = convertFrames(this.frames);
    const transcript = await this.engine.transcribe(
      pcm,
      { languages: settings.languages, chineseVariant: settings.chineseVariant },
      signal,
    );
    if (signal.aborted || this.abort !== recording || this._state.phase !== "listening") {
      return;
    }

    // A preview must stay cheap: in `llm` mode show the rules result now and
    // let the final pass apply the model rewrite.
    const cleaned = await cleanTranscript(transcript.text, {
      mode: settings.cleanupMode === "llm" ? "rules" : settings.cleanupMode,
      languages: settings.languages,
      detectedLanguage: transcript.language,
      signal,
    });
    if (signal.aborted || this.abort !== recording || this._state.phase !== "listening") {
      return;
    }
    const partialText = cleaned.text.trim();
    if (!partialText || partialText === this.partialText) return;
    this.partialText = partialText;
    this.setState({ ...this._state, partialText });
  }

  private clearPartialTimer(): void {
    if (!this.partialTimer) return;
    clearTimeout(this.partialTimer);
    this.partialTimer = null;
  }

  private onFrame(frame: Int16Array): void {
    if (this._state.phase !== "listening") return;
    this.frames.push(frame);

    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = (frame[i] ?? 0) / 32_768;
      sum += v * v;
    }
    const rms = frame.length > 0 ? Math.sqrt(sum / frame.length) : 0;
    this.setState({
      ...this._state,
      phase: "listening",
      durationSeconds: (performance.now() - this.startedAt) / 1000,
      volumeLevel: rms,
    });
    this.emit("volumeLevel", rms);
  }

  private fail(error: unknown, durationSeconds = 0): void {
    this.setState({
      phase: "error",
      durationSeconds,
      volumeLevel: 0,
      error: error instanceof Error ? error.message : String(error),
      errorCode: error instanceof VoiceInputError ? error.code : "failed",
    });
  }

  private cleanup(): void {
    this.clearPartialTimer();
    this.partialAbort?.abort();
    this.partialAbort = null;
    this.partialTask = null;
    this.partialFramesSeen = 0;
    this.partialText = "";
    this.partialFailureReported = false;
    this.capture = null;
    this.frames = [];
    this.abort = null;
  }

  private setState(state: VoiceState): void {
    this._state = state;
    this.emit("stateChange", state);
  }
}
