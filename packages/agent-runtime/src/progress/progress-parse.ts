import {
  PROGRESS_COMPLETED_MAX,
  PROGRESS_CONFIDENCES,
  PROGRESS_IN_PROGRESS_MAX,
  PROGRESS_MINUTES_MAX,
  PROGRESS_NEXT_MAX,
  PROGRESS_RAW_MAX_CHARS,
  PROGRESS_STEPS_MAX,
  clampProgressEstimate,
  clampProgressSection,
  type ProgressConfidence,
  type ProgressReportBody,
} from "@pi-harbor/shared";

/**
 * The tolerant report parser (design § 7.3). Providers differ in how well they
 * follow a JSON shape, so the parser accepts the shape wherever it appears and
 * keeps the raw text when it cannot find one. It never throws.
 */

export type ProgressParseResult =
  | { status: "ok"; body: ProgressReportBody }
  | { status: "unparsed"; raw: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A leading or trailing Markdown fence is common and never meaningful. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const withoutOpen = trimmed.replace(/^```[A-Za-z0-9_-]*[ \t]*\r?\n?/, "");
  return withoutOpen.replace(/\r?\n?```\s*$/, "").trim();
}

/** The outermost `{...}` span, or null when the text holds no object. */
function outermostObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

function confidenceOf(value: unknown): ProgressConfidence | null {
  return typeof value === "string" && (PROGRESS_CONFIDENCES as readonly string[]).includes(value)
    ? (value as ProgressConfidence)
    : null;
}

function bodyOf(value: Record<string, unknown>): ProgressReportBody | null {
  const hasInProgress = value.inProgress !== undefined;
  const hasCompleted = value.completed !== undefined;
  // Neither array means the model answered something else entirely.
  if (!hasInProgress && !hasCompleted) return null;
  return {
    completed: clampProgressSection(value.completed, PROGRESS_COMPLETED_MAX),
    inProgress: clampProgressSection(value.inProgress, PROGRESS_IN_PROGRESS_MAX),
    next: clampProgressSection(value.next, PROGRESS_NEXT_MAX),
    remainingSteps: clampProgressEstimate(value.remainingSteps, PROGRESS_STEPS_MAX),
    remainingMinutes: clampProgressEstimate(value.remainingMinutes, PROGRESS_MINUTES_MAX),
    confidence: confidenceOf(value.confidence),
  };
}

function unparsed(text: string): ProgressParseResult {
  return { status: "unparsed", raw: text.slice(0, PROGRESS_RAW_MAX_CHARS) };
}

/**
 * Parse one model answer into the fixed report body, or keep the raw text. The
 * raw text is capped so a hostile or chatty answer cannot grow the row.
 */
export function parseProgressReport(text: string): ProgressParseResult {
  const source = typeof text === "string" ? text : "";
  if (source.trim().length === 0) return unparsed(source);

  const candidate = outermostObject(stripCodeFence(source));
  if (!candidate) return unparsed(source);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return unparsed(source);
  }
  if (!isRecord(parsed)) return unparsed(source);

  const body = bodyOf(parsed);
  if (!body) return unparsed(source);
  return { status: "ok", body };
}
