import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { dockGoalFor } = await import("../src/features/chat/goal-dock/dock-goal.ts");

/** A Goal approval as the host reports it; each case varies what the dock reads. */
function proposal(patch = {}) {
  return {
    id: "goal-1",
    sessionId: "s1",
    turnId: "turn-1",
    toolCallId: "call-1",
    kind: "goal",
    title: "Ship the dock goal row",
    markdown: "# Goal",
    question: "Approve this goal?",
    artifact: { relativePath: ".pi/goal/ship.md", sha256: "0".repeat(64), sizeBytes: 6 },
    version: 1,
    status: "approved",
    createdAt: "2026-10-31T08:00:00.000Z",
    updatedAt: "2026-10-31T08:00:01.000Z",
    executionId: "exec-1",
    executionState: "running",
    ...patch,
  };
}

test("an approved goal is current while its execution is queued or running", () => {
  assert.deepEqual(dockGoalFor(proposal({ executionState: "queued" })), {
    title: "Ship the dock goal row",
    phase: "queued",
    artifactPath: ".pi/goal/ship.md",
  });
  assert.deepEqual(dockGoalFor(proposal()), {
    title: "Ship the dock goal row",
    phase: "running",
    artifactPath: ".pi/goal/ship.md",
  });
});

test("a goal outside its execution is not current", () => {
  assert.equal(dockGoalFor(undefined), null);
  assert.equal(dockGoalFor(null), null);
  for (const executionState of [undefined, "completed", "interrupted"]) {
    assert.equal(dockGoalFor(proposal({ executionState })), null, String(executionState));
  }
  for (const status of ["pending", "rejected", "expired", "interrupted"]) {
    assert.equal(dockGoalFor(proposal({ status, executionState: undefined })), null, status);
  }
});

test("a plan execution never takes the goal line", () => {
  assert.equal(dockGoalFor(proposal({ kind: "plan" })), null);
  assert.equal(dockGoalFor(proposal({ kind: "plan", executionState: "queued" })), null);
});

test("a goal without a title or contract file reports neither", () => {
  assert.deepEqual(dockGoalFor(proposal({ title: "", artifact: undefined })), {
    title: "",
    phase: "running",
    artifactPath: undefined,
  });
});
