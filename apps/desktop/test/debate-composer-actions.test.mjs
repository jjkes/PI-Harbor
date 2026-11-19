import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The debate surface's composer action is a UI wiring fact, not a value: it
// must exist, and it must exist only under the debate-surface guard. The
// renderer package has no DOM harness here, so the guard is asserted on the
// source the build compiles.
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

test("the debate surface adds exactly one action, and it is an icon button", () => {
  const block = guardedBlock(toolbar, "debateMode");
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
  const block = guardedBlock(toolbar, "debateMode");
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
  const block = guardedBlock(toolbar, "debateMode");
  assert.ok(block.includes("onClick={() => void submit(false, planDebateRequest)}"));
});

test("the debate surface is the app preference plus the Agent contract", () => {
  // One derivation, in the Composer, from the settings row and the session
  // mode: a session the runtime moved to Plan can never keep the surface.
  assert.ok(composer.includes('import { debateSurfaceOn } from "../features/plan-debate/debate-mode";'));
  assert.ok(composer.includes("const debateMode = debateSurfaceOn(settings, mode);"));
  assert.ok(composer.includes("debateMode={debateMode}"));
  assert.ok(composer.includes("setDebateMode={setDebateMode}"));
});

test("the debate card is rendered on the debate surface only", () => {
  const block = guardedBlock(composer, "activeSessionId && debateMode");
  assert.equal(composer.split("<PlanDebateCard").length - 1, 1);
  assert.ok(block.includes("<PlanDebateCard sessionId={activeSessionId} />"));
});

test("the chip's debate choice turns the switch on and configures Agent", () => {
  const select = toolbar.slice(
    toolbar.indexOf("onSelect={async (choice) => {"),
    toolbar.indexOf("<ComposerPermissionPicker"),
  );
  assert.ok(select.length > 0, "the picker receives the choice");
  assert.ok(select.includes("await setDebateMode(choice === \"debate\");"));
  assert.ok(select.includes("mode: sessionModeForChoice(choice),"));
});
