import { describe, expect, it } from "vitest";
import { fillerRulesFor, removeFillers } from "../src/cleanup/fillers.js";

const zh = { zh: true, en: false };
const en = { zh: false, en: true };

describe("fillerRulesFor", () => {
  it("prefers the language the recognizer detected", () => {
    expect(fillerRulesFor(["zh", "en"], "zh")).toEqual({ zh: true, en: false });
    expect(fillerRulesFor(["zh", "en"], "en")).toEqual({ zh: false, en: true });
  });

  it("falls back to the selected languages", () => {
    expect(fillerRulesFor(["zh-CN", "en"])).toEqual({ zh: true, en: true });
    expect(fillerRulesFor(["de"])).toEqual({ zh: false, en: false });
  });

  it("applies both rule sets when nothing is known", () => {
    expect(fillerRulesFor([])).toEqual({ zh: true, en: true });
  });
});

describe("removeFillers (Chinese)", () => {
  it("removes hesitations and a leading 那个 before a pronoun", () => {
    expect(
      removeFillers(
        "嗯，那个我想让你帮我看一下，就是登录页面的那个报错，呃，好像是token过期了。",
        zh,
      ),
    ).toBe("我想让你帮我看一下，就是登录页面的那个报错，好像是token过期了。");
  });

  it("collapses stutters and repeated connectors", () => {
    expect(removeFillers("我我我想改一下，然后然后跑测试。", zh)).toBe("我想改一下，然后跑测试。");
    expect(removeFillers("我，我想用这个方案。", zh)).toBe("我想用这个方案。");
  });

  it("drops a filler standing alone between pauses", () => {
    expect(removeFillers("我觉得，这个，挺好的。", zh)).toBe("我觉得，挺好的。");
  });

  it("keeps self-corrections and words that only look like fillers", () => {
    const corrected = "把超时改成5秒，不对，改成10秒，然后重试3次。";
    expect(removeFillers(corrected, zh)).toBe(corrected);
    expect(removeFillers("金额不对，额度也不够。", zh)).toBe("金额不对，额度也不够。");
    expect(removeFillers("选那个我们之前讨论过的方案。", zh)).toBe("选那个我们之前讨论过的方案。");
  });

  it("returns an empty string for a pure hesitation", () => {
    expect(removeFillers("嗯。", zh)).toBe("");
  });
});

describe("removeFillers (English)", () => {
  it("removes filler sounds and a comma-bounded you know", () => {
    expect(
      removeFillers(
        "So basically, I want you to, uh, rename the function and, you know, update the tests.",
        en,
      ),
    ).toBe("So basically, I want you to rename the function and update the tests.");
  });

  it("restores the capital after a leading filler", () => {
    expect(removeFillers("Um, so we should ship it.", en)).toBe("So we should ship it.");
  });

  it("collapses stutters", () => {
    expect(removeFillers("I I I think the the build is fine.", en)).toBe("I think the build is fine.");
  });

  it("leaves words that only contain filler sounds", () => {
    const text = "Hum the drum part for Ahmed, then ask do you know where the config is?";
    expect(removeFillers(text, en)).toBe(text);
  });
});

describe("removeFillers (rule selection)", () => {
  it("does not apply English rules to other languages", () => {
    const text = "Wir treffen uns um 10 Uhr.";
    expect(removeFillers(text, { zh: false, en: false })).toBe(text);
  });

  it("leaves text without fillers untouched", () => {
    const text = "请帮我在 voice service 里面加一个 dispose 方法。";
    expect(removeFillers(text, { zh: true, en: true })).toBe(text);
  });
});
