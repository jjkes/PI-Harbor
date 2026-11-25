import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/components/workpanel/TerminalTab.tsx", import.meta.url),
  "utf8",
);

test("TerminalTab does not render its own confirmation dialog", () => {
  assert.doesNotMatch(source, /globalThis\.confirm/);
  assert.doesNotMatch(source, /showConfirm/);
  assert.doesNotMatch(source, /terminal-tab-confirm/);
  assert.doesNotMatch(source, /openConfirmTitle/);
  assert.doesNotMatch(source, /role="alertdialog"/);
});

test("open button requests a terminal directly from the main process", () => {
  assert.match(source, /const handleOpen = useCallback\(\(\) => \{\s*if \(!allowed\) return;\s*void open\(\);/s);
  assert.match(source, /onClick=\{handleOpen\}/);
});

test("submit sends non-empty command input to the terminal hook", () => {
  assert.match(source, /if \(text === "" \|\| status !== "open" \|\| pending\) return;/);
  assert.match(source, /void sendInput\(text\)/);
});

test("textarea Ctrl+C copies selected text and interrupts only when nothing is selected", () => {
  assert.match(source, /event\.key\.toLowerCase\(\) === "c"/);
  assert.match(source, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(source, /const hasSelection = target\.selectionStart !== target\.selectionEnd;/);
  assert.match(source, /if \(!hasSelection\) \{\s*event\.preventDefault\(\);\s*void interrupt\(\);/s);
});

test("toolbar interrupt button is always available and calls interrupt", () => {
  assert.match(source, /tooltip=\{t\("panel\.terminal\.interrupt"\)\}/);
  assert.match(source, /onClick=\{onInterrupt\}/);
  assert.match(source, /const onInterrupt = useCallback\(\(\) => \{\s*void interrupt\(\);/s);
});

test("error state offers a retry that re-requests the terminal", () => {
  assert.match(source, /status === "error"/);
  assert.match(source, /onClick=\{handleOpen\}/);
  assert.match(source, /panel\.terminal\.retryOpen/);
});
