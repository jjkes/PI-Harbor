import assert from "node:assert/strict";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IPC, WEB_ACCESS_DEFAULT_PORT } from "@pi-harbor/shared";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const auth = await import("../electron/main/web-access/auth.ts");
const password = await import("../electron/main/web-access/password.ts");
const certificate = await import("../electron/main/web-access/certificate.ts");
const policy = await import("../electron/main/web-access/channel-policy.ts");
const assets = await import("../electron/main/web-access/assets.ts");
const config = await import("../electron/main/web-access/config.ts");

const DAY_MS = 24 * 60 * 60 * 1000;

test("sessions end after the idle timeout and at the absolute lifetime", () => {
  let now = 1_000;
  const store = auth.createSessionStore(() => now);

  const idle = store.create();
  assert.ok(store.touch(idle.token));
  now += auth.SESSION_IDLE_MS - 1;
  assert.ok(store.peek(idle.token), "peek sees a live session");
  now += 2;
  assert.equal(store.touch(idle.token), null);

  const start = now;
  const busy = store.create();
  while (now - start < auth.SESSION_LIFETIME_MS - auth.SESSION_IDLE_MS / 2) {
    now += auth.SESSION_IDLE_MS / 2;
    assert.ok(store.touch(busy.token));
  }
  now = start + auth.SESSION_LIFETIME_MS + 1;
  assert.equal(store.touch(busy.token), null);

  const a = store.create();
  store.create();
  assert.equal(store.touch("not-a-token"), null);
  assert.equal(store.touch(null), null);
  store.revoke(a.token);
  assert.equal(store.peek(a.token), null);
  store.revokeAll();
  assert.equal(store.count(), 0);
});

test("peeking at a session does not keep it alive", () => {
  let now = 0;
  const store = auth.createSessionStore(() => now);
  const { token } = store.create();
  now += auth.SESSION_IDLE_MS - 1;
  assert.ok(store.peek(token));
  now += 2;
  assert.equal(store.peek(token), null);
});

test("sign-in attempts lock out one address and count parallel attempts", () => {
  let now = 0;
  const limiter = auth.createLoginRateLimiter(() => now);
  for (let attempt = 0; attempt < auth.LOGIN_MAX_FAILURES; attempt += 1) {
    assert.equal(limiter.begin("a"), true);
    limiter.finish("a", false);
  }
  assert.equal(limiter.begin("a"), false);
  assert.equal(limiter.begin("b"), true, "another address is unaffected");
  limiter.finish("b", true);
  now += auth.LOGIN_LOCKOUT_MS + 1;
  assert.equal(limiter.begin("a"), true, "the lockout expires");
  limiter.finish("a", true);

  for (let attempt = 0; attempt < auth.LOGIN_MAX_FAILURES; attempt += 1) {
    assert.equal(limiter.begin("c"), true);
  }
  assert.equal(limiter.begin("c"), false, "attempts still being checked count against the limit");
});

test("client keys group IPv6 by /64 and unmap IPv4", () => {
  assert.equal(auth.clientKey("::ffff:192.0.2.7"), auth.clientKey("192.0.2.7"));
  assert.equal(auth.clientKey("2001:db8:1:2::5"), auth.clientKey("2001:db8:1:2:aaaa::1"));
  assert.equal(auth.clientKey("fe80::1%en0"), auth.clientKey("fe80::2"));
  assert.notEqual(auth.clientKey("2001:db8:1:2::5"), auth.clientKey("2001:db8:1:3::5"));
  assert.equal(typeof auth.clientKey(undefined), "string");
});

test("cookies and secrets", () => {
  assert.equal(auth.readCookie(`a=1; ${auth.SESSION_COOKIE}=tok; b=2`, auth.SESSION_COOKIE), "tok");
  assert.equal(auth.readCookie(undefined, auth.SESSION_COOKIE), null);
  assert.match(auth.sessionCookie("tok"), /^__Host-pi-web-session=tok;/);
  assert.match(auth.clearedSessionCookie(), /Max-Age=0/);
  assert.equal(auth.sameSecret("abc", "abc"), true);
  assert.equal(auth.sameSecret("abc", "abd"), false);
  assert.equal(auth.sameSecret("abc", "abcd"), false);
});

test("passwords are salted scrypt hashes and damaged hashes never verify", async () => {
  const hash = await password.hashPassword("correct horse battery");
  assert.equal(password.isPasswordHash(hash), true);
  assert.match(hash, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await password.verifyPassword("correct horse battery", hash), true);
  assert.equal(await password.verifyPassword("correct horse batterz", hash), false);
  assert.notEqual(await password.hashPassword("correct horse battery"), hash);
  assert.equal(await password.verifyPassword("x", "not-a-hash"), false);
  assert.equal(await password.verifyPassword("x", "scrypt$1073741824$8$1$AAAA$AAAA"), false);

  const stored = { username: "owner", passwordHash: hash };
  assert.equal(await password.verifyCredentials({ username: " owner ", password: "correct horse battery" }, stored), true);
  assert.equal(await password.verifyCredentials({ username: "other", password: "correct horse battery" }, stored), false);
  assert.equal(await password.verifyCredentials({ username: "", password: "" }, { username: "", passwordHash: "" }), false);
});

test("the self-signed certificate is a valid P-256 server certificate", async () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const { cert, key } = certificate.generateSelfSignedCertificate({
    now,
    dnsNames: ["localhost"],
    ipAddresses: ["127.0.0.1", "::1"],
  });
  const x509 = new X509Certificate(cert);
  assert.equal(x509.verify(x509.publicKey), true);
  assert.equal(x509.checkPrivateKey(createPrivateKey(key)), true);
  assert.equal(x509.ca, false);
  assert.equal(x509.publicKey.asymmetricKeyDetails?.namedCurve, "prime256v1");
  assert.match(x509.subjectAltName ?? "", /DNS:localhost/);
  assert.match(x509.subjectAltName ?? "", /IP Address:127\.0\.0\.1/);
  assert.ok(new Date(x509.validFrom) <= now);
  assert.ok(new Date(x509.validTo) > new Date(now.getTime() + 390 * DAY_MS));

  const material = certificate.inspectTlsMaterial(cert, key);
  assert.match(material.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  const other = certificate.generateSelfSignedCertificate({ dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"] });
  assert.throws(() => certificate.inspectTlsMaterial(cert, other.key));

  const directory = mkdtempSync(join(tmpdir(), "pi-web-access-tls-"));
  const first = await certificate.loadSelfSignedMaterial(directory);
  const second = await certificate.loadSelfSignedMaterial(directory);
  assert.equal(second.fingerprint256, first.fingerprint256, "a valid certificate is reused");
  const renewed = await certificate.loadSelfSignedMaterial(directory, new Date(Date.parse(first.validTo) - DAY_MS));
  assert.notEqual(renewed.fingerprint256, first.fingerprint256, "a certificate near expiry is renewed");
  if (process.platform !== "win32") {
    for (const name of readdirSync(directory)) {
      if (name.includes("key")) assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600, name);
    }
  }
});

test("the channel policy keeps device and web access channels on the desktop", () => {
  assert.equal(policy.webChannelDecision(IPC.invoke.appGetVersion), "dispatch");
  const denied = [
    IPC.invoke.appQuit,
    IPC.invoke.devtoolsToggle,
    IPC.invoke.windowControl,
    IPC.invoke.fsReveal,
    IPC.invoke.pluginInstallFromPath,
    IPC.invoke.pluginImportExtension,
    IPC.invoke.skillImport,
    IPC.invoke.storageGet,
    IPC.invoke.browserOpenExternal,
    IPC.invoke.voiceStart,
    IPC.invoke.liveVoiceConnect,
    IPC.invoke.webAccessGetStatus,
    IPC.invoke.webAccessConfigure,
    IPC.invoke.webAccessRevokeSessions,
  ];
  for (const channel of denied) assert.equal(policy.webChannelDecision(channel), "deny", channel);
  assert.equal(policy.webChannelDecision(IPC.invoke.windowSetWorkPanelReservation), "noop");
  assert.equal(policy.webChannelDecision(IPC.event.sessionsChanged), "deny", "an event name is never invoked");
  assert.equal(policy.webChannelDecision("pi-harbor/none"), "deny");

  assert.equal(policy.forwardsEventToWeb(IPC.event.sessionsChanged), true);
  assert.equal(policy.forwardsEventToWeb(IPC.event.webAccessChanged), false);
  assert.equal(policy.forwardsEventToWeb(IPC.event.liveVoicePort), false);
});

test("plugin view and panel window channels stay on the desktop", () => {
  // Opening a plugin view or panel window creates a native window on this computer.
  assert.equal(policy.webChannelDecision(IPC.invoke.pluginViewOpen), "deny");
  assert.equal(policy.webChannelDecision(IPC.invoke.pluginOpenPanel), "deny");
  // Closing, resizing, and hiding act on a native view only: success, no effect.
  assert.equal(policy.webChannelDecision(IPC.invoke.pluginViewClose), "noop");
  assert.equal(policy.webChannelDecision(IPC.invoke.pluginViewSetBounds), "noop");
  assert.equal(policy.webChannelDecision(IPC.invoke.pluginViewSetVisible), "noop");
  // The view list is not a native-window action, so it still dispatches.
  assert.equal(policy.webChannelDecision(IPC.invoke.pluginViews), "dispatch");
});

test("the served document carries the CSRF token, the host platform, and the bridge origin", () => {
  const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' ws://localhost:*" /></head><body><header>x</header></body></html>`;
  const page = assets.injectWebAccess(html, { csrfToken: "tok", host: "192.168.1.5:39321", platform: "linux" });
  assert.match(page, /<head>\n\s+<meta name="pi-web-access-csrf" content="tok" \/>/);
  assert.match(page, /<meta name="pi-web-access-platform" content="linux" \/>/);
  assert.match(page, /connect-src wss:\/\/192\.168\.1\.5:39321 'self'/);
  assert.ok(page.indexOf("pi-web-access-csrf") < page.indexOf("<header>"));
});

test("bundle paths stay inside the renderer root", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-access-root-"));
  assert.equal(assets.resolveBundlePath(root, "/"), join(root, "index.html"));
  assert.equal(assets.resolveBundlePath(root, "/assets/app.js"), join(root, "assets", "app.js"));
  for (const escape of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/a%00b", "/%E0%A4%A"]) {
    assert.equal(assets.resolveBundlePath(root, escape), null, escape);
  }
});

test("the stored configuration is validated and owner-only", async () => {
  // A damaged file falls back to loopback so it can never widen exposure; a
  // missing file is a fresh install and gets the defaults.
  assert.deepEqual(config.parseWebAccessConfig(null), {
    ...config.defaultWebAccessConfig(),
    bind: "loopback",
  });
  assert.equal(config.parseWebAccessConfig({ port: 80 }).port, WEB_ACCESS_DEFAULT_PORT);
  assert.equal(config.parseWebAccessConfig({ bind: "everywhere" }).bind, "loopback");
  assert.equal(config.parseWebAccessConfig({ bind: "all" }).bind, "all");
  assert.equal(config.parseWebAccessConfig({ passwordHash: "garbage" }).passwordHash, "");

  const dataDir = mkdtempSync(join(tmpdir(), "pi-web-access-config-"));
  assert.deepEqual(await config.loadWebAccessConfig(dataDir), config.defaultWebAccessConfig());
  const saved = {
    enabled: true,
    bind: "loopback",
    port: 40000,
    username: "owner",
    passwordHash: await password.hashPassword("correct horse battery"),
    tls: { mode: "custom", certPath: "/c.pem", keyPath: "/k.pem" },
  };
  await config.saveWebAccessConfig(dataDir, saved);
  assert.deepEqual(await config.loadWebAccessConfig(dataDir), saved);
  if (process.platform !== "win32") {
    const directory = config.webAccessDirectory(dataDir);
    for (const name of readdirSync(directory)) {
      const entry = statSync(join(directory, name));
      if (entry.isFile()) assert.equal(entry.mode & 0o777, 0o600, name);
    }
  }
});
