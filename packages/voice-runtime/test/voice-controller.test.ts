import { describe, expect, it, vi } from "vitest";
import type { TranscriptionEngine } from "../src/transcription-engine.js";
import type { TranscriptionOutput, VoiceSettings, VoiceState } from "../src/types.js";
import { VoiceController } from "../src/voice-controller.js";

type Permission = "granted" | "denied" | "undetermined";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function createEngine(
  transcribe: (
    pcm: Float32Array,
    options: unknown,
    signal?: AbortSignal,
  ) => Promise<TranscriptionOutput> = async () => ({ text: "嗯，你好世界。", language: "zh" }),
  downloaded = true,
) {
  let loaded: string | null = null;
  const modelManager = {
    ensureLoaded: vi.fn(async (modelId: string) => {
      loaded = modelId;
    }),
    isDownloaded: vi.fn(() => downloaded),
    getLoadedModelId: vi.fn(() => loaded),
    getLoadedModel: vi.fn(() => ({})),
    unload: vi.fn(() => {
      loaded = null;
    }),
  };
  const transcribeMock = vi.fn(transcribe);
  const engine = { modelManager, transcribe: transcribeMock, shutdown: vi.fn() };
  return {
    engine: engine as unknown as TranscriptionEngine,
    modelManager,
    transcribe: transcribeMock,
  };
}

function createCapture(open: () => Promise<void> = async () => undefined) {
  const capture = {
    isActive: false,
    start: vi.fn(async () => {
      await open();
      capture.isActive = true;
    }),
    stop: vi.fn(async () => {
      capture.isActive = false;
      return new Float32Array(0);
    }),
    cancel: vi.fn(() => {
      capture.isActive = false;
    }),
    onFrame: vi.fn(),
  };
  return capture;
}

function createFactory(
  capture = createCapture(),
  permission: Permission = "granted",
  grantOnRequest = false,
) {
  return {
    getDevices: vi.fn(async () => []),
    create: vi.fn(() => capture),
    checkPermission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => grantOnRequest),
  };
}

function settings(overrides: Partial<VoiceSettings> = {}): VoiceSettings {
  return {
    enabled: true,
    deviceId: null,
    languages: ["zh"],
    chineseVariant: "simplified",
    modelId: "sensevoice-small",
    cleanupMode: "rules",
    ...overrides,
  };
}

function recordPhases(controller: VoiceController): string[] {
  const seen: string[] = [];
  controller.on("stateChange", (state: VoiceState) => seen.push(state.phase));
  return seen;
}

describe("VoiceController", () => {
  it("starts in idle state", () => {
    const controller = new VoiceController(createEngine().engine, createFactory(), () => settings());
    expect(controller.state.phase).toBe("idle");
  });

  it("prepare rejects without a selected model", async () => {
    const controller = new VoiceController(createEngine().engine, createFactory(), () =>
      settings({ modelId: "" }),
    );
    await expect(controller.prepare()).rejects.toThrow("No model selected");
    expect(controller.state.errorCode).toBe("no-model");
  });

  it("start transitions through preparing, ready, starting, listening", async () => {
    const controller = new VoiceController(createEngine().engine, createFactory(), () => settings());
    const seen = recordPhases(controller);
    await controller.start();
    expect(seen).toEqual(["preparing", "ready", "starting", "listening"]);
  });

  it("transcribes, removes fillers, and keeps the recognizer text", async () => {
    const { engine, transcribe } = createEngine();
    const controller = new VoiceController(engine, createFactory(), () => settings());
    await controller.start();
    const result = await controller.stop();

    expect(result?.text).toBe("你好世界。");
    expect(result?.rawText).toBe("嗯，你好世界。");
    expect(result?.cleanup).toEqual({ mode: "rules", applied: "rules" });
    expect(result?.language).toBe("zh");
    expect(controller.state.phase).toBe("done");
    expect(transcribe).toHaveBeenCalledWith(
      expect.any(Float32Array),
      { languages: ["zh"], chineseVariant: "simplified" },
      expect.any(AbortSignal),
    );
  });

  it("inserts the recognizer text verbatim when cleanup is off", async () => {
    const controller = new VoiceController(createEngine().engine, createFactory(), () =>
      settings({ cleanupMode: "off" }),
    );
    await controller.start();
    const result = await controller.stop();
    expect(result?.text).toBe("嗯，你好世界。");
    expect(result?.cleanup).toEqual({ mode: "off", applied: "off" });
  });

  it("falls back to rules when local AI cleanup has no model", async () => {
    const controller = new VoiceController(createEngine().engine, createFactory(), () =>
      settings({ cleanupMode: "llm" }),
    );
    await controller.start();
    const result = await controller.stop();
    expect(result?.text).toBe("你好世界。");
    expect(result?.cleanup).toEqual({ mode: "llm", applied: "rules", fallback: "model-missing" });
  });

  it("can record again after a finished dictation", async () => {
    const controller = new VoiceController(createEngine().engine, createFactory(), () => settings());
    await controller.start();
    await controller.stop();
    expect(controller.state.phase).toBe("done");

    await controller.start();
    expect(controller.state.phase).toBe("listening");
  });

  it("cancelling during transcription returns to idle without an error", async () => {
    const pending = deferred<TranscriptionOutput>();
    const { engine, transcribe } = createEngine(() => pending.promise);
    const controller = new VoiceController(engine, createFactory(), () => settings());
    await controller.start();
    const seen = recordPhases(controller);

    const stopping = controller.stop();
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled());
    controller.cancel();
    pending.resolve({ text: "晚到的结果", language: "zh" });

    await expect(stopping).resolves.toBeNull();
    expect(controller.state.phase).toBe("idle");
    expect(seen).not.toContain("error");
    expect(seen).not.toContain("done");
  });

  it("cancelling while the recorder opens never starts listening", async () => {
    const opening = deferred<void>();
    const capture = createCapture(() => opening.promise);
    const controller = new VoiceController(createEngine().engine, createFactory(capture), () =>
      settings(),
    );
    const starting = controller.start();
    await vi.waitFor(() => expect(capture.start).toHaveBeenCalled());

    controller.cancel();
    opening.resolve();
    await starting;

    expect(capture.cancel).toHaveBeenCalled();
    expect(controller.state.phase).toBe("idle");
  });

  it("reports a model that is not downloaded", async () => {
    const { engine, modelManager } = createEngine(undefined, false);
    const controller = new VoiceController(engine, createFactory(), () => settings());
    await expect(controller.start()).rejects.toThrow("Model not downloaded");
    expect(controller.state.errorCode).toBe("model-not-downloaded");
    expect(modelManager.ensureLoaded).not.toHaveBeenCalled();
  });

  it("reports refused microphone permission before opening the recorder", async () => {
    const factory = createFactory(createCapture(), "undetermined", false);
    const controller = new VoiceController(createEngine().engine, factory, () => settings());
    await expect(controller.start()).rejects.toThrow("Microphone access denied");
    expect(factory.requestPermission).toHaveBeenCalled();
    expect(factory.create).not.toHaveBeenCalled();
    expect(controller.state.errorCode).toBe("microphone-denied");
  });

  it("rejects start while already listening", async () => {
    const controller = new VoiceController(createEngine().engine, createFactory(), () => settings());
    await controller.start();
    await expect(controller.start()).rejects.toThrow("Cannot start from phase: listening");
  });

  it("dispose cancels and removes listeners", async () => {
    const controller = new VoiceController(createEngine().engine, createFactory(), () => settings());
    recordPhases(controller);
    await controller.start();
    controller.dispose();
    expect(controller.state.phase).toBe("idle");
    expect(controller.listenerCount("stateChange")).toBe(0);
  });
});
