import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("Settings → Voice shows Dictation before Live Voice, and the Composer control reports cleanup", async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin: "http://localhost" },
      addEventListener() {},
      removeEventListener() {},
      piDesktop: {
        on: () => () => undefined,
        invoke: async () => ({ ok: true, data: { voice: { enabled: true } } }),
      },
    },
  });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  });

  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());

  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { VoiceSettingsSection } = await server.ssrLoadModule(
    "/src/features/settings/voice/VoiceSettingsSection.tsx",
  );
  const { DictationControl } = await server.ssrLoadModule("/src/features/voice/DictationControl.tsx");

  let savedPatch;
  const renderSettings = (voice) =>
    renderToStaticMarkup(
      React.createElement(VoiceSettingsSection, {
        t: (key) => key,
        settings: { voice, liveVoice: { enabled: false, bindings: [] } },
        saveSettings: async (patch) => {
          savedPatch = patch;
        },
      }),
    );

  const enabled = renderSettings({
    enabled: true,
    deviceId: null,
    languages: ["zh", "en"],
    chineseVariant: "simplified",
    modelId: "sensevoice-small",
    cleanupMode: "llm",
  });
  for (const key of [
    "settings.voiceDictationTitle",
    "settings.voiceEnable",
    "settings.voiceMicrophone",
    "settings.voiceLanguages",
    "settings.voiceChineseVariant",
    "settings.voiceModel",
    "settings.voiceCleanup",
    "settings.voiceCleanupModel",
    "liveVoice.title",
  ]) {
    assert.ok(enabled.includes(key), `missing ${key}`);
  }
  assert.ok(enabled.indexOf("settings.voiceDictationTitle") < enabled.indexOf("liveVoice.title"));

  // Settings stored before cleanup existed still render; disabled Dictation shows only its switch.
  const disabled = renderSettings({
    enabled: false,
    deviceId: null,
    languages: ["zh"],
    chineseVariant: "simplified",
    modelId: "",
  });
  assert.ok(disabled.includes("settings.voiceEnable"));
  for (const key of ["settings.voiceMicrophone", "settings.voiceModel", "settings.voiceCleanup"]) {
    assert.ok(!disabled.includes(key), `unexpected ${key}`);
  }
  assert.equal(savedPatch, undefined, "rendering never saves settings");

  const renderControl = (notice) =>
    renderToStaticMarkup(
      React.createElement(DictationControl, {
        t: (key) => key,
        dictation: { enabled: true, settings: undefined, onResult() {}, notice, restoreOriginal() {} },
      }),
    );

  const idle = renderControl(null);
  assert.ok(idle.includes("settings.voiceDictationStart"));
  assert.ok(!idle.includes("settings.voiceRestoreOriginal"));

  const cleaned = renderControl({ applied: "rules", canRestore: true });
  assert.ok(cleaned.includes("settings.voiceCleanedRules"));
  assert.ok(cleaned.includes("settings.voiceRestoreOriginal"));

  const tidied = renderControl({ applied: "llm", canRestore: true });
  assert.ok(tidied.includes("settings.voiceCleanedLlm"));

  const fallback = renderControl({ applied: "rules", fallback: "model-missing", canRestore: false });
  assert.ok(fallback.includes("settings.voiceCleanupFallback"));
  assert.ok(!fallback.includes("settings.voiceRestoreOriginal"));
});
