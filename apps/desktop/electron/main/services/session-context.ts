import { replaySessionSystemContext } from "@pi-harbor/agent-runtime";
import type { ContextCompactionRecord, SessionContextSnapshot, UiMessage } from "@pi-harbor/shared";

/** The part of `HostProcess` this module needs. */
export type SessionContextHost = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
};

/**
 * The system prompt and tool declarations a session's last model request
 * carried, for the read-only context viewer.
 *
 * host-core owns the transcript, so this reads the whole of it (no message or
 * content limit: a windowed read could miss the rows the replay needs) and
 * hands it to the agent runtime's replay, the same rules a restored runtime
 * applies. Remote and native Pi CLI sessions keep no such rows on this host.
 */
export async function readSessionContextSnapshot(
  host: SessionContextHost | null,
  sessionId: string,
): Promise<SessionContextSnapshot> {
  if (sessionId.startsWith("remote:")) return { status: "unavailable", sessionId, reason: "remote" };
  if (sessionId.startsWith("native-pi:")) return { status: "unavailable", sessionId, reason: "native" };
  if (!host) throw new Error("host unavailable");
  const result = await host.call<{
    session?: { messages?: UiMessage[]; compaction?: ContextCompactionRecord | null } | null;
  }>("session.get", { id: sessionId });
  const session = result?.session;
  if (!session) throw new Error("session not found");
  const replay = replaySessionSystemContext(session.messages ?? [], session.compaction);
  return replay ? { status: "ready", sessionId, ...replay } : { status: "empty", sessionId };
}
