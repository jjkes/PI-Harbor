import assert from "node:assert/strict";
import test from "node:test";

const { terminalOpenDialogOptions, CANCEL_BUTTON_INDEX, CONFIRM_BUTTON_INDEX } = await import(
  "../electron/main/terminal-confirmation.ts"
);

const LABELS = {
  title: "打开终端？",
  message: "为这个会话打开交互式终端？命令将以你在主机上的用户权限运行。",
  cancel: "取消",
  confirm: "打开终端",
};

test("the confirmation dialog uses the labels it was given, not English copy", () => {
  const options = terminalOpenDialogOptions(LABELS);
  assert.equal(options.title, LABELS.title);
  assert.equal(options.message, LABELS.message);
  assert.deepEqual(options.buttons, [LABELS.cancel, LABELS.confirm]);
});

test("cancel owns the default button and Escape", () => {
  const options = terminalOpenDialogOptions(LABELS);
  // Opening a shell must cost an explicit click: a stray Enter on a dialog the
  // user did not read must not grant one.
  assert.equal(options.defaultId, CANCEL_BUTTON_INDEX);
  assert.equal(options.cancelId, CANCEL_BUTTON_INDEX);
  assert.notEqual(options.defaultId, CONFIRM_BUTTON_INDEX);
  assert.equal(options.buttons[CONFIRM_BUTTON_INDEX], LABELS.confirm);
});

test("the dialog always offers exactly the two buttons it can return", () => {
  const options = terminalOpenDialogOptions(LABELS);
  assert.equal(options.buttons?.length, 2);
  assert.equal(options.noLink, true);
  assert.equal(options.type, "question");
});
