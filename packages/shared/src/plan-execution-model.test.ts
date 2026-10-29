import { describe, expect, it } from "vitest";
import { normalizePlanExecutionModel } from "./plan-execution-model.js";

describe("normalizePlanExecutionModel", () => {
  it("accepts and trims a complete target", () => {
    expect(normalizePlanExecutionModel({
      providerId: "  provider-a  ",
      modelId: "  model-b  ",
      thinkingLevel: "high",
    })).toEqual({ providerId: "provider-a", modelId: "model-b", thinkingLevel: "high" });
  });

  it("accepts a target without a thinking level and treats null as absent", () => {
    expect(normalizePlanExecutionModel({ providerId: "p", modelId: "m" })).toEqual({
      providerId: "p",
      modelId: "m",
    });
    expect(normalizePlanExecutionModel(undefined)).toBeNull();
    expect(normalizePlanExecutionModel(null)).toBeNull();
  });

  it("rejects blank ids and malformed containers", () => {
    for (const value of [
      {},
      [],
      "provider/model",
      { providerId: " ", modelId: "model" },
      { providerId: "provider", modelId: "\n" },
      { providerId: 1, modelId: "model" },
      { providerId: "provider", modelId: null },
    ]) {
      expect(normalizePlanExecutionModel(value)).toBeNull();
    }
  });

  it("rejects unknown or null thinking levels", () => {
    for (const thinkingLevel of ["turbo", "", null, 1, true]) {
      expect(normalizePlanExecutionModel({
        providerId: "provider",
        modelId: "model",
        thinkingLevel,
      })).toBeNull();
    }
  });
});
