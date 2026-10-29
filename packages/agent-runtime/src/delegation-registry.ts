import type {
  AgentActivityAgentPhase,
  SubagentRunStatus,
  SubagentDefinition,
  SubagentThinkingLevel,
  UiMessage,
} from "@pi-harbor/shared";
import type { SubagentRunResult } from "./subagent.js";
import { assertCanDelegate, TeamPolicyError } from "./team-policy.js";

/**
 * Delegation lifecycle (ADR 0089): `Task` starts a subagent in the background
 * and returns immediately; `TaskWait` converges on running delegations;
 * `TaskList` reports on them; `TaskStop` stops them. Records are kept for the
 * session's lifetime (bounded by pruning below), so a settled delegation can
 * be re-read by id without re-running it.
 */
const MAX_RETAINED_DELEGATIONS = 100;

export type DelegationStatus =
  | "running"
  | SubagentRunStatus
  | "stopped";

/**
 * One background delegation owned by the session runtime. `completion`
 * resolves when the delegate settles; `abort` stops the delegate's agent.
 */
export type DelegationRecord = {
  delegationId: string;
  /** In-memory owner; null denotes an L0-owned root delegation. */
  ownerDelegationId: string | null;
  /** Owner-derived depth, never accepted from persisted or model input. */
  depth: 1 | 2;
  /** Successful nested starts during this run. */
  nestedStarts: number;
  /** Definition and resolved tools used if this record later owns a nested Task. */
  definition: SubagentDefinition;
  resolvedToolNames: string[];
  /** Parent `Task` toolCallId that started this delegation. */
  parentToolCallId?: string;
  /** True when the delegate declares file-mutating tools (`Write` / `Edit`). */
  writable?: boolean;
  /** True only for the record that created and therefore settles this worktree. */
  ownsWorktree: boolean;
  /**
   * Chain id under which host-core keeps this Write/Edit subagent's own git
   * worktree in an isolated session (ADR 0329); absent otherwise.
   */
  worktreeKey?: string;
  /** Original Task transcript snapshot, available after its immediate result. */
  taskMessage?: UiMessage;
  taskTurnId?: string;
  agentName: string;
  modelId: string;
  thinkingLevel: SubagentThinkingLevel;
  status: DelegationStatus;
  startedAt: number;
  completedAt?: number;
  result?: SubagentRunResult;
  completion: Promise<void>;
  resolveCompletion: () => void;
  abort: () => void;
  /** The delegate's own signal, retained for owner-linked cancellation. */
  signal: AbortSignal;
  /** True when `TaskStop` asked for this stop, so an aborted run reads as
   * `stopped` rather than `aborted`. */
  stopRequested: boolean;
  /** System interruption preserves resume eligibility; explicit Stop wins. */
  parentErrorInterrupted?: boolean;
  turns: number;
  toolCalls: number;
  lastToolName?: string;
  lastPhase?: AgentActivityAgentPhase;
  lastActivityAt: number;
  /** `prompt()` / `executeApprovedPlan()` generation that started this run.
   * Resume-after-idle only waits for the current turn's delegates (D352). */
  startedEpoch: number;
  /** The settled report reached the parent's context once: through a
   * `TaskWait` result or the resume-after-idle prompt. Auto-delivery is a
   * single shot per record. */
  reportDelivered: boolean;
  /** Stable chain identity; never appears in a tool parameter (ADR 0279). */
  delegateSessionId: string;
  /** Prior `delegationId` this run continues, when `Task.resume` was set. */
  resumedFrom?: string;
  /** Model the run kept before the resume could not re-resolve it (ADR 0279
   * §4): recorded so the parent can see that the delegate's binding moved. */
  modelChangedFrom?: string;
  /** `toolCallId`s of this run's calls that have not ended yet: dropped when the
   * run settles, so an aborted call cannot pin its captured arguments. */
  pendingToolCallIds?: Set<string>;
};

/** In-memory lifecycle records for the delegations owned by one session. */
export class DelegationRegistry {
  private readonly records = new Map<string, DelegationRecord>();

  add(record: DelegationRecord): void {
    this.records.set(record.delegationId, record);
  }

  get(delegationId: string): DelegationRecord | undefined {
    return this.records.get(delegationId);
  }

  has(delegationId: string): boolean {
    return this.records.has(delegationId);
  }

  all(): DelegationRecord[] {
    return [...this.records.values()];
  }

  ownedBy(ownerDelegationId: string | null): DelegationRecord[] {
    return this.all().filter(
      (record) => record.ownerDelegationId === ownerDelegationId,
    );
  }

  /** Return this record and every descendant in breadth-first registry order. */
  subtree(delegationId: string): DelegationRecord[] {
    const result: DelegationRecord[] = [];
    const pending = [delegationId];
    const visited = new Set<string>();
    for (let index = 0; index < pending.length; index += 1) {
      const currentId = pending[index];
      if (visited.has(currentId)) continue;
      visited.add(currentId);
      const record = this.records.get(currentId);
      if (!record) continue;
      result.push(record);
      for (const child of this.ownedBy(currentId)) {
        pending.push(child.delegationId);
      }
    }
    return result;
  }

  /** Derive a child depth exclusively from the current in-memory owner. */
  assertCanSpawn(
    ownerDelegationId: string | null,
    teamMode: boolean,
  ): 1 | 2 {
    const owner =
      ownerDelegationId === null
        ? null
        : this.records.get(ownerDelegationId);
    if (ownerDelegationId !== null && !owner) {
      throw new TeamPolicyError(
        "delegation_depth_exceeded",
        `Delegation owner "${ownerDelegationId}" is not registered in this session. No subagent was started.`,
      );
    }
    return assertCanDelegate(owner?.depth ?? 0, teamMode);
  }

  running(): DelegationRecord[] {
    return this.all().filter((record) => record.status === "running");
  }

  currentTurn(
    epoch: number,
    ownerDelegationId: string | null = null,
  ): DelegationRecord[] {
    return this.running().filter(
      (record) =>
        record.startedEpoch === epoch &&
        record.ownerDelegationId === ownerDelegationId,
    );
  }

  /**
   * Current-turn delegates whose report the parent has not seen yet: still
   * running, or settled before the parent idled and never read through
   * `TaskWait`. A delegate that finished in a few hundred milliseconds is
   * "done and unpublished", not "unfinished"; keying the idle resume on
   * running delegates alone dropped such reports (#226). Stopped and
   * aborted runs are not auto-delivered.
   */
  pendingCurrentTurn(
    epoch: number,
    ownerDelegationId: string | null = null,
  ): DelegationRecord[] {
    return this.all().filter(
      (record) =>
        record.startedEpoch === epoch &&
        record.ownerDelegationId === ownerDelegationId &&
        !record.reportDelivered &&
        record.status !== "stopped" &&
        record.status !== "aborted",
    );
  }

  /** Record a terminal result and wake waiters before runtime side effects. */
  settle(record: DelegationRecord, result: SubagentRunResult): boolean {
    if (record.status !== "running") return false;
    record.status =
      record.stopRequested && result.status === "aborted"
        ? "stopped"
        : result.status;
    record.result = result;
    record.completedAt = Date.now();
    record.resolveCompletion();
    return true;
  }

  /** Cap retained history so a long session cannot grow the registry forever.
   * Finished records are dropped oldest-first; running ones never are. */
  pruneFinished(): void {
    const finished = this.all()
      .filter((record) => record.status !== "running")
      .sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0));
    const excess = finished.length - MAX_RETAINED_DELEGATIONS;
    for (const record of finished.slice(0, Math.max(0, excess))) {
      this.records.delete(record.delegationId);
    }
  }

  /** Abort every running delegation (user Stop, dispose, parent fatal error). */
  abortRunning(parentErrorInterrupted = false): void {
    for (const record of this.running()) {
      record.parentErrorInterrupted = parentErrorInterrupted;
      record.abort();
    }
  }

  abortPreviousTurns(epoch: number): void {
    for (const record of this.running()) {
      if (record.startedEpoch !== epoch) record.abort();
    }
  }
}
