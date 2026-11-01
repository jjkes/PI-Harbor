/**
 * Browser web access (ADR 0342).
 *
 * The desktop renderer can be served over HTTPS to a browser that signs in
 * with the owner's username and password. The page then installs a
 * replacement for the Electron preload bridge that carries the same
 * `invoke` / `on` semantics over one WebSocket. This module holds the
 * contract both ends share: the status and configuration shapes, input
 * validation, the routes, and the wire codec that stands in for Electron's
 * structured clone.
 */

export type WebAccessBind = "loopback" | "all";
export type WebAccessTlsMode = "self-signed" | "custom";
export type WebAccessState = "disabled" | "starting" | "running" | "error";

export const WEB_ACCESS_DEFAULT_PORT = 39321;
export const WEB_ACCESS_MIN_PORT = 1024;
export const WEB_ACCESS_MAX_PORT = 65535;
export const WEB_ACCESS_USERNAME_MAX_LENGTH = 64;
export const WEB_ACCESS_PASSWORD_MIN_LENGTH = 10;
export const WEB_ACCESS_PASSWORD_MAX_LENGTH = 256;

export type WebAccessStatus = {
  enabled: boolean;
  state: WebAccessState;
  bind: WebAccessBind;
  port: number;
  username: string;
  hasPassword: boolean;
  tls: {
    mode: WebAccessTlsMode;
    certPath: string;
    keyPath: string;
    /** SHA-256 fingerprint of the certificate being served, when running. */
    fingerprint256: string | null;
    validTo: string | null;
  };
  /** Addresses a browser can open; empty unless the server is running. */
  urls: string[];
  activeSessions: number;
  connectedClients: number;
  /** Last start failure, in English, for diagnostics. */
  error: string | null;
};

export type WebAccessConfigureInput = {
  enabled: boolean;
  bind: WebAccessBind;
  port: number;
  username: string;
  /** A new password. Omitted or empty keeps the stored one. */
  password?: string;
  tls: { mode: WebAccessTlsMode; certPath?: string; keyPath?: string };
};

export type WebAccessInputProblem =
  | "port"
  | "usernameRequired"
  | "usernameInvalid"
  | "passwordRequired"
  | "passwordLength"
  | "certPathRequired"
  | "keyPathRequired";

/**
 * The one validation rule for a configuration change. The settings form uses
 * it to explain a problem before saving; Electron Main runs it again on the
 * untrusted IPC input.
 */
export function validateWebAccessInput(
  input: WebAccessConfigureInput,
  hasStoredPassword: boolean,
): WebAccessInputProblem | null {
  if (
    !Number.isInteger(input.port) ||
    input.port < WEB_ACCESS_MIN_PORT ||
    input.port > WEB_ACCESS_MAX_PORT
  ) {
    return "port";
  }
  const username = input.username.trim();
  if (username.length > WEB_ACCESS_USERNAME_MAX_LENGTH || hasControlCharacter(username)) {
    return "usernameInvalid";
  }
  const password = input.password ?? "";
  if (
    password.length > 0 &&
    (password.length < WEB_ACCESS_PASSWORD_MIN_LENGTH ||
      password.length > WEB_ACCESS_PASSWORD_MAX_LENGTH)
  ) {
    return "passwordLength";
  }
  if (input.enabled) {
    if (!username) return "usernameRequired";
    if (!password && !hasStoredPassword) return "passwordRequired";
    if (input.tls.mode === "custom") {
      if (!input.tls.certPath?.trim()) return "certPathRequired";
      if (!input.tls.keyPath?.trim()) return "keyPathRequired";
    }
  }
  return null;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export const WEB_ACCESS_ROUTES = {
  login: "/__pi/login",
  logout: "/__pi/logout",
  session: "/__pi/session",
  bridge: "/__pi/bridge",
} as const;

/** WebSocket subprotocol of the bridge. */
export const WEB_ACCESS_BRIDGE_PROTOCOL = "pi-web.v1";
/**
 * The page proves it can read its own document by offering the session's
 * CSRF token as a second subprotocol, `pi-csrf.<token>`. Browsers cannot set
 * headers on a WebSocket handshake, and a subprotocol never lands in a URL.
 */
export const WEB_ACCESS_CSRF_PROTOCOL_PREFIX = "pi-csrf.";
/** `<meta name>` that carries the CSRF token in the served document. */
export const WEB_ACCESS_CSRF_META = "pi-web-access-csrf";
/**
 * `<meta name>` that carries the host's `process.platform`. Paths and shell
 * defaults in the renderer describe the host, not the browser's device.
 */
export const WEB_ACCESS_PLATFORM_META = "pi-web-access-platform";
/** Close code for a missing, expired, or revoked session. */
export const WEB_ACCESS_CLOSE_UNAUTHORIZED = 4401;

/** Browser to host. `args` is wire-encoded. */
export type WebBridgeInvokeFrame = {
  kind: "invoke";
  id: number;
  channel: string;
  args: unknown;
};

/**
 * Host to browser. `ok: true` carries the wire-encoded value the handler
 * resolved (the same `Result` envelope the preload bridge returns);
 * `ok: false` means the call itself failed, as a rejected
 * `ipcRenderer.invoke` would.
 */
export type WebBridgeResultFrame =
  | { kind: "result"; id: number; ok: true; value: unknown }
  | { kind: "result"; id: number; ok: false; message: string };

/** Host to browser. `payload` is wire-encoded. */
export type WebBridgeEventFrame = {
  kind: "event";
  channel: string;
  payload: unknown;
};

const TAG = "$pw";

type ViewConstructor = (new (
  buffer: ArrayBufferLike,
  byteOffset: number,
  length: number,
) => ArrayBufferView) & { readonly BYTES_PER_ELEMENT: number };

// Uint8Array is listed before its subclasses are met (Node's Buffer), so a
// Buffer travels as a Uint8Array, as it does through Electron IPC.
const TYPED_ARRAYS: ReadonlyArray<readonly [string, ViewConstructor]> = [
  ["Uint8Array", Uint8Array],
  ["Int8Array", Int8Array],
  ["Uint8ClampedArray", Uint8ClampedArray],
  ["Int16Array", Int16Array],
  ["Uint16Array", Uint16Array],
  ["Int32Array", Int32Array],
  ["Uint32Array", Uint32Array],
  ["Float32Array", Float32Array],
  ["Float64Array", Float64Array],
];

/**
 * Encode a value for JSON transport so it decodes to what Electron's
 * structured clone would deliver: `undefined`, non-finite numbers, dates,
 * binary data, maps, sets, and errors survive. Values structured clone
 * rejects (functions, symbols, bigint, cycles) throw.
 */
export function encodeWireValue(value: unknown): unknown {
  return encodeValue(value, new WeakSet<object>());
}

function encodeValue(value: unknown, path: WeakSet<object>): unknown {
  if (value === undefined) return { [TAG]: "undefined" };
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : { [TAG]: "number", v: String(value) };
  }
  if (typeof value !== "object") {
    throw new TypeError(`A ${typeof value} value cannot be sent over web access.`);
  }
  if (path.has(value)) throw new TypeError("A cyclic value cannot be sent over web access.");
  path.add(value);
  try {
    return encodeObject(value, path);
  } finally {
    path.delete(value);
  }
}

function encodeObject(value: object, path: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map((item) => encodeValue(item, path));
  if (value instanceof Date) {
    const time = value.getTime();
    return { [TAG]: "date", v: Number.isNaN(time) ? null : time };
  }
  if (value instanceof ArrayBuffer) {
    return { [TAG]: "ArrayBuffer", v: bytesToBase64(new Uint8Array(value)) };
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { [TAG]: viewName(value), v: bytesToBase64(bytes) };
  }
  if (value instanceof Map) {
    return {
      [TAG]: "map",
      v: [...value.entries()].map(([key, item]) => [encodeValue(key, path), encodeValue(item, path)]),
    };
  }
  if (value instanceof Set) {
    return { [TAG]: "set", v: [...value.values()].map((item) => encodeValue(item, path)) };
  }
  if (value instanceof Error) {
    return { [TAG]: "error", name: value.name, message: value.message };
  }
  const encoded: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    setOwn(encoded, key, encodeValue(item, path));
  }
  // A record that already owns the tag key is wrapped so decoding never
  // mistakes caller data for a codec marker.
  return Object.prototype.hasOwnProperty.call(value, TAG) ? { [TAG]: "object", v: encoded } : encoded;
}

function viewName(value: ArrayBufferView): string {
  if (value instanceof DataView) return "DataView";
  for (const [name, constructor] of TYPED_ARRAYS) {
    if (value instanceof constructor) return name;
  }
  throw new TypeError("This binary value cannot be sent over web access.");
}

/** Inverse of {@link encodeWireValue}. Malformed input throws. */
export function decodeWireValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeWireValue);
  if (!isRecord(value)) return value;
  if (!Object.prototype.hasOwnProperty.call(value, TAG)) return decodeEntries(value);
  const tag = value[TAG];
  switch (tag) {
    case "undefined":
      return undefined;
    case "number":
      return Number(value.v);
    case "date":
      return new Date(typeof value.v === "number" ? value.v : Number.NaN);
    case "map":
      return new Map(
        asArray(value.v).map((entry) => {
          const pair = asArray(entry);
          return [decodeWireValue(pair[0]), decodeWireValue(pair[1])] as const;
        }),
      );
    case "set":
      return new Set(asArray(value.v).map(decodeWireValue));
    case "error": {
      const error = new Error(typeof value.message === "string" ? value.message : "");
      if (typeof value.name === "string") error.name = value.name;
      return error;
    }
    case "object":
      return decodeEntries(isRecord(value.v) ? value.v : {});
    case "ArrayBuffer":
      return base64ToBytes(asString(value.v)).buffer;
    case "DataView":
      return new DataView(base64ToBytes(asString(value.v)).buffer);
    default: {
      const constructor = TYPED_ARRAYS.find(([name]) => name === tag)?.[1];
      if (!constructor) throw new TypeError(`Unknown web access value tag: ${String(tag)}`);
      const bytes = base64ToBytes(asString(value.v));
      if (bytes.byteLength % constructor.BYTES_PER_ELEMENT !== 0) {
        throw new TypeError("Malformed binary value.");
      }
      return new constructor(bytes.buffer, 0, bytes.byteLength / constructor.BYTES_PER_ELEMENT);
    }
  }
}

function decodeEntries(record: Record<string, unknown>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    setOwn(decoded, key, decodeWireValue(item));
  }
  return decoded;
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
  } else {
    target[key] = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Malformed web access value.");
  return value;
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Malformed web access value.");
  return value;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const n = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    parts.push(sextet(n >> 18) + sextet(n >> 12) + sextet(n >> 6) + sextet(n));
  }
  const rest = bytes.length - index;
  if (rest === 1) {
    const n = (bytes[index] ?? 0) << 16;
    parts.push(`${sextet(n >> 18)}${sextet(n >> 12)}==`);
  } else if (rest === 2) {
    const n = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8);
    parts.push(`${sextet(n >> 18)}${sextet(n >> 12)}${sextet(n >> 6)}=`);
  }
  return parts.join("");
}

function sextet(value: number): string {
  return BASE64_ALPHABET.charAt(value & 63);
}

function base64ToBytes(text: string): Uint8Array {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 61) end -= 1;
  if (end % 4 === 1 || text.length - end > 2) throw new TypeError("Malformed base64 value.");
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (let index = 0; index < end; index += 1) {
    const code = text.charCodeAt(index);
    const value = code < 128 ? (BASE64_LOOKUP[code] ?? -1) : -1;
    if (value < 0) throw new TypeError("Malformed base64 value.");
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset] = (buffer >> bits) & 0xff;
      offset += 1;
    }
  }
  return out;
}
