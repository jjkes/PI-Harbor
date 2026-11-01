import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { register } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { createWebAccessController } = await import("../electron/main/web-access/controller.ts");

const PASSWORD = "correct horse battery";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function fetchPage(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { host: `127.0.0.1:${port}`, ...headers },
        rejectUnauthorized: false,
        agent: false,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

test("in development the renderer comes from the Vite dev server, with the page transform", async (t) => {
  const vite = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<!doctype html><html><head>" +
          `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' ws://localhost:*" />` +
          '</head><body><script type="module" src="/src/main.tsx"></script></body></html>',
      );
      return;
    }
    if (request.url === "/src/main.tsx") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("export {};");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => vite.listen(0, "127.0.0.1", resolve));
  t.after(() => vite.close());
  const origin = `http://127.0.0.1:${vite.address().port}`;

  const controller = createWebAccessController({
    dataDir: mkdtempSync(join(tmpdir(), "pi-web-access-dev-")),
    renderer: { kind: "dev-server", origin },
    logger: { info() {}, warn() {} },
    onStatusChanged() {},
  });
  t.after(() => controller.dispose());
  await controller.start();
  const port = await freePort();
  const status = await controller.configure({
    enabled: true,
    bind: "loopback",
    port,
    username: "owner",
    password: PASSWORD,
    tls: { mode: "self-signed" },
  });
  assert.equal(status.state, "running", status.error ?? "");

  const signedOut = await fetchPage(port, { path: "/src/main.tsx" });
  assert.equal(signedOut.status, 401);

  const signIn = await fetchPage(port, {
    method: "POST",
    path: "/__pi/login",
    headers: {
      origin: `https://127.0.0.1:${port}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ username: "owner", password: PASSWORD }).toString(),
  });
  assert.ok([302, 303].includes(signIn.status), String(signIn.status));
  const cookie = String(signIn.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  assert.match(cookie, /^__Host-pi-web-session=/);

  const page = await fetchPage(port, { path: "/", headers: { cookie, accept: "text/html" } });
  assert.equal(page.status, 200);
  assert.match(page.body, /<meta name="pi-web-access-csrf" content="[A-Za-z0-9_-]{43}" \/>/);
  assert.match(page.body, new RegExp(`connect-src wss://127\\.0\\.0\\.1:${port} 'self'`));
  assert.match(page.body, /src="\/src\/main\.tsx"/);

  const script = await fetchPage(port, { path: "/src/main.tsx", headers: { cookie } });
  assert.equal(script.status, 200);
  assert.equal(script.body, "export {};");
  assert.match(String(script.headers["content-type"]), /javascript/);

  // A request path that resolves to another origin is never served.
  const escaped = await fetchPage(port, { path: "//example.invalid/x", headers: { cookie } });
  assert.notEqual(escaped.status, 200);
});
