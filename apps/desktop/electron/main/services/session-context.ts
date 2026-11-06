import { replaySessionSystemContext, type SystemContextCheckpoint } from "@pi-harbor/agent-runtime";
import { unavailableSessionContext, type SessionContextSnapshot, type UiMessage } from "@pi-harbor/shared";

/** The part of `HostProcess` this module needs. */
export type SessionContextHost = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
};

/**
 * What `session.contextTranscript` returns: every row of the merged
 * transcript, reduced to the fields the replay reads, and the anchor and
 * folded system state of the latest checkpoint. Null when the session is
 * gone.
 */
type SessionContextTranscript = {
  messages: UiMessage[];
  compaction?: SystemContextCheckpoint;
};

/**
 * The system prompt and tool declarations a session's last model request
 * carried, for the read-only context viewer.
 *
 * host-core owns the transcript. It reads the whole of it (a windowed read
 * could miss the rows the replay needs), holding its state lock only for the
 * file read, and leaves out the tool payloads, usage, and checkpoint bodies
 * the replay never reads. The agent runtime's replay then applies the rules a
 * restored runtime applies. Remote and native Pi CLI sessions keep no such
 * rows on this host; `unavailableSessionContext` answers for them, the rule
 * the renderer also applies before it calls.
 */
export async function readSessionContextSnapshot(
  host: SessionContextHost | null,
  sessionId: string,
): Promise<SessionContextSnapshot> {
  const elsewhere = unavailableSessionContext(sessionId);
  if (elsewhere) return elsewhere;
  if (!host) throw new Error("host unavailable");
  const result = await host.call<{ transcript?: SessionContextTranscript | null }>(
    "session.contextTranscript",
    { id: sessionId },
  );
  const transcript = result?.transcript;
  if (!transcript) throw new Error("session not found");
  const replay = replaySessionSystemContext(transcript.messages, transcript.compaction);
  return replay ? { status: "ready", sessionId, ...replay } : { status: "empty", sessionId };
}
