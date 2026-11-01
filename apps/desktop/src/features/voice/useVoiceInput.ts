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
  /** Called once per finished dictation that produced text. */
  onResult?: (result: DictationResult) => void;
}

/** Live Voice holding the shared microphone lease is the one renderer-mapped code. */
function errorCodeOf(error: unknown): VoiceErrorCode {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === "LIVE_MICROPHONE_BUSY" ? "microphone-busy" : "failed";
}

export function useVoiceInput({ enabled = false, settings, onResult }: UseVoiceInputOptions = {}) {
  const [state, setStateValue] = useState<VoiceState>(IDLE_STATE);
  const stateRef = useRef<VoiceState>(IDLE_STATE);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
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
        // An empty result (silence, fillers only) inserts nothing.
        if (next.result?.text) onResultRef.current?.(next.result);
        setState(IDLE_STATE);
        return;
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

  const toggle = useCallback(async () => {
    if (!enabled) return;
    const { phase } = stateRef.current;
    try {
      if (STARTABLE.has(phase)) {
        setState(IDLE_STATE);
        await voiceIpc.start(settingsRef.current);
      } else if (phase === "listening") {
        await voiceIpc.stop();
      }
    } catch (error) {
      fail(error);
    }
  }, [enabled, fail, setState]);

  const cancel = useCallback(() => {
    if (!enabled) return;
    void voiceIpc.cancel().catch(() => undefined);
    setState(IDLE_STATE);
  }, [enabled, setState]);

  return { state, toggle, cancel };
}
