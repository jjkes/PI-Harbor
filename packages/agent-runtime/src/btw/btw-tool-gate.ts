/**
 * The read-only tool gate of a BTW side run (ADR 0344). The side run declares
 * the main session's tools unchanged, so the provider's prefix cache can hit,
 * but only Read, Glob, and Grep execute, and only through a host client that
 * carries the read-only access profile. Host-core enforces the same profile.
 */

import type { AgentTool, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { ErrorCodes, type Mode } from "@pi-harbor/shared";

export const BTW_ALLOWED_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep"]);

/** Assistant rounds with tool calls before further calls are denied. */
export const BTW_MAX_TOOL_ROUNDS = 8;

export const BTW_BLOCKED_TOOL_REASON =
  "Side questions are read-only: only Read, Glob, and Grep are available.";
export const BTW_TOOL_BUDGET_REASON = "Tool budget used; answer with what you have.";

export type BtwToolRunner = (
  toolName: string,
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
) => ReturnType<AgentTool["execute"]>;

/**
 * Wrap the snapshot's tool declarations. Names, descriptions, and schemas
 * stay unchanged; allowed tools run through `run`, every other tool throws.
 */
export function gateBtwTools(tools: readonly AgentTool[], run: BtwToolRunner): AgentTool[] {
  const blocked: AgentTool["execute"] = () =>
    Promise.reject(new Error(BTW_BLOCKED_TOOL_REASON));
  return tools.map((tool): AgentTool => {
    if (!BTW_ALLOWED_TOOLS.has(tool.name)) return { ...tool, execute: blocked };
    const execute: AgentTool["execute"] = (toolCallId, params, signal) =>
      run(tool.name, toolCallId, params, signal);
    return { ...tool, execute };
  });
}

export type BtwToolDecision =
  | { allow: true }
  | { allow: false; errorCode: string; result: BeforeToolCallResult };

/**
 * Decide one tool call of assistant round `round` (1-based). Past the round
 * budget one more round is denied so the model can still answer; after that
 * the run stops, so a model that keeps calling tools cannot loop.
 */
export function btwToolDecision(toolName: string, round: number): BtwToolDecision {
  if (round > BTW_MAX_TOOL_ROUNDS) {
    return {
      allow: false,
      errorCode: ErrorCodes.BTW_TOOL_BUDGET_EXHAUSTED,
      result: {
        block: true,
        reason: BTW_TOOL_BUDGET_REASON,
        ...(round > BTW_MAX_TOOL_ROUNDS + 1 ? { terminate: true } : {}),
      },
    };
  }
  if (!BTW_ALLOWED_TOOLS.has(toolName)) {
    return {
      allow: false,
      errorCode: ErrorCodes.TOOL_DISABLED_IN_READ_ONLY,
      result: { block: true, reason: BTW_BLOCKED_TOOL_REASON },
    };
  }
  return { allow: true };
}

/** The only host methods a BTW run can reach. */
export type BtwHostCaller = {
  call<T>(method: "tools.execute" | "tools.abort", params: unknown): Promise<T>;
};

export type BtwHostToolResult = {
  ok: boolean;
  isError?: boolean;
  denied?: boolean;
  errorCode?: string;
  content: unknown;
};

/** What a BTW run can do on the host: run an allowed tool, read-only. */
export type BtwHostClient = {
  executeTool(
    toolName: string,
    toolCallId: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<BtwHostToolResult>;
};

/** Host tool-call id of a BTW call: opaque, and never equal to a main id. */
export function btwHostToolCallId(runId: string, toolCallId: string): string {
  return `btw:${runId}:${toolCallId}`;
}

/**
 * The run's host client. Every call carries the main session's mode, which
 * host-core requires, and `accessProfile: "read-only"`. It never sends a turn
 * id, file batch ticket, delegation id, or permission scope.
 */
export function btwHostClient(
  host: BtwHostCaller,
  scope: { sessionId: string; runId: string; mode: Mode },
): BtwHostClient {
  return {
    async executeTool(toolName, toolCallId, args, signal) {
      if (signal?.aborted) throw abortError();
      const hostToolCallId = btwHostToolCallId(scope.runId, toolCallId);
      const pending = host.call<BtwHostToolResult>("tools.execute", {
        sessionId: scope.sessionId,
        toolCallId: hostToolCallId,
        toolName,
        args,
        mode: scope.mode,
        accessProfile: "read-only",
      });
      if (!signal) return pending;
      // A read-only call may be abandoned locally; the host is asked to stop
      // it, and the run does not wait for the host to confirm.
      const onAbort = () => {
        void host
          .call("tools.abort", {
            sessionId: scope.sessionId,
            toolCallId: hostToolCallId,
            toolName,
          })
          .catch((error: unknown) => {
            console.warn("[btw] tools.abort failed", error);
          });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await raceAbort(pending, signal);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

function abortError(): Error {
  const error = new Error("The side question was stopped.");
  error.name = "AbortError";
  return error;
}

/** Settle as soon as `signal` aborts; the host call may still finish later. */
function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
  });
}
