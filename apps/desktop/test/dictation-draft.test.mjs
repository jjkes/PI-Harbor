import assert from "node:assert/strict";
import test from "node:test";
import {
  canRestoreDictation,
  completeDictationPreview,
  joinDictation,
  planDictationInsertion,
  replaceDictationPreview,
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

test("live dictation replaces its preview instead of appending every pass", () => {
  const first = replaceDictationPreview("请", "看一下", null);
  assert.equal(first.draft, "请看一下");
  assert.deepEqual(first.preview, {
    base: "请",
    rendered: "请看一下",
    inserted: "看一下",
  });

  const second = replaceDictationPreview("请看一下", "看一下报错", first.preview);
  assert.equal(second.draft, "请看一下报错");
  assert.equal(second.preview.inserted, "看一下报错");
});

test("live dictation preserves text the user types after the preview", () => {
  const first = replaceDictationPreview("请", "看一下", null);
  const withSuffix = "请看一下。补充一句";
  const next = replaceDictationPreview(withSuffix, "看一下报错", first.preview);
  assert.equal(next.draft, "请看一下报错。补充一句");
});

test("the final result replaces the preview and keeps restore-original", () => {
  const first = replaceDictationPreview("请", "看一下", null);
  const insertion = completeDictationPreview(
    "请看一下",
    "看一下报错！",
    "嗯，看一下报错！",
    first.preview,
  );
  assert.equal(insertion.after, "请看一下报错！");
  assert.equal(insertion.original, "请嗯，看一下报错！");
  assert.equal(canRestoreDictation(insertion, "请看一下报错！"), true);
});

test("the final result keeps a suffix typed after the preview", () => {
  const first = replaceDictationPreview("请", "看一下", null);
  const insertion = completeDictationPreview(
    "请看一下。补充",
    "看一下报错",
    "看一下报错",
    first.preview,
  );
  assert.equal(insertion.after, "请看一下报错。补充");
});

test("an edited preview is left alone rather than duplicated", () => {
  const first = replaceDictationPreview("请", "看一下", null);
  assert.equal(
    replaceDictationPreview("请随便改过了", "看一下报错", first.preview),
    null,
  );
  assert.equal(
    completeDictationPreview("请随便改过了", "看一下报错", "看一下报错", first.preview),
    null,
  );
});

test("the final result lands when the last preview has not painted yet", () => {
  const first = replaceDictationPreview("请", "看一下", null);
  const insertion = completeDictationPreview(
    "请",
    "看一下报错",
    "嗯，看一下报错",
    first.preview,
  );
  assert.equal(insertion.after, "请看一下报错");
  assert.equal(insertion.original, "请嗯，看一下报错");
});
