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

/** Tracks the replaceable tail inserted by the live recognizer. */
export interface DictationPreview {
  /** Draft before the first preview landed. */
  base: string;
  /** Draft currently painted with the preview. */
  rendered: string;
  /** Text this preview appended to `base`. */
  inserted: string;
}

export interface DictationPreviewUpdate {
  draft: string;
  preview: DictationPreview;
}

/**
 * Replace the previous live preview with a newer one. User text typed after
 * the preview is preserved. Returns null when the preview was edited beyond a
 * safe replacement, so the caller can leave the user's text alone.
 */
export function replaceDictationPreview(
  draft: string,
  text: string,
  preview: DictationPreview | null,
): DictationPreviewUpdate | null {
  if (!preview) {
    const rendered = joinDictation(draft, text);
    return {
      draft: rendered,
      preview: { base: draft, rendered, inserted: rendered.slice(draft.length) },
    };
  }

  const fromBase = joinDictation(preview.base, text);
  const inserted = fromBase.slice(preview.base.length);
  if (draft === preview.rendered) {
    return { draft: fromBase, preview: { ...preview, rendered: fromBase, inserted } };
  }
  if (draft.startsWith(preview.rendered)) {
    const suffix = draft.slice(preview.rendered.length);
    const rendered = fromBase + suffix;
    return { draft: rendered, preview: { ...preview, rendered, inserted } };
  }
  if (preview.inserted && draft.endsWith(preview.inserted)) {
    const prefix = draft.slice(0, -preview.inserted.length);
    const rendered = joinDictation(prefix, text);
    return {
      draft: rendered,
      preview: { base: prefix, rendered, inserted: rendered.slice(prefix.length) },
    };
  }
  return null;
}

/** Replace the last live preview with the authoritative final result. */
export function completeDictationPreview(
  draft: string,
  text: string,
  rawText: string,
  preview: DictationPreview,
): DictationInsertion | null {
  const fromBase = planDictationInsertion(preview.base, text, rawText);
  if (draft === preview.base || draft === preview.rendered) return fromBase;
  if (draft.startsWith(preview.rendered)) {
    const suffix = draft.slice(preview.rendered.length);
    return {
      before: preview.base,
      after: fromBase.after + suffix,
      original: fromBase.original + suffix,
    };
  }
  if (preview.inserted && draft.endsWith(preview.inserted)) {
    return planDictationInsertion(
      draft.slice(0, -preview.inserted.length),
      text,
      rawText,
    );
  }
  return null;
}
