import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The plan-mode composer action is a UI wiring fact, not a value: it must
// exist, and it must exist only under the plan-mode guard. The renderer
// package has no DOM harness here, so the guard is asserted on the source the
// build compiles.
const toolbar = readFileSync(
  new URL("../src/features/chat/composer/ComposerToolbar.tsx", import.meta.url),
  "utf8",
);
const composer = readFileSync(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);

/** The JSX expression of one `{condition ? (` … `) : null}` block. */
function guardedBlock(source, condition) {
  const open = source.indexOf(`{${condition} ? (`);
  assert.ok(open >= 0, `missing guard: {${condition} ? (`);
  const close = source.indexOf(") : null}", open);
  assert.ok(close > open, `guard is not closed: {${condition} ? (`);
  return source.slice(open, close);
}

test("plan mode adds exactly one action, and it is an icon button", () => {
  const block = guardedBlock(toolbar, "planMode");
  assert.equal(toolbar.split('data-composer-plan-action="debate"').length - 1, 1);
  assert.ok(block.includes('data-composer-plan-action="debate"'));
  // The plain-message button is gone: the send button already is that path.
  assert.ok(!toolbar.includes('data-composer-plan-action="message"'));
  // A compact icon, not a labelled button: the toolbar stays on one line.
  assert.ok(block.includes('className="icon-btn icon-btn-square composer-plan-debate"'));
  assert.ok(block.includes("<IconSparkles size={15} aria-hidden=\"true\" />"));
  assert.ok(block.includes("tooltip={t(\"planning.startDebate\")}"));
  assert.ok(block.includes("ariaLabel={t(\"planning.startDebate\")}"));
  // Icon-only: the name lives in the tooltip and the accessible label, and the
  // block's only child is the icon.
  assert.ok(!toolbar.includes("发起辩论"), "no hard-coded copy");
  assert.ok(!toolbar.includes("planning.sendDefault"), "the message button is gone");
});

test("the debate action shares the send button's gates plus a running turn", () => {
  assert.ok(
    toolbar.includes(
      "const planActionBlocked = !hasDraftContent || sendBlocked || runActive;",
    ),
    "a running turn and an empty requirement both disable the action",
  );
  const block = guardedBlock(toolbar, "planMode");
  // The debate action also needs a model: it sends a prompt to one.
  assert.ok(block.includes("disabled={planActionBlocked || !modelReady}"));
  // A native button: the keyboard reaches it and it can be disabled natively.
  assert.ok(block.includes('type="button"'));
});

test("the debate action sits immediately left of send, inside the action cluster", () => {
  const right = toolbar.slice(toolbar.indexOf('<div className="composer-right">'));
  const action = right.indexOf('data-composer-plan-action="debate"');
  const send = right.indexOf('className="send-btn"');
  assert.ok(action > 0, "the debate action is in the right-hand cluster");
  assert.ok(send > action, "send comes after the debate action");
});

test("the debate action sends through the composer submit path with a rewrite", () => {
  const block = guardedBlock(toolbar, "planMode");
  assert.ok(block.includes("onClick={() => void submit(false, planDebateRequest)}"));
  // The plan-mode gate is the app-mode setting, not a session mode.
  assert.ok(composer.includes("planMode={isPlanMode(settings)}"));
  assert.ok(composer.includes('import { isPlanMode } from "../lib/app-mode";'));
});

test("the debate card is rendered in plan mode only", () => {
  const block = guardedBlock(composer, "activeSessionId && isPlanMode(settings)");
  assert.equal(composer.split("<PlanDebateCard").length - 1, 1);
  assert.ok(block.includes("<PlanDebateCard sessionId={activeSessionId} />"));
});
