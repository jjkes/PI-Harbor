import { describe, expect, it } from "vitest";
import { PROGRESS_SYSTEM_PROMPT, buildProgressPrompt } from "./progress-prompt.js";

describe("buildProgressPrompt", () => {
  it("builds one system message and one user message", () => {
    const context = buildProgressPrompt("DIGEST-BODY", 1_700_000_000_000);
    expect(context.systemPrompt).toContain(PROGRESS_SYSTEM_PROMPT);
    expect(context.messages).toHaveLength(1);
    const [message] = context.messages;
    expect(message?.role).toBe("user");
    expect(typeof message?.content === "string" ? message.content : "").toContain("DIGEST-BODY");
  });

  it("declares no tools, so a report can never call one", () => {
    expect(buildProgressPrompt("digest", 0).tools).toEqual([]);
  });

  it("states the fixed shape and the estimate rules", () => {
    const context = buildProgressPrompt("digest", 0);
    const [message] = context.messages;
    const text = typeof message?.content === "string" ? message.content : "";
    expect(text).toContain("\"completed\"");
    expect(text).toContain("\"inProgress\"");
    expect(text).toContain("\"next\"");
    expect(text).toContain("\"remainingSteps\"");
    expect(text).toContain("\"remainingMinutes\"");
    expect(text).toContain("\"confidence\"");
    expect(text).toContain("null when the digest does not support an estimate");
  });

  it("uses the injected clock instead of the wall clock", () => {
    const [message] = buildProgressPrompt("digest", 42).messages;
    expect(Reflect.get(message ?? {}, "timestamp")).toBe(42);
  });

  it("writes the report in the UI language and keeps the keys English", () => {
    const zh = buildProgressPrompt("digest", 0, "zh-CN");
    expect(zh.systemPrompt).toContain("Simplified Chinese (zh-CN)");
    expect(zh.systemPrompt).toContain("keep the JSON keys in English");
    expect(buildProgressPrompt("digest", 0, "zh-TW").systemPrompt).toContain("Traditional Chinese");
    expect(buildProgressPrompt("digest", 0, "ko").systemPrompt).toContain("Korean");
    // English stays the default, unchanged from before the locale existed.
    expect(buildProgressPrompt("digest", 0).systemPrompt).toContain("Write every string value in English");
  });

  it("says the answer must come only from the digest", () => {
    expect(PROGRESS_SYSTEM_PROMPT).toContain("Answer only from the digest");
    expect(PROGRESS_SYSTEM_PROMPT).toContain("Do not invent");
  });
});
