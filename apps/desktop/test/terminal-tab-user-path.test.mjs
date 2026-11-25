import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { readFileSync } from "node:fs";
import {
  __mount,
  __render,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "./helpers/react-hook-stub.mjs";

function loadHook() {
  const file = new URL(
    "../src/components/workpanel/use-terminal.ts",
    import.meta.url,
  );
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      if (id === "react") {
        return { useState, useRef, useEffect, useCallback, useMemo };
      }
      if (id === "../../lib/api") {
        return {
          api: new Proxy(
            {},
            {
              get: (_, prop) => {
                if (!apiState) apiState = makeApi();
                return apiState[prop];
              },
            },
          ),
        };
      }
      if (id === "@pi-harbor/shared") {
        // Mirrors `parseRemoteSessionId` in the shared package: the hook only
        // needs the grammar, and the real module is not built for this runner.
        return {
          parseRemoteSessionId: (sessionId) => {
            if (typeof sessionId !== "string" || !sessionId.startsWith("remote:")) return null;
            const rest = sessionId.slice("remote:".length);
            const separator = rest.indexOf(":");
            if (separator <= 0 || separator === rest.length - 1) return null;
            return {
              hostKey: rest.slice(0, separator),
              hostSessionId: rest.slice(separator + 1),
            };
          },
        };
      }
      throw new Error(`unmocked dependency: ${id}`);
    },
    module.exports,
    module,
  );
  return module.exports;
}

const SESSION_ID = "sess-1";
const TERMINAL_ID = "term-1";

let apiState;

function makeApi() {
  const invokes = [];
  const listeners = { terminalOutput: [], terminalChanged: [], sessionsChanged: [] };
  let terminalIdCounter = 0;

  const emitOutput = (payload) => {
    for (const listener of listeners.terminalOutput) listener(payload);
  };
  const emitChanged = (payload) => {
    for (const listener of listeners.terminalChanged) listener(payload);
  };

  const emitSessionsChanged = (payload) => {
    for (const listener of listeners.sessionsChanged) listener(payload);
  };

  return {
    invokes,
    listeners,
    emitOutput,
    emitChanged,
    emitSessionsChanged,
    terminalOpen: async (input) => {
      invokes.push({ method: "terminalOpen", input });
      terminalIdCounter += 1;
      const terminalId = `${TERMINAL_ID}-${terminalIdCounter}`;
      return {
        terminalId,
        cols: input.cols ?? 80,
        rows: input.rows ?? 24,
        replay: "",
      };
    },
    terminalInput: async (input) => {
      invokes.push({ method: "terminalInput", input });
      return { ok: true };
    },
    terminalResize: async (input) => {
      invokes.push({ method: "terminalResize", input });
      return { ok: true };
    },
    terminalInterrupt: async (input) => {
      invokes.push({ method: "terminalInterrupt", input });
      return { ok: true };
    },
    terminalClose: async (input) => {
      invokes.push({ method: "terminalClose", input });
      return { ok: true };
    },
    onTerminalOutput: (listener) => {
      listeners.terminalOutput.push(listener);
      return () => {
        const index = listeners.terminalOutput.indexOf(listener);
        if (index >= 0) listeners.terminalOutput.splice(index, 1);
      };
    },
    onTerminalChanged: (listener) => {
      listeners.terminalChanged.push(listener);
      return () => {
        const index = listeners.terminalChanged.indexOf(listener);
        if (index >= 0) listeners.terminalChanged.splice(index, 1);
      };
    },
    onSessionsChanged: (listener) => {
      listeners.sessionsChanged.push(listener);
      return () => {
        const index = listeners.sessionsChanged.indexOf(listener);
        if (index >= 0) listeners.sessionsChanged.splice(index, 1);
      };
    },
  };
}

function resetApi() {
  apiState = makeApi();
}

let observers = [];
let lastObserver = null;

function installResizeObserver() {
  observers = [];
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
      lastObserver = this;
      observers.push(this);
    }
    observe(target) {
      this.target = target;
    }
    unobserve(target) {
      if (this.target === target) this.target = null;
    }
    disconnect() {
      this.target = null;
      const index = observers.indexOf(this);
      if (index >= 0) observers.splice(index, 1);
    }
    notify(entry) {
      this.callback([entry]);
    }
  };
}

function removeResizeObserver() {
  delete globalThis.ResizeObserver;
}

function base64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function decodeBase64(data) {
  return Buffer.from(data, "base64").toString("utf8");
}

const { useTerminal } = loadHook();

test("starts idle with no terminal id and no lines", () => {
  resetApi();
  installResizeObserver();
  try {
    const terminal = __mount(() => useTerminal(SESSION_ID));
    assert.equal(terminal.status, "idle");
    assert.equal(terminal.lines.length, 0);
    assert.equal(terminal.error, null);
    assert.equal(terminal.pending, false);
    assert.equal(terminal.terminalId, null);
  } finally {
    removeResizeObserver();
  }
});

test("open invokes terminalOpen directly without a renderer confirmation", async () => {
  resetApi();
  installResizeObserver();
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));
    assert.equal(terminal.status, "open");
    assert.equal(apiState.invokes.length, 1);
    assert.equal(apiState.invokes[0].method, "terminalOpen");
    assert.equal(apiState.invokes[0].input.sessionId, SESSION_ID);
    assert.equal(apiState.invokes[0].input.userConfirmed, true);
    assert.ok(terminal.terminalId);
    assert.equal(apiState.listeners.terminalOutput.length, 1);
    assert.equal(apiState.listeners.terminalChanged.length, 1);
  } finally {
    removeResizeObserver();
  }
});

test("open surfaces a main-process cancellation as an error status", async () => {
  resetApi();
  installResizeObserver();
  apiState.terminalOpen = async () => {
    apiState.invokes.push({ method: "terminalOpen" });
    const error = new Error("terminal open cancelled by user");
    error.code = "CANCELLED";
    throw error;
  };
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));
    assert.equal(terminal.status, "error");
    assert.equal(terminal.pending, false);
    assert.ok(terminal.error);
    assert.equal(apiState.listeners.terminalOutput.length, 0);
    assert.equal(apiState.listeners.terminalChanged.length, 0);
  } finally {
    removeResizeObserver();
  }
});

test("output events are decoded, filtered by terminal id, and bounded", async () => {
  resetApi();
  installResizeObserver();
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));
    const id = terminal.terminalId;

    apiState.emitOutput({ sessionId: SESSION_ID, terminalId: id, data: base64("hello") });
    terminal = __render(() => useTerminal(SESSION_ID));
    assert.equal(terminal.lines.length, 1);
    assert.equal(terminal.lines[0].text, "hello");

    apiState.emitOutput({ sessionId: SESSION_ID, terminalId: "other", data: base64("ignored") });
    terminal = __render(() => useTerminal(SESSION_ID));
    assert.equal(terminal.lines.length, 1);

    apiState.emitOutput({ sessionId: "other-session", terminalId: id, data: base64("ignored") });
    terminal = __render(() => useTerminal(SESSION_ID));
    assert.equal(terminal.lines.length, 1);
  } finally {
    removeResizeObserver();
  }
});

test("sendInput appends a carriage return for the PTY", async () => {
  resetApi();
  installResizeObserver();
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));
    await terminal.sendInput("ls -la");
    const inputCall = apiState.invokes.find((inv) => inv.method === "terminalInput");
    assert.ok(inputCall);
    assert.equal(inputCall.input.sessionId, SESSION_ID);
    assert.equal(inputCall.input.terminalId, terminal.terminalId);
    assert.equal(decodeBase64(inputCall.input.data), "ls -la\r");
  } finally {
    removeResizeObserver();
  }
});

test("sendInput does not double the carriage return when one is already present", async () => {
  resetApi();
  installResizeObserver();
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));
    await terminal.sendInput("ls\r");
    const inputCall = apiState.invokes.find((inv) => inv.method === "terminalInput");
    assert.equal(decodeBase64(inputCall.input.data), "ls\r");
  } finally {
    removeResizeObserver();
  }
});

test("sendInput ignores an empty command", async () => {
  resetApi();
  installResizeObserver();
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));
    await terminal.sendInput("");
    const inputCall = apiState.invokes.find((inv) => inv.method === "terminalInput");
    assert.equal(inputCall, undefined);
  } finally {
    removeResizeObserver();
  }
});

test("output sanitization removes ANSI, BEL, and backspace but preserves tab and newline", async () => {
  resetApi();
  installResizeObserver();
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));
    const id = terminal.terminalId;

    apiState.emitOutput({
      sessionId: SESSION_ID,
      terminalId: id,
      data: base64("a\x07b\x08c\td\n\x1B[31mred\x1B[0m"),
    });
    terminal = __render(() => useTerminal(SESSION_ID));
    assert.equal(terminal.lines.length, 2);
    assert.equal(terminal.lines[0].text, "abc\td");
    assert.equal(terminal.lines[1].text, "red");
  } finally {
    removeResizeObserver();
  }
});

test("resize observer sends terminalResize with computed dimensions", async () => {
  resetApi();
  installResizeObserver();
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    terminal.containerRef.current = {
      clientWidth: 720,
      clientHeight: 340,
    };
    await terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));
    lastObserver.notify({ contentRect: { width: 720, height: 340 } });
    // Wait for the resize debounce (100 ms).
    await new Promise((resolve) => setTimeout(resolve, 150));
    const resizeCall = apiState.invokes.find((inv) => inv.method === "terminalResize");
    assert.ok(resizeCall, "terminalResize was called");
    assert.equal(resizeCall.input.sessionId, SESSION_ID);
    assert.equal(resizeCall.input.terminalId, terminal.terminalId);
    assert.ok(Number.isInteger(resizeCall.input.cols) && resizeCall.input.cols > 0);
    assert.ok(Number.isInteger(resizeCall.input.rows) && resizeCall.input.rows > 0);
  } finally {
    removeResizeObserver();
  }
});

test("resize observer ignores a hidden zero-size container", async () => {
  resetApi();
  installResizeObserver();
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    terminal.containerRef.current = { clientWidth: 720, clientHeight: 340 };
    await terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));
    lastObserver.notify({ contentRect: { width: 0, height: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const resizeCalls = apiState.invokes.filter((inv) => inv.method === "terminalResize");
    assert.equal(resizeCalls.length, 0, "hidden container should not trigger a resize");
  } finally {
    removeResizeObserver();
  }
});


test("interrupt calls terminalInterrupt", async () => {
  resetApi();
  installResizeObserver();
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));
    await terminal.interrupt();
    const interruptCall = apiState.invokes.find((inv) => inv.method === "terminalInterrupt");
    assert.ok(interruptCall);
    assert.equal(interruptCall.input.sessionId, SESSION_ID);
    assert.equal(interruptCall.input.terminalId, terminal.terminalId);
  } finally {
    removeResizeObserver();
  }
});

test("close calls terminalClose and stops listeners", async () => {
  resetApi();
  installResizeObserver();
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));
    const previousId = terminal.terminalId;
    await terminal.close();
    terminal = __render(() => useTerminal(SESSION_ID));
    assert.equal(terminal.status, "closed");
    const closeCall = apiState.invokes.find((inv) => inv.method === "terminalClose");
    assert.ok(closeCall);
    assert.equal(closeCall.input.sessionId, SESSION_ID);
    assert.equal(closeCall.input.terminalId, previousId);
    assert.equal(terminal.terminalId, null);
    assert.equal(apiState.listeners.terminalOutput.length, 0);
    assert.equal(apiState.listeners.terminalChanged.length, 0);
    assert.equal(observers.length, 0);
  } finally {
    removeResizeObserver();
  }
});

test("session switch closes the terminal and cleans up", async () => {
  resetApi();
  installResizeObserver();
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));
    const previousId = terminal.terminalId;
    terminal = __render(() => useTerminal("sess-2"));
    const closeCall = apiState.invokes.find((inv) => inv.method === "terminalClose");
    assert.ok(closeCall);
    assert.equal(closeCall.input.sessionId, SESSION_ID);
    assert.equal(closeCall.input.terminalId, previousId);
    assert.equal(apiState.listeners.terminalOutput.length, 0);
    assert.equal(apiState.listeners.terminalChanged.length, 0);
    assert.equal(observers.length, 0);
  } finally {
    removeResizeObserver();
  }
});

test("terminalChanged exit updates status without double close", async () => {
  resetApi();
  installResizeObserver();
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));
    apiState.emitChanged({ sessionId: SESSION_ID, terminalId: terminal.terminalId, state: "exited", code: 0 });
    terminal = __render(() => useTerminal(SESSION_ID));
    assert.equal(terminal.status, "closed");
    assert.equal(apiState.invokes.filter((inv) => inv.method === "terminalClose").length, 0);
  } finally {
    removeResizeObserver();
  }
});

test("open error surfaces as error status without leaking listeners", async () => {
  resetApi();
  installResizeObserver();
  apiState.terminalOpen = async () => {
    apiState.invokes.push({ method: "terminalOpen" });
    const error = new Error("not allowed");
    error.code = "CAPABILITY_UNAVAILABLE";
    throw error;
  };
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));
    assert.equal(terminal.status, "error");
    assert.ok(terminal.error);
    assert.equal(apiState.listeners.terminalOutput.length, 0);
    assert.equal(apiState.listeners.terminalChanged.length, 0);
  } finally {
    removeResizeObserver();
  }
});

test("pagehide closes the terminal and detaches listeners", async () => {
  resetApi();
  installResizeObserver();
  const pagehideListeners = [];
  globalThis.window = {
    addEventListener: (name, handler) => {
      if (name === "pagehide") pagehideListeners.push(handler);
    },
    removeEventListener: (name, handler) => {
      if (name === "pagehide") {
        const index = pagehideListeners.indexOf(handler);
        if (index >= 0) pagehideListeners.splice(index, 1);
      }
    },
  };
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));
    const previousId = terminal.terminalId;
    assert.equal(pagehideListeners.length, 1);
    pagehideListeners[0]();
    terminal = __render(() => useTerminal(SESSION_ID));
    assert.equal(terminal.status, "closed");
    const closeCall = apiState.invokes.find((inv) => inv.method === "terminalClose");
    assert.ok(closeCall);
    assert.equal(closeCall.input.sessionId, SESSION_ID);
    assert.equal(closeCall.input.terminalId, previousId);
    assert.equal(apiState.listeners.terminalOutput.length, 0);
    assert.equal(apiState.listeners.terminalChanged.length, 0);
  } finally {
    removeResizeObserver();
    delete globalThis.window;
  }
});

test("stale open result is closed when the session changes while opening", async () => {
  resetApi();
  installResizeObserver();
  let resolveOpen;
  apiState.terminalOpen = async () => {
    apiState.invokes.push({ method: "terminalOpen" });
    await new Promise((resolve) => {
      resolveOpen = resolve;
    });
    return { terminalId: "term-stale-1", cols: 80, rows: 24, replay: "" };
  };
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    const openPromise = terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));
    assert.equal(terminal.pending, true);
    // Switch session before the open resolves.
    terminal = __render(() => useTerminal("sess-2"));
    resolveOpen();
    await openPromise;
    terminal = __render(() => useTerminal("sess-2"));
    // The orphan terminal opened for sess-1 must be closed, not wired to sess-2.
    const closeCall = apiState.invokes.find((inv) => inv.method === "terminalClose");
    assert.ok(closeCall);
    assert.equal(closeCall.input.sessionId, SESSION_ID);
    assert.equal(closeCall.input.terminalId, "term-stale-1");
    assert.equal(terminal.status, "idle");
    assert.equal(terminal.terminalId, null);
  } finally {
    removeResizeObserver();
  }
});

const REMOTE_SESSION_ID = "remote:host-a:sess-9";

test("a dropped host connection marks the terminal detached and keeps its id", async () => {
  resetApi();
  installResizeObserver();
  try {
    let terminal = __mount(() => useTerminal(REMOTE_SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(REMOTE_SESSION_ID));
    const id = terminal.terminalId;
    assert.equal(apiState.listeners.sessionsChanged.length, 1);

    apiState.emitSessionsChanged({ reason: "remote.disconnected", hostKey: "host-a" });
    terminal = __render(() => useTerminal(REMOTE_SESSION_ID));

    // The host-side PTY outlives the transport, so the shell is not "closed"
    // and the id must survive for the re-attach.
    assert.equal(terminal.status, "detached");
    assert.equal(terminal.terminalId, id);
    assert.equal(terminal.error, null);
  } finally {
    removeResizeObserver();
  }
});

test("a host reconnect re-attaches the same terminal id and reloads the host ring", async () => {
  resetApi();
  installResizeObserver();
  apiState.terminalOpen = async (input) => {
    apiState.invokes.push({ method: "terminalOpen", input });
    // The first open has no ring yet; the re-attach replays the host's whole
    // ring, reusing the id it was handed.
    return {
      terminalId: input.terminalId ?? "term-first",
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
      replay: input.terminalId ? base64("restored-output\n") : "",
    };
  };
  try {
    let terminal = __mount(() => useTerminal(REMOTE_SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(REMOTE_SESSION_ID));
    const id = terminal.terminalId;
    assert.equal(id, "term-first");

    // Pre-reconnect output stays until the replay replaces it.
    apiState.emitOutput({ sessionId: REMOTE_SESSION_ID, terminalId: id, data: base64("stale") });
    terminal = __render(() => useTerminal(REMOTE_SESSION_ID));
    assert.equal(terminal.lines.length, 1);

    apiState.emitSessionsChanged({ reason: "remote.reconnected", hostKey: "host-a" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    terminal = __render(() => useTerminal(REMOTE_SESSION_ID));

    const openCalls = apiState.invokes.filter((inv) => inv.method === "terminalOpen");
    assert.equal(openCalls.length, 2, "the reconnect issues one re-attach");
    assert.equal(openCalls[1].input.terminalId, id, "re-attach reuses the host-side terminal");
    assert.equal(openCalls[1].input.sessionId, REMOTE_SESSION_ID);
    assert.equal(terminal.status, "open");
    assert.equal(terminal.terminalId, id);
    assert.deepEqual(terminal.lines.map((line) => line.text), ["restored-output", ""]);
  } finally {
    removeResizeObserver();
  }
});

test("another host's reconnect never re-attaches this terminal", async () => {
  resetApi();
  installResizeObserver();
  try {
    let terminal = __mount(() => useTerminal(REMOTE_SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(REMOTE_SESSION_ID));

    apiState.emitSessionsChanged({ reason: "remote.reconnected", hostKey: "host-b" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    terminal = __render(() => useTerminal(REMOTE_SESSION_ID));

    const openCalls = apiState.invokes.filter((inv) => inv.method === "terminalOpen");
    assert.equal(openCalls.length, 1, "only the original open happened");
    assert.equal(terminal.status, "open");
  } finally {
    removeResizeObserver();
  }
});

test("a failed input keeps the terminal open and reports a visible action error", async () => {
  resetApi();
  installResizeObserver();
  apiState.terminalInput = async () => {
    throw new Error("host connection closed");
  };
  try {
    let terminal = __mount(() => useTerminal(SESSION_ID));
    await terminal.open();
    terminal = __render(() => useTerminal(SESSION_ID));

    await terminal.sendInput("ls");
    terminal = __render(() => useTerminal(SESSION_ID));

    // The session did not fail — only the command did, so the page must not
    // collapse into the fatal error state where the output disappears.
    assert.equal(terminal.status, "open");
    assert.equal(terminal.error, null);
    assert.match(terminal.actionError ?? "", /host connection closed/);

    terminal.dismissActionError();
    terminal = __render(() => useTerminal(SESSION_ID));
    assert.equal(terminal.actionError, null);
  } finally {
    removeResizeObserver();
  }
});