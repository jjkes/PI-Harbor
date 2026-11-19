import type { ComposerModeChoice } from "../../plan-debate/debate-mode";
import { IconListChecks, IconShield, IconSparkles, IconTarget } from "../../../components/icons";

export function ModeIcon({ mode }: { mode: ComposerModeChoice }) {
  if (mode === "plan") return <IconListChecks size={14} />;
  if (mode === "goal") return <IconTarget size={14} />;
  if (mode === "debate") return <IconSparkles size={14} />;
  return <IconShield size={14} />;
}
