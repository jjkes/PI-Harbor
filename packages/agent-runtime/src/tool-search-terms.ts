/**
 * ToolSearch matching for Desktop's own on-demand tool catalog
 * (`runtime.ts` `findDeferredTools`). This is not pi's `tool_search`
 * extension, so pi 1.5.0's non-ASCII fix there does not reach it.
 *
 * Invariant: an ASCII query against an ASCII catalog ranks exactly as the
 * legacy separator-only tokenizer did, because NFKC and the added CJK
 * separators are identity on ASCII. Queries in scripts written without
 * spaces (CJK, Thai) are also segmented into words, so "搜索记录" matches a
 * tool whose description mentions "搜索" and "记录" apart.
 */

export interface ToolSearchCandidate {
  name: string;
  description: string;
}

export type ToolSearchSegmenter = Pick<Intl.Segmenter, "segment">;

const UNSPACED_SCRIPT = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u0e00-\u0e7f]/u;
// Legacy separators plus the ideographic comma and full stop. NFKC already
// folds full-width ，；｜／ into their ASCII forms.
const SEPARATORS = /[\s,;|/、。]+/;

/** Fold full-width and compatibility forms, then lowercase. */
export function normalizeSearchText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

let systemSegmenter: ToolSearchSegmenter | null | undefined;
function defaultSegmenter(): ToolSearchSegmenter | null {
  if (systemSegmenter === undefined) {
    systemSegmenter = typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "word" })
      : null;
  }
  return systemSegmenter;
}

/** Split a query into match terms; a blank query has none. */
export function toolSearchTerms(
  query: string,
  segmenter: ToolSearchSegmenter | null = defaultSegmenter(),
): string[] {
  const normalized = normalizeSearchText(query);
  const terms = normalized.split(SEPARATORS).filter(Boolean);
  if (segmenter && UNSPACED_SCRIPT.test(normalized)) {
    for (const part of segmenter.segment(normalized)) {
      if (part.isWordLike && !terms.includes(part.segment)) terms.push(part.segment);
    }
  }
  return terms;
}

/**
 * Rank candidates for a query: exact name, then name substring, then
 * per-term name and description hits. Returns every match, best first;
 * ties keep catalog order.
 */
export function rankToolSearch(
  query: string,
  candidates: Iterable<ToolSearchCandidate>,
  segmenter: ToolSearchSegmenter | null = defaultSegmenter(),
): string[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];
  const terms = toolSearchTerms(query, segmenter);
  const scored: Array<{ name: string; score: number }> = [];
  for (const { name, description } of candidates) {
    const normalizedName = normalizeSearchText(name);
    const normalizedDescription = normalizeSearchText(description);
    let score = 0;
    if (normalizedName === normalizedQuery) score += 10_000;
    else if (normalizedName.includes(normalizedQuery)) score += 2_000;
    for (const term of terms) {
      if (normalizedName.includes(term)) score += 300;
      if (normalizedDescription.includes(term)) score += 25;
    }
    if (score > 0) scored.push({ name, score });
  }
  return scored.sort((left, right) => right.score - left.score).map((entry) => entry.name);
}
