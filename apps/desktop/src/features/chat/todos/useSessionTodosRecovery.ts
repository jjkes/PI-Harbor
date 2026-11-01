import { useEffect } from "react";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { startSessionTodosRecovery } from "./session-todos-recovery";

/**
 * Keep the session's checklist snapshot recovered. `enabled` is false for a
 * session that cannot use local tools (a remote one), which has no checklist.
 */
export function useSessionTodosRecovery(sessionId: string, enabled = true): void {
  useEffect(() => {
    if (!enabled) return undefined;
    return startSessionTodosRecovery(sessionId, {
      getTodos: api.getTodos,
      onHostStatus: api.onHostStatus,
      applySnapshot: (snapshot) => useAppStore.getState().applyTodosChanged(snapshot),
      reportError: (error) => console.error("Session checklist recovery failed", error),
    });
  }, [sessionId, enabled]);
}
