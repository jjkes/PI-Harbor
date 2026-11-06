import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Mode, SessionThinkingLevel } from "@pi-harbor/shared";
import type { RuntimeProviderConfig } from "../provider-binding.js";
import type { ReasoningReplayIdentity } from "../reasoning-replay.js";

/**
 * What a BTW side question starts from (ADR 0344): a read-only copy of the
 * main session's next provider request and its model binding.
 */
export type SideQuestionSnapshot = {
  /** The main session; BTW requests keep its prefix-cache affinity. */
  sessionId: string;
  /** The main session's mode; host-core requires it on every tool call. */
  mode: Mode;
  provider: RuntimeProviderConfig;
  thinkingLevel: SessionThinkingLevel;
  /** Deep copy of the transcript the next main request would start from. */
  messages: AgentMessage[];
  /** That request's tool declarations. A side run never executes these. */
  tools: AgentTool[];
  reasoningReplayIdentity: ReasoningReplayIdentity;
  /** Whether a main turn was running when the snapshot was taken. */
  mainTurnRunning: boolean;
};
