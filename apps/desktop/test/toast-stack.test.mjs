import assert from "node:assert/strict";
import test from "node:test";
import { stackToast, TOAST_STACK_LIMIT } from "../src/lib/toast-stack.ts";

let nextId = 0;
const toast = (message, overrides = {}) => ({
  id: ++nextId,
  message,
  variant: "info",
  duration: 4000,
  sound: true,
  ...overrides,
});
const reminder = (sessionId, inputRequest, message = `${sessionId} ${inputRequest}`) =>
  toast(message, { duration: 0, sessionId, inputRequest });
const stackOf = (...items) => items.reduce((stack, item) => stackToast(stack, item), []);
const messages = (stack) => stack.map((item) => item.message);

test("a newer reminder for the same request replaces its card", () => {
  const first = reminder("a", "ask", "Which path?");
  const second = reminder("a", "ask", "Which database?");
  const stack = stackOf(first, second);
  assert.deepEqual(stack.map((item) => item.id), [second.id]);
  assert.equal(stack[0].message, "Which database?");
});

test("reminders for different conversations or request kinds stay apart", () => {
  const stack = stackOf(
    reminder("a", "ask", "Same text"),
    reminder("b", "ask", "Same text"),
    reminder("a", "permission"),
  );
  assert.deepEqual(
    stack.map((item) => [item.sessionId, item.inputRequest]),
    [["a", "ask"], ["b", "ask"], ["a", "permission"]],
  );
});

test("a reminder and an ordinary toast never replace each other", () => {
  const stack = stackOf(
    toast("Same text", { sessionId: "a" }),
    reminder("a", "ask", "Same text"),
  );
  assert.equal(stack.length, 2);
});

test("ordinary toasts keep their message, variant, and target dedupe", () => {
  const stack = stackOf(
    toast("Saved"),
    toast("Saved", { variant: "error" }),
    toast("Saved", { sessionId: "a" }),
    toast("Saved"),
  );
  assert.deepEqual(
    stack.map((item) => [item.variant, item.sessionId]),
    [["error", undefined], ["info", "a"], ["info", undefined]],
  );
});

test("past the limit the oldest ordinary toast leaves before any reminder", () => {
  assert.equal(TOAST_STACK_LIMIT, 4);
  const stack = stackOf(
    reminder("a", "ask"),
    toast("one"),
    reminder("b", "plan"),
    toast("two"),
    toast("three"),
    toast("four"),
  );
  assert.deepEqual(messages(stack), ["a ask", "b plan", "three", "four"]);
});

test("a stack of reminders drops its oldest reminder for the newest toast", () => {
  const stack = stackOf(
    reminder("a", "ask"),
    reminder("b", "ask"),
    reminder("c", "ask"),
    reminder("d", "ask"),
    toast("Copied"),
  );
  assert.deepEqual(messages(stack), ["b ask", "c ask", "d ask", "Copied"]);
});
