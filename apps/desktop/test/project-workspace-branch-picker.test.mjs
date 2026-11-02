/**
 * Display contract of the "New workspace" source-branch combobox.
 *
 * The option list used to be drawn inside the dialog: the scrolling dialog
 * body clipped it, and its translucent panel let the dialog's own text show
 * through. These assertions pin the floating layer it became, the loading
 * indicator that replaced the label drawn over the list, and the rule for
 * every class the picker renders.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pickerSource = await readFile(
  new URL(
    "../src/features/project-workspace/ProjectWorkspaceBranchPicker.tsx",
    import.meta.url,
  ),
  "utf8",
);
const styles = await readFile(
  new URL("../src/styles/project-workspace.css", import.meta.url),
  "utf8",
);

test("the branch list is the shared anchored surface, not a panel inside the dialog", () => {
  assert.match(pickerSource, /<AnchoredMenu/);
  assert.match(pickerSource, /menuClassName="project-workspace-listbox"/);
  assert.match(pickerSource, /role="listbox"/);
  // The combobox keeps the focus and points at the popup it controls.
  assert.match(pickerSource, /initialFocus="none"/);
  assert.match(pickerSource, /anchorRef=\{inputRef\}/);
  assert.match(pickerSource, /aria-controls=\{listId\}/);
  assert.match(pickerSource, /id=\{listId\}/);
  assert.match(pickerSource, /aria-activedescendant=\{open \? activeId : undefined\}/);
});

test("the option list is a viewport-fixed, opaque layer", () => {
  const rule = styles.match(/\.project-workspace-listbox\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(rule, /position:\s*fixed/);
  assert.doesNotMatch(rule, /position:\s*absolute/);
  // A translucent panel let the dialog's own text read through it.
  assert.match(rule, /background:\s*var\(--ds-bg-elevated-opaque\)/);
  assert.doesNotMatch(rule, /background:\s*var\(--ds-bg-elevated\)/);
  // It is measured before it is revealed, so it never shows unplaced.
  assert.match(rule, /visibility:\s*hidden/);
  assert.match(styles, /\.project-workspace-listbox\.is-open\s*\{[\s\S]*?visibility:\s*visible/);
});

test("a long branch name is truncated instead of widening the list", () => {
  const name = styles.match(/\.project-workspace-option-name\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(name, /overflow:\s*hidden/);
  assert.match(name, /text-overflow:\s*ellipsis/);
  assert.match(name, /white-space:\s*nowrap/);
});

test("the loading state is a spinner in the field, not a label over the list", () => {
  const spinner = styles.match(/\.project-workspace-spinner\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(spinner, /position:\s*absolute/);
  assert.match(spinner, /animation:/);
  // The wording is the spinner's accessible name, never body text over the list.
  assert.doesNotMatch(
    pickerSource,
    /project-workspace-spinner" role="status">\s*\{t\(/,
  );
  assert.match(
    pickerSource,
    /aria-label=\{t\("projectWorkspace\.create\.branchLoading"\)\}/,
  );
});

test("every class the picker renders has a rule", () => {
  const used = new Set();
  for (const [, quoted, templated] of pickerSource.matchAll(
    /className=(?:"([^"]+)"|\{`([^`]+)`\})/g,
  )) {
    for (const token of `${quoted ?? ""} ${templated ?? ""}`.split(/\s+/)) {
      if (/^project-workspace-[\w-]+$/.test(token)) used.add(token);
    }
  }
  assert.ok(used.size > 0, "the picker renders no project-workspace class");
  for (const className of used) {
    assert.ok(
      styles.includes(`.${className}`),
      `no stylesheet rule for .${className}`,
    );
  }
});
