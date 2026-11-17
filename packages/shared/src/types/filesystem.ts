/** Shared public types grouped by the owning application domain. */
export type FsEntry = {
  name: string;
  kind: "dir" | "file";
  size: number;
};

export type FsReadResult = {
  kind: "text" | "image" | "binary" | "tooLarge";
  /** UTF-8 file content when kind is "text". */
  content?: string;
  /** Base64 data URL when kind is "image". */
  dataUrl?: string;
  size: number;
};

/** Bounded in-chat image read. Non-images never include file bytes. */
export type FsImageDataUrlResult = {
  kind: "image" | "missing" | "notImage" | "tooLarge";
  dataUrl?: string;
  size?: number;
  errorCode?: string;
};

export type AgentInstructionFile = {
  scope: "global" | "project";
  path: string;
  content: string;
  exists: boolean;
};

export type ProjectMemory = {
  content: string;
  entries?: ProjectMemoryEntry[];
  updatedAt?: number;
};

export type ProjectMemoryEntry = {
  id: string;
  title: string;
  content: string;
};

/** Workspace-relative entry of the `fs/index` snapshot for the "@" menu (D124). */
export type FsIndexEntry = {
  path: string;
  kind: "dir" | "file";
};

export type FsIndexResult = {
  entries: FsIndexEntry[];
  /** True when the index hit its entry cap and results were dropped. */
  truncated: boolean;
};

export type TokenUsageBucket = "day" | "week" | "month";

export type TokenUsageHistoryItem = {
  date: string;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  turnCount: number;
};

export type TokenUsageHistoryResult = {
  bucket: TokenUsageBucket;
  rangeStart: number;
  rangeEnd: number;
  items: TokenUsageHistoryItem[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    turnCount: number;
  };
};

/**
 * One folder of the project a chat reference may resolve into. A project can be
 * a logical group of several folders (ADR 0249), and only the primary one is
 * the workspace that relative paths are expressed against.
 */
export type FsChatRefProjectRoot = {
  path: string;
  name: string;
  primary: boolean;
};

/**
 * A file referenced from chat text, resolved to a real file (D320 follow-up).
 *
 * `root` names which store answered, because the caller routes on it: a project
 * file is expressed to the work panel as a path relative to the project's
 * **primary** folder, while any other project folder — and every scratch or
 * attachment file — can only be addressed by its absolute path.
 *
 * `local` is the fourth answer: a real file on this computer that no allowed
 * root contains (a draft the agent wrote to `/tmp`, a report in a sibling
 * checkout). It is addressed by its absolute path like scratch and attachment
 * files, and opening it unlocks that one file for this run (ADR 0348).
 */
export type FsChatRefRoot = "workspace" | "scratch" | "attachments" | "local";

/** Which rule produced the match; the shallow tiers are informational. */
export type FsChatRefMatchKind =
  | "exact-relative"
  | "exact-absolute"
  | "path-suffix"
  | "basename";

export type FsChatRefMatch = {
  root: FsChatRefRoot;
  /** The match belongs to this session's scratch, not the wider read-only store. */
  sessionScratch?: boolean;
  /**
   * POSIX path relative to the matched root. For `root: "local"` there is no
   * root to be relative to, so it repeats the absolute path — the one spelling
   * that addresses the file.
   */
  relativePath: string;
  /** Native absolute path of the matched regular file. */
  absolutePath: string;
  matchedBy: FsChatRefMatchKind;
  /**
   * Which folder of the project answered, for `root: "workspace"`. The caller
   * needs it to decide how to address the file: relative for the primary
   * folder, absolute for any other.
   */
  projectRoot?: FsChatRefProjectRoot;
};

export type FsChatRefResolveResult = {
  match: FsChatRefMatch | null;
  /**
   * The supplied absolute path is not inside a project, scratch, or attachment
   * root. Only a remote workspace reports this: a local reference that names a
   * file outside every root completes as `root: "local"` instead, and one that
   * names nothing simply matches nothing.
   */
  reason?: "outside-allowed-roots";
};
