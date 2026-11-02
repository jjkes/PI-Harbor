import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-harbor/shared";

register(new URL("./helpers/voice-service-stubs-hook.mjs", import.meta.url).href);

const { VoiceService } = await import("../electron/main/voice-service.ts");
const { StubVoiceController } = await import("./helpers/voice-runtime-stub.mjs");

test("publishes state and model progress on the renderer's subscribed IPC channels", async (t) => {
  const sent = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, data) => sent.push({ channel, data }),
    },
  };
  const service = new VoiceService("unused-model-cache-dir", () => window);
  t.after(() => service.dispose());

  await service.start();
  await service.stop();
  await service.downloadModel("sensevoice-small");

  assert.deepEqual(
    sent.map(({ channel }) => channel),
    [
      IPC.event.voiceStateChanged,
      IPC.event.voiceStateChanged,
      IPC.event.voiceModelProgress,
    ],
  );
  assert.equal(sent[0].data.phase, "listening");
  assert.equal(sent[1].data.phase, "done");
  assert.deepEqual(sent[2].data, { modelId: "sensevoice-small", progress: 1 });
});

test("a live preview failure is diagnostic-only for the recording", async (t) => {
  const logs = [];
  const service = new VoiceService(
    "unused-model-cache-dir",
    () => null,
    () => () => undefined,
    { logger: { log: (...args) => logs.push(args) } },
  );
  t.after(() => service.dispose());

  await service.start();
  StubVoiceController.last.emit("partialError", new Error("preview fixture failure"));

  assert.equal(logs.length, 1);
  assert.equal(logs[0][2], "warn");
  assert.equal(logs[0][3], "voice dictation live preview failed");
  assert.equal(logs[0][4].event, "voice.dictation.partial-failed");
  assert.equal(logs[0][4].data.detail, "preview fixture failure");
  assert.equal(service.getState().phase, "listening");
});
