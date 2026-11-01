import type { UiMessage } from "@pi-harbor/shared";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useAppStore } from "../../stores/app-store";

export type SessionTranscriptPreview =
  | { status: "ready"; messages: UiMessage[] }
  | { status: "loading" | "unavailable"; messages?: undefined };

/**
 * A session's live transcript, read without selecting the session.
 *
 * The preview reads the projection the store already keeps: the active
 * transcript, or the background cache that agent events stream into. A pane
 * therefore shows what the conversation would, with no second copy to drift.
 * A session this window has not read yet has no projection, so the pane loads
 * its recent tail once with the same bounded read as hover prefetch; agent
 * events keep it current from there. While a pane observes a projection, the
 * cache keeps it resident.
 */
export function useSessionTranscriptPreview(sessionId: string): SessionTranscriptPreview {
  const observe = useAppStore((state) => state.observeSessionTranscript);
  const peek = useAppStore((state) => state.peekSessionTranscript);
  const prefetchSession = useAppStore((state) => state.prefetchSession);

  const subscribe = useCallback(
    (onChange: () => void) => {
      // Background writes reach only the runtime observer; selecting another
      // session or repainting a retained pane changes the store instead.
      const stopObserving = observe(sessionId, onChange);
      const stopStore = useAppStore.subscribe(onChange);
      return () => {
        stopObserving();
        stopStore();
      };
    },
    [observe, sessionId],
  );
  const getSnapshot = useCallback(() => peek(sessionId), [peek, sessionId]);
  const messages = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const [unavailableId, setUnavailableId] = useState<string | null>(null);
  const missing = messages === undefined;
  useEffect(() => {
    if (!missing) return;
    let disposed = false;
    const settle = () => {
      if (!disposed && peek(sessionId) === undefined) setUnavailableId(sessionId);
    };
    prefetchSession(sessionId).then(settle, (error: unknown) => {
      console.error("Active session preview failed to load", error);
      settle();
    });
    return () => {
      disposed = true;
    };
  }, [missing, peek, prefetchSession, sessionId]);

  if (messages) return { status: "ready", messages };
  return { status: unavailableId === sessionId ? "unavailable" : "loading" };
}
