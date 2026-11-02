import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchDictationPushToTalk,
  registerDictationPushToTalk,
} from "../src/features/voice/dictation-push-to-talk.ts";

test("push-to-talk dispatches only while a Composer control owns the shortcut", () => {
  assert.equal(dispatchDictationPushToTalk("press"), false);

  const seen = [];
  const unregister = registerDictationPushToTalk((action) => {
    seen.push(action);
    return action === "press";
  });

  assert.equal(dispatchDictationPushToTalk("press"), true);
  assert.equal(dispatchDictationPushToTalk("release"), false);
  assert.deepEqual(seen, ["press", "release"]);
  unregister();
  assert.equal(dispatchDictationPushToTalk("press"), false);
});

test("the newest Composer control owns the shortcut and stale cleanup is harmless", () => {
  const seen = [];
  const unregisterFirst = registerDictationPushToTalk(() => {
    seen.push("first");
    return true;
  });
  const unregisterSecond = registerDictationPushToTalk(() => {
    seen.push("second");
    return true;
  });

  unregisterFirst();
  assert.equal(dispatchDictationPushToTalk("press"), true);
  unregisterSecond();
  assert.deepEqual(seen, ["second"]);
  assert.equal(dispatchDictationPushToTalk("press"), false);
});
