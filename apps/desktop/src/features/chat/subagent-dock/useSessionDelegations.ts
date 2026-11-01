import { useMemo, useRef } from "react";
import { useTranscriptView } from "../../../hooks/use-transcript-view";
import { collectLiveDelegationEntries } from "../../../lib/live-delegation-entries";
import {
  reuseSessionDelegations,
  sessionDelegations,
  type SessionDelegations,
} from "../../../lib/session-delegations";
import { getTranscriptProjection } from "../../../lib/transcript-projection";
import { EMPTY_TRANSCRIPT } from "../../../lib/transcript-reading";
import { useAppStore } from "../../../stores/app-store";

/**
 * Every delegate of one session, as the composer dock's graph draws them.
 *
 * It reads the range the main transcript reads, through the same cached
 * projection, so the dock and the transcript cards judge the same messages the
 * same way. A reading range that has left the live tail (a search result, a
 * restored position) would hide the run that is still going, so the dock then
 * reads the live session instead: a running delegate never drops out of the
 * graph while the user reads history.
 */
export function useSessionDelegations(sessionId: string): SessionDelegations {
  const transcript = useTranscriptView(sessionId);
  // The live session, selected the way `useTranscriptView` selects it.
  const live = useAppStore((state) =>
    state.activeSessionId === sessionId
      ? state.messages
      : (state.retainedTranscripts[sessionId] ?? EMPTY_TRANSCRIPT),
  );
  const running = useAppStore((state) => state.runningSessions[sessionId] ?? false);
  // The same value the transcript projects with, so both share one cache entry.
  const compactions = useAppStore((state) => state.sessionCompactions[sessionId]);
  const messages = transcript.liveTail ? transcript.messages : live;

  const next = useMemo(() => {
    const projection = getTranscriptProjection(messages, compactions);
    const liveEntries = collectLiveDelegationEntries(
      projection.history,
      projection.entries.at(-1),
      running,
    );
    return sessionDelegations(projection.entries, liveEntries, projection.runs);
  }, [messages, compactions, running]);

  // A stream tick rebuilds the reading; keep the identities the graph's rows
  // and the dock's badge rule key on while nothing they show changed.
  const previous = useRef<SessionDelegations | undefined>(undefined);
  const delegations = reuseSessionDelegations(previous.current, next);
  previous.current = delegations;
  return delegations;
}
