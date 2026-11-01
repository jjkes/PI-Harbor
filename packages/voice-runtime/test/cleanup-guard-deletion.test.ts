import { describe, expect, it } from "vitest";
import { acceptPolished, hasSelfCorrection } from "../src/cleanup/guard.js";
import { maskProtectedSpans, type MaskedText } from "../src/cleanup/protect.js";
import { POLISH_EXAMPLES } from "../src/cleanup/prompt.js";

function mask(text: string): MaskedText {
  const masked = maskProtectedSpans(text);
  if (!masked) throw new Error("reserved characters in fixture");
  return masked;
}

describe("acceptPolished keeps cleanup to deletions", () => {
  const deploy = "Deploy to staging first, sorry, I mean production, and then notify the team.";

  it("rejects a rewrite that swaps the retracted and the corrected words", () => {
    // Regression: Qwen3-1.7B returned these two targets swapped, inverting the request.
    expect(
      acceptPolished(
        "Deploy to production first, sorry, I mean staging, and then notify the team.",
        mask(deploy),
        true,
      ),
    ).toEqual({ ok: false, reason: "not-a-deletion" });
  });

  it("accepts a correction resolved by deleting the retracted words", () => {
    expect(acceptPolished("Deploy to production, and then notify the team.", mask(deploy), true)).toEqual({
      ok: true,
      text: "Deploy to production, and then notify the team.",
    });
  });

  it("rejects moved or added words even when the meaning looks close", () => {
    const source = mask("Use Redis for the cache, no wait, actually use Postgres.");
    expect(acceptPolished("Use Postgres for the cache.", source, true).ok).toBe(false);
  });

  it("rejects a deletion that drops a negation", () => {
    expect(
      acceptPolished(
        "Delete the old migration, just rename it.",
        mask("Don't delete the old migration, just rename it."),
        false,
      ),
    ).toEqual({ ok: false, reason: "dropped-negation" });
    expect(acceptPolished("把旧的迁移删掉，改个名字就行。", mask("别把旧的迁移删掉，改个名字就行。"), false)).toEqual({
      ok: false,
      reason: "dropped-negation",
    });
  });

  it("allows deleting a self-correction cue that contains a negation", () => {
    expect(acceptPolished("把超时改成⟦2⟧秒。", mask("把超时改成5秒，不对，改成10秒。"), true)).toEqual({
      ok: true,
      text: "把超时改成10秒。",
    });
  });

  it("every prompt example is itself an accepted deletion", () => {
    for (const example of POLISH_EXAMPLES) {
      const count = Math.max(
        0,
        ...Array.from(example.input.matchAll(/⟦(\d+)⟧/g), (match) => Number(match[1])),
      );
      const masked: MaskedText = {
        text: example.input,
        spans: Array.from({ length: count }, (_, index) => `span${index + 1}`),
      };
      expect(acceptPolished(example.output, masked, hasSelfCorrection(example.input)).ok, example.input).toBe(true);
    }
  });
});
