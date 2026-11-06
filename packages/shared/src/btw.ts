import type { BtwAskRequest, BtwHistoryTurn } from "./types/btw.js";
import type { SessionSummary } from "./types/sessions.js";

/** Longest side question, in characters (ADR 0344). */
export const BTW_QUESTION_MAX_CHARS = 8_000;
/** Most earlier turns one side question carries. */
export const BTW_HISTORY_MAX_TURNS = 20;
/** Largest combined size of the carried turns, in characters. */
export const BTW_HISTORY_MAX_CHARS = 64_000;
/** Run ids are embedded in host tool-call ids, so they stay short and plain. */
const BTW_RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a session can host BTW side questions. Fails closed: only a local
 * desktop session qualifies, judged by both its `source` and its id prefix,
 * the two signals `isRemoteSession` reads. Older hosts omit `source`, which
 * normalizes to `desktop`.
 */
export function btwAvailableFor(
  session: Pick<SessionSummary, "id" | "source"> | null | undefined,
): boolean {
  if (!session || typeof session.id !== "string" || session.id.length === 0) return false;
  if ((session.source ?? "desktop") !== "desktop") return false;
  return !session.id.startsWith("remote:") && !session.id.startsWith("native-pi:");
}

/**
 * The newest contiguous turns that fit the history limits, oldest first. The
 * renderer sends this, so a long thread keeps working instead of failing
 * validation.
 */
export function boundedBtwHistory(turns: readonly BtwHistoryTurn[]): BtwHistoryTurn[] {
  const kept: BtwHistoryTurn[] = [];
  let chars = 0;
  for (let index = turns.length - 1; index >= 0 && kept.length < BTW_HISTORY_MAX_TURNS; index -= 1) {
    const turn = turns[index];
    if (!turn) break;
    const size = turn.question.length + turn.answer.length;
    if (chars + size > BTW_HISTORY_MAX_CHARS) break;
    chars += size;
    kept.push({ question: turn.question, answer: turn.answer });
  }
  return kept.reverse();
}

export type BtwAskValidation =
  | { ok: true; request: BtwAskRequest }
  | { ok: false; message: string };

function invalid(message: string): BtwAskValidation {
  return { ok: false, message };
}

/**
 * Validate an untrusted ask payload. Electron Main checks it before it forwards
 * the request and the sidecar checks it again; only known fields are copied.
 */
export function parseBtwAskRequest(value: unknown): BtwAskValidation {
  if (!isRecord(value)) return invalid("request must be an object");
  const { sessionId, runId, question, history } = value;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return invalid("sessionId must be a non-empty string");
  }
  if (typeof runId !== "string" || !BTW_RUN_ID_PATTERN.test(runId)) {
    return invalid("runId must be 1 to 64 letters, digits, '-' or '_'");
  }
  if (typeof question !== "string" || question.trim().length === 0) {
    return invalid("question must be a non-empty string");
  }
  if (question.length > BTW_QUESTION_MAX_CHARS) {
    return invalid(`question must be at most ${BTW_QUESTION_MAX_CHARS} characters`);
  }
  if (!Array.isArray(history) || history.length > BTW_HISTORY_MAX_TURNS) {
    return invalid(`history must be an array of at most ${BTW_HISTORY_MAX_TURNS} turns`);
  }
  const turns: BtwHistoryTurn[] = [];
  let chars = 0;
  for (const turn of history) {
    if (!isRecord(turn) || typeof turn.question !== "string" || typeof turn.answer !== "string") {
      return invalid("each history turn needs a string question and answer");
    }
    chars += turn.question.length + turn.answer.length;
    turns.push({ question: turn.question, answer: turn.answer });
  }
  if (chars > BTW_HISTORY_MAX_CHARS) {
    return invalid(`history must be at most ${BTW_HISTORY_MAX_CHARS} characters`);
  }
  return { ok: true, request: { sessionId, runId, question, history: turns } };
}
