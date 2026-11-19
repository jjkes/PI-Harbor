import type { SessionTodoSnapshot } from "./session-todos.js";
import type { SessionSummary } from "./types/sessions.js";

/**
 * Read-only session progress reports (ADR 0350).
 *
 * A report is a model-written snapshot of what a session has done, is doing,
 * and has left. It reads the persisted transcript, never writes the session,
 * and lives outside the turn lifecycle. This module is the wire contract
 * shared by Electron Main, the renderer, and the host.
 */

/** Newest transcript messages a snapshot reads (design § 7.1). */
export const PROGRESS_WINDOW_MESSAGES = 200;
/** Estimated-token budget of the digest the model sees (design § 7.2). */
export const PROGRESS_DIGEST_TOKEN_BUDGET = 6_000;
/** Wall-clock budget of one collection, in milliseconds (design § 7.1). */
export const PROGRESS_TIMEOUT_MS = 60_000;
/** Output cap of one collection, in tokens (design § 7.5). */
export const PROGRESS_MAX_OUTPUT_TOKENS = 1_200;
/** Raw model text kept for an unparsed answer (design § 7.3). */
export const PROGRESS_RAW_MAX_CHARS = 4_000;

/** Per-message character caps of the digest (design § 7.2). */
export const PROGRESS_USER_CHARS = 600;
export const PROGRESS_ASSISTANT_CHARS = 800;
export const PROGRESS_TOOL_ARG_CHARS = 160;
export const PROGRESS_TOOL_RESULT_CHARS = 240;

/** Section caps of the fixed report layout (design § 6.3). */
export const PROGRESS_COMPLETED_MAX = 8;
export const PROGRESS_IN_PROGRESS_MAX = 3;
export const PROGRESS_NEXT_MAX = 5;
/** An estimate is a count, never a percentage (ADR 0175). */
export const PROGRESS_STEPS_MAX = 99;
export const PROGRESS_MINUTES_MAX = 600;

/** History page size and the retained rows per session (design § 8.4, Q3). */
export const PROGRESS_REPORTS_PAGE_SIZE = 20;
export const PROGRESS_REPORTS_KEEP = 100;

/** Automatic collection stops after this many failures in a row (design § 7.6). */
export const PROGRESS_MAX_CONSECUTIVE_FAILURES = 3;
/** Automatic runs Main and the scheduler keep in flight together (design § 7.1). */
export const PROGRESS_MAX_AUTO_RUNS = 2;

/** Selectable automatic-collection intervals, in minutes (design Q1). */
export const PROGRESS_INTERVALS = [1, 3, 5, 10, 15, 30] as const;
export const PROGRESS_DEFAULT_INTERVAL = 5;

/** UI languages a report can be written in (the nine shipped catalogs). */
export const PROGRESS_LOCALES = [
  "en",
  "zh-CN",
  "zh-TW",
  "de",
  "es",
  "fr",
  "ko",
  "pt-BR",
  "tr",
] as const;

export type ProgressLocale = (typeof PROGRESS_LOCALES)[number];

export const PROGRESS_DEFAULT_LOCALE: ProgressLocale = "en";

export const PROGRESS_TRIGGERS = ["manual", "auto", "turnEnd"] as const;
export const PROGRESS_CONFIDENCES = ["low", "medium", "high"] as const;

export type ProgressTrigger = (typeof PROGRESS_TRIGGERS)[number];
export type ProgressConfidence = (typeof PROGRESS_CONFIDENCES)[number];

/**
 * Which model writes a report: the session's own pair, or one explicit pair.
 * `followSession` is the default (design Q2).
 */
export type ProgressModelRef =
  | { followSession: true }
  | { providerId: string; modelId: string };

export type ProgressReportBody = {
  completed: string[];
  inProgress: string[];
  next: string[];
  remainingSteps: number | null;
  remainingMinutes: number | null;
  confidence: ProgressConfidence | null;
};

export type ProgressReport = {
  id: string;
  sessionId: string;
  runId: string;
  createdAt: number;
  trigger: ProgressTrigger;
  providerId: string;
  modelId: string;
  /** `unparsed` still carries a row so the history can show what happened. */
  status: "ok" | "unparsed";
  body: ProgressReportBody | null;
  raw: string | null;
  fingerprint: string;
  lastMessageId: string | null;
  messageCount: number;
  includedMessages: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  durationMs: number;
};

export type ProgressSettings = {
  sessionId: string;
  model: ProgressModelRef;
  autoEnabled: boolean;
  /** Minutes. One of `PROGRESS_INTERVALS`; default `PROGRESS_DEFAULT_INTERVAL`. */
  intervalMinutes: number;
  lastCollectedAt: number | null;
  consecutiveFailures: number;
  updatedAt: number;
};

/** The patch `progress.settings.set` accepts; every field is optional. */
export type ProgressSettingsPatch = {
  model?: ProgressModelRef;
  autoEnabled?: boolean;
  intervalMinutes?: number;
  lastCollectedAt?: number | null;
  consecutiveFailures?: number;
};

export type ProgressCollectRequest = {
  sessionId: string;
  runId: string;
  trigger: ProgressTrigger;
  model: ProgressModelRef;
  /** Language the report body is written in; the JSON keys stay English. */
  locale: ProgressLocale;
};

export type ProgressReportPage = {
  reports: ProgressReport[];
  nextCursor: string | null;
};

export type ProgressCollectResult =
  | { kind: "ok"; report: ProgressReport; skipped: false }
  | { kind: "skipped"; report: ProgressReport | null; skipped: true }
  | { kind: "error"; code: string; message: string; retriable: boolean };

/** Run ids are embedded in host tool-call ids, so they stay short and plain. */
const PROGRESS_RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Whether a session can host progress reports. Fails closed: only a local
 * desktop session qualifies, judged by both its `source` and its id prefix,
 * the two signals `isRemoteSession` reads, exactly as `btwAvailableFor` does.
 * Older hosts omit `source`, which normalizes to `desktop`.
 */
export function progressAvailableFor(
  session: Pick<SessionSummary, "id" | "source"> | null | undefined,
): boolean {
  if (!session || typeof session.id !== "string" || session.id.length === 0) return false;
  if ((session.source ?? "desktop") !== "desktop") return false;
  return !session.id.startsWith("remote:") && !session.id.startsWith("native-pi:");
}

/** Whether a stored interval is one the popover can render. */
export function isProgressInterval(value: unknown): value is number {
  return typeof value === "number" && (PROGRESS_INTERVALS as readonly number[]).includes(value);
}

/** The defaults `progress.settings.get` returns for a session with no row yet. */
export function defaultProgressSettings(sessionId: string, updatedAt = 0): ProgressSettings {
  return {
    sessionId,
    model: { followSession: true },
    autoEnabled: false,
    intervalMinutes: PROGRESS_DEFAULT_INTERVAL,
    lastCollectedAt: null,
    consecutiveFailures: 0,
    updatedAt,
  };
}

/**
 * Validate an untrusted `ProgressModelRef`. Only known fields are copied, so a
 * hostile payload cannot smuggle extra keys into `progress_settings`.
 */
export function parseProgressModelRef(value: unknown): ProgressModelRef | null {
  if (!isRecord(value)) return null;
  if (value.followSession === true) return { followSession: true };
  const { providerId, modelId } = value;
  if (!isNonEmptyString(providerId) || !isNonEmptyString(modelId)) return null;
  return { providerId, modelId };
}


/**
 * Normalize an untrusted UI language tag to a shipped catalog. A region-less
 * tag falls back to the catalog that covers it, and anything unknown reads as
 * English so a report is never blocked by an odd tag.
 */
export function normalizeProgressLocale(value: unknown): ProgressLocale {
  if (typeof value !== "string") return PROGRESS_DEFAULT_LOCALE;
  const tag = value.trim().toLowerCase();
  if (tag.length === 0) return PROGRESS_DEFAULT_LOCALE;
  for (const locale of PROGRESS_LOCALES) {
    if (locale.toLowerCase() === tag) return locale;
  }
  if (tag.startsWith("zh")) {
    return tag.includes("tw") || tag.includes("hk") || tag.includes("hant") ? "zh-TW" : "zh-CN";
  }
  if (tag.startsWith("pt")) return "pt-BR";
  const base = tag.split(/[-_]/)[0] ?? "";
  for (const locale of PROGRESS_LOCALES) {
    if (locale.toLowerCase() === base) return locale;
  }
  return PROGRESS_DEFAULT_LOCALE;
}

export type ProgressCollectValidation =
  | { ok: true; request: ProgressCollectRequest }
  | { ok: false; message: string };

function invalid(message: string): ProgressCollectValidation {
  return { ok: false, message };
}

/**
 * Validate an untrusted collect payload before Main registers a run. Main
 * checks it on entry; nothing downstream trusts these fields again.
 */
export function parseProgressCollectRequest(value: unknown): ProgressCollectValidation {
  if (!isRecord(value)) return invalid("request must be an object");
  const { sessionId, runId, trigger, model, locale } = value;
  if (!isNonEmptyString(sessionId)) {
    return invalid("sessionId must be a non-empty string");
  }
  if (typeof runId !== "string" || !PROGRESS_RUN_ID_PATTERN.test(runId)) {
    return invalid("runId must be 1 to 64 letters, digits, '-' or '_'");
  }
  if (typeof trigger !== "string" || !(PROGRESS_TRIGGERS as readonly string[]).includes(trigger)) {
    return invalid(`trigger must be one of ${PROGRESS_TRIGGERS.join(", ")}`);
  }
  const parsedModel = parseProgressModelRef(model);
  if (!parsedModel) {
    return invalid("model must be { followSession: true } or { providerId, modelId }");
  }
  return {
    ok: true,
    request: {
      sessionId,
      runId,
      trigger: trigger as ProgressTrigger,
      model: parsedModel,
      locale: normalizeProgressLocale(locale),
    },
  };
}

export type ProgressSettingsValidation =
  | { ok: true; patch: ProgressSettingsPatch }
  | { ok: false; message: string };

/**
 * Validate an untrusted settings patch. An out-of-range interval is refused
 * here so a stored interval is always one the popover can render (design § 8.5).
 */
export function parseProgressSettingsPatch(value: unknown): ProgressSettingsValidation {
  if (!isRecord(value)) return { ok: false, message: "patch must be an object" };
  const patch: ProgressSettingsPatch = {};
  if (value.model !== undefined) {
    const model = parseProgressModelRef(value.model);
    if (!model) {
      return {
        ok: false,
        message: "model must be { followSession: true } or { providerId, modelId }",
      };
    }
    patch.model = model;
  }
  if (value.autoEnabled !== undefined) {
    if (typeof value.autoEnabled !== "boolean") {
      return { ok: false, message: "autoEnabled must be a boolean" };
    }
    patch.autoEnabled = value.autoEnabled;
  }
  if (value.intervalMinutes !== undefined) {
    if (!isProgressInterval(value.intervalMinutes)) {
      return {
        ok: false,
        message: `intervalMinutes must be one of ${PROGRESS_INTERVALS.join(", ")}`,
      };
    }
    patch.intervalMinutes = value.intervalMinutes;
  }
  if (value.lastCollectedAt !== undefined) {
    if (value.lastCollectedAt !== null && typeof value.lastCollectedAt !== "number") {
      return { ok: false, message: "lastCollectedAt must be a number or null" };
    }
    patch.lastCollectedAt = value.lastCollectedAt;
  }
  if (value.consecutiveFailures !== undefined) {
    const failures = value.consecutiveFailures;
    if (typeof failures !== "number" || !Number.isInteger(failures) || failures < 0) {
      return { ok: false, message: "consecutiveFailures must be a non-negative integer" };
    }
    patch.consecutiveFailures = failures;
  }
  return { ok: true, patch };
}

/**
 * Clamp one section of a parsed report to its cap. Non-string entries are
 * dropped rather than stringified, so a model cannot inject an object into the
 * render path.
 */
export function clampProgressSection(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const kept: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (text.length === 0) continue;
    kept.push(text);
    if (kept.length >= max) break;
  }
  return kept;
}

/** Clamp one estimate to its integer range, accepting a numeric string. */
export function clampProgressEstimate(value: unknown, max: number): number | null {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  if (rounded < 0) return 0;
  return rounded > max ? max : rounded;
}

/** The checklist a report may read; it is digest context and is never written. */
export type ProgressTodoContext = Pick<SessionTodoSnapshot, "todos" | "revision">;
