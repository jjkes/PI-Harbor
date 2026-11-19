import { describe, expect, it } from "vitest";
import {
  PROGRESS_COMPLETED_MAX,
  PROGRESS_MINUTES_MAX,
  PROGRESS_RAW_MAX_CHARS,
  PROGRESS_STEPS_MAX,
} from "@pi-harbor/shared";
import { parseProgressReport } from "./progress-parse.js";

const valid = {
  completed: ["Read the design", "Wrote the shared contract"],
  inProgress: ["Wiring the host tables"],
  next: ["Electron main handler"],
  remainingSteps: 4,
  remainingMinutes: 18,
  confidence: "medium",
};

describe("parseProgressReport", () => {
  it("parses a plain JSON answer", () => {
    const parsed = parseProgressReport(JSON.stringify(valid));
    expect(parsed).toEqual({ status: "ok", body: valid });
  });

  it("strips a Markdown code fence", () => {
    const parsed = parseProgressReport("```json\n" + JSON.stringify(valid) + "\n```");
    expect(parsed.status).toBe("ok");
  });

  it("ignores prose around the object", () => {
    const parsed = parseProgressReport(`Sure! Here is the report:\n${JSON.stringify(valid)}\nHope it helps.`);
    expect(parsed.status).toBe("ok");
  });

  it("accepts numeric strings and clamps them to the range", () => {
    const parsed = parseProgressReport(
      JSON.stringify({ ...valid, remainingSteps: "9", remainingMinutes: String(PROGRESS_MINUTES_MAX * 4) }),
    );
    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok") {
      expect(parsed.body.remainingSteps).toBe(9);
      expect(parsed.body.remainingMinutes).toBe(PROGRESS_MINUTES_MAX);
    }
  });

  it("accepts missing arrays as empty and null estimates", () => {
    const parsed = parseProgressReport(JSON.stringify({ completed: ["only completed"] }));
    expect(parsed).toEqual({
      status: "ok",
      body: {
        completed: ["only completed"],
        inProgress: [],
        next: [],
        remainingSteps: null,
        remainingMinutes: null,
        confidence: null,
      },
    });
  });

  it("clamps every list to its cap and drops non-string items", () => {
    const parsed = parseProgressReport(
      JSON.stringify({
        completed: Array.from({ length: 20 }, (_, index) => `done ${index}`),
        inProgress: ["a", 1, null, "b", "c", "d"],
        next: { nope: true },
        remainingSteps: 1_000,
        confidence: "certain",
      }),
    );
    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok") {
      expect(parsed.body.completed).toHaveLength(PROGRESS_COMPLETED_MAX);
      expect(parsed.body.inProgress).toEqual(["a", "b", "c"]);
      expect(parsed.body.next).toEqual([]);
      expect(parsed.body.remainingSteps).toBe(PROGRESS_STEPS_MAX);
      expect(parsed.body.confidence).toBeNull();
    }
  });

  it("marks an answer without either array as unparsed", () => {
    const parsed = parseProgressReport('{"answer": "everything looks fine"}');
    expect(parsed.status).toBe("unparsed");
  });

  it("keeps the raw text when there is no JSON at all", () => {
    const raw = "I cannot see the transcript, sorry.";
    expect(parseProgressReport(raw)).toEqual({ status: "unparsed", raw });
  });

  it("keeps the raw text when the JSON is broken", () => {
    expect(parseProgressReport('{"completed": ["a",').status).toBe("unparsed");
  });

  it("caps the raw fallback", () => {
    const parsed = parseProgressReport("x".repeat(PROGRESS_RAW_MAX_CHARS * 3));
    expect(parsed.status).toBe("unparsed");
    if (parsed.status === "unparsed") expect(parsed.raw).toHaveLength(PROGRESS_RAW_MAX_CHARS);
  });

  it("never throws on hostile input", () => {
    for (const value of ["", "   ", "null", "[]", "{}", "{}{}", "🦄", '{"completed": {"a": 1}}']) {
      expect(() => parseProgressReport(value)).not.toThrow();
    }
    expect(parseProgressReport("null").status).toBe("unparsed");
    expect(parseProgressReport("[]").status).toBe("unparsed");
    expect(parseProgressReport("{}").status).toBe("unparsed");
  });

  it("renders text as plain data, never as markup", () => {
    const parsed = parseProgressReport(
      JSON.stringify({ completed: ["<script>alert(1)</script>"], inProgress: [] }),
    );
    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok") expect(parsed.body.completed[0]).toBe("<script>alert(1)</script>");
  });
});
