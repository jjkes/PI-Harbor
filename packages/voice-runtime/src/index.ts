// Types
export type {
  VoicePhase,
  VoiceErrorCode,
  VoiceState,
  VoiceResult,
  VoiceSettings,
  ChineseVariant,
  CleanupMode,
  CleanupFallback,
  CleanupOutcome,
  ModelKind,
  ModelInfo,
  ModelStatus,
  ModelState,
  AudioInputDevice,
  AudioCapture,
  AudioCaptureFactory,
  TranscribeOptions,
  TranscriptionOutput,
} from "./types.js";
export { DEFAULT_VOICE_SETTINGS } from "./types.js";

// Constants
export { CAPTURE_SAMPLE_RATE, FRAME_LENGTH, STREAM_CHUNK_SAMPLES } from "./audio-constants.js";

// Core classes
export { VoiceController, VoiceInputError, type TranscriptCleanupStage } from "./voice-controller.js";
export { TranscriptionEngine } from "./transcription-engine.js";
export { ModelManager, type ModelManagerOptions } from "./model-manager.js";
export type { FetchLike } from "./model-downloader.js";

// Transcript cleanup
export {
  TranscriptCleaner,
  type CleanRequest,
  type TranscriptCleanerOptions,
} from "./cleanup/transcript-cleaner.js";
export { ProcessPolisher } from "./cleanup/process-polisher.js";
export type {
  PolisherChannel,
  PolisherRequest,
  PolisherResponse,
} from "./cleanup/polisher-protocol.js";
export type { TranscriptPolisher } from "./cleanup/llama-polisher.js";

// Settings
export { normalizeVoiceSettingsPatch, resolveVoiceSettings } from "./settings.js";

// Utilities
export { PcmChunker } from "./pcm-chunker.js";
export { convertFrames, computeRms } from "./pcm-utils.js";
export { isChineseLanguage, convertChineseOutput } from "./chinese.js";
export { SUPPORTED_LANGUAGES, languageLabel } from "./languages.js";
export {
  CLEANUP_MODEL_ID,
  getCatalog,
  findModel,
  getCleanupModel,
  getRecommendedModel,
  getTranscriptionModels,
} from "./model-catalog.js";
