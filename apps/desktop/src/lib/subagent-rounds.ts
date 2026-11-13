/**
 * Per-round lifecycle for a session's delegates.
 *
 * A session used to keep every settled delegate forever: the dock's graph and
 * the work panel grew with each fan-out, and a long conversation turned into a
 * wall of finished work. A round is one dispatch — the delegates a single
 * dispatcher started, which is the `parentToolCallId` grouping
 * `subagent-topology` already draws. "End round" retires the settled delegates
 * of the current round from the session's live view: nodes leave the graph,
 * their tabs close, and the transcript folds them into one line.
 *
 * Nothing is deleted. Retiring only records which rounds are folded, so the
 * host, the transcript and the record of what ran are untouched, and a retired
 * round's own rows stay expandable. A round is also folded one delegate at a
 * time: `retireDelegation` puts away the single node the user is done with, so
 * a finished delegate leaves the graph while its running siblings keep theirs.
 */
import type { SessionDelegations } from "./session-delegations";
import {
  summarizeSubagentActivity,
  type DelegationActivityItem,
  type SubagentOutcome,
} from "./subagent-topology";
import { toolResultPayload } from "./tool-presentation";

/** A node's identity, matching `delegationNodeId` in `session-delegations`. */
function nodeIdOf(item: DelegationActivityItem): string {
  return item.message.toolCallId || item.message.id;
}

/**
 * Folded rounds of one session: the round key to the node ids it retired.
 *
 * The node ids are stored beside the key because the transcript reads a
 * per-fan-out row and has no round key of its own: it asks whether the rows it
 * drew are the ones that were folded.
 */
export type RetiredRounds = ReadonlyMap<string, readonly string[]>;

export const NO_RETIRED_ROUNDS: RetiredRounds = new Map();

/** Neither a running nor a queued delegate has finished, so neither is history. */
function isSettled(outcome: SubagentOutcome): boolean {
  return outcome !== "running" && outcome !== "queued";
}

function outcomeOf(
  item: DelegationActivityItem,
  delegations: SessionDelegations,
): SubagentOutcome {
  const payload = toolResultPayload(item.message);
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { delegationId?: unknown; status?: unknown })
      : null;
  const id = typeof record?.delegationId === "string" ? record.delegationId : "";
  const settled = id ? delegations.statuses.get(id) : undefined;
  if (settled) return settled;
  if (item.message.toolStatus === "running") return "running";
  if (item.message.toolStatus === "error") return "failed";
  if (item.message.toolStatus === "denied") return "denied";
  return "completed";
}

/** The round a node belongs to, or null for a node the reading does not key. */
export function nodeRound(
  delegations: SessionDelegations,
  nodeId: string,
): string | null {
  return delegations.rounds.get(nodeId) ?? null;
}

/**
 * The round "End round" would retire: the newest round that still has a
 * settled delegate.
 *
 * `items` is ordered running work first, then settled work newest turn first,
 * so the first settled item names it. A mixed round (one sibling still
 * running) is still the current round; the retirer folds only its settled
 * members, which is why a running delegate can never disappear.
 */
export function currentSettledRound(
  delegations: SessionDelegations,
): string | null {
  for (const item of delegations.items) {
    if (!isSettled(outcomeOf(item, delegations))) continue;
    const round = nodeRound(delegations, nodeIdOf(item));
    if (round) return round;
  }
  return null;
}

/**
 * Retire the current round.
 *
 * Only settled delegates are folded, and only from one round, so a running
 * delegate can never disappear from the graph. A round the user already folded
 * one node of keeps the ids it holds and gains this round's remaining settled
 * ones, so the two ways of putting work away meet in one set instead of
 * overwriting each other. With nothing new to fold the same map comes back: the
 * action is idempotent, which is what lets the control be clicked twice without
 * a second fold or an extra entry.
 */
export function retireCurrentRound(
  delegations: SessionDelegations,
  retired: RetiredRounds,
): RetiredRounds {
  const round = currentSettledRound(delegations);
  if (!round) return retired;
  const nodes: string[] = [...(retired.get(round) ?? [])];
  let added = false;
  for (const item of delegations.items) {
    if (nodeRound(delegations, nodeIdOf(item)) !== round) continue;
    if (!isSettled(outcomeOf(item, delegations))) continue;
    const nodeId = nodeIdOf(item);
    if (nodes.includes(nodeId)) continue;
    nodes.push(nodeId);
    added = true;
  }
  if (!added) return retired;
  const next = new Map(retired);
  next.set(round, nodes);
  return next;
}

/**
 * Retire one settled delegate, leaving every sibling where it is.
 *
 * "End round" puts a whole dispatch away at once; this folds the one node the
 * user is finished with, so a settled delegate can leave the graph while the
 * siblings it was dispatched with — running or not — stay exactly as they are.
 * Only a settled delegate is folded, the same rule the round action keeps: a
 * running or queued node is still doing something the user asked for, so it is
 * never closed behind their back. A node the reading does not key to a round
 * is left alone too, because nothing would follow it into the folded set.
 *
 * Idempotent: an unknown node, a roundless node, a node that has not settled
 * and a node already folded all return the same map, so a double click folds
 * once. Otherwise the node is appended to its round's list — merged with what
 * an earlier folding already put there, never duplicated — and every other
 * round keeps the ids it holds.
 */
export function retireDelegation(
  delegations: SessionDelegations,
  retired: RetiredRounds,
  nodeId: string,
): RetiredRounds {
  const item = delegations.items.find((candidate) => nodeIdOf(candidate) === nodeId);
  if (!item) return retired;
  const round = nodeRound(delegations, nodeId);
  if (!round) return retired;
  if (!isSettled(outcomeOf(item, delegations))) return retired;
  const folded = retired.get(round) ?? [];
  if (folded.includes(nodeId)) return retired;
  const next = new Map(retired);
  next.set(round, [...folded, nodeId]);
  return next;
}

/** Whether a round key is folded. */
export function isRoundRetired(
  round: string | null | undefined,
  retired: RetiredRounds,
): boolean {
  return Boolean(round) && retired.has(round as string);
}

/**
 * Whether one transcript fan-out was folded: it is retired when every row it
 * drew belongs to a retired round. An empty group is never folded, because
 * there would be nothing to expand.
 */
export function isRoundFolded(
  nodes: readonly string[],
  retired: RetiredRounds,
): boolean {
  if (nodes.length === 0 || retired.size === 0) return false;
  const folded = new Set<string>();
  for (const ids of retired.values()) for (const id of ids) folded.add(id);
  return nodes.every((id) => folded.has(id));
}

/**
 * The folded line for what is still live: the newest retired round that the
 * reading still knows about, and how many delegates it folded.
 *
 * It is a selector, not a stored string, so it follows the same ordering rules
 * the graph uses: a session that folded two rounds reports the newer one.
 */
export function foldedRoundSummary(
  delegations: SessionDelegations,
  retired: RetiredRounds,
): { round: string; count: number } | null {
  if (retired.size === 0) return null;
  for (const item of delegations.items) {
    const round = nodeRound(delegations, nodeIdOf(item));
    if (!round) continue;
    const nodes = retired.get(round);
    if (!nodes || nodes.length === 0) continue;
    return { round, count: nodes.length };
  }
  return null;
}

/** The delegation ids of the retired nodes, so their work-panel tabs can close. */
export function retiredDelegationIds(
  delegations: SessionDelegations,
  retired: RetiredRounds,
): string[] {
  if (retired.size === 0) return [];
  const folded = new Set<string>();
  for (const ids of retired.values()) for (const id of ids) folded.add(id);
  const ids: string[] = [];
  for (const item of delegations.items) {
    if (!folded.has(nodeIdOf(item))) continue;
    const payload = toolResultPayload(item.message);
    const record =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { delegationId?: unknown })
        : null;
    const id = record && typeof record.delegationId === "string" ? record.delegationId : "";
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The reading with retired rounds removed, for the graph, the badge rule and
 * the roster: what the session is currently doing, not everything it ever did.
 *
 * Nothing retired means the same object back, so a session that never used the
 * action pays nothing for it.
 */
export function liveSessionDelegations(
  delegations: SessionDelegations,
  retired: RetiredRounds,
): SessionDelegations {
  if (retired.size === 0) return delegations;
  // Folded by node, not by round key: a mixed round keeps the sibling that is
  // still running in the graph even after the settled ones are put away.
  const foldedNodes = new Set<string>();
  for (const ids of retired.values()) for (const id of ids) foldedNodes.add(id);
  const items = delegations.items.filter((item) => !foldedNodes.has(nodeIdOf(item)));
  if (items.length === delegations.items.length) return delegations;
  const keep = new Set(items.map(nodeIdOf));
  const children = new Map<string, readonly DelegationActivityItem[]>();
  for (const [node, nested] of delegations.children) {
    if (keep.has(node)) children.set(node, nested);
  }
  const nodes = delegations.nodes.filter((node) => keep.has(node.id));
  return {
    items,
    statuses: delegations.statuses,
    timings: delegations.timings,
    nodes,
    summary: summarizeSubagentActivity(items, delegations.statuses),
    children: children.size > 0 ? children : new Map(),
    deepNodeIds: delegations.deepNodeIds,
    rounds: delegations.rounds,
    delegationIds: delegations.delegationIds,
  };
}

/* -------------------------------------------------------------------------- */
/* Snapshot                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Renderer-storage snapshot. The version is part of the payload as well as the
 * key so a build that reads an older shape can tell it apart and start folded
 * nothing, rather than folding the wrong rounds.
 */
export const RETIRED_ROUNDS_SNAPSHOT_VERSION = 1;

export type RetiredRoundsSnapshot = {
  version: number;
  rounds: { round: string; nodes: string[] }[];
};

export function toRetiredRoundsSnapshot(
  retired: RetiredRounds,
): RetiredRoundsSnapshot {
  return {
    version: RETIRED_ROUNDS_SNAPSHOT_VERSION,
    rounds: [...retired.entries()].map(([round, nodes]) => ({
      round,
      nodes: [...nodes],
    })),
  };
}

/**
 * Read a stored snapshot back. Anything that is not exactly the current shape
 * is dropped: the set only decides what the UI folds, so a stale or corrupt
 * entry must leave the session unfolded rather than hide live work.
 */
export function fromRetiredRoundsSnapshot(raw: unknown): RetiredRounds {
  const retired = new Map<string, string[]>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return retired;
  const record = raw as { version?: unknown; rounds?: unknown };
  if (record.version !== RETIRED_ROUNDS_SNAPSHOT_VERSION) return retired;
  if (!Array.isArray(record.rounds)) return retired;
  for (const entry of record.rounds) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { round, nodes } = entry as { round?: unknown; nodes?: unknown };
    if (typeof round !== "string" || !round) continue;
    if (!Array.isArray(nodes)) continue;
    const ids = nodes.filter((node): node is string => typeof node === "string" && !!node);
    if (ids.length === 0) continue;
    retired.set(round, ids);
  }
  return retired;
}
