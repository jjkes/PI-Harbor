import type { TranscribeOptions as RecognizerOptions, TranscribeModel } from "transcribe-cpp";
import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import { convertChineseOutput, isChineseLanguage } from "./chinese.js";
import type { ModelManager } from "./model-manager.js";
import type { ChineseVariant, TranscribeOptions, TranscriptionOutput } from "./types.js";

/** Recognizers reject near-empty input; shorter clips transcribe to "". */
const MIN_AUDIO_SECONDS = 0.3;

const HAN = /\p{Script=Han}/u;
const KANA = /[\u3040-\u30ff]/;

/**
 * Wraps transcribe-cpp for dictation: language hinting, written-form output
 * (punctuation, casing, digits), cancellation, and Chinese variant
 * conversion. Model lifecycle stays with ModelManager.
 */
export class TranscriptionEngine {
  constructor(readonly modelManager: ModelManager) {}

  async transcribe(
    pcm: Float32Array,
    options: TranscribeOptions,
    signal?: AbortSignal,
  ): Promise<TranscriptionOutput> {
    const model = this.modelManager.getLoadedModel();
    if (!model) throw new Error("No model loaded");
    signal?.throwIfAborted();
    if (pcm.length < MIN_AUDIO_SECONDS * CAPTURE_SAMPLE_RATE) return { text: "", language: "" };

    const hint = languageHint(model, options.languages);
    let result = await model.transcribe(pcm, runOptions(model, hint, signal));
    let language = hint ?? result.language;
    if (!hint) {
      const retry = correctiveHint(model, options.languages, language);
      if (retry) {
        signal?.throwIfAborted();
        result = await model.transcribe(pcm, runOptions(model, retry, signal));
        language = retry;
      }
    }
    signal?.throwIfAborted();

    let text = result.text.trim();
    if (text && options.chineseVariant && shouldConvertChinese(language, options.languages, text)) {
      text = await convertChinese(text, options.chineseVariant);
    }
    return { text, language };
  }

  /** Shut down the engine and unload the model. */
  async shutdown(): Promise<void> {
    this.modelManager.unload();
  }
}

function baseLanguage(language: string): string {
  const lower = language.toLowerCase();
  return lower.split("-")[0] || lower;
}

/** Recognizer codes usable for the user's dictation languages, in their order. */
function usableLanguages(model: TranscribeModel, languages: readonly string[]): string[] {
  const supported = model.capabilities.languages;
  const usable: string[] = [];
  for (const language of languages) {
    const code = supported.includes(language) ? language : baseLanguage(language);
    if (supported.includes(code) && !usable.includes(code)) usable.push(code);
  }
  return usable;
}

/**
 * A single usable language pins the recognizer to it. Several (or none) let a
 * model that detects language choose; one that cannot detect gets the first.
 */
function languageHint(model: TranscribeModel, languages: readonly string[]): string | undefined {
  const usable = usableLanguages(model, languages);
  if (usable.length === 1) return usable[0];
  if (model.capabilities.supportsLanguageDetect) return undefined;
  return usable[0];
}

/** Detection picked a language the user does not dictate in: retry pinned. */
function correctiveHint(
  model: TranscribeModel,
  languages: readonly string[],
  detected: string,
): string | undefined {
  if (!detected) return undefined;
  const usable = usableLanguages(model, languages);
  if (usable.length === 0) return undefined;
  if (usable.includes(detected) || usable.includes(baseLanguage(detected))) return undefined;
  return usable[0];
}

function runOptions(
  model: TranscribeModel,
  language: string | undefined,
  signal: AbortSignal | undefined,
): RecognizerOptions {
  const options: RecognizerOptions = {};
  if (language) options.language = language;
  // Dictation wants written form. SenseVoice and Fun-ASR emit lowercase,
  // unpunctuated text unless ITN is on.
  if (model.supports("pnc")) options.pnc = "on";
  if (model.supports("itn")) options.itn = "on";
  if (signal && model.supports("cancellation")) options.signal = signal;
  return options;
}

/** Variant conversion applies to Chinese output only, never to Japanese kanji. */
function shouldConvertChinese(language: string, languages: readonly string[], text: string): boolean {
  if (language) return isChineseLanguage(language);
  return languages.some((code) => isChineseLanguage(code)) && HAN.test(text) && !KANA.test(text);
}

async function convertChinese(text: string, variant: ChineseVariant): Promise<string> {
  try {
    return await convertChineseOutput(text, variant);
  } catch {
    // OpenCC unavailable: keep the recognizer text.
    return text;
  }
}
