// A minimal Chrome DevTools Protocol client over Node's WebSocket global, for
// harnesses that drive a built Electron app. Shared by the desktop E2E
// scenarios in `desktop-app.mjs`.

const SEND_TIMEOUT_MS = 12_000;

function cdpError(message) {
  const error = new Error(message);
  error.cdp = true;
  return error;
}

function exceptionText(details, fallback) {
  return details?.exception?.description || details?.text || fallback;
}

export async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`CDP /json/list returned HTTP ${response.status}`);
  return response.json();
}

export class CdpClient {
  constructor(onFailure) {
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.onFailure = onFailure;
    this.closed = false;
  }

  /** Connect to one target; `onFailure` hears an unexpected close or error. */
  static async connect(url, onFailure) {
    if (typeof WebSocket !== "function") throw new Error("Node's WebSocket global is unavailable");
    const client = new CdpClient(onFailure);
    await new Promise((resolveOpen, rejectOpen) => {
      const socket = new WebSocket(url);
      client.socket = socket;
      socket.addEventListener("open", resolveOpen, { once: true });
      socket.addEventListener("error", () => rejectOpen(new Error(`CDP connection failed: ${url}`)), { once: true });
    });
    client.socket.addEventListener("message", (event) => client.receive(String(event.data)));
    client.socket.addEventListener("close", () => client.fail(cdpError("CDP WebSocket closed unexpectedly")));
    return client;
  }

  receive(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      this.fail(cdpError(`invalid CDP message: ${error}`));
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(cdpError(`CDP ${entry.method} failed: ${message.error.message}`));
      else entry.resolve(message.result);
      return;
    }
    for (const listener of this.handlers.get(message.method) ?? []) listener(message.params ?? {});
  }

  /** Reject everything pending and report the failure once. */
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.onFailure?.(error);
  }

  on(method, listener) {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), listener]);
    return () => this.handlers.set(method, (this.handlers.get(method) ?? []).filter((item) => item !== listener));
  }

  send(method, params = {}, timeoutMs = SEND_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(cdpError(`CDP is closed; cannot send ${method}`));
    const id = this.nextId++;
    return new Promise((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) rejectResult(cdpError(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolveResult, reject: rejectResult, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate in a page and return the value; a thrown error rejects. */
  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (response?.exceptionDetails) {
      throw new Error(`evaluation failed: ${exceptionText(response.exceptionDetails, "page evaluation threw")}`);
    }
    return response?.result?.value;
  }

  /**
   * Evaluate in Electron Main. Its inspector does not await promises for
   * `Runtime.evaluate`, so a returned promise is awaited separately.
   */
  async evaluateMain(expression) {
    const response = await this.send("Runtime.evaluate", { expression, awaitPromise: false, returnByValue: false });
    if (response?.exceptionDetails) {
      throw new Error(`Main evaluation failed: ${exceptionText(response.exceptionDetails, "Main evaluation threw")}`);
    }
    const remote = response?.result;
    if (remote?.subtype !== "promise" || !remote.objectId) return remote?.value;
    const awaited = await this.send("Runtime.awaitPromise", { promiseObjectId: remote.objectId, returnByValue: true });
    if (awaited?.exceptionDetails) {
      throw new Error(`Main evaluation failed: ${exceptionText(awaited.exceptionDetails, "Main promise rejected")}`);
    }
    return awaited?.result?.value;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("CDP closed by the harness"));
    }
    this.pending.clear();
    try {
      this.socket?.close();
    } catch {
      // Already closing.
    }
  }
}
