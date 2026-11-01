/**
 * Deterministic filler-word removal for dictated text.
 *
 * Only tokens that carry no meaning in dictation are removed here. Words that
 * are fillers in one sentence and content in another (这个, 然后, 就是,
 * like, I mean) are left for the optional local model, which sees context.
 */

export interface FillerRules {
  zh: boolean;
  en: boolean;
}

function baseLanguage(code: string): string {
  return code.toLowerCase().split("-", 1)[0] ?? "";
}

/**
 * Pick rule sets from the recognizer's language when known, otherwise from
 * the user's languages. English sound rules stay off for other languages
 * (German "um" is a word).
 */
export function fillerRulesFor(languages: readonly string[], detectedLanguage = ""): FillerRules {
  const codes = detectedLanguage ? [baseLanguage(detectedLanguage)] : languages.map(baseLanguage);
  if (codes.length === 0) return { zh: true, en: true };
  return {
    zh: codes.some((code) => code === "zh" || code === "yue"),
    en: codes.includes("en"),
  };
}

/** Start of text or a phrase boundary; fillers are removed only next to one. */
const B = "(^|[\\s，。！？、；：,.!?;:])";

const ZH_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Hesitation sounds carry no meaning anywhere in dictation.
  [/[嗯呃]+[，,、]?/g, ""],
  // Immediate repeats: 然后然后 → 然后, 我觉得，我觉得 → 我觉得.
  [/(那个|这个|就是|然后|所以|我们|你们|他们|咱们|我觉得)(?:[，,、]?\1)+/g, "$1"],
  // Discourse fillers standing alone between pauses.
  [new RegExp(`${B}(?:那个|这个|就是说|怎么说呢|你知道吗|你懂吗)[，,、]`, "g"), "$1"],
  // Interjections standing alone before a pause.
  [new RegExp(`${B}[额唔啊哦噢诶欸哎喔]+[，,、]`, "g"), "$1"],
  // 那个 opening a phrase right before a pronoun: 那个我想 → 我想.
  [new RegExp(`${B}那个(?=[我你他她咱])`, "g"), "$1"],
  // Stuttered pronouns: 我我我 → 我, 我，我想 → 我想.
  [/([我你他她])\1{2,}/g, "$1"],
  [new RegExp(`${B}([我你他她])[，,、]\\2`, "g"), "$1$2"],
];

const EN_SOUND = /,?\s*\b(?:[Uu]m+|[Uu]h+|[Uu]hm|[Ee]rm|[Hh]m+|[Aa]h+)\b\s*,?\s*/g;
const EN_YOU_KNOW_INNER = /\s*,\s*you know\s*,\s*/gi;
const EN_YOU_KNOW_OPEN = /(^|[.!?]\s+)you know,\s*/gi;
const EN_YOU_KNOW_CLOSE = /\s*,\s*you know(?=\s*[.!?]|\s*$)/gi;
const EN_TRIPLE = /\b([A-Za-z]+)(?:\s+\1\b){2,}/g;
const EN_DOUBLE = /\b(I|the|a|an|to|and|we|you)\s+\1\b/gi;

/** Replacement for a removed span: nothing at an edge or before punctuation, else one space. */
function joinAround(match: string, offset: number, whole: string): string {
  const before = whole.slice(0, offset);
  const after = whole.slice(offset + match.length);
  if (before.trim() === "" || after.trim() === "" || /^[.,!?;:]/.test(after)) return "";
  return " ";
}

function removeEnglishFillers(text: string): string {
  return text
    .replace(EN_SOUND, joinAround)
    .replace(EN_YOU_KNOW_INNER, joinAround)
    .replace(EN_YOU_KNOW_OPEN, "$1")
    .replace(EN_YOU_KNOW_CLOSE, "")
    .replace(EN_TRIPLE, "$1")
    .replace(EN_DOUBLE, "$1");
}

function applyUntilStable(text: string, rules: ReadonlyArray<readonly [RegExp, string]>): string {
  let out = text;
  for (let pass = 0; pass < 3; pass++) {
    const before = out;
    for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
    if (out === before) break;
  }
  return out;
}

/** Repair punctuation and spacing left behind by removals. */
function tidy(text: string): string {
  return text
    .replace(/([，、,])(?:\s*[，、,])+/g, "$1")
    .replace(/[，、,]+\s*([。！？.!?])/g, "$1")
    .replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, "$1")
    .replace(/\s*([，。！？、；：])\s*/g, "$1")
    .replace(/\s+([,!?;:])(?=\s|$)/g, "$1")
    .replace(/\s+\.(?=\s|$)/g, ".")
    .replace(/^[\s，,、。！？；：;:!?]+/, "")
    .replace(/[\s，,、]+$/, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function restoreLeadingCapital(original: string, cleaned: string): string {
  const first = original.trimStart()[0];
  if (!first || !/[A-Z]/.test(first)) return cleaned;
  if (!/^[a-z](?![A-Z])/.test(cleaned)) return cleaned;
  return cleaned[0]!.toUpperCase() + cleaned.slice(1);
}

/**
 * Remove filler words. Returns the input unchanged when nothing matched and
 * "" when only fillers were spoken.
 */
export function removeFillers(text: string, rules: FillerRules): string {
  let out = text;
  if (rules.zh) out = applyUntilStable(out, ZH_RULES);
  if (rules.en) out = removeEnglishFillers(out);
  if (out === text) return text;
  out = tidy(out);
  if (!/[\p{L}\p{N}]/u.test(out)) return "";
  return restoreLeadingCapital(text, out);
}
