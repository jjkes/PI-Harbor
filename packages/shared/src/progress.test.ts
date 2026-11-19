import { describe, expect, it } from "vitest";
import {
  PROGRESS_DEFAULT_INTERVAL,
  PROGRESS_INTERVALS,
  PROGRESS_LOCALES,
  clampProgressEstimate,
  clampProgressSection,
  defaultProgressSettings,
  isProgressInterval,
  normalizeProgressLocale,
  parseProgressCollectRequest,
  parseProgressModelRef,
  parseProgressSettingsPatch,
  progressAvailableFor,
} from "./progress.js";

const runId = "run_01";

describe("progressAvailableFor", () => {
  it("accepts a local desktop session", () => {
    expect(progressAvailableFor({ id: "abc" })).toBe(true);
    expect(progressAvailableFor({ id: "abc", source: "desktop" })).toBe(true);
  });

  it("fails closed for missing, remote, and native sessions", () => {
    expect(progressAvailableFor(null)).toBe(false);
    expect(progressAvailableFor(undefined)).toBe(false);
    expect(progressAvailableFor({ id: "" })).toBe(false);
    expect(progressAvailableFor({ id: "remote:abc" })).toBe(false);
    expect(progressAvailableFor({ id: "native-pi:abc" })).toBe(false);
    expect(progressAvailableFor({ id: "abc", source: "remote" })).toBe(false);
  });
});

describe("parseProgressCollectRequest", () => {
  it("copies only known fields from a valid request", () => {
    const parsed = parseProgressCollectRequest({
      sessionId: "abc",
      runId,
      trigger: "manual",
      model: { followSession: true },
      extra: "dropped",
    });
    expect(parsed).toEqual({
      ok: true,
      request: {
        sessionId: "abc",
        runId,
        trigger: "manual",
        model: { followSession: true },
        locale: "en",
      },
    });
  });

  it("accepts an explicit model pair", () => {
    const parsed = parseProgressCollectRequest({
      sessionId: "abc",
      runId,
      trigger: "auto",
      model: { providerId: "openai", modelId: "gpt-4.1-mini" },
    });
    expect(parsed).toEqual({
      ok: true,
      request: {
        sessionId: "abc",
        runId,
        trigger: "auto",
        model: { providerId: "openai", modelId: "gpt-4.1-mini" },
        locale: "en",
      },
    });
  });

  it("rejects a non-object payload", () => {
    expect(parseProgressCollectRequest(null).ok).toBe(false);
    expect(parseProgressCollectRequest("abc").ok).toBe(false);
    expect(parseProgressCollectRequest([]).ok).toBe(false);
  });

  it("rejects an empty or unsupported session id", () => {
    expect(parseProgressCollectRequest({ sessionId: "", runId, trigger: "manual" }).ok).toBe(false);
    expect(parseProgressCollectRequest({ runId, trigger: "manual" }).ok).toBe(false);
  });

  it("rejects an unknown trigger", () => {
    const parsed = parseProgressCollectRequest({
      sessionId: "abc",
      runId,
      trigger: "scheduled",
      model: { followSession: true },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("trigger must be one of");
  });

  it("rejects a malformed run id", () => {
    for (const bad of ["", "has space", "a".repeat(65), "run/id"]) {
      expect(
        parseProgressCollectRequest({
          sessionId: "abc",
          runId: bad,
          trigger: "manual",
          model: { followSession: true },
        }).ok,
      ).toBe(false);
    }
  });

  it("carries the UI language the report is written in", () => {
    const parsed = parseProgressCollectRequest({
      sessionId: "abc",
      runId,
      trigger: "manual",
      model: { followSession: true },
      locale: "zh-CN",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.request.locale).toBe("zh-CN");
  });

  it("rejects a malformed model reference", () => {
    for (const model of [
      undefined,
      null,
      {},
      { followSession: false },
      { providerId: "openai" },
      { providerId: "", modelId: "x" },
      { providerId: "openai", modelId: 7 },
    ]) {
      expect(parseProgressCollectRequest({ sessionId: "abc", runId, trigger: "manual", model }).ok).toBe(
        false,
      );
    }
  });
});

describe("normalizeProgressLocale", () => {
  it("keeps a shipped catalog tag", () => {
    for (const locale of PROGRESS_LOCALES) {
      expect(normalizeProgressLocale(locale)).toBe(locale);
    }
  });

  it("folds a region-less or differently cased tag onto its catalog", () => {
    expect(normalizeProgressLocale("zh")).toBe("zh-CN");
    expect(normalizeProgressLocale("zh-hans")).toBe("zh-CN");
    expect(normalizeProgressLocale("zh-Hant-TW")).toBe("zh-TW");
    expect(normalizeProgressLocale("zh-HK")).toBe("zh-TW");
    expect(normalizeProgressLocale("pt")).toBe("pt-BR");
    expect(normalizeProgressLocale("pt-PT")).toBe("pt-BR");
    expect(normalizeProgressLocale("de-AT")).toBe("de");
    expect(normalizeProgressLocale("EN")).toBe("en");
  });

  it("never blocks a request on an unknown tag", () => {
    expect(normalizeProgressLocale("kl-GL")).toBe("en");
    expect(normalizeProgressLocale("")).toBe("en");
    expect(normalizeProgressLocale(undefined)).toBe("en");
    expect(normalizeProgressLocale(7)).toBe("en");
  });
});

describe("parseProgressModelRef", () => {
  it("normalizes followSession strictly to true", () => {
    expect(parseProgressModelRef({ followSession: true })).toEqual({ followSession: true });
    expect(parseProgressModelRef({ followSession: 1 })).toBeNull();
  });
});

describe("parseProgressSettingsPatch", () => {
  it("keeps a valid patch", () => {
    expect(
      parseProgressSettingsPatch({
        model: { providerId: "openai", modelId: "gpt-4.1-mini" },
        autoEnabled: true,
        intervalMinutes: 5,
        consecutiveFailures: 0,
      }),
    ).toEqual({
      ok: true,
      patch: {
        model: { providerId: "openai", modelId: "gpt-4.1-mini" },
        autoEnabled: true,
        intervalMinutes: 5,
        consecutiveFailures: 0,
      },
    });
  });

  it("accepts an explicit null lastCollectedAt", () => {
    expect(parseProgressSettingsPatch({ lastCollectedAt: null })).toEqual({
      ok: true,
      patch: { lastCollectedAt: null },
    });
  });

  it("refuses an interval the popover cannot render", () => {
    for (const intervalMinutes of [0, 2, 7, 60, "5", null]) {
      const parsed = parseProgressSettingsPatch({ intervalMinutes });
      expect(parsed.ok).toBe(false);
    }
    for (const intervalMinutes of PROGRESS_INTERVALS) {
      expect(parseProgressSettingsPatch({ intervalMinutes }).ok).toBe(true);
    }
  });

  it("refuses wrong primitive types", () => {
    expect(parseProgressSettingsPatch({ autoEnabled: "yes" }).ok).toBe(false);
    expect(parseProgressSettingsPatch({ consecutiveFailures: -1 }).ok).toBe(false);
    expect(parseProgressSettingsPatch({ consecutiveFailures: 1.5 }).ok).toBe(false);
    expect(parseProgressSettingsPatch({ lastCollectedAt: "now" }).ok).toBe(false);
    expect(parseProgressSettingsPatch(null).ok).toBe(false);
  });
});

describe("isProgressInterval", () => {
  it("matches only the presets", () => {
    expect(PROGRESS_INTERVALS).toEqual([1, 3, 5, 10, 15, 30]);
    expect(isProgressInterval(PROGRESS_DEFAULT_INTERVAL)).toBe(true);
    expect(isProgressInterval(2)).toBe(false);
    expect(isProgressInterval("5")).toBe(false);
  });
});

describe("defaultProgressSettings", () => {
  it("is auto-off, follows the session model, and uses the default interval", () => {
    expect(defaultProgressSettings("abc")).toEqual({
      sessionId: "abc",
      model: { followSession: true },
      autoEnabled: false,
      intervalMinutes: PROGRESS_DEFAULT_INTERVAL,
      lastCollectedAt: null,
      consecutiveFailures: 0,
      updatedAt: 0,
    });
  });
});

describe("clampProgressSection", () => {
  it("caps the list and drops non-string items", () => {
    expect(clampProgressSection(["a", 1, null, " b ", ""], 8)).toEqual(["a", "b"]);
    expect(clampProgressSection(["a", "b", "c"], 2)).toEqual(["a", "b"]);
    expect(clampProgressSection("nope", 3)).toEqual([]);
    expect(clampProgressSection(undefined, 3)).toEqual([]);
  });
});

describe("clampProgressEstimate", () => {
  it("clamps to the range and coerces numeric strings", () => {
    expect(clampProgressEstimate(4, 99)).toBe(4);
    expect(clampProgressEstimate("4", 99)).toBe(4);
    expect(clampProgressEstimate(4.6, 99)).toBe(5);
    expect(clampProgressEstimate(-3, 99)).toBe(0);
    expect(clampProgressEstimate(1_000, 99)).toBe(99);
  });

  it("returns null when no estimate was given", () => {
    expect(clampProgressEstimate(null, 99)).toBeNull();
    expect(clampProgressEstimate(undefined, 99)).toBeNull();
    expect(clampProgressEstimate("soon", 99)).toBeNull();
    expect(clampProgressEstimate(Number.POSITIVE_INFINITY, 99)).toBeNull();
  });
});
