import type {
  DiffHunk,
  DiffLineType,
  ReviewChange,
  ReviewChangeStatus,
} from "@pi-harbor/shared";

/**
 * The conversation's changed files and their diffs, derived only from the
 * transcript's recorded Write/Edit evidence (D180). Messages are in
 * chronological order, so a path's first change is its baseline and later
 * changes supersede it.
 */

/** Mirrors the host's `MAX_FILE_DIFF_SNAPSHOTS` in `review/net_diff.rs`. */
export const MAX_FILE_DIFF_SNAPSHOTS = 512;

/** One file the conversation changed, with its net status since then. */
export type SessionFileChange = {
  path: string;
  status: ReviewChangeStatus;
};

function existedBefore(change: ReviewChange): boolean {
  return change.status !== "added";
}

function existsAfter(change: ReviewChange): boolean {
  return change.status !== "deleted";
}

function newestActive(changes: readonly ReviewChange[]): ReviewChange | null {
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    if (changes[index].state === "active") return changes[index];
  }
  return null;
}

/**
 * Net status from the file before its first recorded change to the file after
 * its newest change still in effect. `null` means nothing is left to review:
 * every change was rolled back, or the file was created and removed again.
 */
function netStatus(changes: readonly ReviewChange[]): ReviewChangeStatus | null {
  const head = newestActive(changes);
  if (!head) return null;
  const before = existedBefore(changes[0]);
  const after = existsAfter(head);
  if (before && after) return "modified";
  if (after) return "added";
  if (before) return "deleted";
  return null;
}

function changesByPath(
  changes: readonly ReviewChange[],
): Map<string, ReviewChange[]> {
  const byPath = new Map<string, ReviewChange[]>();
  for (const change of changes) {
    const list = byPath.get(change.path);
    if (list) list.push(change);
    else byPath.set(change.path, [change]);
  }
  return byPath;
}

/**
 * Every file the conversation's recorded changes still affect, once each, in
 * the order the conversation first changed them.
 */
export function sessionFileChanges(
  changes: readonly ReviewChange[],
): SessionFileChange[] {
  const files: SessionFileChange[] = [];
  for (const [path, list] of changesByPath(changes)) {
    const status = netStatus(list);
    if (status) files.push({ path, status });
  }
  return files;
}

/**
 * The snapshot ids the host needs for one file's net diff, oldest first.
 *
 * Rolled-back changes stay in the chain: their pre-tool states are legitimate
 * end states, so a rollback does not read as an edit made elsewhere. A chain
 * longer than the host bound keeps the baseline and the newest changes.
 */
export function fileDiffSnapshotChain(
  changes: readonly ReviewChange[],
  path: string,
): string[] {
  const ids = changes
    .filter((change) => change.path === path)
    .map((change) => change.snapshotId);
  if (ids.length <= MAX_FILE_DIFF_SNAPSHOTS) return ids;
  return [ids[0], ...ids.slice(ids.length - (MAX_FILE_DIFF_SNAPSHOTS - 1))];
}

/** A diff line with its old- and new-file line numbers, where it has them. */
export type NumberedDiffLine = {
  type: DiffLineType;
  text: string;
  oldLine?: number;
  newLine?: number;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Number a hunk's lines from its `@@ -a,b +c,d @@` header: a deletion advances
 * the old side, an addition the new side, and context both. A header that does
 * not parse leaves the lines unnumbered rather than guessing.
 */
export function numberDiffHunkLines(hunk: DiffHunk): NumberedDiffLine[] {
  const match = HUNK_HEADER.exec(hunk.header);
  if (!match) {
    return hunk.lines.map((line) => ({ type: line.type, text: line.text }));
  }
  let oldLine = Number(match[1]);
  let newLine = Number(match[2]);
  return hunk.lines.map((line) => {
    if (line.type === "add") {
      const numbered = { type: line.type, text: line.text, newLine };
      newLine += 1;
      return numbered;
    }
    if (line.type === "del") {
      const numbered = { type: line.type, text: line.text, oldLine };
      oldLine += 1;
      return numbered;
    }
    const numbered = { type: line.type, text: line.text, oldLine, newLine };
    oldLine += 1;
    newLine += 1;
    return numbered;
  });
}

/** Split a workspace-relative path into its file name and parent folder. */
export function splitWorkspacePath(path: string): {
  name: string;
  directory: string;
} {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { name: path, directory: "" }
    : { name: path.slice(slash + 1), directory: path.slice(0, slash) };
}
