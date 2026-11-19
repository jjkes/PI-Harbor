import { describe, expect, it } from "vitest";
import { resolveProgressModelRef, type ProgressModelLookup } from "./progress-model.js";

function lookup(overrides: Partial<ProgressModelLookup> = {}): ProgressModelLookup {
  return {
    providerExists: (providerId) => providerId === "openai",
    modelIds: (providerId) => (providerId === "openai" ? ["gpt-4.1-mini", "gpt-4.1"] : []),
    hasCredential: () => true,
    ...overrides,
  };
}

describe("resolveProgressModelRef", () => {
  it("follows the session model by default", () => {
    expect(
      resolveProgressModelRef(
        { followSession: true },
        { providerId: "openai", modelId: "gpt-4.1-mini" },
        lookup(),
      ),
    ).toEqual({ ok: true, providerId: "openai", modelId: "gpt-4.1-mini" });
  });

  it("fails when the session has no model", () => {
    const resolved = resolveProgressModelRef({ followSession: true }, {}, lookup());
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe("PROGRESS_MODEL_UNAVAILABLE");
      expect(resolved.message).toContain("no model");
    }
  });

  it("accepts an explicit pair that exists in the catalog", () => {
    expect(
      resolveProgressModelRef({ providerId: "openai", modelId: "gpt-4.1" }, {}, lookup()),
    ).toEqual({ ok: true, providerId: "openai", modelId: "gpt-4.1" });
  });

  it("fails before the request when the provider was removed", () => {
    const resolved = resolveProgressModelRef(
      { providerId: "anthropic", modelId: "claude" },
      {},
      lookup(),
    );
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain("was removed");
  });

  it("fails when the provider does not offer the model", () => {
    const resolved = resolveProgressModelRef({ providerId: "openai", modelId: "gpt-9" }, {}, lookup());
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain("is not offered");
  });

  it("fails when no credential is configured", () => {
    const resolved = resolveProgressModelRef(
      { providerId: "openai", modelId: "gpt-4.1-mini" },
      {},
      lookup({ hasCredential: () => false }),
    );
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain("no credential");
  });

  it("checks the session pair through the same catalog rules", () => {
    const resolved = resolveProgressModelRef(
      { followSession: true },
      { providerId: "openai", modelId: "gpt-4.1-mini" },
      lookup({ hasCredential: () => false }),
    );
    expect(resolved.ok).toBe(false);
  });
});
