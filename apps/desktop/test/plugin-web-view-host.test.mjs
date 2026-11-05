import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { PluginWebViewHost, referencedAssets } = await import(
  "../electron/main/plugin-web-view-host.ts"
);

const root = "/plugins/pi.file-manager";
const files = new Map([
  [`${root}/views/index.html`, '<div id="root"></div><script src="./assets/index.js" defer></script>'],
  [`${root}/views/assets/index.js`, "console.log('view')"],
  [`${root}/secret.txt`, "do not serve"],
]);

function harness(overrides = {}) {
  const bridged = [];
  const loaded = new Map([
    [
      "pi.file-manager",
      {
        path: root,
        permissions: new Set(["ui.view", "fs.read"]),
        manifest: { contributes: { views: [{ id: "manager", entry: "views/index.html" }] } },
      },
    ],
    [
      "pi.no-view",
      { path: root, permissions: new Set(["fs.read"]), manifest: { contributes: { views: [] } } },
    ],
  ]);
  const host = new PluginWebViewHost({
    getLoaded: (pluginId) => loaded.get(pluginId),
    pluginActiveInProject: () => true,
    bridge: async (pluginId, channel, payload, context) => {
      bridged.push({ pluginId, channel, payload, context });
      return { ok: true };
    },
    locale: () => "zh-CN",
    theme: () => "dark",
    readTextFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    readFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return new Uint8Array(Buffer.from(value, "utf8"));
    },
    exists: (path) => files.has(path),
    randomId: () => "instance-1",
    ...overrides,
  });
  return { host, bridged };
}

test("referenced assets resolve against the entry directory and stop at the package", () => {
  const html = [
    '<script src="./assets/index.js"></script>',
    '<link rel="stylesheet" href="styles/app.css">',
    '<script src="https://cdn.example/app.js"></script>',
    '<script src="/absolute.js"></script>',
    '<script src="../../escape.js"></script>',
    '<link rel="icon" href="icon.png">',
  ].join("");
  assert.deepEqual(referencedAssets(html, "views"), [
    { reference: "./assets/index.js", path: "views/assets/index.js" },
    { reference: "styles/app.css", path: "views/styles/app.css" },
  ]);
});

test("open loads the declared entry and returns the document with its references", async () => {
  const { host } = harness();
  const opened = await host.open({ pluginId: "pi.file-manager", viewId: "manager", sessionId: "s1" });
  assert.equal(opened.instanceId, "instance-1");
  assert.match(opened.html, /<div id="root">/);
  assert.deepEqual(opened.assets, [
    { reference: "./assets/index.js", path: "views/assets/index.js" },
  ]);
  assert.equal(opened.locale, "zh-CN");
  assert.equal(opened.theme, "dark");
  assert.equal(host.size, 1);
});

test("open refuses what the desktop path refuses", async () => {
  const { host } = harness();
  await assert.rejects(host.open({ pluginId: "pi.absent", viewId: "manager" }), (error) => {
    assert.equal(error.errorCode, "NOT_FOUND");
    return true;
  });
  await assert.rejects(host.open({ pluginId: "pi.no-view", viewId: "manager" }), (error) => {
    assert.equal(error.errorCode, "PERMISSION_DENIED");
    return true;
  });
  await assert.rejects(host.open({ pluginId: "pi.file-manager", viewId: "absent" }), (error) => {
    assert.equal(error.errorCode, "NOT_FOUND");
    return true;
  });
  await assert.rejects(host.open({ pluginId: "", viewId: "" }), (error) => {
    assert.equal(error.errorCode, "INVALID_ARGUMENT");
    return true;
  });
});

test("open refuses a plugin that is not active in this project", async () => {
  const { host } = harness({ pluginActiveInProject: () => false });
  await assert.rejects(host.open({ pluginId: "pi.file-manager", viewId: "manager" }), (error) => {
    assert.equal(error.errorCode, "PERMISSION_DENIED");
    return true;
  });
});

test("an asset read never leaves the plugin package", async () => {
  const { host } = harness();
  await host.open({ pluginId: "pi.file-manager", viewId: "manager" });
  const bytes = await host.asset({ instanceId: "instance-1", path: "views/assets/index.js" });
  assert.equal(Buffer.from(bytes).toString("utf8"), "console.log('view')");
  for (const path of ["../secret.txt", "/etc/passwd", `${root}/secret.txt`, "file:///etc/passwd"]) {
    await assert.rejects(host.asset({ instanceId: "instance-1", path }), (error) => {
      assert.equal(error.errorCode, "NOT_FOUND");
      return true;
    });
  }
  await assert.rejects(host.asset({ instanceId: "unknown", path: "views/index.html" }), (error) => {
    assert.equal(error.errorCode, "NOT_FOUND");
    return true;
  });
});

test("a bridge call carries the instance's plugin and session, never the frame's", async () => {
  const { host, bridged } = harness();
  await host.open({ pluginId: "pi.file-manager", viewId: "manager", sessionId: "s1" });
  await host.invoke({ instanceId: "instance-1", channel: "fm.list", payload: { path: "" } });
  assert.deepEqual(bridged, [
    {
      pluginId: "pi.file-manager",
      channel: "fm.list",
      payload: { path: "" },
      context: { sessionId: "s1" },
    },
  ]);
});

test("a bridge call that acts on the host's screen is refused", async () => {
  const { host, bridged } = harness();
  await host.open({ pluginId: "pi.file-manager", viewId: "manager" });
  for (const channel of [
    "fs.reveal",
    "fs.openDefault",
    "fs.openInBrowser",
    "fs.registerDropped",
    "app.launchURL",
  ]) {
    await assert.rejects(host.invoke({ instanceId: "instance-1", channel }), (error) => {
      assert.equal(error.errorCode, "UNSUPPORTED", channel);
      return true;
    });
  }
  assert.deepEqual(bridged, []);
});

test("instances are cleaned up per view, per plugin, and all at once", async () => {
  let next = 0;
  const { host } = harness({ randomId: () => `instance-${++next}` });
  await host.open({ pluginId: "pi.file-manager", viewId: "manager" });
  await host.open({ pluginId: "pi.file-manager", viewId: "manager" });
  assert.equal(host.size, 2);
  host.close({ instanceId: "instance-1" });
  assert.equal(host.size, 1);
  assert.deepEqual(host.close({ instanceId: "unknown" }), { ok: true });
  host.closePlugin("pi.file-manager");
  assert.equal(host.size, 0);
  await host.open({ pluginId: "pi.file-manager", viewId: "manager" });
  host.closeAll();
  assert.equal(host.size, 0);
});

test("an event reaches only the frames whose plugin it belongs to", async () => {
  let next = 0;
  const { host } = harness({ randomId: () => `instance-${++next}` });
  await host.open({ pluginId: "pi.file-manager", viewId: "manager" });
  const frames = host.broadcast("view:open", { path: "/p/a.ts" }, () => true);
  assert.deepEqual(frames, [
    { instanceId: "instance-1", event: "view:open", payload: { path: "/p/a.ts" } },
  ]);
  assert.deepEqual(host.broadcast("view:open", {}, () => false), []);
});
