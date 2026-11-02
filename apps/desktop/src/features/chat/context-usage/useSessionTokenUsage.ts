import { useMemo } from "react";
import type { UiMessage } from "@pi-harbor/shared";
import {
  aggregateSessionTokenUsage,
  type SessionTokenUsage,
} from "../../../lib/session-token-usage";

/**
 * Calculate session-level token usage statistics from messages.
 *
 * Separates main session usage from subagent usage based on `parentToolCallId`.
 * The result updates whenever messages change.
 *
 * @param sessionId Current session id (for keying)
 * @param messages All messages in the session
 * @param enabled Whether to compute usage (optimization)
 */
export function useSessionTokenUsage(
  sessionId: string | undefined,
  messages: readonly UiMessage[],
  enabled = true,
): SessionTokenUsage | undefined {
  return useMemo(() => {
    if (!enabled || !sessionId) return undefined;
    return aggregateSessionTokenUsage(messages);
  }, [enabled, sessionId, messages]);
}
