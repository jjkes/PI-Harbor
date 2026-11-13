import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
 * `queued` is the one non-terminal, non-running subagent state: the runtime
 * accepted the delegation but has not begun executing it. Two rules follow:
 * a queued node is not finished work, and no settled node ever moves back to a
 * live state (`running` or `queued`) when a later lifecycle row still says so.
 */

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  collectDelegationStatuses,
  delegationRoster,
  delegationRosterOutcome,
  subagentOutcome,
  summarizeSubagentActivity,
} = await import("../src/lib/subagent-topology.ts");

const at = "2026-10-29T08:00:00.000Z";

/** A `Task` row as the runtime publishes it. */
function task(id, status) {
  return {
    id,
    role: "tool",
    content: "",
    createdAt: at,
    toolName: "Task",
    toolCallId: id,
    toolStatus: "success",
    toolArgs: { agent: "explorer" },
    toolResult: { details: { delegationId: id, status } },
  };
}

/** A lifecycle row reporting on other delegations. */
function lifecycle(id, toolName, entries, key) {
  return {
    id,
    role: "tool",
    content: "",
    createdAt: at,
    toolName,
    toolCallId: id,
    toolStatus: "success",
    toolArgs: {},
    toolResult: { details: { [key]: entries } },
  };
}

const item = (message) => ({ kind: "tool", message });

test("a published queued delegation reads as waiting, not running", async (t) => {
  await t.test("the node's own status is the queued one", () => {
    assert.equal(subagentOutcome(task("d1", "queued")), "queued");
  });

  await t.test("a lifecycle row can report queued too", () => {
    const statuses = collectDelegationStatuses([
      item(lifecycle("l1", "TaskList", [{ delegationId: "d1", status: "queued" }], "delegations")),
    ]);
    assert.equal(statuses.get("d1"), "queued");
  });

  await t.test("queued work is outstanding, not finished", () => {
    const items = [item(task("d1", "queued")), item(task("d2", "completed"))];
    const summary = summarizeSubagentActivity(items);
    assert.deepEqual(
      { total: summary.total, finished: summary.finished, running: summary.running },
      { total: 2, finished: 1, running: 1 },
    );
  });

  await t.test("a queued roster entry keeps the lifecycle row open", () => {
    const roster = delegationRoster(
      lifecycle("l1", "TaskList", [{ delegationId: "d1", agent: "explorer", status: "queued" }], "delegations"),
    );
    assert.equal(delegationRosterOutcome(roster), "queued");
  });
});

test("a settled outcome never moves back to a live state", async (t) => {
  await t.test("a later running row cannot reopen a completed delegation", () => {
    const statuses = collectDelegationStatuses([
      item(lifecycle("w1", "TaskWait", [{ delegationId: "d1", status: "completed" }], "delegations")),
      item(lifecycle("l1", "TaskList", [{ delegationId: "d1", status: "running" }], "delegations")),
    ]);
    assert.equal(statuses.get("d1"), "completed");
  });

  await t.test("a later queued row cannot reopen a completed delegation", () => {
    const statuses = collectDelegationStatuses([
      item(lifecycle("w1", "TaskWait", [{ delegationId: "d1", status: "completed" }], "delegations")),
      item(lifecycle("l1", "TaskList", [{ delegationId: "d1", status: "queued" }], "delegations")),
    ]);
    assert.equal(statuses.get("d1"), "completed");
  });

  await t.test("a settled Task snapshot outranks a queued lifecycle row", () => {
    const statuses = collectDelegationStatuses([
      item(lifecycle("l1", "TaskList", [{ delegationId: "d1", status: "queued" }], "delegations")),
      item(task("d1", "completed")),
    ]);
    assert.equal(statuses.get("d1"), "completed");
  });

  await t.test("a live delegation still settles from a later row", () => {
    const statuses = collectDelegationStatuses([
      item(lifecycle("l1", "TaskList", [{ delegationId: "d1", status: "queued" }], "delegations")),
      item(lifecycle("w1", "TaskWait", [{ delegationId: "d1", status: "failed" }], "delegations")),
    ]);
    assert.equal(statuses.get("d1"), "failed");
  });

  await t.test("an ended turn settles a queued node as aborted", () => {
    const statuses = collectDelegationStatuses(
      [item(task("d1", "queued"))],
      { turnLive: false },
    );
    assert.equal(statuses.get("d1"), "aborted");
  });
});
