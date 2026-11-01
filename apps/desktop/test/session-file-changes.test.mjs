import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * The conversation's changed-files bar and its read-only diff tab, from the
 * transcript rows a user's session actually holds: the bar's file list, the
 * snapshot chain the diff tab sends to the host, the gutter numbering, and the
 * work-panel tab that shows one file's changes.
 */

const { reviewChangesFromMessages } = await import("../src/lib/workspace-review.ts");
const {
  MAX_FILE_DIFF_SNAPSHOTS,
  fileDiffSnapshotChain,
  numberDiffHunkLines,
  sessionFileChanges,
  splitWorkspacePath,
} = await import("../src/lib/session-file-changes.ts");
const {
  diffWorkPanelTab,
  fileWorkPanelTab,
  isKnownWorkPanelTab,
  isToolWorkPanelTab,
  openWorkPanelTabState,
  sanitizeWorkPanelTabsState,
} = await import("../src/lib/work-panel-tabs.ts");

let sequence = 0;

/** A successful workspace Write/Edit row carrying the host's review evidence. */
function edit(path, status, state = "active") {
  sequence += 1;
  const id = `tool-${sequence}`;
  const write = status === "added";
  return {
    id,
    role: "tool",
    toolName: write ? "Write" : "Edit",
    toolStatus: "success",
    toolResult: {
      details: {
        root: "workspace",
        review: {
          version: 1,
          snapshotId: `snapshot-${sequence}`,
          messageId: id,
          path,
          operation: write ? "write" : "edit",
          status,
          state,
          additions: 1,
          deletions: 0,
          hunks: [],
          reversible: true,
        },
      },
    },
  };
}

const snapshotOf = (row) => row.toolResult.details.review.snapshotId;
const changes = (rows) => reviewChangesFromMessages(rows).map((entry) => entry.change);

test("the changed-files bar lists each file once, in first-change order, with its net status", () => {
  const files = sessionFileChanges(
    changes([
      edit("src/a.ts", "modified"),
      { id: "user-1", role: "user", content: "keep going" },
      edit("src/b.ts", "added"),
      { ...edit("src/failed.ts", "modified"), toolStatus: "error" },
      edit("src/a.ts", "modified"),
      edit("docs/c.md", "deleted"),
    ]),
  );
  assert.deepEqual(files, [
    { path: "src/a.ts", status: "modified" },
    { path: "src/b.ts", status: "added" },
    { path: "docs/c.md", status: "deleted" },
  ]);
});

test("a file's net status runs from its first change to its newest active one", () => {
  const files = sessionFileChanges(
    changes([
      edit("created.ts", "added"),
      edit("created.ts", "modified"),
      edit("removed.ts", "modified"),
      edit("removed.ts", "deleted"),
      edit("transient.ts", "added"),
      edit("transient.ts", "deleted"),
    ]),
  );
  // A file created and removed again leaves nothing to review.
  assert.deepEqual(files, [
    { path: "created.ts", status: "added" },
    { path: "removed.ts", status: "deleted" },
  ]);
});

test("rolled-back changes drop out of the bar", () => {
  const files = sessionFileChanges(
    changes([
      edit("undone.ts", "modified", "rolledBack"),
      edit("partly.ts", "modified"),
      edit("partly.ts", "modified", "rolledBack"),
      edit("restored.ts", "deleted", "rolledBack"),
    ]),
  );
  assert.deepEqual(files, [{ path: "partly.ts", status: "modified" }]);
});

test("a file's diff chain names every snapshot oldest first, rolled-back ones included", () => {
  const rows = [
    edit("src/a.ts", "modified"),
    edit("src/b.ts", "added"),
    edit("src/a.ts", "modified", "rolledBack"),
    edit("src/a.ts", "modified"),
  ];
  const ids = rows.map(snapshotOf);
  const recorded = changes(rows);
  assert.deepEqual(fileDiffSnapshotChain(recorded, "src/a.ts"), [ids[0], ids[2], ids[3]]);
  assert.deepEqual(fileDiffSnapshotChain(recorded, "src/b.ts"), [ids[1]]);
  assert.deepEqual(fileDiffSnapshotChain(recorded, "src/never.ts"), []);
});

test("a long chain keeps the baseline and the newest snapshots within the host bound", async () => {
  const rows = Array.from({ length: MAX_FILE_DIFF_SNAPSHOTS + 88 }, () =>
    edit("big.ts", "modified"),
  );
  const ids = rows.map(snapshotOf);
  const chain = fileDiffSnapshotChain(changes(rows), "big.ts");
  assert.equal(chain.length, MAX_FILE_DIFF_SNAPSHOTS);
  assert.equal(chain[0], ids[0]);
  assert.deepEqual(chain.slice(1), ids.slice(ids.length - (MAX_FILE_DIFF_SNAPSHOTS - 1)));

  // The renderer bound mirrors the host's, which refuses longer requests.
  const host = await readFile(
    new URL("../../../crates/host-core/src/review/net_diff.rs", import.meta.url),
    "utf8",
  );
  assert.match(host, new RegExp(`const MAX_FILE_DIFF_SNAPSHOTS: usize = ${MAX_FILE_DIFF_SNAPSHOTS};`));
});

test("diff lines are numbered from their hunk header on both sides", () => {
  const numbered = numberDiffHunkLines({
    header: "@@ -5,3 +5,4 @@",
    lines: [
      { type: "context", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "B" },
      { type: "add", text: "B2" },
      { type: "context", text: "c" },
    ],
  });
  assert.deepEqual(
    numbered.map((line) => [line.type, line.oldLine, line.newLine]),
    [
      ["context", 5, 5],
      ["del", 6, undefined],
      ["add", undefined, 6],
      ["add", undefined, 7],
      ["context", 7, 8],
    ],
  );
  // A header that does not parse leaves the lines unnumbered.
  assert.deepEqual(
    numberDiffHunkLines({ header: "not a hunk header", lines: [{ type: "context", text: "x" }] }),
    [{ type: "context", text: "x" }],
  );
});

test("a workspace path splits into its file name and folder", () => {
  assert.deepEqual(splitWorkspacePath("src/lib/api.ts"), { name: "api.ts", directory: "src/lib" });
  assert.deepEqual(splitWorkspacePath("README.md"), { name: "README.md", directory: "" });
});

test("a diff tab is keyed by its path and coexists with the same file's view", () => {
  const tab = diffWorkPanelTab("src/App.tsx");
  assert.deepEqual(tab, { id: "diff:src/App.tsx", kind: "diff", resource: "src/App.tsx" });
  assert.equal(isKnownWorkPanelTab(tab), true);
  assert.equal(isToolWorkPanelTab(tab), false);

  let state = openWorkPanelTabState({ tabs: [], activeTabId: null }, tab);
  state = openWorkPanelTabState(state, fileWorkPanelTab("src/App.tsx"));
  state = openWorkPanelTabState(state, diffWorkPanelTab("src/App.tsx"));
  assert.deepEqual(state.tabs.map((item) => item.id), ["diff:src/App.tsx", "file:src/App.tsx"]);
  assert.equal(state.activeTabId, "diff:src/App.tsx");

  // A diff tab without a path cannot render, so retained state drops it.
  const pathless = { id: "diff:", kind: "diff" };
  assert.equal(isKnownWorkPanelTab(pathless), false);
  assert.deepEqual(sanitizeWorkPanelTabsState({ tabs: [pathless, tab], activeTabId: pathless.id }), {
    tabs: [tab],
    activeTabId: tab.id,
  });
});
