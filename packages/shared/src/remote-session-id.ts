/**
 * Renderer-visible ids for sessions a paired remote host owns, and the
 * `native-pi:` namespace of imported Pi CLI sessions.
 *
 * Main namespaces remote ids `remote:<hostKey>:<hostSessionId>`. The renderer
 * never routes on the prefix, but it does decide that a remote session's
 * context cannot be read here (`unavailableSessionContext`), and that decision
 * needs the grammar: a malformed `remote:` id must fall through to the IPC
 * handler and be rejected, not be answered as an unavailable session. Keeping
 * the parser here means Main and the renderer read the same grammar.
 */
export const REMOTE_SESSION_PREFIX = "remote:";

/** Namespace of an imported Pi CLI session, whose runtime keeps its own context. */
export const NATIVE_PI_SESSION_PREFIX = "native-pi:";

/** Build the namespaced id the renderer sees for a remote session. */
export function makeRemoteSessionId(hostKey: string, hostSessionId: string): string {
  if (hostKey.includes(":")) {
    throw Object.assign(new Error("remote hostKey must not contain ':'"), {
      errorCode: "INVALID_ARGUMENT",
    });
  }
  return `${REMOTE_SESSION_PREFIX}${hostKey}:${hostSessionId}`;
}

export function isRemoteSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && sessionId.startsWith(REMOTE_SESSION_PREFIX);
}

/** Split a `remote:<hostKey>:<hostSessionId>` id back into its parts. */
export function parseRemoteSessionId(
  sessionId: string,
): { hostKey: string; hostSessionId: string } | null {
  if (!sessionId.startsWith(REMOTE_SESSION_PREFIX)) return null;
  const rest = sessionId.slice(REMOTE_SESSION_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { hostKey: rest.slice(0, separator), hostSessionId: rest.slice(separator + 1) };
}
