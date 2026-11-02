/**
 * Composer side of Dictation: replaces the live preview as the recognizer
 * produces text, then settles on the final cleaned result and keeps the
 * cleanup notice / "restore original" for the last insertion.
 * Recording state lives in DictationControl so it does not re-render the
 * Composer on every volume update.
 */

import { useCallback, useRef, useState } from "react";
import type { VoiceInputSettings } from "@pi-harbor/shared";
import {
  canRestoreDictation,
  completeDictationPreview,
  planDictationInsertion,
  replaceDictationPreview,
  type DictationInsertion,
  type DictationPreview,
} from "./dictation-draft";
import type { DictationCleanupMode, DictationResult } from "./useVoiceInput";

interface PendingNotice extends DictationInsertion {
  applied: DictationCleanupMode;
  fallback?: string;
}

export interface DictationNotice {
  applied: DictationCleanupMode;
  /** Set when local AI cleanup was requested but its output was not used. */
  fallback?: string;
  /** The draft can still be switched back to the recognizer text. */
  canRestore: boolean;
}

export interface ComposerDictation {
  enabled: boolean;
  settings?: VoiceInputSettings;
  onResult: (result: DictationResult) => void;
  /** Replaces the replaceable live-preview tail while the user speaks. */
  onPartial: (text: string) => void;
  /** A new recording must not rewrite text left by an earlier session. */
  onSessionStart: () => void;
  /** Notice for the last insertion; null once the draft changed. */
  notice: DictationNotice | null;
  restoreOriginal: () => void;
}

export function useComposerDictation({
  enabled,
  settings,
  draft,
  readDraft,
  applyDraft,
}: {
  enabled: boolean;
  settings?: VoiceInputSettings;
  /** Current draft value; the notice disappears once it changes. */
  draft: string;
  readDraft: () => string;
  /** Preview writes leave focus alone; the final write keeps it. */
  applyDraft: (next: string, focus?: boolean) => void;
}): ComposerDictation {
  const [pending, setPending] = useState<PendingNotice | null>(null);
  const previewRef = useRef<DictationPreview | null>(null);

  const onSessionStart = useCallback(() => {
    previewRef.current = null;
    setPending(null);
  }, []);

  const onPartial = useCallback(
    (text: string) => {
      if (!text) return;
      const update = replaceDictationPreview(readDraft(), text, previewRef.current);
      if (!update) return;
      previewRef.current = update.preview;
      applyDraft(update.draft, false);
    },
    [readDraft, applyDraft],
  );

  const onResult = useCallback(
    (result: DictationResult) => {
      const currentDraft = readDraft();
      const preview = previewRef.current;
      previewRef.current = null;

      const insertion = preview
        ? completeDictationPreview(currentDraft, result.text, result.rawText, preview)
        : result.text
          ? planDictationInsertion(currentDraft, result.text, result.rawText)
          : null;

      // The preview was edited beyond a safe replacement. Keep the user's
      // text rather than appending a duplicate final transcript.
      if (!insertion) {
        setPending(null);
        return;
      }

      applyDraft(insertion.after);
      const { applied, fallback } = result.cleanup;
      const edited = insertion.original !== insertion.after;
      setPending(edited || fallback ? { ...insertion, applied, fallback } : null);
    },
    [readDraft, applyDraft],
  );

  const restoreOriginal = useCallback(() => {
    if (!pending || !canRestoreDictation(pending, readDraft())) return;
    applyDraft(pending.original);
    setPending(null);
  }, [pending, readDraft, applyDraft]);

  const notice =
    pending && pending.after === draft
      ? {
          applied: pending.applied,
          fallback: pending.fallback,
          canRestore: pending.original !== pending.after,
        }
      : null;

  return {
    enabled,
    settings,
    onResult,
    onPartial,
    onSessionStart,
    notice,
    restoreOriginal,
  };
}
