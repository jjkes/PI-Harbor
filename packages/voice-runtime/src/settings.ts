import { findModel } from "./model-catalog.js";
import { DEFAULT_VOICE_SETTINGS } from "./types.js";
import type { ChineseVariant, CleanupMode, VoiceSettings } from "./types.js";

const CLEANUP_MODES: readonly CleanupMode[] = ["off", "rules", "llm"];
const CHINESE_VARIANTS: readonly ChineseVariant[] = [
  "simplified",
  "traditional-taiwan",
  "traditional-hong-kong",
];
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const MAX_LANGUAGES = 8;
const MAX_DEVICE_ID_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/**
 * Validate an untrusted voice settings patch (renderer IPC input or stored
 * JSON). Unknown keys and invalid values are dropped, so a bad field cannot
 * reach the controller or the native recognizer.
 */
export function normalizeVoiceSettingsPatch(input: unknown): Partial<VoiceSettings> {
  if (!isRecord(input)) return {};
  const patch: Partial<VoiceSettings> = {};
  if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
  if (input.deviceId === null) {
    patch.deviceId = null;
  } else if (
    typeof input.deviceId === "string" &&
    input.deviceId.length > 0 &&
    input.deviceId.length <= MAX_DEVICE_ID_LENGTH
  ) {
    patch.deviceId = input.deviceId;
  }
  if (Array.isArray(input.languages)) {
    const languages = [
      ...new Set(
        input.languages.filter(
          (code): code is string => typeof code === "string" && LANGUAGE_CODE.test(code),
        ),
      ),
    ].slice(0, MAX_LANGUAGES);
    if (languages.length > 0) patch.languages = languages;
  }
  if (isOneOf(CHINESE_VARIANTS, input.chineseVariant)) patch.chineseVariant = input.chineseVariant;
  if (typeof input.modelId === "string") {
    if (input.modelId === "") {
      patch.modelId = "";
    } else if (findModel(input.modelId)?.kind === "transcription") {
      patch.modelId = input.modelId;
    }
  }
  if (isOneOf(CLEANUP_MODES, input.cleanupMode)) patch.cleanupMode = input.cleanupMode;
  return patch;
}

/** Complete settings from a stored or partial value; missing fields use defaults. */
export function resolveVoiceSettings(input: unknown): VoiceSettings {
  return { ...DEFAULT_VOICE_SETTINGS, ...normalizeVoiceSettingsPatch(input) };
}
