import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const frame = await import("../src/lib/web-access/plugin-view-frame.ts");
const assets = await import("../electron/main/web-access/assets.ts");

test("the frame is sandboxed without a same-origin grant", () => {
  assert.match(frame.PLUGIN_VIEW_FRAME_SANDBOX, /allow-scripts/);
  assert.doesNotMatch(frame.PLUGIN_VIEW_FRAME_SANDBOX, /allow-same-origin/);
});

test("the shell installs the bridge before the view's own script", () => {
  const html = frame.PLUGIN_VIEW_FRAME_HTML;
  assert.ok(html.indexOf("window.pluginBridge = bridge") > 0);
  assert.ok(
    html.indexOf("window.pluginBridge = bridge") < html.indexOf('post({ source: SOURCE, kind: "ready" })'),
    "the bridge exists before the view is told the frame is ready",
  );
  // Nothing in the shell points at a URL: there is no address to put a token in.
  assert.doesNotMatch(html, /https?:\/\//);
  // The shell is one inline script; a second script tag would mean it leans on
  // markup the frame never receives.
  assert.equal((html.match(/<script/g) ?? []).length, 1);
});

test("asset URLs are minted inside the frame, not by the app", () => {
  // A `blob:` URL belongs to the origin that created it; an opaque-origin frame
  // cannot load one the app made, so the frame must build its own.
  const html = frame.PLUGIN_VIEW_FRAME_HTML;
  assert.match(html, /URL\.createObjectURL\(/);
  assert.match(html, /asset\.bytes/);
  assert.doesNotMatch(html, /message\.blobs/);
});


test("the frame reports a browser's device boundary instead of failing on click", () => {
  assert.match(frame.PLUGIN_VIEW_FRAME_HTML, /hostDevice: false/);
  assert.match(frame.PLUGIN_VIEW_FRAME_HTML, /clipboard: "browser"/);
  assert.match(frame.PLUGIN_VIEW_FRAME_HTML, /navigator\.clipboard\.writeText/);
});

test("asset blobs get a type the frame can execute or render", () => {
  assert.equal(frame.blobTypeFor("views/assets/index.js"), "text/javascript");
  assert.equal(frame.blobTypeFor("views/assets/index.mjs"), "text/javascript");
  assert.equal(frame.blobTypeFor("views/styles/app.css"), "text/css");
  assert.equal(frame.blobTypeFor("views/app.wasm"), "application/wasm");
  assert.equal(frame.blobTypeFor("views/app.png"), "image/png");
  assert.equal(frame.blobTypeFor("views/app.bin"), "application/octet-stream");
});

test("only this frame's messages are served", () => {
  assert.equal(
    frame.isPluginViewFrameMessage({ source: "pi-plugin-view", kind: "ready" }),
    true,
  );
  assert.equal(
    frame.isPluginViewFrameMessage({ source: "pi-plugin-view", kind: "invoke", id: 1, channel: "fm.list" }),
    true,
  );
  assert.equal(frame.isPluginViewFrameMessage({ source: "pi-host", kind: "mount" }), false);
  assert.equal(frame.isPluginViewFrameMessage({ source: "pi-plugin-view", kind: "other" }), false);
  assert.equal(frame.isPluginViewFrameMessage(null), false);
  assert.equal(frame.isPluginViewFrameMessage("ready"), false);
});

const SHIPPED_CSP = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: plugin-renderer:; connect-src 'self' ws://localhost:*; frame-src pi-genui:;" /></head><body></body></html>`;

test("the served document admits a frame while the desktop policy does not", () => {
  const served = assets.injectWebAccess(SHIPPED_CSP, {
    csrfToken: "token",
    host: "127.0.0.1:39321",
    platform: "darwin",
  });
  assert.match(served, /frame-src pi-genui: 'self' blob:;/);
  assert.match(served, /worker-src 'self' blob:/);
  assert.match(served, /connect-src wss:\/\/127\.0\.0\.1:39321 /);
  // The desktop document is a file on disk; nothing rewrites it here.
  assert.equal(SHIPPED_CSP.includes("frame-src pi-genui:;"), true);
});

test("a document without the shipped frame directive is left alone", () => {
  const other = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self'" /></head></html>`;
  const served = assets.injectWebAccess(other, {
    csrfToken: "t",
    host: "127.0.0.1:39321",
    platform: "linux",
  });
  assert.equal(served.includes("worker-src"), false);
});
