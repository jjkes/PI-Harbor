import type { TFunction } from "i18next";
import type { AppSettings } from "@pi-harbor/shared";
import { DictationSettings } from "./DictationSettings";
import { LiveVoiceSettings } from "./LiveVoiceSettings";

/** Settings → Voice: local Dictation, then the opt-in Live Voice bindings. */
export function VoiceSettingsSection(props: {
  t: TFunction;
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  return (
    <>
      <DictationSettings {...props} />
      <LiveVoiceSettings {...props} />
    </>
  );
}
