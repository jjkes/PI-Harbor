import assert from "node:assert/strict";
import test from "node:test";
import { IPC } from "@pi-harbor/shared";

// The real voice-runtime validators run here: the IPC boundary is where
// renderer input stops being trusted, so the test must not stub them.
const { registerVoiceIpc } = await import("../electron/main/ipc/voice-ipc.ts");

function harness() {
  const handlers = new Map();
  const calls = [];
  const voiceService = new Proxy(
    {},
    {
      get:
        (_target, method) =>
        (...args) => {
          calls.push([method, ...args]);
          return Promise.resolve(undefined);
        },
    },
  );
  registerVoiceIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    voiceService,
  });
  const invoke = (channel, ...args) => handlers.get(channel)(...args);
  return { invoke, calls };
}

test("start normalizes an untrusted settings patch before it reaches VoiceService", async () => {
  const { invoke, calls } = harness();

  await invoke(IPC.invoke.voiceStart, {
    enabled: true,
    deviceId: "mic-1",
    modelId: "../../outside-the-cache",
    languages: ["zh", "not a language", 42],
    cleanupMode: "shell",
    extra: "dropped",
  });

  assert.deepEqual(calls, [["start", { enabled: true, deviceId: "mic-1", languages: ["zh"] }]]);
});

test("start without a patch keeps the stored settings", async () => {
  const { invoke, calls } = harness();

  await invoke(IPC.invoke.voiceStart, undefined);

  assert.deepEqual(calls, [["start", undefined]]);
});

test("updateSettings drops values outside the contract", async () => {
  const { invoke, calls } = harness();

  await invoke(IPC.invoke.voiceUpdateSettings, { cleanupMode: "llm", chineseVariant: "klingon" });

  assert.deepEqual(calls, [["updateSettings", { cleanupMode: "llm" }]]);
});

test("model download and delete only accept catalog ids", async () => {
  const { invoke, calls } = harness();

  for (const channel of [IPC.invoke.voiceDownloadModel, IPC.invoke.voiceDeleteModel]) {
    for (const input of [{ modelId: "../escape" }, { modelId: 7 }, {}, null, undefined]) {
      await assert.rejects(invoke(channel, input), /Unknown voice model/);
    }
  }
  assert.deepEqual(calls, []);

  await invoke(IPC.invoke.voiceDownloadModel, { modelId: "sensevoice-small" });
  await invoke(IPC.invoke.voiceDeleteModel, { modelId: "qwen3-1.7b" });

  assert.deepEqual(calls, [
    ["downloadModel", "sensevoice-small"],
    ["deleteModel", "qwen3-1.7b"],
  ]);
});

test("model import only accepts catalog ids", async () => {
  const { invoke, calls } = harness();

  for (const input of [{ modelId: "../escape" }, { modelId: 7 }, {}, null, undefined]) {
    await assert.rejects(invoke(IPC.invoke.voiceImportModel, input), /Unknown voice model/);
  }
  assert.deepEqual(calls, []);

  await invoke(IPC.invoke.voiceImportModel, { modelId: "sensevoice-small" });
  assert.deepEqual(calls, [["importModel", "sensevoice-small"]]);
});
