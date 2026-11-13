import { useTranslation } from "react-i18next";
import { IconSparkles } from "../../components/icons";
import "./debate-instruction-chip.css";

/**
 * The framing a plan-debate launch carries, shown as its own chip under the
 * bubble instead of as raw `<details>` markup inside the user's message.
 *
 * Native `<details>`/`<summary>` keeps it keyboard-operable and collapsed by
 * default; the instruction is readable, not editable, so it stays out of the
 * message text the user owns.
 */
export function DebateInstructionChip({ instruction }: { instruction: string }) {
  const { t } = useTranslation();
  return (
    <details className="debate-instruction-chip">
      <summary>
        <IconSparkles size={11} aria-hidden />
        <span>{t("planning.debateChip")}</span>
      </summary>
      <p className="debate-instruction-text">{instruction}</p>
    </details>
  );
}
