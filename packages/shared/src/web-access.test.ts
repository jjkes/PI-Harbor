import { describe, expect, it } from "vitest";
import {
  decodeWireValue,
  encodeWireValue,
  validateWebAccessInput,
  WEB_ACCESS_PASSWORD_MIN_LENGTH,
  type WebAccessConfigureInput,
} from "./web-access.js";

function roundTrip(value: unknown): unknown {
  return decodeWireValue(JSON.parse(JSON.stringify(encodeWireValue(value))));
}

describe("web access wire codec", () => {
  it("keeps what structured clone keeps", () => {
    const decoded = roundTrip({
      missing: undefined,
      list: [1, undefined, null],
      nan: Number.NaN,
      infinity: Number.POSITIVE_INFINITY,
      when: new Date(0),
      map: new Map([["a", 1]]),
      set: new Set(["x"]),
    }) as Record<string, unknown>;
    expect(Object.hasOwn(decoded, "missing")).toBe(true);
    expect(decoded.missing).toBeUndefined();
    expect(decoded.list).toEqual([1, undefined, null]);
    expect(decoded.nan).toBeNaN();
    expect(decoded.infinity).toBe(Number.POSITIVE_INFINITY);
    expect(decoded.when).toEqual(new Date(0));
    expect(decoded.map).toEqual(new Map([["a", 1]]));
    expect(decoded.set).toEqual(new Set(["x"]));
  });

  it("carries binary data", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 300]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37) % 256);
      expect(roundTrip(bytes)).toEqual(bytes);
    }
    const floats = new Float32Array([1.5, -2]);
    expect(roundTrip(floats)).toEqual(floats);
    const buffer = new Uint8Array([9, 8, 7]).buffer;
    expect(new Uint8Array(roundTrip(buffer) as ArrayBuffer)).toEqual(new Uint8Array([9, 8, 7]));
    // A view carries only its own bytes, not the whole backing buffer.
    expect(roundTrip(new Uint8Array([1, 2, 3, 4]).subarray(1, 3))).toEqual(new Uint8Array([2, 3]));
  });

  it("keeps error messages", () => {
    const decoded = roundTrip(new TypeError("boom"));
    expect(decoded).toBeInstanceOf(Error);
    expect((decoded as Error).message).toBe("boom");
  });

  it("rejects what structured clone rejects", () => {
    expect(() => encodeWireValue({ run: () => 1 })).toThrow();
    expect(() => encodeWireValue(Symbol("s"))).toThrow();
    expect(() => encodeWireValue(1n)).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeWireValue(cyclic)).toThrow();
  });

  it("keeps a shared reference that is not a cycle", () => {
    const shared = { a: 1 };
    expect(roundTrip({ left: shared, right: shared })).toEqual({ left: { a: 1 }, right: { a: 1 } });
  });

  it("does not let a payload reach Object.prototype", () => {
    const decoded = decodeWireValue(JSON.parse('{"__proto__":{"polluted":true}}')) as object;
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("round-trips an object that uses the tag key itself", () => {
    expect(roundTrip({ $pw: "literal", other: 1 })).toEqual({ $pw: "literal", other: 1 });
  });
});

describe("validateWebAccessInput", () => {
  const base: WebAccessConfigureInput = {
    enabled: true,
    bind: "all",
    port: 39321,
    username: "owner",
    password: "a".repeat(WEB_ACCESS_PASSWORD_MIN_LENGTH),
    tls: { mode: "self-signed" },
  };

  it("accepts a complete configuration", () => {
    expect(validateWebAccessInput(base, false)).toBeNull();
  });

  it("requires a password only until one is stored", () => {
    expect(validateWebAccessInput({ ...base, password: "" }, false)).toBe("passwordRequired");
    expect(validateWebAccessInput({ ...base, password: "" }, true)).toBeNull();
  });

  it("checks the port, username, password length, and certificate paths", () => {
    expect(validateWebAccessInput({ ...base, port: 80 }, true)).toBe("port");
    expect(validateWebAccessInput({ ...base, port: 1.5 }, true)).toBe("port");
    expect(validateWebAccessInput({ ...base, username: " " }, true)).toBe("usernameRequired");
    expect(validateWebAccessInput({ ...base, username: "a\nb" }, true)).toBe("usernameInvalid");
    expect(validateWebAccessInput({ ...base, password: "short" }, true)).toBe("passwordLength");
    expect(
      validateWebAccessInput({ ...base, tls: { mode: "custom", keyPath: "/k" } }, true),
    ).toBe("certPathRequired");
    expect(
      validateWebAccessInput({ ...base, tls: { mode: "custom", certPath: "/c" } }, true),
    ).toBe("keyPathRequired");
  });

  it("lets the owner turn web access off without credentials", () => {
    expect(
      validateWebAccessInput({ ...base, enabled: false, username: "", password: "" }, false),
    ).toBeNull();
  });
});
