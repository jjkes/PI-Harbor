import { describe, expect, it } from "vitest";
import {
  BTW_HISTORY_MAX_CHARS,
  BTW_HISTORY_MAX_TURNS,
  BTW_QUESTION_MAX_CHARS,
  boundedBtwHistory,
  btwAvailableFor,
  parseBtwAskRequest,
} from "./btw.js";
import { ErrorCodes } from "./errors.js";
import { IPC, IPC_WHITELIST } from "./protocol.js";

describe("btwAvailableFor", () => {
  it("admits local desktop sessions, including older hosts that omit the source", () => {
    expect(btwAvailableFor({ id: "s1", source: "desktop" })).toBe(true);
    expect(btwAvailableFor({ id: "s1" })).toBe(true);
  });

  it("fails closed on remote, Pi-native, and missing sessions", () => {
    expect(btwAvailableFor({ id: "s1", source: "remote" })).toBe(false);
    expect(btwAvailableFor({ id: "s1", source: "pi-native" })).toBe(false);
    expect(btwAvailableFor({ id: "remote:host:s1", source: "desktop" })).toBe(false);
    expect(btwAvailableFor({ id: "native-pi:abc" })).toBe(false);
    expect(btwAvailableFor({ id: "" })).toBe(false);
    expect(btwAvailableFor(undefined)).toBe(false);
    expect(btwAvailableFor(null)).toBe(false);
  });
});

describe("parseBtwAskRequest", () => {
  const valid = {
    sessionId: "s1",
    runId: "0f8c2a3e-1b2c-4d5e-8f90-123456789abc",
    question: "What changed?",
    history: [],
  };

  it("accepts a well-formed request and copies only known fields", () => {
    const parsed = parseBtwAskRequest({
      ...valid,
      history: [{ question: "q", answer: "a", extra: 1 }],
      extra: true,
    });
    expect(parsed).toEqual({
      ok: true,
      request: { ...valid, history: [{ question: "q", answer: "a" }] },
    });
  });

  it.each([
    ["a non-object", null],
    ["a missing session", { ...valid, sessionId: "" }],
    ["a run id that is unsafe in a tool-call id", { ...valid, runId: "btw:1/2" }],
    ["a blank question", { ...valid, question: "   " }],
    ["an oversized question", { ...valid, question: "x".repeat(BTW_QUESTION_MAX_CHARS + 1) }],
    [
      "too many turns",
      {
        ...valid,
        history: Array.from({ length: BTW_HISTORY_MAX_TURNS + 1 }, () => ({ question: "q", answer: "a" })),
      },
    ],
    ["an oversized history", { ...valid, history: [{ question: "q", answer: "x".repeat(BTW_HISTORY_MAX_CHARS) }] }],
    ["a malformed turn", { ...valid, history: [{ question: "q" }] }],
  ])("rejects %s", (_label, value) => {
    expect(parseBtwAskRequest(value).ok).toBe(false);
  });
});

describe("boundedBtwHistory", () => {
  it("keeps the newest contiguous turns within the turn limit", () => {
    const turns = Array.from({ length: BTW_HISTORY_MAX_TURNS + 5 }, (_, index) => ({
      question: `q${index}`,
      answer: "a",
    }));
    const bounded = boundedBtwHistory(turns);
    expect(bounded).toHaveLength(BTW_HISTORY_MAX_TURNS);
    expect(bounded[0]?.question).toBe("q5");
    expect(bounded.at(-1)?.question).toBe(`q${BTW_HISTORY_MAX_TURNS + 4}`);
    expect(parseBtwAskRequest({ sessionId: "s", runId: "r", question: "q", history: bounded }).ok).toBe(true);
  });

  it("drops older turns once the character budget is spent", () => {
    const big = { question: "old", answer: "x".repeat(BTW_HISTORY_MAX_CHARS - 10) };
    const recent = { question: "new", answer: "short answer" };
    expect(boundedBtwHistory([big, recent])).toEqual([recent]);
  });
});

describe("BTW contract", () => {
  it("uses its own IPC channels, all preload-whitelisted", () => {
    expect(IPC.invoke.btwAsk).toBe("pi-harbor/btw/ask");
    expect(IPC.invoke.btwAbort).toBe("pi-harbor/btw/abort");
    expect(IPC.event.btwMessage).toBe("pi-harbor/btw/event/message");
    expect(IPC.event.btwMessage).not.toBe(IPC.event.agentMessage);
    for (const channel of [IPC.invoke.btwAsk, IPC.invoke.btwAbort, IPC.event.btwMessage]) {
      expect(IPC_WHITELIST.has(channel)).toBe(true);
    }
  });

  it("names the read-only profile denials exactly as host-core emits them", () => {
    expect(ErrorCodes.TOOL_DISABLED_IN_READ_ONLY).toBe("TOOL_DISABLED_IN_READ_ONLY");
    expect(ErrorCodes.EXTERNAL_PATH_DISABLED_IN_READ_ONLY).toBe("EXTERNAL_PATH_DISABLED_IN_READ_ONLY");
    expect(ErrorCodes.BTW_TOOL_BUDGET_EXHAUSTED).toBe("BTW_TOOL_BUDGET_EXHAUSTED");
  });
});
