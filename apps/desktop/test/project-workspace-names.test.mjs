/**
 * Inline create-dialog validation for project workspaces.
 *
 * The dialog keeps its Create button disabled while the typed name breaks a
 * rule (design §4.8), so these renderer rules have to agree with the rules
 * host-core enforces in `validate_name`
 * (`crates/host-core/src/project_workspaces/mod.rs:208`). Where they drift the
 * user can submit a name the host then rejects, which is what the last test
 * pins down.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  PROJECT_WORKSPACE_NAME_MAX_CHARS,
  normalizeProjectWorkspaceName,
  projectWorkspaceBranchProblem,
  projectWorkspaceNameProblem,
  projectWorkspacePathPreview,
} = await import("../src/features/project-workspace/project-workspace-names.ts");

test("a usable workspace name is kept verbatim in NFC, not slugified", () => {
  for (const name of ["My Feature 2", "feature-1_b", "重构", "a".repeat(64)]) {
    assert.equal(projectWorkspaceNameProblem(name), null, name);
  }
  // Decomposed "é" (e + U+0301) normalizes to the composed form, so two
  // visually identical names cannot preview two different directories.
  const decomposed = "cafe\u0301";
  assert.notEqual(decomposed, "caf\u00e9");
  assert.equal(normalizeProjectWorkspaceName(decomposed), "caf\u00e9");
  assert.equal(projectWorkspacePathPreview(decomposed), ".pi/worktree/caf\u00e9");
  assert.equal(PROJECT_WORKSPACE_NAME_MAX_CHARS, 64);
});

test("the dialog names the first rule a bad workspace name breaks", () => {
  const expected = {
    "": "required",
    "   ": "required",
    ["a".repeat(65)]: "tooLong",
    "a/b": "separator",
    "a\\b": "separator",
    "a..b": "relative",
    "..": "relative",
    ".hidden": "leadingDot",
    "with\u0000null": "control",
    "with\nnewline": "control",
    "trailing ": "whitespace",
    " leading": "whitespace",
    CON: "reserved",
    "con.txt": "reserved",
    NUL: "reserved",
    lpt1: "reserved",
  };
  for (const [name, problem] of Object.entries(expected)) {
    assert.equal(projectWorkspaceNameProblem(name), problem, JSON.stringify(name));
  }
});

test("a branch name the dialog can reject before a round trip", () => {
  assert.equal(projectWorkspaceBranchProblem("feature/one"), null);
  assert.equal(projectWorkspaceBranchProblem(""), "required");
  for (const branch of [
    "-dash",
    "HEAD",
    "/leading",
    "trailing/",
    "double//slash",
    "trailing.",
    "ends.lock",
    "a..b",
    "a@{b",
    "@",
    "with space",
    "with~tilde",
    "with^caret",
    "with:colon",
    "with?question",
    "with*star",
    "with[bracket",
    ".dot/part",
  ]) {
    assert.equal(projectWorkspaceBranchProblem(branch), "invalid", branch);
  }
});

/**
 * The renderer rules are the host's rules. `validate_name` also rejects a
 * trailing `.` and the Windows-forbidden characters `: * ? " < > |`
 * (`crates/host-core/src/project_workspaces/mod.rs:220`, `:227`), so the
 * dialog has to name those inline too. Otherwise it enables Create, the
 * request reaches the host, and the user gets a generic
 * `WORKSPACE_NAME_INVALID` alert instead of the inline message design §4.8
 * asks for.
 */
test("inline validation covers every name host-core rejects", () => {
  const expected = {
    "trailing.": "trailingDot",
    "a:b": "forbidden",
    "a*b": "forbidden",
    "a?b": "forbidden",
    'a"b': "forbidden",
    "a<b": "forbidden",
    "a>b": "forbidden",
    "a|b": "forbidden",
  };
  for (const [name, problem] of Object.entries(expected)) {
    assert.equal(projectWorkspaceNameProblem(name), problem, JSON.stringify(name));
  }
});
