import { useTranslation } from "react-i18next";
import { ToolDetailBlocks } from "./ToolDetails";
import type { ToolBlock } from "../lib/tool-presentation";

/*
 * The terminal surface a running call paints around its own output (D683).
 *
 * A call that is producing output reads as a command window while it works:
 * one chrome strip names what is running (a shell prompt and its command, or the
 * host tool and its summary) and one quiet pulse says it is still going, so the
 * live body cannot be mistaken for a result that already settled. The body is
 * the same structured block list the settled row renders, so nothing here can
 * change what the output says — only the surface it says it on.
 *
 * When the call settles this surface is gone and the row returns to D227's
 * unframed body, which is what a reader scrolled back through is reading.
 */
export function ToolLiveTerminal({
  command,
  label,
  blocks,
}: {
  /** The command a run row is executing, as written. */
  command?: string;
  /** What the head calls the call when it is not a command. */
  label?: string;
  /** The structured body the row already built; rendered unframed inside. */
  blocks: ToolBlock[];
}) {
  const { t } = useTranslation();
  return (
    <section className="tool-live-terminal" aria-label={t("chat.toolLiveOutput")}>
      <header className="tool-live-terminal-bar">
        <span className="tool-live-terminal-line">
          <span className="tool-live-terminal-prompt" aria-hidden="true">
            {command ? "$" : "›"}
          </span>
          <code className="tool-live-terminal-command" title={command ?? undefined}>
            {command ?? label}
          </code>
        </span>
        <span className="tool-live-terminal-state">
          <span className="tool-live-terminal-pulse" aria-hidden="true" />
          {t("chat.toolLiveRunning")}
        </span>
      </header>
      <div className="tool-live-terminal-body">
        <ToolDetailBlocks blocks={blocks} plain streaming />
      </div>
    </section>
  );
}
