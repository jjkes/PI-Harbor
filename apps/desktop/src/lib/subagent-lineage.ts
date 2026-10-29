import type { UiMessage } from "@pi-harbor/shared";
import { delegateAgentName } from "../features/chat/transcript/model";
import type { PendingPermission } from "./pending-permissions";

const MAX_LINEAGE_HOPS = 32;

/**
 * Resolve the asking delegate's ancestry through loaded Task evidence only.
 * The permission's parentToolCallId identifies the Task that owns the asking
 * loop; following each Task row's own parent reaches the root without guessing.
 */
export function delegationAgentLineage(
  messages: readonly UiMessage[],
  request: Pick<PendingPermission, "parentToolCallId" | "agentName">,
): string[] {
  const tasksByCallId = new Map<string, UiMessage>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolName === "Task" && message.toolCallId) {
      tasksByCallId.set(message.toolCallId, message);
    }
  }

  const names: string[] = [];
  const seen = new Set<string>();
  const askingAgent = request.agentName?.trim();
  let parentToolCallId = request.parentToolCallId;
  let hops = 0;
  while (parentToolCallId && hops < MAX_LINEAGE_HOPS) {
    if (seen.has(parentToolCallId)) {
      // Cyclic history has no truthful ancestry; retain only the asking agent.
      return askingAgent ? [askingAgent] : [];
    }
    seen.add(parentToolCallId);
    const task = tasksByCallId.get(parentToolCallId);
    if (!task) break;
    const agent = delegateAgentName(task).trim();
    if (agent) names.unshift(agent);
    parentToolCallId = task.parentToolCallId;
    hops += 1;
  }

  if (askingAgent && names.at(-1) !== askingAgent) names.push(askingAgent);
  return names;
}

export function formatDelegationAgentLineage(
  messages: readonly UiMessage[],
  request: Pick<PendingPermission, "parentToolCallId" | "agentName">,
): string {
  return delegationAgentLineage(messages, request).join(" › ");
}
