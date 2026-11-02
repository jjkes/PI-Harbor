import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/*
 * Settings → Voice → Dictation states why a model download failed, not only
 * that it failed: the last error from Main is shown under the retry button,
 * and a failure Main remembers survives a settings reload.
 */

test("a failed model download shows the reason Main reported", async (t) => {
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
  const { VoiceModelStatus } = await server.ssrLoadModule(
    "/src/features/settings/voice/DictationSettings.tsx",
  );

  const t2 = (key) => key;
  const entry = (overrides = {}) => ({
    info: {
      id: "sensevoice-small",
      kind: "transcription",
      name: "SenseVoice Small",
      languages: ["zh", "en"],
      sizeBytes: 252_684_608,
      recommended: true,
    },
    status: "not-downloaded",
    ...overrides,
  });
  const render = (props) =>
    renderToStaticMarkup(React.createElement(VoiceModelStatus, { t: t2, ...props }));

  const live = render({
    entry: entry({ status: "error" }),
    percent: undefined,
    failedMessage: "Model download failed: huggingface.co unreachable (fetch failed)",
    onDownload: () => undefined,
    onDelete: () => undefined,
  });
  assert.match(live, /settings\.voiceModelFailed/);
  assert.match(live, /huggingface\.co unreachable/);
  assert.match(live, /settings\.voiceModelDownload/);
  assert.doesNotMatch(live, /settings\.voiceModelNotDownloaded/);

  // Main keeps the reason on the model state, so reopening Settings still shows it.
  const remembered = render({
    entry: entry({ status: "error", error: "Model download failed: HTTP 404 from hf-mirror.com" }),
    percent: undefined,
    onDownload: () => undefined,
    onDelete: () => undefined,
  });
  assert.match(remembered, /HTTP 404 from hf-mirror\.com/);

  const installed = render({
    entry: entry({ status: "downloaded", localPath: "/tmp/model.gguf" }),
    percent: undefined,
    onDownload: () => undefined,
    onDelete: () => undefined,
  });
  assert.match(installed, /settings\.voiceModelDownloaded/);
  assert.match(installed, /settings\.voiceModelDelete/);
  assert.doesNotMatch(installed, /settings\.voiceModelFailed/);

  const running = render({
    entry: entry({ status: "downloading" }),
    percent: 0.42,
    onDownload: () => undefined,
    onDelete: () => undefined,
  });
  assert.match(running, /settings\.voiceModelDownloading 42%/);

  const idle = render({
    entry: entry(),
    percent: undefined,
    onDownload: () => undefined,
    onDelete: () => undefined,
  });
  assert.match(idle, /settings\.voiceModelNotDownloaded/);
  assert.match(idle, /settings\.voiceModelDownload/);
});
