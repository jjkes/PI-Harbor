import { describe, expect, it } from "vitest";
import { normalizeVoiceSettingsPatch, resolveVoiceSettings } from "../src/settings.js";

describe("normalizeVoiceSettingsPatch", () => {
  it("keeps valid fields", () => {
    const patch = {
      enabled: true,
      deviceId: null,
      languages: ["zh", "en"],
      chineseVariant: "traditional-taiwan",
      modelId: "sensevoice-small",
      cleanupMode: "llm",
    };
    expect(normalizeVoiceSettingsPatch(patch)).toEqual(patch);
  });

  it("drops invalid and unknown fields", () => {
    expect(
      normalizeVoiceSettingsPatch({
        enabled: "yes",
        deviceId: 5,
        languages: ["zh", "zh", "<script>", 3],
        chineseVariant: "klingon",
        modelId: "qwen3-1.7b",
        cleanupMode: "magic",
        extra: true,
      }),
    ).toEqual({ languages: ["zh"] });
  });

  it("accepts clearing the model and ignores non-objects", () => {
    expect(normalizeVoiceSettingsPatch({ modelId: "" })).toEqual({ modelId: "" });
    expect(normalizeVoiceSettingsPatch("voice")).toEqual({});
    expect(normalizeVoiceSettingsPatch(null)).toEqual({});
  });
});

describe("resolveVoiceSettings", () => {
  it("fills defaults for settings stored before cleanup existed", () => {
    expect(resolveVoiceSettings({ enabled: true, modelId: "sensevoice-small" })).toEqual({
      enabled: true,
      deviceId: null,
      languages: ["zh", "en"],
      chineseVariant: "simplified",
      modelId: "sensevoice-small",
      cleanupMode: "rules",
    });
  });
});
