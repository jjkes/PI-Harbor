import { describe, expect, it } from "vitest";
import {
  isRemoteSessionId,
  makeRemoteSessionId,
  parseRemoteSessionId,
} from "./remote-session-id.js";

describe("remote session ids", () => {
  it("round-trips a host key and session id", () => {
    const id = makeRemoteSessionId("host-1", "sess:with:colons");
    expect(id).toBe("remote:host-1:sess:with:colons");
    expect(isRemoteSessionId(id)).toBe(true);
    expect(parseRemoteSessionId(id)).toEqual({ hostKey: "host-1", hostSessionId: "sess:with:colons" });
  });

  it("rejects a host key that would split the id", () => {
    expect(() => makeRemoteSessionId("host:1", "s")).toThrow(/must not contain/);
  });

  it("declines ids that are not a complete remote session id", () => {
    for (const id of ["remote:", "remote:host", "remote::session", "remote:host:", "local", "native-pi:x"]) {
      expect(parseRemoteSessionId(id), id).toBeNull();
    }
    expect(isRemoteSessionId("REMOTE:host:session")).toBe(false);
    expect(isRemoteSessionId(undefined)).toBe(false);
  });
});
