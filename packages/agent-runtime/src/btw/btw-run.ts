/**
 * One BTW run (ADR 0344): a pi-agent-core Agent for one side question, seeded
 * from a snapshot of the main session, with the main session's model binding
 * and a read-only tool gate. The run owns its abort controller and reports
 * BTW events. It never writes to the main session.
 */

import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentToolResult,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  ErrorCodes,
  type AppError,
  type BtwEvent,
  type BtwHistoryTurn,
} from "@pi-harbor/shared";
import { classifyAgentError } from "../agent-errors.js";
import { DESKTOP_AGENT_IDENTITY } from "../agent-identity.js";
import { contextBudgetFor } from "../context-budget.js";
import { hostToolResultContent } from "../host-tool-result.js";
import { readLocalRequestErrorDetails } from "../local-request-errors.js";
import { visionFromModelConfig } from "../model-capabilities.js";
import { convertToLlm } from "../pi-runtime-messages.js";
import { classifyProviderError } from "../provider-retry.js";
import { withProviderFetchFailure } from "../provider-transport-recovery.js";
import { alignRetainedReasoningIdentity } from "../reasoning-replay.js";
import { normalizeToolParams, requireAliasedParams } from "../runtime.js";
import {
  subagentModelBinding,
  type SubagentProviderRetryState,
} from "../subagent-model-binding.js";
import { createToolCallIdentity, dedupeToolCallMessages } from "../tool-call-dedupe.js";
import { buildBtwRequest } from "./btw-request.js";
import { btwToolDecision, gateBtwTools, type BtwHostClient } from "./btw-tool-gate.js";
import type { SideQuestionSnapshot } from "./btw-types.js";

export type BtwRunOptions = {
  runId: string;
  snapshot: SideQuestionSnapshot;
  question: string;
  history: readonly BtwHistoryTurn[];
  client: BtwHostClient;
  emit: (event: BtwEvent) => void;
};

/** A classified failure as the wire-safe error a BTW event carries. */
export function btwAppError(error: {
  code: string;
  message: string;
  retriable: boolean;
  details?: unknown;
}): AppError {
  return {
    code: error.code,
    message: error.message,
    retriable: error.retriable,
    ...(error.details !== undefined ? { details: error.details } : {}),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

export class BtwRun {
  private readonly opts: BtwRunOptions;
  private readonly controller = new AbortController();
  private agent?: Agent;
  private toolRounds = 0;
  private readonly countedAssistants = new WeakSet<object>();
  private readonly toolErrorCodes = new Map<string, string>();
  private budgetExhausted = false;
  private messageHasText = false;
  private wroteText = false;
  /** A side question reports provider failures instead of retrying them. */
  private readonly retryState: SubagentProviderRetryState = { claim: () => undefined };

  constructor(opts: BtwRunOptions) {
    this.opts = opts;
  }

  abort(): void {
    this.controller.abort();
    this.agent?.abort();
  }

  /** Run to completion and end with one `done` or `error`. Never throws. */
  async execute(): Promise<void> {
    try {
      await this.run();
    } catch (error) {
      if (this.controller.signal.aborted || isAbortError(error)) {
        this.opts.emit({ type: "done", stopReason: "aborted" });
      } else {
        this.opts.emit({ type: "error", error: btwAppError(classifyAgentError(error)) });
      }
    }
  }

  private async run(): Promise<void> {
    const { snapshot } = this.opts;
    if (this.controller.signal.aborted) {
      this.opts.emit({ type: "done", stopReason: "aborted" });
      return;
    }
    const binding = subagentModelBinding(
      {
        provider: snapshot.provider,
        thinkingLevel: snapshot.thinkingLevel,
        // The main session's id keeps prefix-cache affinity with its requests.
        sessionId: snapshot.sessionId,
        onUsage: (usage) => this.opts.emit({ type: "usage", usage }),
        uniqueToolCalls: createToolCallIdentity(snapshot.messages),
      },
      this.retryState,
    );
    const request = buildBtwRequest({
      messages: snapshot.messages,
      question: this.opts.question,
      history: this.opts.history,
      mainTurnRunning: snapshot.mainTurnRunning,
      fits: (messages) => {
        const budget = contextBudgetFor(binding.model, messages);
        return budget.tokens < budget.hardLimit;
      },
    });
    if (!request) {
      this.opts.emit({
        type: "error",
        error: {
          code: ErrorCodes.BTW_CONTEXT_FULL,
          message:
            "The main conversation is too long for a side question. Compact it and ask again.",
          retriable: false,
        },
      });
      return;
    }
    const vision = visionFromModelConfig(snapshot.provider.modelConfig);
    const tools = gateBtwTools(snapshot.tools, (toolName, toolCallId, params, signal) =>
      this.runTool(toolName, toolCallId, params, vision, signal),
    );
    const agent = new Agent({
      identity: DESKTOP_AGENT_IDENTITY,
      streamFn: binding.streamFn,
      getApiKey: binding.getApiKey,
      // The same pure conversion the main session applies to its requests,
      // without its journal write.
      convertToLlm: (messages) =>
        alignRetainedReasoningIdentity(
          convertToLlm(dedupeToolCallMessages(messages).messages),
          snapshot.reasoningReplayIdentity,
        ),
      beforeToolCall: async (context) => this.beforeToolCall(context),
      initialState: {
        model: binding.model,
        thinkingLevel: binding.agentThinkingLevel,
        tools,
        messages: request.messages,
      },
      toolExecution: "parallel",
    });
    this.agent = agent;
    const startLength = request.messages.length;
    const unsubscribe = agent.subscribe((event) => this.handleEvent(event));
    try {
      if (!this.controller.signal.aborted) await agent.continue();
    } finally {
      unsubscribe();
    }
    this.finish(agent.state.messages.slice(startLength), agent.state.errorMessage);
  }

  private async runTool(
    toolName: string,
    toolCallId: string,
    rawParams: unknown,
    vision: boolean,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    const params = normalizeToolParams(toolName, rawParams);
    requireAliasedParams(toolName, params);
    const result = await this.opts.client.executeTool(toolName, toolCallId, params, signal);
    if (typeof result.errorCode === "string") {
      this.toolErrorCodes.set(toolCallId, result.errorCode);
    }
    const { text, imageBlocks, details } = hostToolResultContent(result.content, vision);
    return {
      content: [{ type: "text", text }, ...imageBlocks],
      details,
      isError: result.isError === true || result.ok === false,
    };
  }

  private beforeToolCall(context: BeforeToolCallContext): BeforeToolCallResult | undefined {
    if (!this.countedAssistants.has(context.assistantMessage)) {
      this.countedAssistants.add(context.assistantMessage);
      this.toolRounds += 1;
    }
    const decision = btwToolDecision(context.toolCall.name, this.toolRounds);
    if (decision.allow) return undefined;
    this.toolErrorCodes.set(context.toolCall.id, decision.errorCode);
    if (decision.result.terminate) this.budgetExhausted = true;
    return decision.result;
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") this.messageHasText = false;
        return;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type !== "text_delta" || !update.delta) return;
        // Text after a tool round starts a new paragraph of the answer.
        const separator = this.wroteText && !this.messageHasText ? "\n\n" : "";
        this.messageHasText = true;
        this.wroteText = true;
        this.opts.emit({ type: "text_delta", delta: `${separator}${update.delta}` });
        return;
      }
      case "tool_execution_start":
        this.opts.emit({
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        return;
      case "tool_execution_end": {
        const errorCode = this.toolErrorCodes.get(event.toolCallId);
        this.opts.emit({
          type: "tool_end",
          toolCallId: event.toolCallId,
          ok: !event.isError,
          ...(errorCode ? { errorCode } : {}),
        });
        return;
      }
      default:
        return;
    }
  }

  private finish(added: readonly AgentMessage[], errorMessage: string | undefined): void {
    if (this.controller.signal.aborted) {
      this.opts.emit({ type: "done", stopReason: "aborted" });
      return;
    }
    const last = lastAssistant(added);
    if (last) {
      const localError = readLocalRequestErrorDetails(last);
      if (last.stopReason === "aborted" || localError?.causeName === "AbortError") {
        this.opts.emit({ type: "done", stopReason: "aborted" });
        return;
      }
      if (last.stopReason === "error") {
        const classified = withProviderFetchFailure(
          classifyProviderError(last, this.retryState.status),
          this.retryState.failure,
        );
        this.opts.emit({ type: "error", error: btwAppError(classified) });
        return;
      }
    } else if (errorMessage) {
      this.opts.emit({
        type: "error",
        error: btwAppError(classifyAgentError(new Error(errorMessage))),
      });
      return;
    }
    if (this.budgetExhausted) {
      this.opts.emit({
        type: "error",
        error: {
          code: ErrorCodes.BTW_TOOL_BUDGET_EXHAUSTED,
          message: "The side question used its tool budget before it finished answering.",
          retriable: true,
        },
      });
      return;
    }
    this.opts.emit({ type: "done", stopReason: "stop" });
  }
}
