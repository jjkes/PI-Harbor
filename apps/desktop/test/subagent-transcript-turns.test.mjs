import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const { isDelegationActivityItem } = await import("../src/lib/subagent-topology.ts");
const {
  buildSubagentTranscript,
  countNestedDelegations,
  delegationTranscriptSource,
  groupSubagentTranscriptRows,
} = await import("../src/lib/subagent-transcript.ts");

function message(id, content, extra = {}) {
  return { id, content, ...extra };
}

function taskCall(id, task, extra = {}) {
  return message(id, "", {
    role: "tool",
    toolName: "Task",
    toolCallId: id,
    toolArgs: { task },
    ...extra,
  });
}

test("one Task call becomes one user turn followed by the delegate's rows", () => {
  const messages = [
    taskCall("call-1", "Find all call sites of resize()", {
      toolResult: { delegationId: "del-1" },
    }),
    message("step-1", "grep resize(", {
      role: "tool",
      parentToolCallId: "call-1",
      agentName: "explorer",
    }),
    message("note-1", "Found three call sites.", {
      role: "assistant",
      parentToolCallId: "call-1",
      thinking: "Check the header first.",
      agentName: "explorer",
    }),
  ];
  const transcript = buildSubagentTranscript(messages, "del-1");
  assert.ok(transcript);
  assert.equal(transcript.agentName, "explorer");
  assert.equal(transcript.turns.length, 1);
  assert.equal(transcript.turns[0].task, "Find all call sites of resize()");
  assert.deepEqual(
    transcript.turns[0].rows.map((row) => row.kind),
    ["tool", "thinking", "answer"],
  );
});

test("a resumed delegation renders follow-up prompts as further user turns", () => {
  const messages = [
    taskCall("call-1", "First prompt", {
      toolResult: { delegationId: "del-1" },
    }),
    message("answer-1", "First answer.", {
      role: "assistant",
      parentToolCallId: "call-1",
    }),
    taskCall("call-2", "Follow-up prompt", {
      toolArgs: { task: "Follow-up prompt", resume: "call-1" },
      toolResult: { delegationId: "del-1" },
    }),
    message("answer-2", "Second answer.", {
      role: "assistant",
      parentToolCallId: "call-2",
    }),
  ];
  const transcript = buildSubagentTranscript(messages, "del-1");
  assert.equal(transcript.turns.length, 2);
  assert.equal(transcript.turns[0].task, "First prompt");
  assert.deepEqual(
    transcript.turns[0].rows.map((row) => row.message.id),
    ["answer-1"],
  );
  assert.equal(transcript.turns[1].task, "Follow-up prompt");
  assert.deepEqual(
    transcript.turns[1].rows.map((row) => row.message.id),
    ["answer-2"],
  );
});

test("a chain is recognized from either end of the resume links", () => {
  // Only the resumed call carries the result payload; the original call is
  // linked backward through the runtime's resume record.
  const messages = [
    taskCall("call-1", "Original prompt"),
    taskCall("call-2", "Follow-up prompt", {
      toolArgs: { task: "Follow-up prompt", resume: "call-1" },
      toolResult: { delegationId: "del-1" },
    }),
    message("answer-1", "Original answer.", {
      role: "assistant",
      parentToolCallId: "call-1",
    }),
  ];
  const transcript = buildSubagentTranscript(messages, "del-1");
  assert.equal(transcript.turns.length, 2);
  assert.equal(transcript.turns[0].task, "Original prompt");
});

test("parallel delegates never mix into each other's turns", () => {
  const messages = [
    taskCall("call-a", "Task A", {
      toolResult: { delegationId: "del-a" },
    }),
    taskCall("call-b", "Task B", {
      toolResult: { delegationId: "del-b" },
    }),
    message("answer-a", "Answer A.", {
      role: "assistant",
      parentToolCallId: "call-a",
      agentName: "explorer",
    }),
    message("answer-b", "Answer B.", {
      role: "assistant",
      parentToolCallId: "call-b",
      agentName: "reviewer",
    }),
  ];
  const a = buildSubagentTranscript(messages, "del-a");
  const b = buildSubagentTranscript(messages, "del-b");
  assert.equal(a.agentName, "explorer");
  assert.deepEqual(
    a.turns.flatMap((turn) => turn.rows.map((row) => row.message.id)),
    ["answer-a"],
  );
  assert.equal(b.agentName, "reviewer");
  assert.deepEqual(
    b.turns.flatMap((turn) => turn.rows.map((row) => row.message.id)),
    ["answer-b"],
  );
});

test("nested tools stay with their owning delegate, not their tool parent", () => {
  const messages = [
    taskCall("task-1", "Inspect files", { toolResult: { delegationId: "delegate-1" } }),
    message("root-read", "root result", {
      role: "tool", toolName: "Read", nestedParentToolCallId: "root-code",
    }),
    message("code-1", "running", {
      role: "tool", toolName: "codemode", parentToolCallId: "task-1", agentName: "reader",
    }),
    message("nested-read", "delegate result", {
      role: "tool", toolName: "Read", parentToolCallId: "task-1",
      nestedParentToolCallId: "code-1", agentName: "reader",
    }),
  ];
  const transcript = buildSubagentTranscript(messages, "delegate-1");
  assert.equal(transcript.agentName, "reader");
  assert.deepEqual(transcript.turns[0].rows.map((row) => row.message.id), ["code-1", "nested-read"]);
  assert.equal(transcript.turns[0].rows[1].message.nestedParentToolCallId, "code-1");
  assert.equal(buildSubagentTranscript(messages, "root-code"), null);
});

test("an unknown delegation id yields no transcript", () => {
  const messages = [taskCall("call-1", "Task", {
    toolResult: { delegationId: "del-1" },
  })];
  assert.equal(buildSubagentTranscript(messages, "missing"), null);
  assert.equal(buildSubagentTranscript(messages, ""), null);
});

test("a call with no task argument degrades to an empty prompt", () => {
  const messages = [
    message("call-1", "", {
      role: "tool",
      toolName: "Task",
      toolCallId: "call-1",
      toolArgs: {},
      toolResult: { delegationId: "del-1" },
    }),
  ];
  const transcript = buildSubagentTranscript(messages, "del-1");
  assert.equal(transcript.turns[0].task, "");
});

function nestedDelegationMessages() {
  return [
    taskCall("call-l1", "Coordinate the inspection", {
      toolResult: { delegationId: "del-l1" },
    }),
    message("l1-note", "I will inspect both areas.", {
      role: "assistant",
      parentToolCallId: "call-l1",
      agentName: "explorer",
    }),
    taskCall("call-l2-a", "Inspect area A", {
      parentToolCallId: "call-l1",
      agentName: "explorer",
      toolResult: { delegationId: "del-l2-a" },
    }),
    taskCall("call-l2-b", "Inspect area B", {
      parentToolCallId: "call-l1",
      agentName: "explorer",
      toolResult: { delegationId: "del-l2-b" },
    }),
    message("l2-answer-a", "Area A is clear.", {
      role: "assistant",
      parentToolCallId: "call-l2-a",
      agentName: "test-runner",
    }),
    message("l2-answer-b", "Area B is clear.", {
      role: "assistant",
      parentToolCallId: "call-l2-b",
      agentName: "test-runner",
    }),
  ];
}

test("the root topology stays one level and counts deeper Task rows", () => {
  const { entries } = buildTranscriptEntries(nestedDelegationMessages());
  const rootItems = entries
    .flatMap((entry) => entry.kind === "assistant-turn" ? entry.parts : [])
    .flatMap((part) => part.kind === "activity" ? part.items : [])
    .filter(isDelegationActivityItem);
  assert.deepEqual(rootItems.map((item) => item.message.id), ["call-l1"]);
  assert.equal(countNestedDelegations(rootItems), 2);
});

test("an L1 transcript groups its L2 fan-out without taking L2 rows", () => {
  const messages = nestedDelegationMessages();
  const l1 = buildSubagentTranscript(messages, "del-l1");
  assert.deepEqual(
    l1.turns[0].rows.map((row) => row.message.id),
    ["l1-note", "call-l2-a", "call-l2-b"],
  );
  const groups = groupSubagentTranscriptRows(l1.turns[0].rows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0], l1.turns[0].rows[0]);
  assert.equal(groups[1].kind, "delegations");
  assert.deepEqual(
    groups[1].items.map((item) => item.message.id),
    ["call-l2-a", "call-l2-b"],
  );

  const l2a = buildSubagentTranscript(messages, "del-l2-a");
  const l2b = buildSubagentTranscript(messages, "del-l2-b");
  assert.deepEqual(l2a.turns[0].rows.map((row) => row.message.id), ["l2-answer-a"]);
  assert.deepEqual(l2b.turns[0].rows.map((row) => row.message.id), ["l2-answer-b"]);
});

test("flat transcript rows stay ungrouped and add no nested count", () => {
  const rows = [
    message("read", "read result", { role: "tool", toolName: "Read" }),
    message("answer", "Done", { role: "assistant" }),
  ].map((row, index) => ({ kind: index === 0 ? "tool" : "answer", message: row }));
  assert.deepEqual(groupSubagentTranscriptRows(rows), rows);
  assert.equal(countNestedDelegations([{
    kind: "tool",
    message: taskCall("call-flat", "Flat task"),
    delegate: { items: rows },
  }]), 0);
});

/** A plan-debate seat: the driver's own `Task` row, tagged with phase and round. */
function debateSeatCall(id, delegationId, rows = []) {
  return [
    taskCall(id, "Draft the plan", {
      toolResult: {
        details: {
          delegationId,
          agent: "ui-架构",
          status: "running",
          phase: "draft",
          debateRound: 1,
          debateRole: "ui-架构",
          debateSeat: 1,
        },
      },
    }),
    ...rows,
  ];
}

test("a plan-debate seat resolves to its own transcript", () => {
  // The panel's 打开对话记录 opens `subagent:<delegationId>`; the tab resolves
  // that id from the session's `Task` rows, so a seat must resolve like any
  // other delegate — its row is the driver's, not the model's.
  const messages = [
    ...debateSeatCall("call-seat", "debate-seat-1", [
      message("step-1", "read plan-debate-view.ts", {
        role: "tool",
        parentToolCallId: "call-seat",
        agentName: "ui-架构",
      }),
      message("report-1", "Layout first, then the data layer.", {
        role: "assistant",
        parentToolCallId: "call-seat",
        agentName: "ui-架构",
      }),
    ]),
  ];
  const transcript = buildSubagentTranscript(messages, "debate-seat-1");
  assert.ok(transcript, "the seat's delegation id resolves");
  assert.equal(transcript.agentName, "ui-架构");
  assert.equal(transcript.turns.length, 1);
  assert.equal(transcript.turns[0].task, "Draft the plan");
  assert.deepEqual(
    transcript.turns[0].rows.map((row) => row.kind),
    ["tool", "answer"],
  );
  // A seat that has produced nothing yet still resolves: the tab opens with its
  // starting state instead of doing nothing.
  const starting = buildSubagentTranscript(debateSeatCall("call-seat", "debate-seat-1"), "debate-seat-1");
  assert.ok(starting);
  assert.deepEqual(starting.turns.map((turn) => turn.rows.length), [0]);
});

test("a delegation opened from a node resolves against the live session", () => {
  const live = debateSeatCall("call-seat", "debate-seat-1");
  const elsewhere = [message("other-1", "unrelated row")];
  // The reading range (a search hit, a restored snapshot) does not hold the
  // seat's call: the tab reads the live session instead of opening blank.
  assert.equal(delegationTranscriptSource(elsewhere, live, "debate-seat-1"), live);
  // A range that does hold the delegate is left alone, and so is the live
  // session itself.
  assert.equal(delegationTranscriptSource(live, live, "debate-seat-1"), live);
  const held = [...live, ...elsewhere];
  assert.equal(delegationTranscriptSource(held, live, "debate-seat-1"), held);
});
