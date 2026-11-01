import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { StubTranscriptCleaner, StubVoiceController } from "./helpers/voice-runtime-stub.mjs";

// Same stubs as voice-service-idle-unload: `electron` and the voice runtime
// are replaced, so these tests cover VoiceService's own wiring of the
// cleanup-model worker (a separate process in the real app) without native
// code.
register(new URL("./helpers/voice-service-stubs-hook.mjs", import.meta.url).href);

const { VoiceService } = await import("../electron/main/voice-service.ts");

const MODEL_IDLE_UNLOAD_MS = 10 * 60 * 1000;

// Manual fake clock for the idle-unload timer.
function fakeClock(t) {
  const pending = new Map();
  let now = 0;
  let seq = 0;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    seq += 1;
    pending.set(seq, { callback, at: now + (delay ?? 0) });
    return { id: seq, ref() {}, unref() {}, hasRef: () => true };
  });
  t.mock.method(globalThis, "clearTimeout", (handle) => {
    pending.delete(handle?.id);
  });
  return {
    advance(ms) {
      now += ms;
      for (const [id, job] of [...pending.entries()]) {
        if (job.at <= now) {
          pending.delete(id);
          job.callback();
        }
      }
    },
  };
}

function newService() {
  return new VoiceService("unused-model-cache-dir", () => null);
}

test("the idle boundary also ends the cleanup-model worker", async (t) => {
  const clock = fakeClock(t);
  const service = newService();
  await service.start({ cleanupMode: "llm" });
  const cleaner = StubTranscriptCleaner.last;
  const { modelManager } = StubVoiceController.last;

  await service.stop(); // → phase "done", schedules the idle unload
  clock.advance(MODEL_IDLE_UNLOAD_MS - 1);
  assert.equal(cleaner.unloadCalls, 0, "must not end the worker early");

  clock.advance(1);
  assert.equal(modelManager.unloadCalls, 1);
  assert.equal(cleaner.unloadCalls, 1);
});

test("leaving local-AI cleanup ends the worker; other setting changes keep it", async (t) => {
  fakeClock(t);
  const service = newService();
  await service.start({ cleanupMode: "llm" });
  const cleaner = StubTranscriptCleaner.last;

  service.updateSettings({ languages: ["zh"] });
  service.updateSettings({ cleanupMode: "llm" });
  assert.equal(cleaner.unloadCalls, 0);

  service.updateSettings({ cleanupMode: "rules" });
  assert.equal(cleaner.unloadCalls, 1);

  service.updateSettings({ cleanupMode: "off" });
  assert.equal(cleaner.unloadCalls, 1, "the worker was already released");
});

test("deleting the cleanup model ends its worker before the file is removed", async (t) => {
  fakeClock(t);
  const service = newService();
  await service.start();
  const cleaner = StubTranscriptCleaner.last;
  const { modelManager } = StubVoiceController.last;
  const order = [];
  t.mock.method(cleaner, "unload", async () => {
    order.push("end-worker");
  });
  t.mock.method(modelManager, "deleteModel", async (modelId) => {
    order.push(`delete:${modelId}`);
  });

  await service.deleteModel("sensevoice-small");
  await service.deleteModel("qwen3-1.7b");

  assert.deepEqual(order, ["delete:sensevoice-small", "end-worker", "delete:qwen3-1.7b"]);
});

test("dispose cancels downloads and ends the cleanup-model worker", async (t) => {
  fakeClock(t);
  const service = newService();
  await service.start();
  const cleaner = StubTranscriptCleaner.last;
  const { modelManager } = StubVoiceController.last;

  service.dispose();

  assert.equal(modelManager.cancelDownloadCalls, 1);
  assert.equal(cleaner.unloadCalls, 1);
});

test("concurrent model listing and start build a single runtime", async (t) => {
  fakeClock(t);
  const service = newService();
  const before = StubVoiceController.created;

  await Promise.all([service.getModels(), service.start(), service.getModels()]);

  assert.equal(StubVoiceController.created - before, 1);
});

test("listing models after dispose builds no runtime", async () => {
  const service = newService();
  service.dispose();
  const before = StubVoiceController.created;

  assert.deepEqual(await service.getModels(), []);
  assert.equal(StubVoiceController.created, before);
});
