import { describe, expect, it } from "vitest";
import { unavailableSessionContext } from "./types/sessions.js";

describe("unavailableSessionContext", () => {
  it("answers a remote session whose host keeps its context", () => {
    expect(unavailableSessionContext("remote:host-1:abc")).toEqual({
      status: "unavailable", sessionId: "remote:host-1:abc", reason: "remote",
    });
  });

  it("answers an imported Pi CLI session", () => {
    expect(unavailableSessionContext("native-pi:abc")).toEqual({
      status: "unavailable", sessionId: "native-pi:abc", reason: "native",
    });
  });

  it("leaves a local session, and every id Main would reject, to the IPC call", () => {
    for (const id of [
      "local", "remote:", "remote:host", "remote::abc", "remote:host:",
      "", "   ", `native-pi:${"x".repeat(250)}`, 42, undefined, null,
    ]) {
      expect(unavailableSessionContext(id as never), String(id)).toBeNull();
    }
  });

  it("reads the trimmed id, as Main does", () => {
    expect(unavailableSessionContext("  native-pi:abc\n")?.sessionId).toBe("native-pi:abc");
  });
});
