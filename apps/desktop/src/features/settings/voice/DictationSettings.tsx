/**
 * Settings → Voice → Dictation: local speech-to-text into the Composer draft.
 * Models load from Main only after Dictation is enabled, so a disabled
 * feature never starts the voice runtime.
 */

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import type { AppSettings, VoiceInputSettings } from "@pi-harbor/shared";
import { Badge, Button, SettingsToggle } from "../../../components/ui";
import { SettingsMenuSelect } from "../../../components/settings/SettingsMenuSelect";
import { SettingsCard, SettingsRow } from "../primitives";
import { voiceIpc } from "../../voice/voice-ipc";

type CleanupMode = NonNullable<VoiceInputSettings["cleanupMode"]>;

interface ModelEntry {
  info: {
    id: string;
    kind?: "transcription" | "cleanup";
    name: string;
    languages: string[];
    sizeBytes: number;
    recommended: boolean;
  };
  status: "not-downloaded" | "downloading" | "downloaded" | "loading" | "loaded" | "error";
  localPath?: string;
}

interface DeviceEntry {
  deviceId: string;
  label: string;
}

const DEFAULT_VOICE: VoiceInputSettings = {
  enabled: false,
  deviceId: null,
  languages: ["zh", "en"],
  chineseVariant: "simplified",
  modelId: "",
  cleanupMode: "rules",
};

const CLEANUP_MODES: readonly CleanupMode[] = ["off", "rules", "llm"];
const CLEANUP_LABELS: Record<CleanupMode, string> = {
  off: "settings.voiceCleanupOff",
  rules: "settings.voiceCleanupRules",
  llm: "settings.voiceCleanupLlm",
};
const CHINESE_VARIANTS: ReadonlyArray<{ id: VoiceInputSettings["chineseVariant"]; key: string }> = [
  { id: "simplified", key: "settings.voiceSimplified" },
  { id: "traditional-taiwan", key: "settings.voiceTraditionalTaiwan" },
  { id: "traditional-hong-kong", key: "settings.voiceTraditionalHK" },
];

const inline = { display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" } as const;

function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function languageLabel(code: string): string {
  try {
    const locale = typeof navigator === "undefined" ? "en" : navigator.language;
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function isOnDisk(entry: ModelEntry): boolean {
  return (
    entry.status === "downloaded" ||
    entry.status === "loading" ||
    entry.status === "loaded" ||
    (entry.status === "error" && Boolean(entry.localPath))
  );
}

export function DictationSettings({
  t,
  settings,
  saveSettings,
}: {
  t: TFunction;
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const voice: VoiceInputSettings = { ...DEFAULT_VOICE, ...settings.voice };
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});

  const refreshModels = useCallback(() => {
    voiceIpc
      .getModels()
      .then((list) => setModels(list as ModelEntry[]))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!voice.enabled) return;
    refreshModels();
    voiceIpc
      .getDevices()
      .then((list) => setDevices(list as DeviceEntry[]))
      .catch(() => undefined);
    return voiceIpc.onModelProgress(({ modelId, progress: value }) => {
      setProgress((all) => ({ ...all, [modelId]: value }));
    });
  }, [voice.enabled, refreshModels]);

  const update = (patch: Partial<VoiceInputSettings>) => {
    const next: VoiceInputSettings = { ...voice, ...patch };
    void saveSettings({ voice: next }).catch(() => undefined);
    void voiceIpc.updateSettings(next).catch(() => undefined);
  };

  const download = (modelId: string) => {
    setFailed((all) => ({ ...all, [modelId]: false }));
    setProgress((all) => ({ ...all, [modelId]: 0 }));
    void voiceIpc
      .downloadModel(modelId)
      .catch(() => setFailed((all) => ({ ...all, [modelId]: true })))
      .finally(() => {
        setProgress((all) => {
          const next = { ...all };
          delete next[modelId];
          return next;
        });
        refreshModels();
      });
  };

  const remove = (modelId: string) => {
    void voiceIpc
      .deleteModel(modelId)
      .catch(() => undefined)
      .finally(refreshModels);
  };

  const modelControls = (entry: ModelEntry | undefined): ReactNode => {
    if (!entry) return null;
    const { id } = entry.info;
    const percent = progress[id];
    if (percent !== undefined) {
      return <Badge>{`${t("settings.voiceModelDownloading")} ${Math.round(percent * 100)}%`}</Badge>;
    }
    if (entry.status === "downloading") return <Badge>{t("settings.voiceModelDownloading")}</Badge>;
    if (isOnDisk(entry)) {
      return (
        <>
          <Badge tone="success">{t("settings.voiceModelDownloaded")}</Badge>
          <Button type="button" size="sm" variant="ghost" onClick={() => remove(id)}>
            {t("settings.voiceModelDelete")}
          </Button>
        </>
      );
    }
    return (
      <>
        <Badge tone={failed[id] ? "error" : "neutral"}>
          {t(failed[id] ? "settings.voiceModelFailed" : "settings.voiceModelNotDownloaded")}
        </Badge>
        <Button type="button" size="sm" onClick={() => download(id)}>
          {t("settings.voiceModelDownload")}
        </Button>
      </>
    );
  };

  const transcriptionModels = models.filter((entry) => entry.info.kind !== "cleanup");
  const cleanupModel = models.find((entry) => entry.info.kind === "cleanup");
  const selectedModel = transcriptionModels.find((entry) => entry.info.id === voice.modelId);
  const languageCodes = [
    ...new Set([...(selectedModel?.info.languages ?? ["zh", "en"]), ...voice.languages]),
  ];
  const chinese = voice.languages.some((code) => code.startsWith("zh") || code === "yue");
  const modelOptions = [
    { id: "", label: t("settings.voiceNoModelSelected") },
    ...transcriptionModels.map((entry) => ({
      id: entry.info.id,
      label: `${entry.info.name} · ${formatSize(entry.info.sizeBytes)}${
        entry.info.recommended ? ` · ${t("settings.voiceModelRecommended")}` : ""
      }`,
    })),
  ];
  if (voice.modelId && !selectedModel) modelOptions.push({ id: voice.modelId, label: voice.modelId });
  const deviceOptions = [
    { id: "", label: t("settings.voiceSystemDefault") },
    ...devices.map((device) => ({ id: device.deviceId, label: device.label })),
  ];

  return (
    <SettingsCard title={t("settings.voiceDictationTitle")} description={t("settings.voiceDictationDesc")}>
      <SettingsRow title={t("settings.voiceEnable")}>
        <SettingsToggle
          checked={voice.enabled}
          label={t("settings.voiceEnable")}
          onChange={() => update({ enabled: !voice.enabled })}
        />
      </SettingsRow>
      {voice.enabled ? (
        <>
          <SettingsRow title={t("settings.voiceMicrophone")}>
            <SettingsMenuSelect
              label={t("settings.voiceMicrophone")}
              value={voice.deviceId ?? ""}
              options={deviceOptions}
              onChange={(id) => update({ deviceId: id || null })}
            />
          </SettingsRow>
          <SettingsRow title={t("settings.voiceLanguages")} description={t("settings.voiceLanguagesDesc")}>
            <span style={inline}>
              {languageCodes.map((code) => {
                const on = voice.languages.includes(code);
                return (
                  <Button
                    key={code}
                    type="button"
                    size="sm"
                    variant={on ? "primary" : "secondary"}
                    aria-pressed={on}
                    onClick={() => {
                      const languages = on
                        ? voice.languages.filter((selected) => selected !== code)
                        : [...voice.languages, code];
                      if (languages.length > 0) update({ languages });
                    }}
                  >
                    {languageLabel(code)}
                  </Button>
                );
              })}
            </span>
          </SettingsRow>
          {chinese ? (
            <SettingsRow title={t("settings.voiceChineseVariant")}>
              <SettingsMenuSelect
                label={t("settings.voiceChineseVariant")}
                value={voice.chineseVariant}
                options={CHINESE_VARIANTS.map((variant) => ({ id: variant.id, label: t(variant.key) }))}
                onChange={(id) => {
                  const variant = CHINESE_VARIANTS.find((candidate) => candidate.id === id);
                  if (variant) update({ chineseVariant: variant.id });
                }}
              />
            </SettingsRow>
          ) : null}
          <SettingsRow title={t("settings.voiceModel")} description={t("settings.voiceModelNetworkHint")}>
            <span style={inline}>
              <SettingsMenuSelect
                label={t("settings.voiceModel")}
                value={voice.modelId}
                options={modelOptions}
                onChange={(id) => update({ modelId: id })}
              />
              {modelControls(selectedModel)}
            </span>
          </SettingsRow>
          <SettingsRow title={t("settings.voiceCleanup")} description={t("settings.voiceCleanupDesc")}>
            <SettingsMenuSelect
              label={t("settings.voiceCleanup")}
              value={voice.cleanupMode ?? "rules"}
              options={CLEANUP_MODES.map((mode) => ({ id: mode, label: t(CLEANUP_LABELS[mode]) }))}
              onChange={(id) => {
                const mode = CLEANUP_MODES.find((candidate) => candidate === id);
                if (mode) update({ cleanupMode: mode });
              }}
            />
          </SettingsRow>
          {voice.cleanupMode === "llm" ? (
            <SettingsRow title={t("settings.voiceCleanupModel")} description={t("settings.voiceCleanupModelDesc")}>
              <span style={inline}>
                {cleanupModel ? (
                  <span>{`${cleanupModel.info.name} · ${formatSize(cleanupModel.info.sizeBytes)}`}</span>
                ) : null}
                {modelControls(cleanupModel)}
              </span>
            </SettingsRow>
          ) : null}
        </>
      ) : null}
    </SettingsCard>
  );
}
