import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Browser sessions and sign-in throttling for web access (ADR 0342).
 *
 * Sessions live only in memory: restarting the app, changing the
 * credentials, or turning web access off signs every browser out. The store
 * keeps a SHA-256 of each cookie token, never the token itself.
 */
export const SESSION_COOKIE = "__Host-pi-web-session";
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 32;

export type WebSession = { csrfToken: string; createdAt: number; lastSeenAt: number };

export type SessionStore = {
  create(): { token: string; session: WebSession };
  /** The live session for a cookie token, recording the activity. */
  touch(token: string | null): WebSession | null;
  /** The live session for a cookie token, without recording activity. */
  peek(token: string | null): WebSession | null;
  revoke(token: string | null): void;
  revokeAll(): void;
  count(): number;
};

export function createSessionStore(now: () => number = Date.now): SessionStore {
  const sessions = new Map<string, WebSession>();
  const keyOf = (token: string) => createHash("sha256").update(token, "utf8").digest("base64url");
  const expired = (session: WebSession, at: number) =>
    at - session.lastSeenAt > SESSION_IDLE_MS || at - session.createdAt > SESSION_LIFETIME_MS;
  const prune = (at: number) => {
    for (const [key, session] of sessions) {
      if (expired(session, at)) sessions.delete(key);
    }
  };
  const find = (token: string | null, record: boolean): WebSession | null => {
    if (!token) return null;
    const at = now();
    const key = keyOf(token);
    const session = sessions.get(key);
    if (!session) return null;
    if (expired(session, at)) {
      sessions.delete(key);
      return null;
    }
    if (record) session.lastSeenAt = at;
    return session;
  };
  return {
    create() {
      const at = now();
      prune(at);
      while (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next();
        if (oldest.done) break;
        sessions.delete(oldest.value);
      }
      const token = randomBytes(32).toString("base64url");
      const session: WebSession = {
        csrfToken: randomBytes(32).toString("base64url"),
        createdAt: at,
        lastSeenAt: at,
      };
      sessions.set(keyOf(token), session);
      return { token, session };
    },
    touch: (token) => find(token, true),
    peek: (token) => find(token, false),
    revoke(token) {
      if (token) sessions.delete(keyOf(token));
    },
    revokeAll() {
      sessions.clear();
    },
    count() {
      prune(now());
      return sessions.size;
    },
  };
}

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
/** Failures older than this, with no lockout pending, are forgotten. */
const FAILURE_MEMORY_MS = 60 * 60 * 1000;
const MAX_TRACKED_CLIENTS = 4096;

type Attempts = { failures: number; inFlight: number; lockedUntil: number; updatedAt: number };

export type LoginRateLimiter = {
  /**
   * Reserves one attempt before the password is checked, so parallel
   * requests cannot run ahead of the failure count. False while locked out.
   */
  begin(client: string): boolean;
  finish(client: string, succeeded: boolean): void;
};

export function createLoginRateLimiter(now: () => number = Date.now): LoginRateLimiter {
  const clients = new Map<string, Attempts>();
  return {
    begin(client) {
      const at = now();
      let entry = clients.get(client);
      if (
        entry &&
        entry.inFlight === 0 &&
        entry.lockedUntil <= at &&
        at - entry.updatedAt > FAILURE_MEMORY_MS
      ) {
        clients.delete(client);
        entry = undefined;
      }
      if (!entry) {
        if (clients.size >= MAX_TRACKED_CLIENTS) {
          const oldest = clients.keys().next();
          if (!oldest.done) clients.delete(oldest.value);
        }
        entry = { failures: 0, inFlight: 0, lockedUntil: 0, updatedAt: at };
        clients.set(client, entry);
      }
      if (entry.lockedUntil > at) return false;
      if (entry.lockedUntil !== 0) {
        entry.lockedUntil = 0;
        entry.failures = 0;
      }
      if (entry.failures + entry.inFlight >= LOGIN_MAX_FAILURES) return false;
      entry.inFlight += 1;
      entry.updatedAt = at;
      return true;
    },
    finish(client, succeeded) {
      const entry = clients.get(client);
      if (!entry) return;
      const at = now();
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      entry.updatedAt = at;
      if (succeeded) {
        entry.failures = 0;
      } else {
        entry.failures += 1;
        if (entry.failures >= LOGIN_MAX_FAILURES) entry.lockedUntil = at + LOGIN_LOCKOUT_MS;
      }
      if (entry.failures === 0 && entry.inFlight === 0 && entry.lockedUntil <= at) {
        clients.delete(client);
      }
    },
  };
}

/**
 * The throttling key for a peer address. IPv6 peers are grouped by /64,
 * because one host can usually pick any address inside its prefix.
 */
export function clientKey(address: string | undefined): string {
  const raw = (address ?? "unknown").toLowerCase().split("%")[0] ?? "unknown";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw);
  if (mapped?.[1]) return mapped[1];
  if (!raw.includes(":")) return raw;
  return `${ipv6Prefix64(raw)}::/64`;
}

function ipv6Prefix64(address: string): string {
  const [head = "", tail] = address.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups = [...headGroups, ...new Array<string>(missing).fill("0"), ...tailGroups];
  return groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":");
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
