/**
 * Composer Dictation control: microphone toggle, recording status, errors,
 * and the cleanup notice with "restore original" for the last insertion.
 */

import type { TFunction } from "i18next";
import { IconMic, IconStop } from "../../components/icons";
import { Button, TooltipButton } from "../../components/ui";
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

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function DictationControl({ t, dictation }: { t: TFunction; dictation: ComposerDictation }) {
  const { state, toggle, cancel } = useVoiceInput({
    enabled: dictation.enabled,
    settings: dictation.settings,
    onResult: dictation.onResult,
  });
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
      {listening || pending ? (
        <span className="composer-dictation-status" role="status">
          {listening ? `${t("settings.voiceRecording")} ${formatDuration(state.durationSeconds)}` : null}
          {phase === "transcribing" ? t("settings.voiceTranscribing") : null}
          {phase !== "cancelling" ? (
            <Button type="button" size="sm" variant="ghost" onClick={cancel}>
              {t("settings.voiceCancel")}
            </Button>
          ) : null}
        </span>
      ) : null}
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
