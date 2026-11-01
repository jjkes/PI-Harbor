import type { ModelInfo } from "./types.js";

/**
 * Pinned model catalog. Every entry names an exact GGUF file and its SHA-256;
 * downloads are verified against it.
 *
 * SenseVoice Small, Fun-ASR-Nano and Whisper Small were loaded and run with
 * the bundled transcribe-cpp 0.2.2 build. The larger Whisper files come from
 * the same converter. The cleanup model is loaded through node-llama-cpp.
 */
const CATALOG: ModelInfo[] = [
  {
    id: "sensevoice-small",
    kind: "transcription",
    name: "SenseVoice Small",
    description: "Fast Chinese, English, Japanese, Korean and Cantonese model (Q8)",
    languages: ["zh", "en", "ja", "ko", "yue"],
    sizeBytes: 252_684_608,
    hfRepo: "handy-computer/SenseVoiceSmall-gguf",
    hfFilename: "SenseVoiceSmall-Q8_0.gguf",
    sha256: "6c759ee4c9748c9b3f7a5a60ca74f0f7e685fb9d45d1378fce7cfd62f59adf29",
    supportsStreaming: false,
    recommended: true,
  },
  {
    id: "fun-asr-nano",
    kind: "transcription",
    name: "Fun-ASR-Nano",
    description: "Chinese-focused model, better on embedded English terms; larger and slower (Q8)",
    languages: ["zh", "en", "ja"],
    sizeBytes: 891_271_072,
    hfRepo: "handy-computer/Fun-ASR-Nano-2512-gguf",
    hfFilename: "Fun-ASR-Nano-2512-Q8_0.gguf",
    sha256: "ae53d84740fafc1ed5ab1703a3dde994926a2be3ea8bf0ec40588dfea44a245f",
    supportsStreaming: false,
    recommended: false,
  },
  {
    id: "whisper-large-v3-turbo",
    kind: "transcription",
    name: "Whisper Large V3 Turbo",
    description: "Fast and accurate multilingual model (Q8)",
    languages: ["zh", "en", "ja", "ko", "de", "fr", "es", "pt", "ru", "ar", "yue"],
    sizeBytes: 886_381_728,
    hfRepo: "handy-computer/whisper-large-v3-turbo-gguf",
    hfFilename: "whisper-large-v3-turbo-Q8_0.gguf",
    sha256: "257aa7ec9121c22c167d5e2c49e3e76b4ba0e6e27ebc13074eba0a80f8190220",
    supportsStreaming: false,
    recommended: true,
  },
  {
    id: "whisper-medium",
    kind: "transcription",
    name: "Whisper Medium",
    description: "Balanced multilingual model (Q8)",
    languages: ["zh", "en", "ja", "ko", "de", "fr", "es", "pt", "ru", "ar"],
    sizeBytes: 831_538_144,
    hfRepo: "handy-computer/whisper-medium-gguf",
    hfFilename: "whisper-medium-Q8_0.gguf",
    sha256: "09e6a65e7de377aa5b10bae24608bc6f8ca2ed04b3993ef10d4a02bcd9a82adf",
    supportsStreaming: false,
    recommended: false,
  },
  {
    id: "whisper-small",
    kind: "transcription",
    name: "Whisper Small",
    description: "Lightweight multilingual model (Q8)",
    languages: ["zh", "en", "ja", "ko", "de", "fr", "es", "pt", "ru", "ar"],
    sizeBytes: 269_751_136,
    hfRepo: "handy-computer/whisper-small-gguf",
    hfFilename: "whisper-small-Q8_0.gguf",
    sha256: "9b9c8811bbcc82a7766f0fb0925614bdacb0923b2cc630daeac17108b655b860",
    supportsStreaming: false,
    recommended: false,
  },
  {
    id: "qwen3-1.7b",
    kind: "cleanup",
    name: "Qwen3 1.7B",
    description: "Local transcript cleanup model (Q4_K_M)",
    languages: ["zh", "en"],
    sizeBytes: 1_107_409_472,
    hfRepo: "unsloth/Qwen3-1.7B-GGUF",
    hfFilename: "Qwen3-1.7B-Q4_K_M.gguf",
    sha256: "b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897",
    supportsStreaming: false,
    recommended: false,
  },
];

/** ID of the bundled transcript cleanup model. */
export const CLEANUP_MODEL_ID = "qwen3-1.7b";

/** Get the full model catalog. */
export function getCatalog(): readonly ModelInfo[] {
  return CATALOG;
}

/** Find a model by its ID. */
export function findModel(modelId: string): ModelInfo | undefined {
  return CATALOG.find((m) => m.id === modelId);
}

/** Catalog entries usable as the dictation recognizer. */
export function getTranscriptionModels(): ModelInfo[] {
  return CATALOG.filter((m) => m.kind === "transcription");
}

/** The bundled transcript cleanup model. */
export function getCleanupModel(): ModelInfo {
  const model = findModel(CLEANUP_MODEL_ID);
  if (!model || model.kind !== "cleanup") throw new Error("Cleanup model missing from catalog");
  return model;
}

/** Get the recommended transcription model for the given languages. */
export function getRecommendedModel(languages: string[]): ModelInfo {
  const candidates = getTranscriptionModels();
  const covering = candidates.find(
    (m) => m.recommended && languages.every((l) => m.languages.includes(l)),
  );
  if (covering) return covering;
  return candidates.find((m) => m.recommended) ?? candidates[0]!;
}
