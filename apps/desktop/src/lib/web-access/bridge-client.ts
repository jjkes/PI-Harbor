import {
  ErrorCodes,
  IPC,
  IPC_WHITELIST,
  WEB_ACCESS_BRIDGE_PROTOCOL,
  WEB_ACCESS_CLOSE_UNAUTHORIZED,
  WEB_ACCESS_CSRF_PROTOCOL_PREFIX,
  WEB_ACCESS_ROUTES,
  decodeWireValue,
  encodeWireValue,
  err,
  ok,
  type Result,
} from "@pi-harbor/shared";

/**
 * The browser replacement for the Electron preload bridge (ADR 0342): the
 * same `invoke` / `on` surface as `window.piDesktop`, carried over one
 * WebSocket to Electron Main.
 */
export type PiDesktopBridge = NonNullable<Window["piDesktop"]>;

/** The part of a WebSocket the bridge uses; tests pass a fake. */
export type BridgeSocket = {
  readonly readyState: number;
  send(data: string): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (data: unknown) => void): void;
  onClose(listener: (code: number) => void): void;
};

export type WebAccessBridgeOptions = {
  csrfToken: string;
  /** `wss://<host>/__pi/bridge`. */
  url: string;
  /** The host computer's platform, from the served page. */
  platform: NodeJS.Platform;
  locale?: string;
  connect?: (url: string, protocols: string[]) => BridgeSocket;
  /** True while the session cookie is valid; rejects while the host is unreachable. */
  checkSession?: () => Promise<boolean>;
  onSignedOut?: () => void;
  /** Events were missed while disconnected; the default reloads the page. */
  onReconnected?: () => void;
  openExternal?: (url: string) => void;
  schedule?: (callback: () => void, delayMs: number) => void;
  reportError?: (error: unknown) => void;
};

const SOCKET_OPEN = 1;
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];
const CONNECTION_LOST = "Web access connection lost";

type PendingCall = {
  resolve: (value: Result<unknown>) => void;
  reject: (error: Error) => void;
};
type ListenerEntry = { listener: (...args: unknown[]) => void };

export function createWebAccessBridge(options: WebAccessBridgeOptions): PiDesktopBridge {
  const connect = options.connect ?? browserSocket;
  const checkSession = options.checkSession ?? fetchSessionState;
  const onSignedOut =
    options.onSignedOut ?? (() => window.location.assign(WEB_ACCESS_ROUTES.login));
  const onReconnected = options.onReconnected ?? (() => window.location.reload());
  const openExternal =
    options.openExternal ??
    ((url: string) => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number) => {
      setTimeout(callback, delayMs);
    });
  // Rethrown outside the dispatch loop, so it surfaces as an uncaught error
  // the way a throwing `ipcRenderer.on` listener does in the desktop window.
  const reportError =
    options.reportError ??
    ((error: unknown) => {
      setTimeout(() => {
        throw error;
      }, 0);
    });

  const pending = new Map<number, PendingCall>();
  const queued: string[] = [];
  const listeners = new Map<string, Set<ListenerEntry>>();
  let socket: BridgeSocket | null = null;
  let everConnected = false;
  let stopped = false;
  let attempt = 0;
  let nextId = 1;

  const failPending = () => {
    queued.length = 0;
    const error = new Error(CONNECTION_LOST);
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };

  const signOut = () => {
    stopped = true;
    onSignedOut();
  };

  const scheduleRetry = () => {
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    attempt += 1;
    schedule(() => {
      checkSession().then(
        (valid) => {
          if (valid) open();
          else signOut();
        },
        () => scheduleRetry(),
      );
    }, delay);
  };

  const handleFrame = (text: string) => {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(frame)) return;
    if (frame.kind === "result" && typeof frame.id === "number") {
      const call = pending.get(frame.id);
      if (!call) return;
      pending.delete(frame.id);
      if (frame.ok === true) {
        const value = safeDecode(frame.value);
        if (isResult(value)) call.resolve(value);
        else call.reject(new Error("Malformed web access reply"));
      } else {
        call.reject(new Error(typeof frame.message === "string" ? frame.message : CONNECTION_LOST));
      }
      return;
    }
    if (frame.kind === "event" && typeof frame.channel === "string") {
      const registered = listeners.get(frame.channel);
      if (!registered || registered.size === 0) return;
      const payload = safeDecode(frame.payload);
      for (const entry of [...registered]) {
        try {
          entry.listener(payload);
        } catch (error) {
          reportError(error);
        }
      }
    }
  };

  const open = () => {
    const current = connect(options.url, [
      WEB_ACCESS_BRIDGE_PROTOCOL,
      `${WEB_ACCESS_CSRF_PROTOCOL_PREFIX}${options.csrfToken}`,
    ]);
    socket = current;
    current.onOpen(() => {
      if (socket !== current) return;
      attempt = 0;
      if (everConnected) {
        // Events were missed while the socket was down. A reload rebuilds the
        // renderer state from Main, as a desktop renderer reload does.
        onReconnected();
        return;
      }
      everConnected = true;
      for (const frame of queued.splice(0)) current.send(frame);
    });
    current.onMessage((data) => {
      if (socket === current && typeof data === "string") handleFrame(data);
    });
    current.onClose((code) => {
      if (socket !== current) return;
      socket = null;
      failPending();
      if (code === WEB_ACCESS_CLOSE_UNAUTHORIZED) signOut();
      else scheduleRetry();
    });
  };

  const openLocally = (input: unknown): Result<unknown> => {
    const url = isRecord(input) && typeof input.url === "string" ? input.url : "";
    if (!/^https?:\/\//i.test(url)) {
      return err(ErrorCodes.UNSUPPORTED, "Only web links can be opened from web access.");
    }
    openExternal(url);
    return ok(null);
  };

  const send = (channel: string, args: unknown[]): Promise<Result<unknown>> => {
    if (!IPC_WHITELIST.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`));
    }
    // The embedded browser panel does not exist here; a link opens in a new tab.
    if (channel === IPC.invoke.browserOpenExternal) return Promise.resolve(openLocally(args[0]));
    if (stopped || (everConnected && socket?.readyState !== SOCKET_OPEN)) {
      return Promise.reject(new Error(CONNECTION_LOST));
    }
    let encoded: unknown;
    try {
      encoded = encodeWireValue(args);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const id = nextId;
    nextId += 1;
    const frame = JSON.stringify({ kind: "invoke", id, channel, args: encoded });
    return new Promise<Result<unknown>>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      if (socket && socket.readyState === SOCKET_OPEN) socket.send(frame);
      else queued.push(frame);
    });
  };

  const invoke = <T = unknown>(channel: string, ...args: unknown[]): Promise<Result<T>> =>
    // The reply is the handler's own `Result`, typed by the caller exactly as
    // the preload bridge's `ipcRenderer.invoke` reply is.
    send(channel, args) as Promise<Result<T>>;

  const on = (channel: string, listener: (...args: unknown[]) => void) => {
    if (!IPC_WHITELIST.has(channel)) throw new Error(`IPC channel not allowed: ${channel}`);
    const entry: ListenerEntry = { listener };
    const registered = listeners.get(channel) ?? new Set<ListenerEntry>();
    listeners.set(channel, registered);
    registered.add(entry);
    return () => {
      registered.delete(entry);
    };
  };

  open();
  return {
    invoke,
    on,
    // Live voice needs a MessagePort from Main; it is unavailable here.
    onLiveVoicePort: () => () => undefined,
    channels: IPC,
    platform: options.platform,
    locale: options.locale,
    // A browser never exposes where a dropped file lives on the host computer.
    getDroppedFilePath: () => null,
  };
}

function browserSocket(url: string, protocols: string[]): BridgeSocket {
  const socket = new WebSocket(url, protocols);
  return {
    get readyState() {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    onOpen: (listener) => socket.addEventListener("open", () => listener()),
    onMessage: (listener) => socket.addEventListener("message", (event) => listener(event.data)),
    onClose: (listener) => socket.addEventListener("close", (event) => listener(event.code)),
  };
}

async function fetchSessionState(): Promise<boolean> {
  const response = await fetch(WEB_ACCESS_ROUTES.session, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 204) return true;
  if (response.status === 401) return false;
  throw new Error(`Unexpected web access session status ${response.status}`);
}

function safeDecode(value: unknown): unknown {
  try {
    return decodeWireValue(value);
  } catch {
    return undefined;
  }
}

function isResult(value: unknown): value is Result<unknown> {
  return isRecord(value) && typeof value.ok === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
