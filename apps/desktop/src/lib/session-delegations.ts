import type { UiMessage } from "@pi-harbor/shared";
import {
  chainLatestCalls,
  reuseReadonlyMap,
  subagentRunsEqual,
  type SubagentRun,
  type AssistantTurnEntry,
  type AssistantTurnPart,
  type TranscriptEntry,
} from "./assistant-turns";
import {
  collectDelegationStatuses,
  collectDelegationTimings,
  isDelegationActivityItem,
  subagentOutcome,
  summarizeSubagentActivity,
  type DelegationActivityItem,
  type SubagentOutcome,
  type SubagentTiming,
} from "./subagent-topology";
import { isDelegationStartTool } from "./tool-display";
import { toolResultPayload } from "./tool-presentation";
import { getAssistantTurnSummary, reuseReferences } from "./transcript-summary";

/** One node of the session graph, as the composer dock's badge rule reads it. */
export type SessionDelegationNode = {
  /** The call the node draws: its `toolCallId`, else the row's own id. */
  id: string;
  /** The delegate is still being created or running. */
  active: boolean;
};

/** Every delegate of one session, in the shape `SubagentTopology` draws. */
export type SessionDelegations = {
  /** One node per delegate: running work first, then the newest settled work. */
  items: DelegationActivityItem[];
  /** Each node's status, read from the node's own turn. */
  statuses: ReadonlyMap<string, SubagentOutcome>;
  /** Each node's runtime timing, read from the node's own turn. */
  timings: ReadonlyMap<string, SubagentTiming>;
  nodes: SessionDelegationNode[];
  summary: ReturnType<typeof summarizeSubagentActivity>;
  /** A node's own nested Task calls, in dispatch order. Only L1 nodes key it. */
  children: ReadonlyMap<string, readonly DelegationActivityItem[]>;
  /** Nested nodes whose own run also starts a delegation (deeper than L2). */
  deepNodeIds: ReadonlySet<string>;
};

const NO_CHILDREN: ReadonlyMap<string, readonly DelegationActivityItem[]> = new Map();
const NO_DEEP_NODES: ReadonlySet<string> = new Set();
const NO_RUNS: ReadonlyMap<string, SubagentRun> = new Map();

/** A topology node's identity, shared by its children map and the badge. */
export function delegationNodeId(item: DelegationActivityItem): string {
  return item.message.toolCallId || item.message.id;
}

/** One assistant turn's delegations, read the way its transcript cards read them. */
type TurnDelegations = {
  /** The turn's `Task` rows, as topology nodes, in transcript order. */
  items: DelegationActivityItem[];
  /** Every delegation-start row of the turn, which is what the resume chain reads. */
  starts: UiMessage[];
  statuses: ReadonlyMap<string, SubagentOutcome>;
  timings: ReadonlyMap<string, SubagentTiming>;
};

const turnCache = new WeakMap<
  readonly AssistantTurnPart[],
  { live: boolean; value: TurnDelegations }
>();

/**
 * Status and timing come from every tool row of the turn, exactly as the turn's
 * own transcript card computes them, so a TaskWait in a later part settles a
 * node drawn from an earlier part. Cached on the immutable parts snapshot, so a
 * stream tick only re-reads the turn that changed.
 */
function turnDelegations(entry: AssistantTurnEntry, live: boolean): TurnDelegations {
  const cached = turnCache.get(entry.parts);
  if (cached && cached.live === live) return cached.value;
  const summary = getAssistantTurnSummary(entry);
  const toolItems = summary.tools.map((message) => ({ kind: "tool" as const, message }));
  const value: TurnDelegations = {
    items: summary.toolItems.filter(isDelegationActivityItem),
    starts: summary.tools.filter((message) => isDelegationStartTool(message.toolName)),
    statuses: collectDelegationStatuses(toolItems, { turnLive: live }),
    timings: collectDelegationTimings(toolItems),
  };
  turnCache.set(entry.parts, { live, value });
  return value;
}

/** The delegation id a `Task` result reported, the key its status is read by. */
function resultDelegationId(message: UiMessage): string | undefined {
  const payload = toolResultPayload(message);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const id = (payload as { delegationId?: unknown }).delegationId;
  return typeof id === "string" && id ? id : undefined;
}

/** The rows of a run that start a nested delegation, in dispatch order. */
function nestedStarts(run: SubagentRun): DelegationActivityItem[] {
  return run.items.flatMap((row) =>
    row.kind === "tool" && isDelegationActivityItem(row) ? [row] : []);
}

/**
 * A call the runtime refused (a role without the Task tool, a denied call) ends
 * in error with no delegation id: no delegate ever existed behind it, so it is
 * not a deeper level.
 */
function startedADelegate(row: DelegationActivityItem): boolean {
  const refused = row.message.toolStatus === "error" || row.message.toolStatus === "denied";
  return !refused || resultDelegationId(row.message) !== undefined;
}

/**
 * Every delegate of the session, as one graph.
 *
 * The transcript draws one topology card per fan-out, each judged by its own
 * turn. This graph stays truthful to those cards: each node is a call some card
 * draws, judged by that call's own turn, so the same messages always give a
 * node and its card the same outcome and timing. `liveEntries` names the turns
 * whose run is still going (`collectLiveDelegationEntries`); a leftover running
 * node of any other turn reads as aborted, as it does on its card.
 *
 * One delegate is one node. A resumed delegate is drawn by its latest call,
 * which is the call the transcript gives the chain's rows (ADR 0279), and calls
 * that report the same delegation id drive one delegate too, so the latest of
 * them stands for it.
 */
export function sessionDelegations(
  entries: readonly TranscriptEntry[],
  liveEntries: ReadonlyMap<string, true>,
  runs: ReadonlyMap<string, SubagentRun> = NO_RUNS,
): SessionDelegations {
  type Candidate = {
    item: DelegationActivityItem;
    turn: TurnDelegations;
    entryIndex: number;
    order: number;
  };
  const candidates: Candidate[] = [];
  const starts: UiMessage[] = [];
  entries.forEach((entry, entryIndex) => {
    if (entry.kind !== "assistant-turn") return;
    const turn = turnDelegations(entry, liveEntries.has(entry.id));
    starts.push(...turn.starts);
    for (const item of turn.items) {
      candidates.push({ item, turn, entryIndex, order: candidates.length });
    }
  });

  const latestCall = chainLatestCalls(starts);
  const chainHeads = candidates.filter(({ item }) => {
    const callId = item.message.toolCallId;
    return !callId || latestCall(callId) === callId;
  });
  const lastIndexById = new Map<string, number>();
  chainHeads.forEach(({ item }, index) => {
    const id = resultDelegationId(item.message);
    if (id) lastIndexById.set(id, index);
  });
  const delegates = chainHeads.filter(({ item }, index) => {
    const id = resultDelegationId(item.message);
    return !id || lastIndexById.get(id) === index;
  });

  // Each id is left on one node, so copying that node's own turn readings can
  // never mix two turns' answers for the same delegate.
  const statuses = new Map<string, SubagentOutcome>();
  const timings = new Map<string, SubagentTiming>();
  for (const { item, turn } of delegates) {
    const id = resultDelegationId(item.message);
    if (!id) continue;
    const status = turn.statuses.get(id);
    if (status) statuses.set(id, status);
    const timing = turn.timings.get(id);
    if (timing) timings.set(id, timing);
  }

  const running = (candidate: Candidate) =>
    subagentOutcome(candidate.item.message, statuses) === "running";
  // Running work first, in the order it was dispatched, so it is never buried;
  // then what settled, newest turn first, each turn in its own call order.
  const ordered = [
    ...delegates.filter(running),
    ...delegates
      .filter((candidate) => !running(candidate))
      .sort((left, right) => right.entryIndex - left.entryIndex || left.order - right.order),
  ];
  const items = ordered.map(({ item }) => item);
  const children = new Map<string, readonly DelegationActivityItem[]>();
  const deepNodeIds = new Set<string>();
  for (const item of items) {
    const run = item.delegate;
    if (!run) continue;
    const nested = nestedStarts(run).map((child) => {
      const ownRun = child.message.toolCallId
        ? runs.get(child.message.toolCallId)
        : undefined;
      if (ownRun && nestedStarts(ownRun).some(startedADelegate)) {
        deepNodeIds.add(delegationNodeId(child));
      }
      return ownRun ? { ...child, delegate: ownRun } : child;
    });
    if (nested.length === 0) continue;
    children.set(delegationNodeId(item), nested);
    // The work panel judges a nested delegate from its owner's own tool rows.
    // Read it the same way here: a settled owner leaves no child running.
    const ownerLive = subagentOutcome(item.message, statuses) === "running";
    const nestedItems = run.items.flatMap((row) => (row.kind === "tool" ? [row] : []));
    for (const [id, status] of collectDelegationStatuses(nestedItems, { turnLive: ownerLive })) {
      statuses.set(id, status);
    }
    for (const [id, timing] of collectDelegationTimings(nestedItems)) timings.set(id, timing);
  }
  return {
    items,
    statuses,
    timings,
    children: children.size > 0 ? children : NO_CHILDREN,
    deepNodeIds: deepNodeIds.size > 0 ? deepNodeIds : NO_DEEP_NODES,
    nodes: ordered.map((candidate) => ({
      id: candidate.item.message.toolCallId || candidate.item.message.id,
      active: running(candidate),
    })),
    summary: summarizeSubagentActivity(items, statuses),
  };
}

function timingsEqual(left: SubagentTiming, right: SubagentTiming): boolean {
  return left.startedAt === right.startedAt && left.completedAt === right.completedAt;
}

function nodesEqual(
  left: readonly SessionDelegationNode[],
  right: readonly SessionDelegationNode[],
): boolean {
  return (
    left.length === right.length &&
    left.every((node, index) => node.id === right[index].id && node.active === right[index].active)
  );
}

function summariesEqual(
  left: SessionDelegations["summary"],
  right: SessionDelegations["summary"],
): boolean {
  return (
    left.total === right.total &&
    left.finished === right.finished &&
    left.running === right.running &&
    left.issues === right.issues &&
    left.warnings === right.warnings
  );
}

function sameDeepNodes(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left === right ||
    (left.size === right.size && [...left].every((id) => right.has(id)));
}

function sameChildren(
  left: readonly DelegationActivityItem[],
  right: readonly DelegationActivityItem[],
): boolean {
  return left.length === right.length && left.every((item, index) =>
    item.message === right[index].message &&
    subagentRunsEqual(item.delegate, right[index].delegate));
}

/**
 * Keep every part of the previous reading that did not change, and the
 * previous reading itself when nothing did. A stream tick rebuilds the reading,
 * while the graph's rows and the dock's badge rule key on these identities.
 */
export function reuseSessionDelegations(
  previous: SessionDelegations | undefined,
  next: SessionDelegations,
): SessionDelegations {
  if (!previous) return next;
  const items = reuseReferences(previous.items, next.items);
  const statuses = reuseReadonlyMap(previous.statuses, next.statuses);
  const timings = reuseReadonlyMap(previous.timings, next.timings, timingsEqual);
  const nodes = nodesEqual(previous.nodes, next.nodes) ? previous.nodes : next.nodes;
  const children = reuseReadonlyMap(previous.children, next.children, sameChildren);
  const deepNodes = sameDeepNodes(previous.deepNodeIds, next.deepNodeIds)
    ? previous.deepNodeIds : next.deepNodeIds;
  const summary = summariesEqual(previous.summary, next.summary) ? previous.summary : next.summary;
  if (
    items === previous.items &&
    statuses === previous.statuses &&
    timings === previous.timings &&
    nodes === previous.nodes &&
    summary === previous.summary &&
    children === previous.children &&
    deepNodes === previous.deepNodeIds
  ) {
    return previous;
  }
  return { items, statuses, timings, nodes, summary, children, deepNodeIds: deepNodes };
}
