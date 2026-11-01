import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { register } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeWireValue, encodeWireValue, IPC } from "@pi-harbor/shared";
import { WebSocket } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createWebAccessController } = await import("../electron/main/web-access/controller.ts");
const { loadWebAccessConfig } = await import("../electron/main/web-access/config.ts");
const { isPasswordHash } = await import("../electron/main/web-access/password.ts");

const PASSWORD = "correct horse battery staple";
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const REDIRECT = [302, 303];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function send(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: "127.0.0.1", port, method, path, headers, agent: false, rejectUnauthorized: false },
      (response) => {
        const fingerprint = response.socket.getPeerCertificate().fingerprint256 ?? null;
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            fingerprint,
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function signIn(port, origin, password = PASSWORD) {
  return send(port, {
    method: "POST",
    path: "/__pi/login",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "owner", password }).toString(),
  });
}

function setCookieOf(response) {
  return [response.headers["set-cookie"] ?? []].flat()[0];
}

function openBridge(port, { cookie, origin, csrf }) {
  const protocols = ["pi-web.v1", ...(csrf ? [`pi-csrf.${csrf}`] : [])];
  const socket = new WebSocket(`wss://127.0.0.1:${port}/__pi/bridge`, protocols, {
    origin,
    headers: cookie ? { cookie } : {},
    rejectUnauthorized: false,
  });
  return new Promise((resolve) => {
    socket.once("open", () => resolve({ socket, status: 101 }));
    socket.once("unexpected-response", (outgoing, response) => {
      resolve({ socket: null, status: response.statusCode });
      outgoing.destroy();
    });
    socket.on("error", () => resolve({ socket: null, status: 0 }));
  });
}

function nextFrame(socket, accept) {
  return new Promise((resolve) => {
    const onMessage = (data) => {
      const frame = JSON.parse(String(data));
      if (!accept(frame)) return;
      socket.off("message", onMessage);
      resolve(frame);
    };
    socket.on("message", onMessage);
  });
}

async function invoke(socket, id, channel, args = []) {
  const reply = nextFrame(socket, (frame) => frame.kind === "result" && frame.id === id);
  socket.send(JSON.stringify({ kind: "invoke", id, channel, args: encodeWireValue(args) }));
  const frame = await reply;
  assert.equal(frame.ok, true, frame.message);
  return decodeWireValue(frame.value);
}

test("browser web access signs the owner in and bridges renderer IPC", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-web-access-"));
  const rendererRoot = join(dataDir, "renderer");
  mkdirSync(join(rendererRoot, "assets"), { recursive: true });
  writeFileSync(
    join(rendererRoot, "index.html"),
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' ws://localhost:*" /></head><body><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>`,
  );
  writeFileSync(join(rendererRoot, "assets", "app.js"), "export const ready = true;\n");

  const statuses = [];
  const dispatched = [];
  const controller = createWebAccessController({
    dataDir,
    renderer: { kind: "bundle", root: rendererRoot },
    logger: { info() {}, warn() {}, error() {} },
    onStatusChanged: (status) => statuses.push(status),
  });
  controller.setDispatcher(async (channel, args) => {
    dispatched.push(channel);
    return { ok: true, data: { channel, args } };
  });
  t.after(() => controller.dispose());

  await controller.start();
  assert.equal(controller.getStatus().state, "disabled");

  const port = await freePort();
  const origin = `https://127.0.0.1:${port}`;
  const status = await controller.configure({
    enabled: true,
    bind: "loopback",
    port,
    username: "owner",
    password: PASSWORD,
    tls: { mode: "self-signed" },
  });
  assert.equal(status.state, "running", status.error ?? undefined);
  assert.equal(status.hasPassword, true);
  assert.ok(status.urls.length > 0);
  assert.match(status.tls.fingerprint256 ?? "", FINGERPRINT);

  const stored = await loadWebAccessConfig(dataDir);
  assert.equal(isPasswordHash(stored.passwordHash), true);
  assert.equal(JSON.stringify(stored).includes(PASSWORD), false);

  await t.test("a signed-out browser reaches only the sign-in page", async () => {
    const page = await send(port, { headers: { accept: "text/html" } });
    assert.ok(REDIRECT.includes(page.status));
    assert.equal(page.headers.location, "/__pi/login");
    assert.equal(page.fingerprint, status.tls.fingerprint256);
    assert.equal((await send(port, { path: "/assets/app.js" })).status, 401);
    assert.equal((await send(port, { path: "/__pi/session" })).status, 401);

    const login = await send(port, { path: "/__pi/login" });
    assert.equal(login.status, 200);
    assert.match(login.body, /name="password"/);
    assert.match(login.headers["content-security-policy"], /default-src 'none'/);
    assert.doesNotMatch(login.body, /<script/i);
  });

  await t.test("sign-in checks the origin and the password", async () => {
    assert.equal((await signIn(port, "https://evil.example")).status, 403);
    const wrong = await signIn(port, origin, "not the owner password");
    assert.ok(REDIRECT.includes(wrong.status));
    assert.equal(wrong.headers.location, "/__pi/login?notice=invalid");
    assert.equal(wrong.headers["set-cookie"], undefined);
  });

  let cookie = "";
  let csrf = "";
  await t.test("the owner signs in and receives the renderer", async () => {
    const signedIn = await signIn(port, origin);
    assert.ok(REDIRECT.includes(signedIn.status));
    assert.equal(signedIn.headers.location, "/");
    const setCookie = setCookieOf(signedIn);
    assert.match(setCookie, /^__Host-pi-web-session=[A-Za-z0-9_-]{43};/);
    for (const attribute of [/; Secure/i, /; HttpOnly/i, /; SameSite=Strict/i, /; Path=\//i]) {
      assert.match(setCookie, attribute);
    }
    assert.doesNotMatch(setCookie, /Domain=/i);
    cookie = setCookie.split(";")[0];

    const page = await send(port, { headers: { cookie, accept: "text/html" } });
    assert.equal(page.status, 200);
    csrf = /<meta name="pi-web-access-csrf" content="([^"]+)"/.exec(page.body)?.[1] ?? "";
    assert.match(csrf, /^[A-Za-z0-9_-]{43}$/);
    assert.match(page.body, new RegExp(`<meta name="pi-web-access-platform" content="${process.platform}"`));
    assert.match(page.body, new RegExp(`connect-src wss://127\\.0\\.0\\.1:${port} 'self'`));
    assert.equal(page.headers["x-frame-options"], "SAMEORIGIN");
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(page.headers["cache-control"], "no-store");

    const asset = await send(port, { path: "/assets/app.js", headers: { cookie } });
    assert.equal(asset.status, 200);
    assert.match(asset.headers["content-type"], /javascript/);
    assert.equal((await send(port, { path: "/__pi/session", headers: { cookie } })).status, 204);
  });

  await t.test("the bridge handshake needs the origin, the cookie, and the CSRF token", async () => {
    assert.equal((await openBridge(port, { cookie, origin })).status, 403);
    assert.equal((await openBridge(port, { cookie, origin: "https://evil.example", csrf })).status, 403);
    assert.equal((await openBridge(port, { origin, csrf })).status, 401);
  });

  await t.test("an open tab invokes renderer IPC, receives events, and is closed on revocation", async () => {
    const { socket } = await openBridge(port, { cookie, origin, csrf });
    assert.ok(socket);
    assert.equal(socket.protocol, "pi-web.v1");

    const reply = await invoke(socket, 1, IPC.invoke.appGetVersion, [
      { keep: undefined, bytes: new Uint8Array([1, 2]) },
    ]);
    assert.equal(reply.ok, true);
    assert.equal(reply.data.channel, IPC.invoke.appGetVersion);
    assert.ok(Object.hasOwn(reply.data.args[0], "keep"));
    assert.deepEqual(reply.data.args[0].bytes, new Uint8Array([1, 2]));

    const refused = [IPC.invoke.appQuit, IPC.invoke.webAccessConfigure, IPC.event.sessionsChanged, "pi-harbor/none"];
    for (const [index, channel] of refused.entries()) {
      const denied = await invoke(socket, 10 + index, channel);
      assert.equal(denied.ok, false, channel);
      assert.equal(denied.error.code, "UNSUPPORTED", channel);
    }
    const layout = await invoke(socket, 20, IPC.invoke.windowSetWorkPanelReservation, [{ width: 0 }]);
    assert.equal(layout.ok, true);
    assert.deepEqual(dispatched, [IPC.invoke.appGetVersion]);

    const event = nextFrame(socket, (frame) => frame.kind === "event");
    controller.broadcast(IPC.event.webAccessChanged, { withheld: true });
    controller.broadcast(IPC.event.sessionsChanged, { bytes: new Uint8Array([7]) });
    const frame = await event;
    assert.equal(frame.channel, IPC.event.sessionsChanged);
    assert.deepEqual(decodeWireValue(frame.payload), { bytes: new Uint8Array([7]) });

    const live = controller.getStatus();
    assert.equal(live.activeSessions, 1);
    assert.equal(live.connectedClients, 1);

    const closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
    assert.equal(controller.revokeSessions().activeSessions, 0);
    assert.equal(await closed, 4401);
    assert.equal((await send(port, { path: "/__pi/session", headers: { cookie } })).status, 401);
  });

  await t.test("signing out ends the session", async () => {
    const fresh = setCookieOf(await signIn(port, origin)).split(";")[0];
    const forged = await send(port, {
      method: "POST",
      path: "/__pi/logout",
      headers: { cookie: fresh, origin: "https://evil.example" },
    });
    assert.equal(forged.status, 403);
    const out = await send(port, { method: "POST", path: "/__pi/logout", headers: { cookie: fresh, origin } });
    assert.ok(REDIRECT.includes(out.status));
    assert.match(out.headers.location, /^\/__pi\/login/);
    assert.match(setCookieOf(out), /Max-Age=0/);
    assert.equal((await send(port, { path: "/__pi/session", headers: { cookie: fresh } })).status, 401);
  });

  await t.test("repeated failures lock the address out", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await signIn(port, origin, "still not the owner password");
    }
    const locked = await signIn(port, origin);
    assert.equal(locked.headers.location, "/__pi/login?notice=locked");
    assert.equal(locked.headers["set-cookie"], undefined);
  });

  await t.test("turning web access off closes the listener", async () => {
    const off = await controller.configure({
      enabled: false,
      bind: "loopback",
      port,
      username: "owner",
      tls: { mode: "self-signed" },
    });
    assert.equal(off.state, "disabled");
    await assert.rejects(send(port, { path: "/__pi/login" }));
  });

  assert.ok(statuses.some((entry) => entry.state === "running"));
});
