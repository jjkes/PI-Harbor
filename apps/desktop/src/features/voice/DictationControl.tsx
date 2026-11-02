/**
 * Composer Dictation control: a single microphone/stop button plus
 * non-persistent error and cleanup feedback. Recording progress is visible in
 * the draft itself, so the control shows no timer or cancel action.
 */

import { useEffect } from "react";
import type { TFunction } from "i18next";
import { IconMic, IconStop } from "../../components/icons";
import { Button, TooltipButton } from "../../components/ui";
import { registerDictationPushToTalk } from "./dictation-push-to-talk";
import type { ComposerDictation } from "./useComposerDictation";
import { useVoiceInput, type VoiceErrorCode } from "./useVoiceInput";
import "../../styles/voice.css";

const ERROR_KEYS: Record<VoiceErrorCode, string> = {
  "no-model": "settings.voiceErrorNoModel",
  "model-not-downloaded": "settings.voiceErrorNoModel",
  "microphone-denied": "settings.voiceMicDenied",
  "microphone-busy": "settings.voiceMicBusy",
  failed: "settings.voiceErrorFailed",
};

export function DictationControl({ t, dictation }: { t: TFunction; dictation: ComposerDictation }) {
  const { state, toggle, beginPushToTalk, endPushToTalk } = useVoiceInput({
    enabled: dictation.enabled,
    settings: dictation.settings,
    onResult: dictation.onResult,
    onPartial: dictation.onPartial,
    onSessionStart: dictation.onSessionStart,
  });
  useEffect(
    () =>
      registerDictationPushToTalk((action) => {
        if (action === "press") return beginPushToTalk();
        endPushToTalk();
        return true;
      }),
    [beginPushToTalk, endPushToTalk],
  );
  const { phase } = state;
  const listening = phase === "listening";
  const pending =
    phase === "preparing" || phase === "starting" || phase === "transcribing" || phase === "cancelling";
  const label = t(listening ? "settings.voiceDictationStop" : "settings.voiceDictationStart");
  const { notice } = dictation;

  return (
    <>
      <TooltipButton
        type="button"
        className={`icon-btn icon-btn-square composer-dictation-btn${pending ? " is-loading" : ""}`}
        tooltip={label}
        ariaLabel={label}
        aria-pressed={listening}
        aria-busy={pending}
        disabled={pending}
        onClick={() => void toggle()}
      >
        {listening ? <IconStop size={16} /> : <IconMic size={16} />}
      </TooltipButton>
      {phase === "error" ? (
        <span className="composer-dictation-error" role="alert">
          {t(ERROR_KEYS[state.errorCode ?? "failed"])}
        </span>
      ) : null}
      {notice && !listening && !pending && phase !== "error" ? (
        <span className="composer-dictation-notice" role="status">
          {t(
            notice.fallback
              ? "settings.voiceCleanupFallback"
              : notice.applied === "llm"
                ? "settings.voiceCleanedLlm"
                : "settings.voiceCleanedRules",
          )}
          {notice.canRestore ? (
            <Button type="button" size="sm" variant="ghost" onClick={dictation.restoreOriginal}>
              {t("settings.voiceRestoreOriginal")}
            </Button>
          ) : null}
        </span>
      ) : null}
    </>
  );
}
