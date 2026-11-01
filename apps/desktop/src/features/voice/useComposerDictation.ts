/**
 * Composer side of Dictation: inserts finished results into the draft and
 * keeps the cleanup notice and "restore original" for the last insertion.
 * Recording state lives in DictationControl so it does not re-render the
 * Composer on every volume update.
 */

import { useCallback, useState } from "react";
import type { VoiceInputSettings } from "@pi-harbor/shared";
import {
  canRestoreDictation,
  planDictationInsertion,
  type DictationInsertion,
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
  applyDraft: (next: string) => void;
}): ComposerDictation {
  const [pending, setPending] = useState<PendingNotice | null>(null);

  const onResult = useCallback(
    (result: DictationResult) => {
      const insertion = planDictationInsertion(readDraft(), result.text, result.rawText);
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

  return { enabled, settings, onResult, notice, restoreOriginal };
}
