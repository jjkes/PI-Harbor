import assert from "node:assert/strict";
import test from "node:test";
import {
  hasPendingInputRequest,
  sessionAwaitsInput,
  viewedSessionId,
} from "../src/lib/session-input-requests.ts";

const ask = (sessionId) => ({
  sessionId,
  requestId: `${sessionId}-ask`,
  toolCallId: `${sessionId}-ask-call`,
  questions: [{ question: "Which path?", options: ["A", "B"] }],
});
const permission = (sessionId) => ({
  requestId: `${sessionId}-permission`,
  sessionId,
  toolCallId: `${sessionId}-permission-call`,
  toolName: "bash",
  argsPreview: {},
  risk: "high",
  reason: "Runs a command",
});
const plan = (sessionId, status) => ({ id: `${sessionId}-plan`, sessionId, status });

const queues = {
  pendingAsks: { asking: [ask("asking")] },
  pendingPermissions: { approving: [permission("approving")] },
  pendingPlans: {
    reviewing: plan("reviewing", "pending"),
    approved: plan("approved", "approved"),
  },
};

test("each request kind reads only its own queue", () => {
  assert.equal(hasPendingInputRequest(queues, "asking", "ask"), true);
  assert.equal(hasPendingInputRequest(queues, "asking", "permission"), false);
  assert.equal(hasPendingInputRequest(queues, "approving", "permission"), true);
  assert.equal(hasPendingInputRequest(queues, "approving", "ask"), false);
  assert.equal(hasPendingInputRequest(queues, "reviewing", "plan"), true);
  assert.equal(hasPendingInputRequest(queues, "idle", "ask"), false);
  assert.equal(
    hasPendingInputRequest({ ...queues, pendingAsks: { asking: [] } }, "asking", "ask"),
    false,
    "an emptied queue is not an open request",
  );
});

test("a plan waits only while its proposal is pending", () => {
  assert.equal(hasPendingInputRequest(queues, "approved", "plan"), false);
  assert.equal(sessionAwaitsInput(queues, "approved"), false);
});

test("a question or a plan review awaits input; tool approval does not", () => {
  assert.equal(sessionAwaitsInput(queues, "asking"), true);
  assert.equal(sessionAwaitsInput(queues, "reviewing"), true);
  assert.equal(sessionAwaitsInput(queues, "approving"), false);
  assert.equal(sessionAwaitsInput(queues, "idle"), false);
});

test("only the chat page has a viewed conversation", () => {
  assert.equal(viewedSessionId({ page: "chat", activeSessionId: "a" }), "a");
  assert.equal(viewedSessionId({ page: "chat" }), null);
  assert.equal(viewedSessionId({ page: "settings", activeSessionId: "a" }), null);
  assert.equal(viewedSessionId({ page: "activeSessions", activeSessionId: "a" }), null);
});
