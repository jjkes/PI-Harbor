/**
 * Process-wide handoff from the shell's configured push-to-talk key to the
 * mounted Composer dictation control. The control owns the recorder and draft,
 * so the shell only routes press and release edges.
 */

export type DictationPushToTalkAction = "press" | "release";

type DictationPushToTalkHandler = (action: DictationPushToTalkAction) => boolean;

let handler: DictationPushToTalkHandler | null = null;

/** Register the active Composer control; the latest mount owns the shortcut. */
export function registerDictationPushToTalk(
  next: DictationPushToTalkHandler,
): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/**
 * Returns false when no control accepted the edge, so the shell leaves the
 * key event to the focused surface instead of swallowing it.
 */
export function dispatchDictationPushToTalk(
  action: DictationPushToTalkAction,
): boolean {
  return handler?.(action) ?? false;
}
