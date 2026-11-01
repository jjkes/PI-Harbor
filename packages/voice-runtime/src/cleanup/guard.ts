import { restoreProtectedSpans, type MaskedText } from "./protect.js";

/** Phrases a speaker uses to retract what they just said. */
const SELF_CORRECTION =
  /不对|说错了|我是说|应该是|算了|不要了|\b(?:no wait|wait no|scratch that|i mean|actually|sorry|correction)\b/i;
const SELF_CORRECTIONS = new RegExp(SELF_CORRECTION.source, "gi");

const LEADING_LABEL =
  /^(?:output|cleaned(?: text)?|tidied(?: text)?|result|answer|整理后|清理后|输出|结果)\s*[:：]\s*/i;
const WRAPPING_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["“", "”"],
  ["「", "」"],
  ["'", "'"],
  ["`", "`"],
];

/**
 * Comparable units: a placeholder, one CJK character, or a run of other
 * letters and digits. Punctuation, symbols and spacing are not compared.
 */
const UNIT =
  /⟦\d+⟧|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{P}\p{S}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;
/** Negations whose loss would invert a request. */
const ZH_NEGATION = /[不没沒别別未无無非勿莫]/g;
const EN_NEGATION = /\b(?:not|no|never|none|nothing|nobody|neither|nor|without|cannot)\b|n['’]t\b/gi;

export type PolishVerdict = { ok: true; text: string } | { ok: false; reason: string };

/** True when the speaker retracted something, so dropping a masked span may be correct. */
export function hasSelfCorrection(text: string): boolean {
  return SELF_CORRECTION.test(text);
}

function contentLength(text: string): number {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").length;
}

function units(text: string): string[] {
  return (text.match(UNIT) ?? []).map((unit) => unit.toLowerCase());
}

/** True when `output` keeps a subset of the units of `source`, in their order. */
function isDeletionOf(output: string, source: string): boolean {
  const kept = units(output);
  let index = 0;
  for (const unit of units(source)) {
    if (index < kept.length && kept[index] === unit) index += 1;
  }
  return index === kept.length;
}

/** Negations outside self-correction cues ("不对", "no wait" may be deleted). */
function negationCount(text: string): number {
  const plain = text.replace(SELF_CORRECTIONS, " ");
  return (plain.match(ZH_NEGATION)?.length ?? 0) + (plain.match(EN_NEGATION)?.length ?? 0);
}

/** Strip wrappers a small model sometimes adds around its answer. */
export function sanitizePolished(output: string, source: string): string {
  let text = output.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  text = text.replace(LEADING_LABEL, "").trim();
  for (const [open, close] of WRAPPING_PAIRS) {
    if (
      text.length >= open.length + close.length &&
      text.startsWith(open) &&
      text.endsWith(close) &&
      !source.startsWith(open)
    ) {
      text = text.slice(open.length, text.length - close.length).trim();
    }
  }
  if (!source.includes("\n")) {
    text = text
      .split(/\n+/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  }
  return text;
}

/**
 * Decide whether the model output may replace the rule-cleaned text, and
 * restore its placeholders. Cleanup may only delete: the output must keep a
 * subset of the input's words in their order, every negation outside a
 * self-correction cue, and enough of the content. Answers, translations,
 * rewrites and damaged placeholders are rejected.
 */
export function acceptPolished(
  output: string,
  masked: MaskedText,
  allowDrops: boolean,
): PolishVerdict {
  const text = sanitizePolished(output, masked.text);
  if (!text) return { ok: false, reason: "empty" };
  if (/<\/?think>/i.test(text)) return { ok: false, reason: "think-tag" };

  const seen = new Set<number>();
  for (const match of text.matchAll(/⟦(\d+)⟧/g)) {
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 1 || index > masked.spans.length) {
      return { ok: false, reason: "unknown-placeholder" };
    }
    if (seen.has(index)) return { ok: false, reason: "duplicate-placeholder" };
    seen.add(index);
  }
  if (!allowDrops && seen.size !== masked.spans.length) {
    return { ok: false, reason: "dropped-placeholder" };
  }
  if (/[⟦⟧]/.test(text.replace(/⟦\d+⟧/g, ""))) return { ok: false, reason: "broken-placeholder" };

  // A reordered or replaced word can invert a request: one correction came
  // back with its retracted and corrected targets swapped.
  if (!isDeletionOf(text, masked.text)) return { ok: false, reason: "not-a-deletion" };
  if (negationCount(text) < negationCount(masked.text)) {
    return { ok: false, reason: "dropped-negation" };
  }

  const restored = restoreProtectedSpans(text, masked.spans);
  const sourceLength = contentLength(restoreProtectedSpans(masked.text, masked.spans));
  if (contentLength(restored) < sourceLength * (allowDrops ? 0.25 : 0.4)) {
    return { ok: false, reason: "shorter" };
  }
  return { ok: true, text: restored };
}
