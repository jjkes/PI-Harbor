/**
 * Mask spans the local cleanup model must copy verbatim: code, paths, URLs,
 * identifiers, numbers and, inside Chinese text, Latin-script terms. The
 * model sees numbered placeholders, so it cannot misspell, translate or
 * "fix" them.
 */

export interface MaskedText {
  text: string;
  /** Original text of placeholder ⟦n⟧ at index n - 1. */
  spans: string[];
}

const RESERVED = /[⟦⟧]/;
const HAN = /\p{Script=Han}/u;
const PLACEHOLDER = /⟦(\d+)⟧/g;

const INLINE_CODE = /`[^`\n]+`/;
const URL = /https?:\/\/[^\s，。！？、；：）」』"'<>]*[^\s，。！？、；：）」』"'<>.,!?;:]/;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const PATH = /(?:~|\.{1,2})?\/?[\w.@-]*[\w@-](?:\/[\w.@-]*[\w@-])+\/?/;
const FILE_NAME =
  /\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|ya?ml|toml|rs|go|py|java|kt|swift|cpp|hpp|cs|rb|php|sh|css|scss|html|vue|sql|lock|env|txt|xml)\b/;
const CLI_FLAG = /(?<![\w-])--?[A-Za-z][\w-]*/;
const DOTTED = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?/;
const CALL = /\b[A-Za-z_$][\w$]*\(\)/;
const CAMEL = /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/;
const PASCAL = /\b(?:[A-Z][a-z0-9]+){2,}\b/;
const SNAKE = /\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\b/;
const KEBAB = /\b[a-z0-9]+(?:-[a-z0-9]+)+\b/;
const ACRONYM = /\b[A-Z]{2,}[0-9]*\b/;
const NUMBER = /(?<![\w.])v?\d+(?:[.,:]\d+)*(?:%|[A-Za-z]{1,3}\b)?/;
const LATIN_WORD = "[A-Za-z](?:[A-Za-z0-9+#._-]*[A-Za-z0-9+#_-])?";
const LATIN_RUN = new RegExp(`${LATIN_WORD}(?:[ \\t]+${LATIN_WORD})*`);

const SHARED = [INLINE_CODE, URL, EMAIL, PATH, FILE_NAME, CLI_FLAG, DOTTED, CALL];

function combine(parts: readonly RegExp[]): RegExp {
  return new RegExp(parts.map((part) => `(?:${part.source})`).join("|"), "g");
}

/** Text without Chinese characters: code-like spans only. */
const CODE_PATTERN = combine([...SHARED, CAMEL, PASCAL, SNAKE, KEBAB, ACRONYM, NUMBER]);
/** Chinese text: also every Latin-script run, usually a technical term. */
const MIXED_PATTERN = combine([...SHARED, LATIN_RUN, NUMBER]);

/**
 * Replace protected spans with ⟦1⟧, ⟦2⟧, … Returns null when the text
 * already contains the placeholder brackets, so masking cannot be confused.
 */
export function maskProtectedSpans(text: string): MaskedText | null {
  if (RESERVED.test(text)) return null;
  const pattern = HAN.test(text) ? MIXED_PATTERN : CODE_PATTERN;
  const spans: string[] = [];
  const masked = text.replace(pattern, (span) => {
    spans.push(span);
    return `⟦${spans.length}⟧`;
  });
  return { text: masked, spans };
}

/** Put the original spans back; unknown placeholders stay as they are. */
export function restoreProtectedSpans(text: string, spans: readonly string[]): string {
  return text.replace(PLACEHOLDER, (token, index: string) => spans[Number(index) - 1] ?? token);
}
