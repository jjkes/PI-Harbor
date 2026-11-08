/**
 * Project-level norm instructions.
 *
 * They are stored on the app settings row, keyed by the project's absolute path,
 * and ride the existing project-instructions chain: the runtime already renders
 * that chain into the main agent's system prompt and into every subagent's
 * guidance (nested and Team delegates included), so nothing else has to learn
 * about them. Only the active project's entry is ever used, which is what makes
 * the text project-scoped rather than global.
 */

export type InstructionEntry = { source: string; content: string };
export type InstructionChain = { entries: InstructionEntry[] };

/** The stored text for one project, or an empty string when there is none. */
export function projectNormContent(
  norms: Record<string, string> | undefined | null,
  projectPath: string | undefined | null,
): string {
  if (!norms || !projectPath) return "";
  const text = norms[projectPath];
  return typeof text === "string" ? text.trim() : "";
}

/**
 * Append the project's norms to a loaded chain as one more source. A blank text
 * leaves the chain untouched, and an existing chain keeps its own order so the
 * norms read last — they are the project's own rules, not a replacement for the
 * repository's AGENTS.md chain.
 */
export function withProjectNorms(
  chain: InstructionChain | undefined,
  content: string,
): InstructionChain | undefined {
  const text = content.trim();
  if (!text) return chain;
  return {
    entries: [...(chain?.entries ?? []), { source: "Project norms", content: text }],
  };
}
