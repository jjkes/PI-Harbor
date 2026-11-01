import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { clearInterval, setInterval, setTimeout } from "node:timers";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  ErrorCodes,
  WEB_ACCESS_BRIDGE_PROTOCOL,
  WEB_ACCESS_CLOSE_UNAUTHORIZED,
  decodeWireValue,
  encodeWireValue,
  err,
  ok,
  type Result,
  type WebBridgeEventFrame,
  type WebBridgeResultFrame,
} from "@pi-harbor/shared";
import { forwardsEventToWeb, webChannelDecision } from "./channel-policy";

/**
 * The browser side of renderer IPC (ADR 0342). Each signed-in tab holds one
 * WebSocket. An `invoke` frame runs the same dispatcher the desktop window's
 * `ipcMain.handle` uses, and every event the desktop renderer receives is
 * fanned out to every open tab.
 */
export type RendererDispatcher = (
  channel: string,
  args: unknown[],
) => Promise<Result<unknown>>;

export type BridgeHub = {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    sessionToken: string,
  ): void;
  broadcast(channel: string, payload: unknown): void;
  closeAll(code: number, reason: string): void;
  clientCount(): number;
  dispose(): void;
};

type BridgeClient = {
  socket: WebSocket;
  sessionToken: string;
  alive: boolean;
};

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
/** A tab that stops reading is dropped instead of buffering without bound. */
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;
const FORCED_CLOSE_MS = 1_000;
const UNAVAILABLE = "This action is not available in web access.";

export function createBridgeHub(options: {
  getDispatcher: () => RendererDispatcher | null;
  /** Records activity; false when the session is gone. */
  touchSession: (token: string) => boolean;
  /** Checks without recording activity; false when the session is gone. */
  sessionAlive: (token: string) => boolean;
  onClientsChanged: () => void;
  onEncodeFailure: (channel: string, error: unknown) => void;
}): BridgeHub {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      protocols.has(WEB_ACCESS_BRIDGE_PROTOCOL) ? WEB_ACCESS_BRIDGE_PROTOCOL : false,
  });
  const clients = new Set<BridgeClient>();
  let heartbeat: NodeJS.Timeout | null = null;

  const startHeartbeat = () => {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
      for (const client of clients) {
        if (!client.alive) {
          client.socket.terminate();
          continue;
        }
        if (!options.sessionAlive(client.sessionToken)) {
          client.socket.close(WEB_ACCESS_CLOSE_UNAUTHORIZED, "session expired");
          continue;
        }
        client.alive = false;
        if (client.socket.readyState === WebSocket.OPEN) client.socket.ping();
      }
    }, HEARTBEAT_MS);
    heartbeat.unref();
  };

  const stopHeartbeat = () => {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = null;
  };

  const resolveInvoke = async (
    channel: string,
    args: unknown[],
  ): Promise<Result<unknown>> => {
    const decision = webChannelDecision(channel);
    if (decision === "noop") return ok({});
    if (decision === "deny") return err(ErrorCodes.UNSUPPORTED, UNAVAILABLE);
    const dispatch = options.getDispatcher();
    if (!dispatch) {
      return err(ErrorCodes.HOST_UNAVAILABLE, "PI Desktop is still starting.");
    }
    return dispatch(channel, args);
  };

  const handleMessage = async (client: BridgeClient, data: RawData, isBinary: boolean) => {
    if (!options.touchSession(client.sessionToken)) {
      client.socket.close(WEB_ACCESS_CLOSE_UNAUTHORIZED, "session expired");
      return;
    }
    if (isBinary) {
      client.socket.close(1003, "binary frames are not supported");
      return;
    }
    const frame = parseInvokeFrame(rawText(data));
    if (!frame) {
      client.socket.close(1007, "malformed frame");
      return;
    }
    let text: string;
    try {
      const decoded = decodeWireValue(frame.args);
      const value = await resolveInvoke(frame.channel, Array.isArray(decoded) ? decoded : []);
      const reply: WebBridgeResultFrame = {
        kind: "result",
        id: frame.id,
        ok: true,
        value: encodeWireValue(value),
      };
      text = JSON.stringify(reply);
    } catch (error) {
      // A reply structured clone could not carry rejects the call, as a
      // rejected `ipcRenderer.invoke` would.
      const reply: WebBridgeResultFrame = {
        kind: "result",
        id: frame.id,
        ok: false,
        message: describe(error),
      };
      text = JSON.stringify(reply);
    }
    sendText(client.socket, text);
  };

  const attach = (socket: WebSocket, sessionToken: string) => {
    const client: BridgeClient = { socket, sessionToken, alive: true };
    clients.add(client);
    startHeartbeat();
    options.onClientsChanged();
    socket.on("pong", () => {
      client.alive = true;
    });
    socket.on("message", (data, isBinary) => {
      client.alive = true;
      void handleMessage(client, data, isBinary);
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      if (!clients.delete(client)) return;
      if (clients.size === 0) stopHeartbeat();
      options.onClientsChanged();
    });
  };

  return {
    handleUpgrade(request, socket, head, sessionToken) {
      server.handleUpgrade(request, socket, head, (ws) => attach(ws, sessionToken));
    },
    broadcast(channel, payload) {
      if (clients.size === 0 || !forwardsEventToWeb(channel)) return;
      let text: string;
      try {
        const frame: WebBridgeEventFrame = {
          kind: "event",
          channel,
          payload: encodeWireValue(payload),
        };
        text = JSON.stringify(frame);
      } catch (error) {
        options.onEncodeFailure(channel, error);
        return;
      }
      for (const client of clients) sendText(client.socket, text);
    },
    closeAll(code, reason) {
      for (const client of [...clients]) {
        client.socket.close(code, reason);
        setTimeout(() => client.socket.terminate(), FORCED_CLOSE_MS).unref();
      }
    },
    clientCount: () => clients.size,
    dispose() {
      stopHeartbeat();
      for (const client of clients) client.socket.terminate();
      clients.clear();
      server.close();
    },
  };
}

function sendText(socket: WebSocket, text: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    socket.terminate();
    return;
  }
  socket.send(text);
}

function parseInvokeFrame(
  text: string,
): { id: number; channel: string; args: unknown } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.kind !== "invoke") return null;
  const { id, channel, args } = value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || typeof channel !== "string") {
    return null;
  }
  return { id, channel, args };
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
