import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TEAM_DELEGATION_DEPTH } from "@pi-harbor/shared";
import {
  DelegationRegistry,
  type DelegationRecord,
} from "./delegation-registry.js";
import { TeamPolicyError } from "./team-policy.js";
import type { SubagentRunResult } from "./subagent.js";

function delegationRecord(
  overrides: Partial<DelegationRecord> = {},
): DelegationRecord {
  const controller = new AbortController();
  let resolveCompletion: () => void = () => {};
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  return {
    delegationId: "del-1",
    ownerDelegationId: null,
    depth: 1,
    nestedStarts: 0,
    definition: {
      name: "explorer",
      description: "Explore files",
      tools: ["Read"],
      prompt: "Report findings",
      source: "builtin",
    },
    resolvedToolNames: ["Read"],
    agentName: "explorer",
    modelId: "model-1",
    thinkingLevel: "off",
    status: "running",
    startedAt: 100,
    completion,
    resolveCompletion,
    abort: () => controller.abort(),
    ownsWorktree: false,
    signal: controller.signal,
    stopRequested: false,
    turns: 0,
    toolCalls: 0,
    lastActivityAt: 100,
    startedEpoch: 1,
    reportDelivered: false,
    delegateSessionId: "chain-1",
    ...overrides,
  };
}

function runResult(
  overrides: Partial<SubagentRunResult> = {},
): SubagentRunResult {
  return {
    agentName: "explorer",
    modelId: "model-1",
    thinkingLevel: "off",
    status: "completed",
    report: "Done",
    turns: 1,
    toolCalls: 2,
    ...overrides,
  };
}

function ids(records: DelegationRecord[]): string[] {
  return records.map((record) => record.delegationId);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DelegationRegistry lookups", () => {
  it("stores records by delegation id without changing their fields", () => {
    const registry = new DelegationRegistry();
    const record = delegationRecord({
      parentToolCallId: "task-1",
      writable: true,
      worktreeKey: "chain-1",
      resumedFrom: "del-0",
      modelChangedFrom: "model-0",
      pendingToolCallIds: new Set(["tool-1"]),
    });

    registry.add(record);

    expect(registry.get("del-1")).toBe(record);
    expect(registry.has("del-1")).toBe(true);
    expect(registry.has("missing")).toBe(false);
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.all()).toEqual([record]);
    expect(registry.get("del-1")).toMatchObject({
      parentToolCallId: "task-1",
      writable: true,
      worktreeKey: "chain-1",
      resumedFrom: "del-0",
      modelChangedFrom: "model-0",
    });
  });
});

describe("DelegationRegistry filters", () => {
  it("selects running records and only running records from the requested epoch", () => {
    const registry = new DelegationRegistry();
    registry.add(delegationRecord({ delegationId: "current", startedEpoch: 7 }));
    registry.add(delegationRecord({ delegationId: "previous", startedEpoch: 6 }));
    registry.add(
      delegationRecord({
        delegationId: "settled-current",
        startedEpoch: 7,
        status: "completed",
      }),
    );

    expect(ids(registry.running())).toEqual(["current", "previous"]);
    expect(ids(registry.currentTurn(7))).toEqual(["current"]);
    expect(ids(registry.currentTurn(6))).toEqual(["previous"]);
  });

  it("keeps undelivered current-turn reports pending except stopped and aborted runs", () => {
    const registry = new DelegationRegistry();
    const records = [
      delegationRecord({ delegationId: "running", startedEpoch: 7 }),
      delegationRecord({
        delegationId: "completed",
        startedEpoch: 7,
        status: "completed",
      }),
      delegationRecord({
        delegationId: "failed",
        startedEpoch: 7,
        status: "failed",
      }),
      delegationRecord({
        delegationId: "timed-out",
        startedEpoch: 7,
        status: "timed_out",
      }),
      delegationRecord({ delegationId: "previous", startedEpoch: 6 }),
      delegationRecord({
        delegationId: "delivered",
        startedEpoch: 7,
        status: "completed",
        reportDelivered: true,
      }),
      delegationRecord({
        delegationId: "stopped",
        startedEpoch: 7,
        status: "stopped",
      }),
      delegationRecord({
        delegationId: "aborted",
        startedEpoch: 7,
        status: "aborted",
      }),
    ];
    for (const record of records) registry.add(record);

    expect(ids(registry.pendingCurrentTurn(7))).toEqual([
      "running",
      "completed",
      "failed",
      "timed-out",
    ]);
    expect(ids(registry.pendingCurrentTurn(6))).toEqual(["previous"]);
  });
});

describe("DelegationRegistry lineage", () => {
  it("queries direct ownership and complete subtrees from in-memory owner links", () => {
    const registry = new DelegationRegistry();
    const root = delegationRecord({ delegationId: "root" });
    const childA = delegationRecord({
      delegationId: "child-a",
      ownerDelegationId: "root",
      depth: 2,
    });
    const childB = delegationRecord({
      delegationId: "child-b",
      ownerDelegationId: "root",
      depth: 2,
    });
    const otherRoot = delegationRecord({ delegationId: "other-root" });
    for (const record of [root, childA, childB, otherRoot]) {
      registry.add(record);
    }

    expect(ids(registry.ownedBy(null))).toEqual(["root", "other-root"]);
    expect(ids(registry.ownedBy("root"))).toEqual(["child-a", "child-b"]);
    expect(ids(registry.subtree("root"))).toEqual([
      "root",
      "child-a",
      "child-b",
    ]);
    expect(ids(registry.subtree("child-a"))).toEqual(["child-a"]);
    expect(registry.subtree("missing")).toEqual([]);
  });

  it("filters current-turn delivery to the requested owner scope", () => {
    const registry = new DelegationRegistry();
    registry.add(delegationRecord({ delegationId: "root", startedEpoch: 7 }));
    registry.add(
      delegationRecord({
        delegationId: "child",
        ownerDelegationId: "root",
        depth: 2,
        startedEpoch: 7,
      }),
    );

    expect(ids(registry.currentTurn(7))).toEqual(["root"]);
    expect(ids(registry.pendingCurrentTurn(7))).toEqual(["root"]);
    expect(ids(registry.currentTurn(7, "root"))).toEqual(["child"]);
    expect(ids(registry.pendingCurrentTurn(7, "root"))).toEqual(["child"]);
  });

  it("derives spawn depth from the in-memory owner and enforces the shared ceiling", () => {
    const registry = new DelegationRegistry();
    expect(registry.assertCanSpawn(null, false)).toBe(1);
    expect(registry.assertCanSpawn(null, true)).toBe(1);

    registry.add(delegationRecord({ delegationId: "root" }));
    expect(registry.assertCanSpawn("root", true)).toBe(2);
    expect(() => registry.assertCanSpawn("root", false)).toThrow(
      TeamPolicyError,
    );

    registry.add(
      delegationRecord({
        delegationId: "leaf",
        ownerDelegationId: "root",
        depth: MAX_TEAM_DELEGATION_DEPTH,
      }),
    );
    expect(() => registry.assertCanSpawn("leaf", true)).toThrow(
      "Agent scope L2 cannot start L3",
    );
    expect(() => registry.assertCanSpawn("missing", true)).toThrow(
      "not registered in this session",
    );
  });
});

describe("DelegationRegistry settlement", () => {
  it("records the terminal result before resolving completion", () => {
    vi.useFakeTimers({ now: 12_345 });
    const registry = new DelegationRegistry();
    let stateAtResolution: Partial<DelegationRecord> | undefined;
    const resolveCompletion = vi.fn(() => {
      stateAtResolution = {
        status: record.status,
        result: record.result,
        completedAt: record.completedAt,
      };
    });
    const record = delegationRecord({
      resolveCompletion,
      worktreeKey: "chain-1",
      reportDelivered: true,
    });
    registry.add(record);
    const result = runResult();

    expect(registry.settle(record, result)).toBe(true);

    expect(stateAtResolution).toEqual({
      status: "completed",
      result,
      completedAt: 12_345,
    });
    expect(resolveCompletion).toHaveBeenCalledTimes(1);
    expect(record.result).toBe(result);
    expect(record.worktreeKey).toBe("chain-1");
    expect(record.reportDelivered).toBe(true);
    expect(registry.settle(record, runResult({ status: "failed" }))).toBe(false);
    expect(resolveCompletion).toHaveBeenCalledTimes(1);
    expect(record.status).toBe("completed");
    expect(record.result).toBe(result);
    expect(record.completedAt).toBe(12_345);
  });

  it.each([
    {
      stopRequested: true,
      resultStatus: "aborted" as const,
      expected: "stopped",
    },
    {
      stopRequested: false,
      resultStatus: "aborted" as const,
      expected: "aborted",
    },
    {
      stopRequested: true,
      resultStatus: "failed" as const,
      expected: "failed",
    },
  ])(
    "maps $resultStatus to $expected when stopRequested is $stopRequested",
    ({ stopRequested, resultStatus, expected }) => {
      const registry = new DelegationRegistry();
      const record = delegationRecord({ stopRequested });
      registry.add(record);

      expect(
        registry.settle(record, runResult({ status: resultStatus })),
      ).toBe(true);
      expect(record.status).toBe(expected);
      expect(record.result?.status).toBe(resultStatus);
    },
  );
});

describe("DelegationRegistry cancellation", () => {
  it("aborts only running records and records the parent interruption flag", () => {
    const registry = new DelegationRegistry();
    const runningAbort = vi.fn();
    const settledAbort = vi.fn();
    const running = delegationRecord({ abort: runningAbort });
    const settled = delegationRecord({
      delegationId: "del-2",
      status: "completed",
      abort: settledAbort,
    });
    registry.add(running);
    registry.add(settled);

    registry.abortRunning(true);

    expect(runningAbort).toHaveBeenCalledTimes(1);
    expect(settledAbort).not.toHaveBeenCalled();
    expect(running.parentErrorInterrupted).toBe(true);
    expect(settled.parentErrorInterrupted).toBeUndefined();

    registry.abortRunning();
    expect(runningAbort).toHaveBeenCalledTimes(2);
    expect(running.parentErrorInterrupted).toBe(false);
  });

  it("aborts running records from other epochs without touching current or settled runs", () => {
    const registry = new DelegationRegistry();
    const previous = delegationRecord({
      delegationId: "previous",
      startedEpoch: 6,
      abort: vi.fn(),
      parentErrorInterrupted: true,
    });
    const current = delegationRecord({
      delegationId: "current",
      startedEpoch: 7,
      abort: vi.fn(),
    });
    const settledPrevious = delegationRecord({
      delegationId: "settled-previous",
      startedEpoch: 6,
      status: "failed",
      abort: vi.fn(),
    });
    for (const record of [previous, current, settledPrevious]) {
      registry.add(record);
    }

    registry.abortPreviousTurns(7);

    expect(previous.abort).toHaveBeenCalledTimes(1);
    expect(current.abort).not.toHaveBeenCalled();
    expect(settledPrevious.abort).not.toHaveBeenCalled();
    expect(previous.parentErrorInterrupted).toBe(true);
  });
});

describe("DelegationRegistry retention", () => {
  it("drops the oldest finished records beyond 100 and never prunes running records", () => {
    const registry = new DelegationRegistry();
    registry.add(delegationRecord({ delegationId: "running" }));
    for (let index = 0; index <= 100; index += 1) {
      registry.add(
        delegationRecord({
          delegationId: `del-${index}`,
          status: "completed",
          completedAt: 10_000 - index,
        }),
      );
    }

    registry.pruneFinished();

    expect(registry.get("running")?.status).toBe("running");
    expect(registry.all()).toHaveLength(101);
    expect(registry.has("del-100")).toBe(false);
    expect(registry.has("del-99")).toBe(true);
    expect(registry.has("del-0")).toBe(true);
  });
});
