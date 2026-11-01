import { describe, expect, it, vi } from "vitest";
import type { TranscriptPolisher } from "../src/cleanup/llama-polisher.js";
import { cleanTranscript, MAX_POLISH_CHARS } from "../src/cleanup/pipeline.js";
import { TranscriptCleaner } from "../src/cleanup/transcript-cleaner.js";

type FakePolisher = TranscriptPolisher & { calls: string[] };

function fakePolisher(polish: (text: string) => Promise<string>): FakePolisher {
  const calls: string[] = [];
  return {
    calls,
    prepare: vi.fn(async () => undefined),
    polish: vi.fn(async (text: string) => {
      calls.push(text);
      return polish(text);
    }),
    unload: vi.fn(async () => undefined),
  };
}

const langs = ["zh", "en"];
const rambling = "嗯，我刚才想说的是，这个函数，这个函数的返回值有点问题。";
const rulesText = "我刚才想说的是，这个函数，这个函数的返回值有点问题。";
const never = () => new Promise<string>(() => undefined);

describe("cleanTranscript", () => {
  it("returns the recognizer text when cleanup is off", async () => {
    expect(await cleanTranscript(rambling, { mode: "off", languages: langs })).toEqual({
      text: rambling,
      cleanup: { mode: "off", applied: "off" },
    });
  });

  it("removes fillers in rules mode", async () => {
    const result = await cleanTranscript(rambling, { mode: "rules", languages: langs, detectedLanguage: "zh" });
    expect(result).toEqual({ text: rulesText, cleanup: { mode: "rules", applied: "rules" } });
  });

  it("uses an accepted local-model rewrite", async () => {
    const polisher = fakePolisher(async () => "这个函数的返回值有点问题。");
    const result = await cleanTranscript(rambling, {
      mode: "llm",
      languages: langs,
      detectedLanguage: "zh",
      polisher,
    });
    expect(result).toEqual({ text: "这个函数的返回值有点问题。", cleanup: { mode: "llm", applied: "llm" } });
  });

  it("hands the model masked text and restores protected spans", async () => {
    const polisher = fakePolisher(async (text) => text);
    const result = await cleanTranscript("嗯，好像是token过期了，帮我看一下。", {
      mode: "llm",
      languages: langs,
      detectedLanguage: "zh",
      polisher,
    });
    expect(polisher.calls[0]).toContain("⟦1⟧");
    expect(polisher.calls[0]).not.toContain("token");
    expect(result.text).toBe("好像是token过期了，帮我看一下。");
  });

  it("falls back to the rule text when the model output is rejected", async () => {
    const polisher = fakePolisher(async () => "The return value of this function is wrong.");
    const result = await cleanTranscript(rambling, { mode: "llm", languages: langs, detectedLanguage: "zh", polisher });
    expect(result).toEqual({ text: rulesText, cleanup: { mode: "llm", applied: "rules", fallback: "rejected" } });
  });

  it("reports a missing model", async () => {
    const result = await cleanTranscript(rambling, { mode: "llm", languages: langs, polisher: null });
    expect(result.cleanup).toEqual({ mode: "llm", applied: "rules", fallback: "model-missing" });
  });

  it("falls back when the model fails", async () => {
    const polisher = fakePolisher(async () => {
      throw new Error("metal device lost");
    });
    const result = await cleanTranscript(rambling, { mode: "llm", languages: langs, polisher });
    expect(result.cleanup).toEqual({ mode: "llm", applied: "rules", fallback: "failed" });
  });

  it("falls back when the model does not answer in time", async () => {
    const polisher = fakePolisher(never);
    const result = await cleanTranscript(rambling, { mode: "llm", languages: langs, polisher, timeoutMs: 20 });
    expect(result.cleanup).toEqual({ mode: "llm", applied: "rules", fallback: "timeout" });
  });

  it("rethrows caller cancellation", async () => {
    const polisher = fakePolisher(never);
    const controller = new AbortController();
    const pending = cleanTranscript(rambling, { mode: "llm", languages: langs, polisher, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("skips the model for long and very short text", async () => {
    const polisher = fakePolisher(async (text) => text);
    const long = "这个函数的返回值有点问题。".repeat(Math.ceil(MAX_POLISH_CHARS / 12) + 1);
    const longResult = await cleanTranscript(long, { mode: "llm", languages: langs, polisher });
    expect(longResult.cleanup).toEqual({ mode: "llm", applied: "rules", fallback: "too-long" });
    const shortResult = await cleanTranscript("好的。", { mode: "llm", languages: langs, polisher });
    expect(shortResult.cleanup.applied).toBe("rules");
    expect(shortResult.cleanup.fallback).toBeUndefined();
    expect(polisher.polish).not.toHaveBeenCalled();
  });
});

describe("TranscriptCleaner", () => {
  const request = { mode: "llm" as const, languages: langs, detectedLanguage: "zh" };

  it("reuses one polisher per model path and releases replaced ones", async () => {
    let modelPath: string | null = "/models/a.gguf";
    const created: FakePolisher[] = [];
    const cleaner = new TranscriptCleaner({
      resolveModelPath: () => modelPath,
      createPolisher: () => {
        const polisher = fakePolisher(async (text) => text);
        created.push(polisher);
        return polisher;
      },
    });
    await cleaner.clean(rambling, request);
    await cleaner.clean(rambling, request);
    expect(created).toHaveLength(1);
    modelPath = "/models/b.gguf";
    await cleaner.clean(rambling, request);
    expect(created).toHaveLength(2);
    expect(created[0]!.unload).toHaveBeenCalled();
    await cleaner.unload();
    expect(created[1]!.unload).toHaveBeenCalled();
  });

  it("reports a missing cleanup model", async () => {
    const cleaner = new TranscriptCleaner({ resolveModelPath: () => null });
    const result = await cleaner.clean(rambling, request);
    expect(result.cleanup).toEqual({ mode: "llm", applied: "rules", fallback: "model-missing" });
  });

  it("prewarms only in local AI mode", () => {
    const created: FakePolisher[] = [];
    const cleaner = new TranscriptCleaner({
      resolveModelPath: () => "/models/a.gguf",
      createPolisher: () => {
        const polisher = fakePolisher(async (text) => text);
        created.push(polisher);
        return polisher;
      },
    });
    cleaner.prewarm("rules");
    expect(created).toHaveLength(0);
    cleaner.prewarm("llm");
    expect(created).toHaveLength(1);
    expect(created[0]!.prepare).toHaveBeenCalledTimes(1);
  });
});
