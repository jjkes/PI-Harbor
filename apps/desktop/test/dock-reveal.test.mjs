import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * Turning Team on and clicking the delegation summary both ask the dock to open
 * its Subagent page. The dock may not exist yet when the request is made (a draft
 * turns into a session first), so the request waits for the dock of that session
 * to take it. These pin the one-shot, per-session and expiry rules with an
 * injected clock.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { clearDockReveal, requestDockReveal, subscribeDockReveal, takeDockReveal } =
  await import("../src/features/chat/background-tasks/dock-reveal.ts");

test("a request is taken once, and only by the dock of the session that asked", () => {
  requestDockReveal("s1", 1_000);
  assert.equal(takeDockReveal("s2", 1_000), false);
  assert.equal(takeDockReveal("s1", 1_500), true);
  assert.equal(takeDockReveal("s1", 1_500), false);
});

test("a dock that mounts a few seconds after the request still takes it", () => {
  requestDockReveal("s1", 0);
  assert.equal(takeDockReveal("s1", 9_000), true);
});

test("a stale request is dropped instead of expanding the dock long afterwards", () => {
  requestDockReveal("s1", 0);
  assert.equal(takeDockReveal("s1", 10_001), false);
  // It is gone, not kept for a later mount.
  assert.equal(takeDockReveal("s1", 10_002), false);
});

test("a withdrawn request is not taken", () => {
  requestDockReveal("s1", 0);
  clearDockReveal("s1");
  assert.equal(takeDockReveal("s1", 1), false);
});

test("a newer request for the same session replaces the older one", () => {
  requestDockReveal("s1", 0);
  requestDockReveal("s1", 20_000);
  assert.equal(takeDockReveal("s1", 25_000), true);
  assert.equal(takeDockReveal("s1", 25_000), false);
});

test("subscribers hear each request and stop hearing after they unsubscribe", () => {
  let heard = 0;
  const stop = subscribeDockReveal(() => {
    heard += 1;
  });
  requestDockReveal("s1", 0);
  assert.equal(heard, 1);
  stop();
  requestDockReveal("s1", 0);
  assert.equal(heard, 1);
  clearDockReveal("s1");
});
