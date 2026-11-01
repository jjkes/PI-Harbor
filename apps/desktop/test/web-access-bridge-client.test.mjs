import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IPC, decodeWireValue, encodeWireValue } from "@pi-harbor/shared";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { createWebAccessBridge } = await import("../src/lib/web-access/bridge-client.ts");

const BRIDGE_URL = "wss://desk.example:39321/__pi/bridge";
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeSocket(url, protocols) {
  const listeners = { open: [], message: [], close: [] };
  const socket = {
    url,
    protocols,
    readyState: 0,
    sent: [],
    send: (data) => {
      socket.sent.push(data);
    },
    onOpen: (listener) => {
      listeners.open.push(listener);
    },
    onMessage: (listener) => {
      listeners.message.push(listener);
    },
    onClose: (listener) => {
      listeners.close.push(listener);
    },
    open: () => {
      socket.readyState = 1;
      for (const listener of listeners.open) listener();
    },
    receive: (frame) => {
      const text = typeof frame === "string" ? frame : JSON.stringify(frame);
      for (const listener of listeners.message) listener(text);
    },
    close: (code) => {
      socket.readyState = 3;
      for (const listener of listeners.close) listener(code);
    },
  };
  return socket;
}

function harness(overrides = {}) {
  const sockets = [];
  const scheduled = [];
  const seen = { signedOut: 0, reconnected: 0, opened: [], errors: [] };
  let sessionValid = true;
  const bridge = createWebAccessBridge({
    csrfToken: "csrf-token",
    url: BRIDGE_URL,
    platform: "linux",
    locale: "en-US",
    connect: (url, protocols) => {
      const socket = fakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    checkSession: async () => sessionValid,
    onSignedOut: () => {
      seen.signedOut += 1;
    },
    onReconnected: () => {
      seen.reconnected += 1;
    },
    openExternal: (url) => {
      seen.opened.push(url);
    },
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
    },
    reportError: (error) => {
      seen.errors.push(error);
    },
    ...overrides,
  });
  return {
    bridge,
    sockets,
    scheduled,
    seen,
    endSession: () => {
      sessionValid = false;
    },
  };
}

function lastInvoke(socket) {
  return JSON.parse(socket.sent.at(-1));
}

test("the bridge connects with the bridge and CSRF subprotocols", () => {
  const { sockets } = harness();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, BRIDGE_URL);
  assert.deepEqual(sockets[0].protocols, ["pi-web.v1", "pi-csrf.csrf-token"]);
});

test("an invoke waits for the socket, then resolves with the handler's Result", async () => {
  const { bridge, sockets } = harness();
  const socket = sockets[0];
  const reply = bridge.invoke(IPC.invoke.appGetVersion, { keep: undefined }, new Uint8Array([1, 2]));
  assert.equal(socket.sent.length, 0);

  socket.open();
  assert.equal(socket.sent.length, 1);
  const frame = lastInvoke(socket);
  assert.equal(frame.kind, "invoke");
  assert.equal(frame.channel, IPC.invoke.appGetVersion);
  const args = decodeWireValue(frame.args);
  assert.ok("keep" in args[0]);
  assert.deepEqual(args[1], new Uint8Array([1, 2]));

  socket.receive({
    kind: "result",
    id: frame.id,
    ok: true,
    value: encodeWireValue({ ok: true, data: "1.2.3" }),
  });
  assert.deepEqual(await reply, { ok: true, data: "1.2.3" });
});

test("a failed call rejects as a rejected ipcRenderer.invoke would", async () => {
  const { bridge, sockets } = harness();
  sockets[0].open();
  const reply = bridge.invoke(IPC.invoke.appGetVersion);
  sockets[0].receive({ kind: "result", id: lastInvoke(sockets[0]).id, ok: false, message: "boom" });
  await assert.rejects(reply, { message: "boom" });
});

test("malformed frames are ignored and a reply that is not a Result rejects", async () => {
  const { bridge, sockets } = harness();
  const socket = sockets[0];
  socket.open();
  socket.receive("not json");
  socket.receive({ kind: "result", id: 999, ok: true, value: {} });

  const reply = bridge.invoke(IPC.invoke.appGetVersion);
  socket.receive({ kind: "result", id: lastInvoke(socket).id, ok: true, value: "nope" });
  await assert.rejects(reply, /Malformed/);
});

test("events reach every listener, and a throwing listener does not stop the rest", () => {
  const { bridge, sockets, seen } = harness();
  const socket = sockets[0];
  socket.open();
  const received = [];
  bridge.on(IPC.event.sessionsChanged, () => {
    throw new Error("listener failed");
  });
  const unsubscribe = bridge.on(IPC.event.sessionsChanged, (payload) => received.push(payload));

  socket.receive({
    kind: "event",
    channel: IPC.event.sessionsChanged,
    payload: encodeWireValue({ at: new Date(5) }),
  });
  assert.equal(received.length, 1);
  assert.ok(received[0].at instanceof Date);
  assert.equal(received[0].at.getTime(), 5);
  assert.equal(seen.errors.length, 1);

  unsubscribe();
  socket.receive({ kind: "event", channel: IPC.event.sessionsChanged, payload: encodeWireValue({}) });
  assert.equal(received.length, 1);
});

test("channels outside the IPC whitelist are refused", async () => {
  const { bridge, sockets } = harness();
  await assert.rejects(bridge.invoke("pi-harbor/not-a-channel"), /not allowed/);
  assert.throws(() => bridge.on("pi-harbor/not-a-channel", () => undefined), /not allowed/);
  assert.equal(sockets[0].sent.length, 0);
});

test("links open in a new tab and other targets are refused without a round trip", async () => {
  const { bridge, sockets, seen } = harness();
  const opened = await bridge.invoke(IPC.invoke.browserOpenExternal, { url: "https://example.com/docs" });
  assert.deepEqual(opened, { ok: true, data: null });
  assert.deepEqual(seen.opened, ["https://example.com/docs"]);

  const refused = await bridge.invoke(IPC.invoke.browserOpenExternal, { url: "file:///etc/passwd" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "UNSUPPORTED");
  assert.deepEqual(seen.opened, ["https://example.com/docs"]);
  assert.equal(sockets[0].sent.length, 0);
});

test("a 4401 close signs the tab out and rejects pending and later calls", async () => {
  const { bridge, sockets, scheduled, seen } = harness();
  sockets[0].open();
  const reply = bridge.invoke(IPC.invoke.appGetVersion);

  sockets[0].close(4401);
  await assert.rejects(reply, Error);
  assert.equal(seen.signedOut, 1);
  assert.equal(scheduled.length, 0);
  await assert.rejects(bridge.invoke(IPC.invoke.appGetVersion), Error);
});

test("a dropped connection checks the session, reconnects, and reloads", async () => {
  const { bridge, sockets, scheduled, seen } = harness();
  sockets[0].open();
  const reply = bridge.invoke(IPC.invoke.appGetVersion);

  sockets[0].close(1006);
  await assert.rejects(reply, Error);
  await assert.rejects(bridge.invoke(IPC.invoke.appGetVersion), Error);
  assert.equal(scheduled.length, 1);

  scheduled[0].callback();
  await flush();
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.equal(seen.reconnected, 1);
  assert.equal(seen.signedOut, 0);
});

test("a dropped connection whose session ended signs the tab out", async () => {
  const { sockets, scheduled, seen, endSession } = harness();
  sockets[0].open();
  sockets[0].close(1006);
  endSession();

  scheduled[0].callback();
  await flush();
  assert.equal(seen.signedOut, 1);
  assert.equal(sockets.length, 1);
});

test("a session check that fails is retried with a growing delay", async () => {
  const { sockets, scheduled } = harness({
    checkSession: async () => {
      throw new Error("offline");
    },
  });
  sockets[0].close(1006);
  assert.equal(scheduled.length, 1);

  scheduled[0].callback();
  await flush();
  assert.equal(scheduled.length, 2);
  assert.ok(scheduled[1].delayMs >= scheduled[0].delayMs);
  assert.equal(sockets.length, 1);
});

test("the bridge reports the host platform and exposes no host file paths or live voice port", () => {
  const { bridge } = harness();
  assert.equal(bridge.platform, "linux");
  assert.equal(bridge.locale, "en-US");
  assert.equal(bridge.channels.invoke.appGetVersion, IPC.invoke.appGetVersion);
  assert.equal(bridge.getDroppedFilePath({ name: "a.txt" }), null);
  const stop = bridge.onLiveVoicePort();
  assert.equal(typeof stop, "function");
  stop();
});
