import type { UiMessage } from "@pi-harbor/shared";
import { delegateAgentName, delegateModelId } from "../chat/transcript/model";
import {
  buildTranscriptEntries,
  type AssistantActivityItem,
} from "../../lib/assistant-turns";
import {
  collectDelegationStatuses,
  collectDelegationTimings,
  delegationTimingBounds,
  isDelegationActivityItem,
  subagentOutcome,
  type DelegationActivityItem,
  type SubagentOutcome,
} from "../../lib/subagent-topology";
import { toolResultPayload } from "../../lib/tool-presentation";

/**
 * One persisted Task call in the Team graph. The Main agent and history
 * placeholders are deliberately not synthetic nodes; a component can render
 * those around this persisted evidence.
 */
export type TeamGraphNode = {
  /** details.delegationId, falling back to toolCallId and then the row id. */
  id: string;
  /** Durable row id, suitable for scrolling back to the Task call. */
  messageId: string;
  delegationId?: string;
  toolCallId?: string;
  agentName: string;
  /** Task description, or the first line of its brief when omitted. */
  description: string;
  /** Full Task brief. */
  brief: string;
  /** Effective model recorded by the Task result; empty while unavailable. */
  modelId: string;
  status: SubagentOutcome;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  /** Actual persisted ancestry depth. Null for an orphan or a cycle. */
  depth: number | null;
  /** Assistant turn containing the root Task row. */
  turnId?: string;
  /** Root L1 node id, including the L1 node itself. */
  rootId?: string;
  /** Direct owner node when its Task row is loaded; undefined means L0 or missing. */
  ownerId?: string;
  /** Persisted owner linkage, retained even when the owner row is missing. */
  parentToolCallId?: string;
  resumed: boolean;
  /** The delegation/call id supplied to Task.resume. */
  resumeFrom?: string;
  /** The owner is not loaded, so this node needs a partial-history treatment. */
  orphan: boolean;
  /** True for actual depth greater than two and for cycles. */
  depthAnomaly: boolean;
  /** The persisted owner chain contains a cycle. */
  cycle: boolean;
};

/** Nodes belonging to one assistant turn, in persisted transcript order. */
export type TeamGraphTurn = {
  id: string;
  /** L1 nodes directly owned by the Main agent. */
  rootIds: string[];
  /** All rooted nodes, including explicitly flagged deep anomalies. */
  nodeIds: string[];
};

/**
 * Flat graph projection for a future TeamGraph component.
 *
 * Orphans and cycles remain in `nodes` but are absent from `turns`, because no
 * loaded root Task row can give them a truthful turn. Consumers must surface
 * their flags rather than silently reattaching them.
 */
export type TeamGraph = {
  nodes: TeamGraphNode[];
  turns: TeamGraphTurn[];
};

type PendingNode = {
  item: DelegationActivityItem;
  message: UiMessage;
  id: string;
  delegationId?: string;
  toolCallId?: string;
  parentToolCallId?: string;
};

type Lineage = {
  depth: number | null;
  root: PendingNode | null;
  orphan: boolean;
  cycle: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Resolve only through persisted Task rows. A missing owner is not evidence of
 * L1/L2 depth, and a cycle has no meaningful depth at all.
 */
function resolveLineage(
  start: PendingNode,
  byToolCallId: ReadonlyMap<string, PendingNode>,
): Lineage {
  const seen = new Set<PendingNode>([start]);
  let current = start;
  let depth = 1;
  while (current.parentToolCallId) {
    const owner = byToolCallId.get(current.parentToolCallId);
    if (!owner) {
      return { depth: null, root: null, orphan: true, cycle: false };
    }
    if (seen.has(owner)) {
      return { depth: null, root: null, orphan: false, cycle: true };
    }
    seen.add(owner);
    current = owner;
    depth += 1;
  }
  return { depth, root: current, orphan: false, cycle: false };
}

/** Assistant-turn identity of every loaded root Task row. */
function rootTaskTurns(messages: readonly UiMessage[]): Map<UiMessage, string> {
  const turns = new Map<UiMessage, string>();
  const { entries } = buildTranscriptEntries([...messages]);
  for (const entry of entries) {
    if (entry.kind !== "assistant-turn") continue;
    for (const part of entry.parts) {
      if (part.kind !== "activity") continue;
      for (const item of part.items) {
        if (item.kind === "tool" && !item.message.parentToolCallId) {
          turns.set(item.message, entry.id);
        }
      }
    }
  }
  return turns;
}

/**
 * Build Team mode's two-level delegation projection from persisted messages.
 * Only Task start rows create nodes. Lifecycle rows contribute status/timing
 * through the same helpers as the transcript, and an optional pre-derived
 * status map overrides those readings (for example, turn-live reconciliation).
 */
export function buildTeamGraph(
  messages: readonly UiMessage[],
  statuses?: ReadonlyMap<string, SubagentOutcome>,
): TeamGraph {
  const toolItems: AssistantActivityItem[] = messages.flatMap((message) =>
    message.role === "tool" ? [{ kind: "tool" as const, message }] : [],
  );
  const startItems = toolItems.filter((item): item is DelegationActivityItem => {
    if (!isDelegationActivityItem(item)) return false;
    const { message } = item;
    if (message.toolStatus !== "error" && message.isError !== true) return true;
    // Rejected/unknown Task calls are activity, not started agents. Preserve
    // legacy successful rows without an id, and any real delegation record.
    return Boolean(identifier(asRecord(toolResultPayload(message))?.delegationId));
  });
  const pending: PendingNode[] = startItems.map((item) => {
    const message = item.message;
    const payload = asRecord(toolResultPayload(message));
    const delegationId = identifier(payload?.delegationId);
    const toolCallId = identifier(message.toolCallId);
    const parentToolCallId = identifier(message.parentToolCallId);
    return {
      item,
      message,
      id: delegationId ?? toolCallId ?? message.id,
      ...(delegationId ? { delegationId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(parentToolCallId ? { parentToolCallId } : {}),
    };
  });

  const byToolCallId = new Map<string, PendingNode>();
  for (const node of pending) {
    if (node.toolCallId) byToolCallId.set(node.toolCallId, node);
  }
  const turnByRoot = rootTaskTurns(messages);
  const derivedStatuses = collectDelegationStatuses(toolItems);
  const effectiveStatuses = new Map(derivedStatuses);
  if (statuses) {
    for (const [id, status] of statuses) effectiveStatuses.set(id, status);
  }
  const timings = collectDelegationTimings(toolItems);

  const nodes = pending.map((node): TeamGraphNode => {
    const { message } = node;
    const args = asRecord(message.toolArgs);
    const payload = asRecord(toolResultPayload(message));
    const lineage = resolveLineage(node, byToolCallId);
    const owner = node.parentToolCallId
      ? byToolCallId.get(node.parentToolCallId)
      : undefined;
    const turnId = lineage.root
      ? turnByRoot.get(lineage.root.message)
      : undefined;
    const bounds = delegationTimingBounds([node.item], timings);
    const startedAt = bounds.startedAt ?? timestamp(payload?.startedAt);
    const completedAt = bounds.completedAt ?? timestamp(payload?.completedAt);
    const brief = text(args?.task) ?? "";
    const description = text(args?.description) ?? brief.split(/\r?\n/, 1)[0];
    const resumeFrom = text(args?.resume);
    return {
      id: node.id,
      messageId: message.id,
      ...(node.delegationId ? { delegationId: node.delegationId } : {}),
      ...(node.toolCallId ? { toolCallId: node.toolCallId } : {}),
      agentName:
        delegateAgentName(message) ||
        text(payload?.agentName) ||
        text(payload?.agent) ||
        "",
      description,
      brief,
      modelId: delegateModelId(message),
      status: subagentOutcome(message, effectiveStatuses),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(startedAt !== undefined && completedAt !== undefined
        ? { durationMs: Math.max(0, completedAt - startedAt) }
        : {}),
      depth: lineage.depth,
      ...(turnId ? { turnId } : {}),
      ...(lineage.root ? { rootId: lineage.root.id } : {}),
      ...(owner ? { ownerId: owner.id } : {}),
      ...(node.parentToolCallId
        ? { parentToolCallId: node.parentToolCallId }
        : {}),
      resumed: resumeFrom !== undefined,
      ...(resumeFrom ? { resumeFrom } : {}),
      orphan: lineage.orphan,
      depthAnomaly: lineage.cycle || (lineage.depth ?? 0) > 2,
      cycle: lineage.cycle,
    };
  });

  const turns: TeamGraphTurn[] = [];
  const turnById = new Map<string, TeamGraphTurn>();
  for (const node of nodes) {
    if (!node.turnId) continue;
    let turn = turnById.get(node.turnId);
    if (!turn) {
      turn = { id: node.turnId, rootIds: [], nodeIds: [] };
      turnById.set(node.turnId, turn);
      turns.push(turn);
    }
    turn.nodeIds.push(node.id);
    if (node.depth === 1 && !node.parentToolCallId) turn.rootIds.push(node.id);
  }
  return { nodes, turns };
}
