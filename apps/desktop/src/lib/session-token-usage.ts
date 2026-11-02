import type { MessageUsage, UiMessage } from "@pi-harbor/shared";

/**
 * Token usage for one scope of a session.
 *
 * `totalTokens` is `input + output + cacheRead + cacheWrite`; `reasoningTokens`
 * is reported beside them for inspection but never added, because a provider's
 * output count already includes reasoning (D103). Summing the buckets instead
 * of the provider's `totalTokens` keeps cache traffic visible even when a
 * provider reports a rounded total.
 */
export type TokenUsageScope = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

/**
 * Session-level token usage, keeping the main session and its delegates apart.
 *
 * A row belongs to a delegate when it carries `parentToolCallId`, the `Task`
 * tool call that spawned it (ADR 0062); the parent model never sees those rows.
 */
export type SessionTokenUsage = {
  /** Rows without `parentToolCallId`. */
  main: TokenUsageScope & {
    /** Assistant replies in the main session; one turn can produce several. */
    modelCallCount: number;
  };

  /** Every row produced inside a delegate. */
  subagents: TokenUsageScope & {
    /** Distinct `Task` tool calls, not the number of delegate rows. */
    delegationCount: number;
  };

  /** Main session plus delegates. */
  total: TokenUsageScope;

  /** Per-agent breakdown keyed by subagent definition name. */
  byAgent?: Map<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      callCount: number;
    }
  >;
};

function safeTokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function emptyScope(): TokenUsageScope {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function addUsageToScope(scope: TokenUsageScope, usage: MessageUsage): void {
  scope.inputTokens += safeTokenCount(usage.inputTokens);
  scope.outputTokens += safeTokenCount(usage.outputTokens);
  scope.cacheReadTokens += safeTokenCount(usage.cacheReadTokens);
  scope.cacheWriteTokens += safeTokenCount(usage.cacheWriteTokens);
  scope.reasoningTokens += safeTokenCount(usage.reasoningTokens);
  scope.totalTokens =
    scope.inputTokens + scope.outputTokens + scope.cacheReadTokens + scope.cacheWriteTokens;
}

function sumScopes(left: TokenUsageScope, right: TokenUsageScope): TokenUsageScope {
  const total: TokenUsageScope = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: 0,
  };
  total.totalTokens =
    total.inputTokens + total.outputTokens + total.cacheReadTokens + total.cacheWriteTokens;
  return total;
}

/**
 * Aggregate token usage across a session's messages.
 *
 * Only assistant rows that reported usage contribute; a session that has not
 * completed a model request yields zeroes rather than throwing.
 *
 * @param messages Every message of the session, in transcript order
 * @param includeByAgent Whether to add the per-agent breakdown
 */
export function aggregateSessionTokenUsage(
  messages: readonly UiMessage[],
  includeByAgent = false,
): SessionTokenUsage {
  const main: SessionTokenUsage["main"] = { ...emptyScope(), modelCallCount: 0 };
  const subagents: SessionTokenUsage["subagents"] = {
    ...emptyScope(),
    delegationCount: 0,
  };
  const delegations = new Set<string>();
  const byAgent = includeByAgent
    ? new Map<
        string,
        {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
          callCount: number;
        }
      >()
    : undefined;

  for (const message of messages) {
    if (message.role !== "assistant" || !message.usage) continue;

    const taskCallId = message.parentToolCallId;
    if (!taskCallId) {
      addUsageToScope(main, message.usage);
      main.modelCallCount += 1;
      continue;
    }

    addUsageToScope(subagents, message.usage);
    delegations.add(taskCallId);

    if (!byAgent || !message.agentName) continue;
    const entry = byAgent.get(message.agentName);
    if (entry) {
      entry.inputTokens += safeTokenCount(message.usage.inputTokens);
      entry.outputTokens += safeTokenCount(message.usage.outputTokens);
      entry.totalTokens = entry.inputTokens + entry.outputTokens;
      entry.callCount += 1;
    } else {
      const inputTokens = safeTokenCount(message.usage.inputTokens);
      const outputTokens = safeTokenCount(message.usage.outputTokens);
      byAgent.set(message.agentName, {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        callCount: 1,
      });
    }
  }

  subagents.delegationCount = delegations.size;

  return {
    main,
    subagents,
    total: sumScopes(main, subagents),
    ...(byAgent ? { byAgent } : {}),
  };
}
