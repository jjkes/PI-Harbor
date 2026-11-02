/**
 * React hook mirroring the main-process Dictation state machine for one
 * Composer control. Main reports volume about 30 times per second while
 * listening, so the hook belongs in the small control, not in the Composer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceInputSettings } from "@pi-harbor/shared";
import { voiceIpc } from "./voice-ipc";

export type VoicePhase =
  | "idle"
  | "preparing"
  | "ready"
  | "starting"
  | "listening"
  | "transcribing"
  | "done"
  | "error"
  | "cancelling";

/** Main-process failure categories plus the renderer-mapped lease conflict. */
export type VoiceErrorCode =
  | "no-model"
  | "model-not-downloaded"
  | "microphone-denied"
  | "microphone-busy"
  | "failed";

export type DictationCleanupMode = "off" | "rules" | "llm";

export interface DictationResult {
  /** Text to insert, after cleanup. */
  text: string;
  /** Recognizer output before cleanup. */
  rawText: string;
  cleanup: {
    mode: DictationCleanupMode;
    applied: DictationCleanupMode;
    fallback?: string;
  };
  speechSeconds: number;
  transcribeSeconds: number;
  language: string;
}

export interface VoiceState {
  phase: VoicePhase;
  durationSeconds: number;
  volumeLevel: number;
  /** Replaceable live transcript while listening. */
  partialText?: string;
  error?: string;
  errorCode?: VoiceErrorCode;
  result?: DictationResult;
}

const IDLE_STATE: VoiceState = { phase: "idle", durationSeconds: 0, volumeLevel: 0 };
/** Phases from which Main accepts a new recording. */
const STARTABLE = new Set<VoicePhase>(["idle", "ready", "done", "error"]);
const ERROR_VISIBLE_MS = 4_000;

export interface UseVoiceInputOptions {
  enabled?: boolean;
  /** Persisted Dictation settings, sent to Main with every start. */
  settings?: VoiceInputSettings;
  /** Called with the latest live transcript while the user speaks. */
  onPartial?: (text: string) => void;
  /** Called before a new recording starts, to close the previous preview. */
  onSessionStart?: () => void;
  /** Called once per finished dictation, including an empty result. */
  onResult?: (result: DictationResult) => void;
}

/** Live Voice holding the shared microphone lease is the one renderer-mapped code. */
function errorCodeOf(error: unknown): VoiceErrorCode {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === "LIVE_MICROPHONE_BUSY" ? "microphone-busy" : "failed";
}

export function useVoiceInput({
  enabled = false,
  settings,
  onResult,
  onPartial,
  onSessionStart,
}: UseVoiceInputOptions = {}) {
  const [state, setStateValue] = useState<VoiceState>(IDLE_STATE);
  const stateRef = useRef<VoiceState>(IDLE_STATE);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const onPartialRef = useRef(onPartial);
  onPartialRef.current = onPartial;
  const pushToTalkHeldRef = useRef(false);
  const pushToTalkStartRef = useRef<Promise<void> | null>(null);
  const onSessionStartRef = useRef(onSessionStart);
  onSessionStartRef.current = onSessionStart;
  const lastPartialRef = useRef("");
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setState = useCallback((next: VoiceState) => {
    if (errorTimer.current) {
      clearTimeout(errorTimer.current);
      errorTimer.current = null;
    }
    stateRef.current = next;
    setStateValue(next);
    if (next.phase === "error") {
      errorTimer.current = setTimeout(() => {
        errorTimer.current = null;
        stateRef.current = IDLE_STATE;
        setStateValue(IDLE_STATE);
      }, ERROR_VISIBLE_MS);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = voiceIpc.onStateChanged((raw) => {
      const next = raw as VoiceState;
      if (next.phase === "done") {
        // A result is reported even when it is empty so the Composer can
        // remove the live preview instead of inserting silence.
        if (next.result) onResultRef.current?.(next.result);
        lastPartialRef.current = "";
        setState(IDLE_STATE);
        return;
      }
      if (
        next.phase === "listening" &&
        next.partialText &&
        next.partialText !== lastPartialRef.current
      ) {
        lastPartialRef.current = next.partialText;
        onPartialRef.current?.(next.partialText);
      }
      if (next.phase === "idle" || next.phase === "cancelling") {
        lastPartialRef.current = "";
      }
      setState(next);
    });
    return () => {
      unsubscribe();
      if (errorTimer.current) clearTimeout(errorTimer.current);
      errorTimer.current = null;
    };
  }, [enabled, setState]);

  const fail = useCallback(
    (error: unknown) => {
      // Main reports categorized failures through voice:stateChanged before
      // the invoke rejects; keep that code instead of a generic one.
      if (stateRef.current.phase === "error") return;
      setState({
        ...IDLE_STATE,
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
        errorCode: errorCodeOf(error),
      });
    },
    [setState],
  );

  const startVoice = useCallback(async () => {
    if (!enabled) return;
    if (!STARTABLE.has(stateRef.current.phase)) return;
    try {
      onSessionStartRef.current?.();
      setState(IDLE_STATE);
      await voiceIpc.start(settingsRef.current);
    } catch (error) {
      fail(error);
    }
  }, [enabled, fail, setState]);

  const stopVoice = useCallback(
    async (force = false) => {
      if (!enabled) return;
      if (!force && stateRef.current.phase !== "listening") return;
      try {
        await voiceIpc.stop();
      } catch (error) {
        // A forced release may race a start that never reached listening.
        // The main process then has nothing to stop; this is not a user error.
        if (!force) fail(error);
      }
    },
    [enabled, fail],
  );

  const toggle = useCallback(async () => {
    if (!enabled) return;
    const { phase } = stateRef.current;
    if (STARTABLE.has(phase)) await startVoice();
    else if (phase === "listening") await stopVoice();
  }, [enabled, startVoice, stopVoice]);

  const cancel = useCallback(() => {
    if (!enabled) return;
    pushToTalkHeldRef.current = false;
    lastPartialRef.current = "";
    void voiceIpc.cancel().catch(() => undefined);
    setState(IDLE_STATE);
  }, [enabled, setState]);

  const settlePushToTalkRelease = useCallback(() => {
    const { phase } = stateRef.current;
    if (phase === "listening") {
      void stopVoice(true);
      return;
    }
    if (phase === "preparing" || phase === "starting") {
      cancel();
      return;
    }
    void voiceIpc
      .getState()
      .then((remote) => {
        if ((remote as VoiceState).phase === "listening") void stopVoice(true);
      })
      .catch(() => undefined);
  }, [cancel, stopVoice]);
  const beginPushToTalk = useCallback(() => {
    if (!enabled || pushToTalkHeldRef.current) return false;
    if (!STARTABLE.has(stateRef.current.phase)) return false;

    pushToTalkHeldRef.current = true;
    const starting = startVoice();
    pushToTalkStartRef.current = starting;
    void starting.finally(() => {
      if (pushToTalkStartRef.current === starting) pushToTalkStartRef.current = null;
      if (!pushToTalkHeldRef.current) settlePushToTalkRelease();
    });
    return true;
  }, [enabled, settlePushToTalkRelease, startVoice]);

  const endPushToTalk = useCallback(() => {
    pushToTalkHeldRef.current = false;
    if (!enabled) return;

    const { phase } = stateRef.current;
    if (pushToTalkStartRef.current) {
      // Loading is abortable; recording may still be settling into listening.
      if (phase === "listening") void stopVoice(true);
      else if (phase === "preparing" || phase === "starting") cancel();
      return;
    }
    if (phase === "listening") {
      void stopVoice(true);
      return;
    }
    if (phase === "preparing" || phase === "starting") {
      cancel();
      return;
    }
    // The Composer can remount while Main is still recording. Reconcile the
    // release with the authoritative process state instead of local state.
    void voiceIpc
      .getState()
      .then((remote) => {
        if ((remote as VoiceState).phase === "listening") void stopVoice(true);
      })
      .catch(() => undefined);
  }, [cancel, enabled, stopVoice]);

  return {
    state,
    toggle,
    cancel,
    beginPushToTalk,
    endPushToTalk,
  };
}
