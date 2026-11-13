import type { UiMessage } from "@pi-harbor/shared";
import type { AssistantActivityItem } from "./assistant-turns";
import {
  delegationLifecycleKind,
  getToolAction,
  isDelegationStartTool,
  type DelegationLifecycleKind,
} from "./tool-display";
import { toolResultPayload } from "./tool-presentation";

export type DelegationActivityItem = Extract<
  AssistantActivityItem,
  { kind: "tool" }
>;

/**
 * What a topology node reports. `queued` is the one non-terminal, non-running
 * state: a delegation the runtime accepted but has not begun executing. It is
 * published only where that is true, never as a softer word for `running`.
 */
export type SubagentOutcome =
  | "queued"
  | "running"
  | "completed"
  | "timed_out"
  | "aborted"
  | "failed"
  | "stopped"
  | "denied";

/**
 * Outcomes a delegation never leaves. A settled subagent is history: a later
 * lifecycle row that still reports `running` (or `queued`) must not reopen it,
 * which would redraw finished work as current.
 */
const TERMINAL_OUTCOMES: ReadonlySet<SubagentOutcome> = new Set<SubagentOutcome>([
  "completed",
  "timed_out",
  "aborted",
  "failed",
  "stopped",
  "denied",
]);

function isTerminalOutcome(outcome: SubagentOutcome): boolean {
  return TERMINAL_OUTCOMES.has(outcome);
}

export type SubagentTiming = {
  startedAt?: number;
  completedAt?: number;
};

export function isDelegationActivityItem(
  item: AssistantActivityItem,
): item is DelegationActivityItem {
  // Only the tool that STARTS a subagent is a delegation activity item (ADR
  // 0062): the lifecycle tools (TaskWait/TaskList/TaskStop, ADR 0089) drive an
  // existing delegation and must not inflate the topology's subagent counts.
  return (
    item.kind === "tool" &&
    isDelegationStartTool(item.message.toolName) &&
    getToolAction(item.message.toolName) === "delegate"
  );
}

const DELEGATION_STATUSES = new Set<SubagentOutcome>([
  "queued",
  "running",
  "completed",
  "timed_out",
  "aborted",
  "failed",
  "stopped",
  "denied",
]);

function asDelegationStatus(value: unknown): SubagentOutcome | null {
  return DELEGATION_STATUSES.has(value as SubagentOutcome)
    ? (value as SubagentOutcome)
    : null;
}

/** The three phases a plan-debate seat publishes beside its `debateRound`. */
const DEBATE_SEAT_PHASES: ReadonlySet<string> = new Set(["draft", "critique", "integrate"]);

/**
 * Is this delegation row one seat of a plan debate?
 *
 * The debate driver publishes `phase` + `debateRound` beside the seat's status.
 * A round outlives the turn that opened it: the coordinator's turn ends the
 * moment its tool calls return, while drafts, critiques and the integrator keep
 * running on their own delegates. The seat's status is therefore the seat's own
 * report; only the parent turn's liveness is irrelevant to it.
 */
function isDebateSeat(payload: Record<string, unknown> | null): boolean {
  return (
    !!payload &&
    typeof payload.debateRound === "number" &&
    typeof payload.phase === "string" &&
    DEBATE_SEAT_PHASES.has(payload.phase)
  );
}
/** A terminal outcome wins over anything a later row still claims. */
function nextStatus(
  current: SubagentOutcome | undefined,
  incoming: SubagentOutcome,
): SubagentOutcome {
  return current && isTerminalOutcome(current) && !isTerminalOutcome(incoming)
    ? current
    : incoming;
}

/** TaskStop listed this row, so a `running` snapshot still means stopped. */
function stoppedEntryStatus(value: unknown): SubagentOutcome {
  const status = asDelegationStatus(value);
  return !status || status === "running" || status === "queued"
    ? "stopped"
    : status;
}

function ingestLifecycleStatuses(
  statuses: Map<string, SubagentOutcome>,
  entries: unknown,
  fromStopped: boolean,
): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    const record = asRecord(entry);
    const id = record?.delegationId;
    const status = fromStopped
      ? stoppedEntryStatus(record?.status)
      : asDelegationStatus(record?.status);
    // Later live rows win, but a settled outcome is final: a row that still
    // reports running (or queued) after one of them closed cannot reopen it.
    if (typeof id === "string" && id && status) {
      statuses.set(id, nextStatus(statuses.get(id), status));
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function addTiming(
  timings: Map<string, SubagentTiming>,
  value: unknown,
): void {
  const record = asRecord(value);
  const delegationId = record?.delegationId;
  if (typeof delegationId !== "string" || !delegationId) return;
  const startedAt = timestamp(record?.startedAt);
  const completedAt = timestamp(record?.completedAt);
  if (startedAt === undefined && completedAt === undefined) return;
  const previous = timings.get(delegationId);
  timings.set(delegationId, {
    ...(previous?.startedAt !== undefined || startedAt !== undefined
      ? { startedAt: startedAt ?? previous?.startedAt }
      : {}),
    ...(previous?.completedAt !== undefined || completedAt !== undefined
      ? { completedAt: completedAt ?? previous?.completedAt }
      : {}),
  });
}

/**
 * Runtime timing for each delegation, including the initial `Task` start and
 * the later lifecycle snapshot that carries `completedAt`.
 *
 * A `Task` tool call ends as soon as the background delegate starts, so its
 * `toolDurationMs` is not the delegate's runtime. TaskList/TaskWait/TaskStop
 * repeat the registry timing and are the source of truth for settled nodes.
 */
export function collectDelegationTimings(
  items: readonly AssistantActivityItem[],
): ReadonlyMap<string, SubagentTiming> {
  const timings = new Map<string, SubagentTiming>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const payload = asRecord(toolResultPayload(item.message));
    if (!payload) continue;
    if (isDelegationActivityItem(item)) addTiming(timings, payload);
    const delegations = [
      ...(Array.isArray(payload.delegations) ? payload.delegations : []),
      ...(Array.isArray(payload.stopped) ? payload.stopped : []),
    ];
    for (const delegation of delegations) {
      addTiming(timings, delegation);
    }
  }
  return timings;
}

/**
 * Wall-clock span of one topology card, keyed by that card's own Task ids so
 * a later fan-out in the same turn cannot stretch an earlier card's elapsed
 * time. `completedAt` is omitted while any of those delegates is still running.
 */
export function delegationTimingBounds(
  items: readonly DelegationActivityItem[],
  timings: ReadonlyMap<string, SubagentTiming>,
): { startedAt?: number; completedAt?: number } {
  let startedAt: number | undefined;
  let completedAt: number | undefined;
  let pending = false;
  for (const item of items) {
    const payload = asRecord(toolResultPayload(item.message));
    const id = payload?.delegationId;
    if (typeof id !== "string" || !id) continue;
    const timing = timings.get(id);
    const start = timing?.startedAt ?? timestamp(payload?.startedAt);
    const end = timing?.completedAt ?? timestamp(payload?.completedAt);
    if (start !== undefined) {
      startedAt = startedAt === undefined ? start : Math.min(startedAt, start);
    }
    if (end === undefined) pending = true;
    else {
      completedAt = completedAt === undefined ? end : Math.max(completedAt, end);
    }
  }
  return {
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(!pending && completedAt !== undefined ? { completedAt } : {}),
  };
}

/**
 * Latest status per delegation id, from Task snapshots and lifecycle results.
 *
 * `Task` returns the moment the delegate starts (ADR 0089), so its own result
 * initially says `running`. The runtime later refreshes that Task row with
 * its terminal status, independently of parent lifecycle polling.
 * TaskWait/TaskList report `details.delegations[]`; TaskStop reports
 * `details.stopped[]`. Those rows — which are deliberately not topology nodes —
 * are what tells a delegation card how its subagent actually finished.
 *
 * When `turnLive` is false the parent turn has ended, so any leftover
 * `running` node is reconstructed as `aborted` (the runtime aborts them at
 * run end). A `TaskStop` snapshot that still says `running` is `stopped`.
 *
 * A plan-debate seat is the one exception: its round outlives the turn that
 * opened it, so a seat that reports `running` keeps reporting `running` after
 * that turn closed (`isDebateSeat`). Ordinary delegations keep the rule above.
 */
export function collectDelegationStatuses(
  items: readonly AssistantActivityItem[],
  options?: { turnLive?: boolean },
): ReadonlyMap<string, SubagentOutcome> {
  const statuses = new Map<string, SubagentOutcome>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    // Read the row before the guard narrows `item` away: every tool item is a
    // potential delegation node, so excluding them leaves TS with `never`.
    const { message } = item;
    if (isDelegationActivityItem(item)) continue;
    const payload = asRecord(toolResultPayload(message));
    if (!payload) continue;
    ingestLifecycleStatuses(statuses, payload.delegations, false);
    ingestLifecycleStatuses(statuses, payload.stopped, true);
  }
  // The runtime refreshes Task itself as soon as its delegate settles. This
  // terminal snapshot outranks an older TaskList/TaskWait running snapshot,
  // even though those lifecycle rows appear later in transcript order.
  for (const item of items) {
    if (!isDelegationActivityItem(item)) continue;
    const payload = asRecord(toolResultPayload(item.message));
    const status = asDelegationStatus(payload?.status);
    const id = payload?.delegationId;
    if (typeof id === "string" && id && status && status !== "running" && status !== "queued") {
      statuses.set(id, nextStatus(statuses.get(id), status));
    }
  }
  if (options?.turnLive === false) {
    for (const item of items) {
      if (item.kind !== "tool" || !isDelegationActivityItem(item)) continue;
      const payload = asRecord(toolResultPayload(item.message));
      // A debate seat's own report stands: the turn that opened the round is
      // not what runs the seat, so its end aborts nothing here.
      if (isDebateSeat(payload)) continue;
      const id = payload?.delegationId;
      if (typeof id !== "string" || !id) continue;
      const current = statuses.get(id);
      if (!current || current === "running" || current === "queued") {
        statuses.set(id, "aborted");
      }
    }
  }
  return statuses;
}

/**
 * A settled subagent's failure as the runtime reported it.
 *
 * `Task` initially returns when a delegate starts (ADR 0089); its refreshed
 * terminal snapshot can carry a failure even before the parent polls.
 * `TaskWait`/`TaskList` report `details.delegations[]` and
 * `TaskStop` reports `details.stopped[]`, and those entries do carry
 * `error: { code, message }` from `SubagentRunResult.error`.
 */
export type DelegationFailure = {
  code: string;
  message: string;
};

function readDelegationFailure(entry: unknown): DelegationFailure | null {
  const record = asRecord(entry);
  const error = asRecord(record?.error);
  if (!error) return null;
  const code = typeof error.code === "string" ? error.code.trim() : "";
  const message = typeof error.message === "string" ? error.message.trim() : "";
  if (!code && !message) return null;
  return { code, message };
}

/**
 * Why each settled delegation failed, keyed by delegation id.
 *
 * {@link collectDelegationStatuses} says *that* a subagent ended as `failed`,
 * `timed_out`, or `aborted`; this says why, from the same lifecycle rows and
 * with the same last-write-wins rule. A delegate that fails before emitting a
 * message row has no other carrier for its reason, which is what left a failed
 * subagent's detail panel showing steps and no explanation.
 */
export function collectDelegationFailures(
  items: readonly AssistantActivityItem[],
): ReadonlyMap<string, DelegationFailure> {
  const failures = new Map<string, DelegationFailure>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    // Read the row before the guard narrows `item` away: every tool item is a
    // potential delegation node, so excluding them leaves TS with `never`.
    const { message } = item;
    if (isDelegationActivityItem(item)) continue;
    const payload = asRecord(toolResultPayload(message));
    if (!payload) continue;
    for (const entries of [payload.delegations, payload.stopped]) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const record = asRecord(entry);
        const id = record?.delegationId;
        if (typeof id !== "string" || !id) continue;
        const failure = readDelegationFailure(entry);
        if (failure) failures.set(id, failure);
      }
    }
  }
  for (const item of items) {
    if (!isDelegationActivityItem(item)) continue;
    const payload = asRecord(toolResultPayload(item.message));
    const id = payload?.delegationId;
    const failure = readDelegationFailure(payload);
    if (typeof id === "string" && id && failure) failures.set(id, failure);
  }
  return failures;
}

/** One subagent named on a lifecycle row's roster (ADR 0089). */
export type DelegationRosterEntry = {
  delegationId: string;
  agentName: string;
  status: SubagentOutcome;
  durationMs?: number;
};

/**
 * The subagents a lifecycle row reports on, in the order the runtime listed
 * them.
 *
 * `TaskWait`/`TaskList` report `details.delegations[]` and `TaskStop` reports
 * `details.stopped[]`; both carry the agent name and status, which is what a
 * reader needs. Without this the row could only show its `delegationIds`
 * argument, which is a list of bare UUIDs (D268).
 */
export function delegationRoster(
  message: UiMessage,
): DelegationRosterEntry[] {
  if (!delegationLifecycleKind(message.toolName)) return [];
  const payload = asRecord(toolResultPayload(message));
  if (!payload) return [];
  const roster: DelegationRosterEntry[] = [];
  const pushEntries = (entries: unknown, fromStopped: boolean) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const record = asRecord(entry);
      const delegationId = record?.delegationId;
      if (typeof delegationId !== "string" || !delegationId) continue;
      const agent = record?.agent;
      const startedAt = timestamp(record?.startedAt);
      const completedAt = timestamp(record?.completedAt);
      roster.push({
        delegationId,
        agentName: typeof agent === "string" ? agent : "",
        status: fromStopped
          ? stoppedEntryStatus(record?.status)
          : (asDelegationStatus(record?.status) ?? "running"),
        ...(startedAt !== undefined && completedAt !== undefined
          ? { durationMs: Math.max(0, completedAt - startedAt) }
          : {}),
      });
    }
  };
  pushEntries(payload.delegations, false);
  pushEntries(payload.stopped, true);
  return roster;
}

/**
 * What a lifecycle row should say in one line: the subagents it reports on, by
 * name, deduplicated so a repeated agent is counted rather than listed twice.
 */
export function delegationRosterSummary(
  roster: readonly DelegationRosterEntry[],
): string {
  if (roster.length === 0) return "";
  const counts = new Map<string, number>();
  for (const entry of roster) {
    if (!entry.agentName) continue;
    counts.set(entry.agentName, (counts.get(entry.agentName) ?? 0) + 1);
  }
  if (counts.size === 0) return "";
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(", ");
}

/** Roster status rolled up for the row's own badge. */
export function delegationRosterOutcome(
  roster: readonly DelegationRosterEntry[],
): SubagentOutcome | null {
  if (roster.length === 0) return null;
  // Neither a running nor a queued delegate has produced a result yet.
  const active = roster.find(
    (entry) => entry.status === "running" || entry.status === "queued",
  );
  if (active) return active.status;
  const failed = roster.find(
    (entry) => entry.status === "failed" || entry.status === "denied",
  );
  if (failed) return failed.status;
  const warned = roster.find((entry) => entry.status !== "completed");
  return warned ? warned.status : "completed";
}

export function lifecycleKindOf(
  message: UiMessage,
): DelegationLifecycleKind | null {
  return delegationLifecycleKind(message.toolName);
}

export function subagentOutcome(
  message: UiMessage,
  statuses?: ReadonlyMap<string, SubagentOutcome>,
): SubagentOutcome {
  const payload = asRecord(toolResultPayload(message));
  if (payload) {
    const delegationId = payload.delegationId;
    if (typeof delegationId === "string") {
      const settled = statuses?.get(delegationId);
      if (settled) return settled;
    }
    const status = asDelegationStatus(payload.status);
    if (status) return status;
  }
  if (message.toolStatus === "running") return "running";
  if (message.toolStatus === "error") return "failed";
  if (message.toolStatus === "denied") return "denied";
  return "completed";
}
/**
 * Whether a running delegation is still being created rather than already
 * executing.
 *
 * The parent `Task` call returns its structured handle (`delegationId`,
 * `startedAt`) only at its own `tool_end` (ADR 0089). Until that result
 * arrives the row is `toolStatus: "running"` with no delegation payload: the
 * delegate runtime is still spawning and the UI cannot resolve a stable
 * delegation id. Phrasing this stretch as a distinct "creating" state — with
 * its own label and a live elapsed ticking from the call's own timestamp —
 * keeps the transcript from reading as frozen while the create happens.
 */
export function delegationIsCreating(message: UiMessage): boolean {
  if (message.toolStatus !== "running") return false;
  const payload = asRecord(toolResultPayload(message));
  if (payload && typeof payload.delegationId === "string") return false;
  return true;
}

export function summarizeSubagentActivity(
  items: readonly DelegationActivityItem[],
  statuses?: ReadonlyMap<string, SubagentOutcome>,
) {
  const outcomes = items.map((item) => subagentOutcome(item.message, statuses));
  // A queued delegation has not produced anything yet either, so it is not
  // finished; it is only ever counted as still outstanding work.
  const outstanding = (outcome: SubagentOutcome) =>
    outcome === "running" || outcome === "queued";
  return {
    total: outcomes.length,
    finished: outcomes.filter((outcome) => !outstanding(outcome)).length,
    running: outcomes.filter(outstanding).length,
    issues: outcomes.filter(
      (outcome) => outcome === "failed" || outcome === "denied",
    ).length,
    warnings: outcomes.filter(
      (outcome) =>
        outcome === "timed_out" ||
        outcome === "aborted" ||
        outcome === "stopped",
    ).length,
  };
}
/**
 * One dispatch round of a parent node's children: the fan-out of one `Task`
 * call.
 */
export type DelegationRound = {
  /** The `Task` call that started this round's children. */
  key: string;
  items: DelegationActivityItem[];
};

/**
 * A parent node's children split into the rounds that dispatched them.
 *
 * A resumed delegation's rows are re-keyed to its newest call, so its run holds
 * the children of every round it ever dispatched. Drawing all of them as this
 * round's work makes finished subagents look current, which is a lie about what
 * is happening now. Each child therefore keeps the call that actually started
 * it: `nodeId` is the round being drawn, every other key is history.
 */
export function delegationChildRounds(
  children: readonly DelegationActivityItem[],
  nodeId: string,
): { current: DelegationActivityItem[]; previous: DelegationRound[] } {
  const byCall = new Map<string, DelegationActivityItem[]>();
  const order: string[] = [];
  for (const child of children) {
    const key = child.message.parentToolCallId || nodeId;
    const round = byCall.get(key);
    if (round) {
      round.push(child);
      continue;
    }
    byCall.set(key, [child]);
    order.push(key);
  }
  return {
    current: byCall.get(nodeId) ?? [],
    previous: order
      .filter((key) => key !== nodeId)
      .map((key) => ({ key, items: byCall.get(key) ?? [] })),
  };
}

/**
 * The round number of each child whose handle repeats across one parent's
 * rounds. Two rounds of the same role would otherwise be drawn as one title
 * twice; the ordinal is what keeps them apart. Children of a handle that
 * appears once carry no ordinal.
 */
export function delegationRoundOrdinals(
  rounds: readonly DelegationRound[],
  handleOf: (item: DelegationActivityItem) => string,
): ReadonlyMap<string, number> {
  const entries: { id: string; handle: string; round: number }[] = [];
  rounds.forEach((round, index) => {
    for (const child of round.items) {
      const handle = handleOf(child);
      if (!handle) continue;
      entries.push({ id: childNodeId(child), handle, round: index + 1 });
    }
  });
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.handle, (counts.get(entry.handle) ?? 0) + 1);
  }
  const ordinals = new Map<string, number>();
  for (const entry of entries) {
    if ((counts.get(entry.handle) ?? 0) > 1) ordinals.set(entry.id, entry.round);
  }
  return ordinals;
}

/**
 * A child node's identity, matching `delegationNodeId` in `session-delegations`
 * (`toolCallId` first). It is repeated here because that module reads this one,
 * and a child's round must not invert the dependency.
 */
function childNodeId(item: DelegationActivityItem): string {
  return item.message.toolCallId || item.message.id;
}
