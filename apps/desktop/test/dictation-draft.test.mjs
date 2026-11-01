import assert from "node:assert/strict";
import test from "node:test";
import {
  canRestoreDictation,
  joinDictation,
  planDictationInsertion,
} from "../src/features/voice/dictation-draft.ts";

test("dictation joins the draft without a space next to CJK text", () => {
  assert.equal(joinDictation("", "你好"), "你好");
  assert.equal(joinDictation("请看一下", "登录页面"), "请看一下登录页面");
  assert.equal(joinDictation("Check", "日志"), "Check日志");
  assert.equal(joinDictation("Fix the bug.", "Then run tests."), "Fix the bug. Then run tests.");
  assert.equal(joinDictation("Fix this ", "now"), "Fix this now");
  assert.equal(joinDictation("draft", ""), "draft");
});

test("restore original is offered only while the draft is unchanged since the insertion", () => {
  const insertion = planDictationInsertion("请", "看一下报错", "嗯，看一下报错");
  assert.equal(insertion.after, "请看一下报错");
  assert.equal(insertion.original, "请嗯，看一下报错");
  assert.equal(canRestoreDictation(insertion, "请看一下报错"), true);
  assert.equal(canRestoreDictation(insertion, "请看一下报错！"), false);
  assert.equal(canRestoreDictation(null, ""), false);
  assert.equal(canRestoreDictation(planDictationInsertion("", "ok", "ok"), "ok"), false);
});
