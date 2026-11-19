import type { Context } from "@earendil-works/pi-ai";
import type { ProgressLocale } from "@pi-harbor/shared";

/**
 * The prompt of one report (design § 7.3). A report is a summary of a digest,
 * never a conversation: one system message states the rules, one user message
 * carries the digest and the required shape.
 */

/** How each shipped UI language names itself to the model. */
const LOCALE_NAMES: Record<ProgressLocale, string> = {
  en: "English",
  "zh-CN": "Simplified Chinese (zh-CN)",
  "zh-TW": "Traditional Chinese (zh-TW)",
  de: "German",
  es: "Spanish",
  fr: "French",
  ko: "Korean",
  "pt-BR": "Brazilian Portuguese",
  tr: "Turkish",
};

export const PROGRESS_SYSTEM_PROMPT = [
  "You summarize an in-progress coding session for its user.",
  "Answer only from the digest. Do not invent files, commands, results, or plans.",
  "Report what the work has accomplished, what is happening now, and what is likely next.",
  "Estimate the remaining work only from the pace visible in the digest; if the digest does not support an estimate, use null.",
  "Reply with a single JSON object and nothing else.",
].join(" ");

/** The exact shape the parser and the report card expect. */
export const PROGRESS_REPORT_SHAPE = `{
  "completed": ["..."],
  "inProgress": ["..."],
  "next": ["..."],
  "remainingSteps": 4,
  "remainingMinutes": 18,
  "confidence": "low | medium | high"
}`;

export const PROGRESS_REPORT_RULES = [
  "Rules:",
  "- completed: up to 8 finished items, most important first.",
  "- inProgress: up to 3 items the session is working on right now.",
  "- next: up to 5 items that most likely come next.",
  "- remainingSteps: integer 0-99, or null when the digest does not support an estimate.",
  "- remainingMinutes: integer 0-600, or null when the digest does not support an estimate.",
  "- confidence: how well the digest supports the estimate (low, medium, or high).",
  "- Every item is one short sentence of plain text. No Markdown, no code fences, no links.",
].join("\n");

/**
 * Build the completion context for one digest. `now` comes from the caller so
 * the prompt stays deterministic for tests.
 */
export function buildProgressPrompt(
  digest: string,
  now: number,
  locale: ProgressLocale = "en",
): Context {
  // The report is read by the user who set the UI language, so the model writes
  // every human-readable string in that language while the JSON keys stay English.
  const systemPrompt = `${PROGRESS_SYSTEM_PROMPT} Write every string value in ${LOCALE_NAMES[locale]}; keep the JSON keys in English.`;
  return {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: `${digest}\n\nReply with this JSON object:\n${PROGRESS_REPORT_SHAPE}\n\n${PROGRESS_REPORT_RULES}`,
        timestamp: now,
      },
    ],
    // A report never calls a tool: the digest is the whole input (design § 7.9).
    tools: [],
  };
}
