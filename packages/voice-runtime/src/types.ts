// ---- Voice Phase ----
export type VoicePhase =
  | "idle"
  | "preparing"
  | "ready"
  | "starting"
  | "listening"
  | "transcribing"
  | "done"
  | "error"
  | "cancelling";

/**
 * Stable failure category for the renderer. The renderer maps it to a
 * localized message; `VoiceState.error` keeps the diagnostic text.
 */
export type VoiceErrorCode =
  | "no-model"
  | "model-not-downloaded"
  | "microphone-denied"
  | "failed";

// ---- Voice State ----
export interface VoiceState {
  phase: VoicePhase;
  /** Recording duration in seconds, updated in real-time during listening. */
  durationSeconds: number;
  /** Current volume level 0–1, updated in real-time during listening. */
  volumeLevel: number;
  /** Diagnostic error message when phase is "error". */
  error?: string;
  /** Failure category when phase is "error". */
  errorCode?: VoiceErrorCode;
  /** Transcription result when phase is "done". */
  result?: VoiceResult;
}

// ---- Transcript cleanup ----

/**
 * How dictated text is tidied before it reaches the Composer.
 * - `off`: insert the recognizer output verbatim.
 * - `rules`: deterministic filler-word removal only.
 * - `llm`: rules, then a bundled local model tightens the wording.
 */
export type CleanupMode = "off" | "rules" | "llm";

/** Why an `llm` cleanup fell back to the rule-based text. */
export type CleanupFallback = "model-missing" | "too-long" | "timeout" | "rejected" | "failed";

export interface CleanupOutcome {
  /** Mode requested by settings. */
  mode: CleanupMode;
  /** Strongest cleanup actually applied to the result text. */
  applied: CleanupMode;
  /** Present when `mode` is `llm` but the model output was not used. */
  fallback?: CleanupFallback;
}

export interface VoiceResult {
  /** Text to insert, after cleanup. */
  text: string;
  /** Recognizer output before cleanup, for "restore original". */
  rawText: string;
  cleanup: CleanupOutcome;
  speechSeconds: number;
  transcribeSeconds: number;
  language: string;
}

// ---- Voice Settings ----
export type ChineseVariant = "simplified" | "traditional-taiwan" | "traditional-hong-kong";

export interface VoiceSettings {
  enabled: boolean;
  /** Device ID; null means system default. */
  deviceId: string | null;
  /**
   * Languages the user dictates in, e.g. ["zh", "en"]. One entry pins the
   * recognizer to it; several let the recognizer detect among them.
   */
  languages: string[];
  /** Chinese output variant. */
  chineseVariant: ChineseVariant;
  /** Transcription model catalog ID. */
  modelId: string;
  /** Transcript cleanup applied before insertion. */
  cleanupMode: CleanupMode;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  deviceId: null,
  languages: ["zh", "en"],
  chineseVariant: "simplified",
  modelId: "",
  cleanupMode: "rules",
};

// ---- Model ----
/** `transcription` models feed the recognizer; `cleanup` models tidy text. */
export type ModelKind = "transcription" | "cleanup";

export interface ModelInfo {
  id: string;
  kind: ModelKind;
  name: string;
  description: string;
  languages: string[];
  sizeBytes: number;
  hfRepo: string;
  hfFilename: string;
  /** Lowercase hex SHA-256 of the pinned file; downloads are verified against it. */
  sha256: string;
  supportsStreaming: boolean;
  recommended: boolean;
}

export type ModelStatus =
  | "not-downloaded"
  | "downloading"
  | "downloaded"
  | "loading"
  | "loaded"
  | "error";

export interface ModelState {
  info: ModelInfo;
  status: ModelStatus;
  downloadProgress?: number;
  localPath?: string;
  error?: string;
}

// ---- Audio Capture Interface ----
export interface AudioInputDevice {
  deviceId: string;
  label: string;
  isDefault: boolean;
}

export interface AudioCapture {
  start(): Promise<void>;
  stop(): Promise<Float32Array>;
  cancel(): void;
  onFrame(cb: (frame: Int16Array) => void): void;
  readonly isActive: boolean;
}

export interface AudioCaptureFactory {
  getDevices(): Promise<AudioInputDevice[]>;
  create(deviceId: string | null): AudioCapture;
  checkPermission(): Promise<"granted" | "denied" | "undetermined">;
  requestPermission(): Promise<boolean>;
}

// ---- Transcription ----
export interface TranscribeOptions {
  /** Languages the user dictates in; the engine derives the recognizer hint. */
  languages: string[];
  chineseVariant?: ChineseVariant;
}

export interface TranscriptionOutput {
  text: string;
  /** Detected or hinted language; "" when unknown. */
  language: string;
}
