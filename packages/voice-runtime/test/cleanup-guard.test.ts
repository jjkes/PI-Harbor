import { describe, expect, it } from "vitest";
import { acceptPolished, hasSelfCorrection } from "../src/cleanup/guard.js";
import { maskProtectedSpans, restoreProtectedSpans } from "../src/cleanup/protect.js";

describe("maskProtectedSpans", () => {
  it("masks Latin terms inside Chinese text and round-trips", () => {
    const text = "请帮我在voice service里面加一个dispose方法，然后跑一下PNPM test。";
    const masked = maskProtectedSpans(text);
    expect(masked).not.toBeNull();
    expect(masked!.text).not.toMatch(/[A-Za-z]/);
    expect(masked!.spans).toEqual(expect.arrayContaining(["dispose"]));
    expect(restoreProtectedSpans(masked!.text, masked!.spans)).toBe(text);
  });

  it("masks code-like spans in English and leaves prose", () => {
    const text = "Rename getUserName in src/auth/login.ts to fetchUser and set the timeout to 10ms.";
    const masked = maskProtectedSpans(text)!;
    expect(masked.text).toContain("Rename");
    expect(masked.text).toContain("timeout");
    for (const span of ["getUserName", "src/auth/login.ts", "fetchUser"]) {
      expect(masked.spans).toContain(span);
      expect(masked.text).not.toContain(span);
    }
    expect(restoreProtectedSpans(masked.text, masked.spans)).toBe(text);
  });

  it("masks numbers", () => {
    const text = "把超时改成5秒，然后重试3次。";
    const masked = maskProtectedSpans(text)!;
    expect(masked.text.replace(/⟦\d+⟧/g, "")).not.toMatch(/\d/);
    expect(restoreProtectedSpans(masked.text, masked.spans)).toBe(text);
  });

  it("refuses text that already contains placeholder brackets", () => {
    expect(maskProtectedSpans("已经有⟦1⟧了")).toBeNull();
  });
});

describe("acceptPolished", () => {
  const masked = { text: "嗯我想让你看一下登录页面的报错，好像是⟦1⟧过期了。", spans: ["token"] };

  it("accepts a faithful rewrite and restores spans", () => {
    expect(acceptPolished("我想让你看一下登录页面的报错，好像是⟦1⟧过期了。", masked, false)).toEqual({
      ok: true,
      text: "我想让你看一下登录页面的报错，好像是token过期了。",
    });
  });

  it("rejects a dropped placeholder unless the speaker corrected themselves", () => {
    const correction = { text: "把超时改成⟦1⟧秒，不对，改成⟦2⟧秒。", spans: ["5", "10"] };
    expect(acceptPolished("把超时改成⟦2⟧秒。", correction, false).ok).toBe(false);
    expect(acceptPolished("把超时改成⟦2⟧秒。", correction, true)).toEqual({
      ok: true,
      text: "把超时改成10秒。",
    });
  });

  it("rejects duplicated or invented placeholders", () => {
    expect(acceptPolished("好像是⟦1⟧和⟦1⟧过期了。", masked, false).ok).toBe(false);
    expect(acceptPolished("好像是⟦2⟧过期了。", masked, true).ok).toBe(false);
  });

  it("rejects a translation", () => {
    expect(
      acceptPolished("Please look at the login page error, the ⟦1⟧ seems expired.", masked, false).ok,
    ).toBe(false);
  });

  it("rejects an answer instead of a rewrite", () => {
    const question = { text: "为什么构建一直失败？", spans: [] };
    const answer =
      "构建失败通常有几个原因：依赖版本冲突、缓存损坏、环境变量缺失或者测试用例超时。你可以先清理缓存，再重新安装依赖，然后逐个排查失败的测试用例，最后检查持续集成的日志输出。";
    expect(acceptPolished(answer, question, false).ok).toBe(false);
  });

  it("strips an empty think block, rejects a stray think tag", () => {
    expect(
      acceptPolished("<think>\n\n</think>\n\n我想让你看一下登录页面的报错，好像是⟦1⟧过期了。", masked, false),
    ).toEqual({ ok: true, text: "我想让你看一下登录页面的报错，好像是token过期了。" });
    expect(acceptPolished("<think>我想让你看一下⟦1⟧", masked, false).ok).toBe(false);
  });
});

describe("hasSelfCorrection", () => {
  it("detects correction cues", () => {
    expect(hasSelfCorrection("改成5秒，不对，改成10秒")).toBe(true);
    expect(hasSelfCorrection("Use Redis, actually use Postgres")).toBe(true);
    expect(hasSelfCorrection("帮我看一下这个函数")).toBe(false);
  });
});
