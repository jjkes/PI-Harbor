/**
 * Read-only session progress reports (ADR 0350): the pure half. Snapshot,
 * digest, prompt, parser, and model resolution live here so Electron Main only
 * wires them. Nothing in this module imports Electron, the database, the
 * filesystem, or the network.
 */

export {
  buildProgressSnapshot,
  progressFingerprint,
  type ProgressSnapshot,
  type ProgressSnapshotFacts,
  type ProgressSnapshotInput,
  type ProgressSnapshotMessage,
} from "./progress-snapshot.js";
export { buildProgressDigest, estimateDigestTokens } from "./progress-digest.js";
export {
  PROGRESS_REPORT_RULES,
  PROGRESS_REPORT_SHAPE,
  PROGRESS_SYSTEM_PROMPT,
  buildProgressPrompt,
} from "./progress-prompt.js";
export { parseProgressReport, type ProgressParseResult } from "./progress-parse.js";
export {
  resolveProgressModelRef,
  type ProgressModelLookup,
  type ProgressModelResolution,
  type ProgressSessionModel,
} from "./progress-model.js";
