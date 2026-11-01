/** Pure helpers for inserting dictated text into the Composer draft. */

const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** Append dictated text to the draft with a separator that suits the script. */
export function joinDictation(draft: string, text: string): string {
  if (!text) return draft;
  if (!draft || /\s$/.test(draft)) return draft + text;
  const before = draft.at(-1) ?? "";
  const after = text[0] ?? "";
  return CJK.test(before) || CJK.test(after) ? draft + text : `${draft} ${text}`;
}

export interface DictationInsertion {
  /** Draft before the insertion. */
  before: string;
  /** Draft right after inserting the cleaned text. */
  after: string;
  /** The same draft with the recognizer text instead. */
  original: string;
}

export function planDictationInsertion(
  draft: string,
  text: string,
  rawText: string,
): DictationInsertion {
  return { before: draft, after: joinDictation(draft, text), original: joinDictation(draft, rawText) };
}

/** "Restore original" applies only while the draft is exactly what the insertion produced. */
export function canRestoreDictation(insertion: DictationInsertion | null, draft: string): boolean {
  return insertion !== null && insertion.after === draft && insertion.original !== insertion.after;
}
