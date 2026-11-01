import { describe, expect, it } from "vitest";
import {
  CLEANUP_MODEL_ID,
  findModel,
  getCatalog,
  getCleanupModel,
  getRecommendedModel,
  getTranscriptionModels,
} from "../src/model-catalog.js";

describe("getCatalog", () => {
  it("returns a non-empty array", () => {
    expect(getCatalog().length).toBeGreaterThan(0);
  });

  it("pins every entry to a GGUF file and its SHA-256", () => {
    const ids = new Set<string>();
    for (const model of getCatalog()) {
      expect(model.id).toBeTruthy();
      expect(model.name).toBeTruthy();
      expect(["transcription", "cleanup"]).toContain(model.kind);
      expect(model.languages.length).toBeGreaterThan(0);
      expect(model.sizeBytes).toBeGreaterThan(0);
      expect(model.hfRepo).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(model.hfFilename).toMatch(/\.gguf$/);
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(ids.has(model.id)).toBe(false);
      ids.add(model.id);
    }
  });
});

describe("findModel", () => {
  it("finds a known model", () => {
    const model = findModel("whisper-large-v3-turbo");
    expect(model).toBeDefined();
    expect(model!.name).toContain("Whisper");
  });

  it("returns undefined for unknown model", () => {
    expect(findModel("nonexistent")).toBeUndefined();
  });
});

describe("model kinds", () => {
  it("has exactly one cleanup model", () => {
    expect(getCatalog().filter((model) => model.kind === "cleanup").map((model) => model.id)).toEqual([
      CLEANUP_MODEL_ID,
    ]);
    expect(getCleanupModel().id).toBe(CLEANUP_MODEL_ID);
  });

  it("never offers the cleanup model for transcription", () => {
    expect(getTranscriptionModels().every((model) => model.kind === "transcription")).toBe(true);
    expect(getRecommendedModel([CLEANUP_MODEL_ID]).kind).toBe("transcription");
  });
});

describe("getRecommendedModel", () => {
  it("recommends SenseVoice Small for Chinese and English", () => {
    const model = getRecommendedModel(["zh", "en"]);
    expect(model.id).toBe("sensevoice-small");
    expect(model.recommended).toBe(true);
  });

  it("recommends a multilingual model for other languages", () => {
    expect(getRecommendedModel(["de"]).id).toBe("whisper-large-v3-turbo");
  });

  it("always returns a transcription model", () => {
    expect(getRecommendedModel(["xx"]).kind).toBe("transcription");
  });
});
