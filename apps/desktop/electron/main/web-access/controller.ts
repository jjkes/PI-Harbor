import { join } from "node:path";
import {
  ErrorCodes,
  WEB_ACCESS_CLOSE_UNAUTHORIZED,
  validateWebAccessInput,
  type WebAccessConfigureInput,
  type WebAccessState,
  type WebAccessStatus,
} from "@pi-harbor/shared";
import type { RendererSource } from "./assets";
import { createLoginRateLimiter, createSessionStore } from "./auth";
import { createBridgeHub, type RendererDispatcher } from "./bridge";
import {
  lanIPv4Addresses,
  loadCustomMaterial,
  loadSelfSignedMaterial,
  type TlsMaterial,
} from "./certificate";
import {
  defaultWebAccessConfig,
  loadWebAccessConfig,
  saveWebAccessConfig,
  webAccessDirectory,
  type WebAccessConfig,
} from "./config";
import { hashPassword, verifyCredentials } from "./password";
import { startWebAccessServer, type WebAccessLogger, type WebAccessServer } from "./server";

/**
 * Owns browser web access (ADR 0342): the persisted settings, the HTTPS
 * listener, the in-memory sessions, and the bridge hub. Every state change
 * runs through one queue, so a save cannot interleave with a start or stop.
 */
export type WebAccessController = {
  start(): Promise<void>;
  getStatus(): WebAccessStatus;
  configure(input: unknown): Promise<WebAccessStatus>;
  revokeSessions(): WebAccessStatus;
  /** Fans a renderer event out to signed-in browsers. */
  broadcast(channel: string, payload: unknown): void;
  setDispatcher(dispatcher: RendererDispatcher): void;
  dispose(): Promise<void>;
};

export function createWebAccessController(options: {
  dataDir: string;
  renderer: RendererSource;
  logger: WebAccessLogger;
  onStatusChanged: (status: WebAccessStatus) => void;
}): WebAccessController {
  let config: WebAccessConfig = defaultWebAccessConfig();
  let state: WebAccessState = "disabled";
  let lastError: string | null = null;
  let server: WebAccessServer | null = null;
  let tls: TlsMaterial | null = null;
  let dispatcher: RendererDispatcher | null = null;
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();

  const sessions = createSessionStore();
  const limiter = createLoginRateLimiter();
  const hub = createBridgeHub({
    getDispatcher: () => dispatcher,
    touchSession: (token) => sessions.touch(token) !== null,
    sessionAlive: (token) => sessions.peek(token) !== null,
    onClientsChanged: () => emit(),
    onEncodeFailure: (channel, error) => {
      options.logger.warn("webAccess.eventEncodeFailed", { channel, message: describe(error) });
    },
  });

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  }

  function emit(): void {
    if (!disposed) options.onStatusChanged(snapshot());
  }

  async function stopServer(): Promise<void> {
    const current = server;
    server = null;
    tls = null;
    if (current) await current.close();
  }

  async function startServer(): Promise<void> {
    await stopServer();
    lastError = null;
    if (!config.enabled) {
      state = "disabled";
      return;
    }
    if (!config.username || !config.passwordHash) {
      state = "error";
      lastError = "A username and password are required.";
      return;
    }
    state = "starting";
    emit();
    try {
      const material =
        config.tls.mode === "custom"
          ? await loadCustomMaterial(config.tls.certPath, config.tls.keyPath)
          : await loadSelfSignedMaterial(join(webAccessDirectory(options.dataDir), "tls"));
      server = await startWebAccessServer({
        host: config.bind === "loopback" ? "127.0.0.1" : undefined,
        port: config.port,
        cert: material.cert,
        key: material.key,
        renderer: options.renderer,
        platform: process.platform,
        sessions,
        limiter,
        hub,
        verifyLogin: (username, password) => verifyCredentials({ username, password }, config),
        logger: options.logger,
      });
      tls = material;
      state = "running";
      options.logger.info("webAccess.started", { bind: config.bind, port: server.port });
    } catch (error) {
      server = null;
      tls = null;
      state = "error";
      lastError = describeStartError(error);
      options.logger.warn("webAccess.startFailed", { message: lastError });
    }
  }

  function snapshot(): WebAccessStatus {
    const running = state === "running" && server !== null;
    return {
      enabled: config.enabled,
      state,
      bind: config.bind,
      port: server?.port ?? config.port,
      username: config.username,
      hasPassword: config.passwordHash.length > 0,
      tls: {
        mode: config.tls.mode,
        certPath: config.tls.certPath,
        keyPath: config.tls.keyPath,
        fingerprint256: running ? (tls?.fingerprint256 ?? null) : null,
        validTo: running ? (tls?.validTo ?? null) : null,
      },
      urls: running && server ? accessUrls(config.bind, server.port) : [],
      activeSessions: sessions.count(),
      connectedClients: hub.clientCount(),
      error: lastError,
    };
  }

  function start(): Promise<void> {
    return serialize(async () => {
      try {
        config = await loadWebAccessConfig(options.dataDir);
      } catch (error) {
        config = defaultWebAccessConfig();
        state = "error";
        lastError = `Web access settings could not be read: ${describe(error)}`;
        options.logger.warn("webAccess.configUnreadable", { message: describe(error) });
        return;
      }
      await startServer();
    }).then(() => emit());
  }

  function configure(raw: unknown): Promise<WebAccessStatus> {
    return serialize(async () => {
      const input = parseConfigureInput(raw);
      const problem = validateWebAccessInput(input, config.passwordHash.length > 0);
      if (problem) throw invalidArgument(problem);
      const next: WebAccessConfig = {
        enabled: input.enabled,
        bind: input.bind,
        port: input.port,
        username: input.username.trim(),
        passwordHash: input.password ? await hashPassword(input.password) : config.passwordHash,
        tls: {
          mode: input.tls.mode,
          certPath: input.tls.certPath?.trim() ?? "",
          keyPath: input.tls.keyPath?.trim() ?? "",
        },
      };
      const credentialsChanged =
        next.username !== config.username || next.passwordHash !== config.passwordHash;
      const listenerChanged =
        next.enabled !== config.enabled ||
        next.bind !== config.bind ||
        next.port !== config.port ||
        next.tls.mode !== config.tls.mode ||
        next.tls.certPath !== config.tls.certPath ||
        next.tls.keyPath !== config.tls.keyPath;
      await saveWebAccessConfig(options.dataDir, next);
      config = next;
      if (credentialsChanged || !next.enabled) {
        sessions.revokeAll();
        hub.closeAll(WEB_ACCESS_CLOSE_UNAUTHORIZED, "Signed out");
      }
      if (!next.enabled) {
        await stopServer();
        state = "disabled";
        lastError = null;
      } else if (listenerChanged || !server) {
        await startServer();
      }
      options.logger.info("webAccess.configured", {
        enabled: next.enabled,
        bind: next.bind,
        port: next.port,
        tls: next.tls.mode,
      });
      return snapshot();
    }).then((status) => {
      emit();
      return status;
    });
  }

  function revokeSessions(): WebAccessStatus {
    sessions.revokeAll();
    hub.closeAll(WEB_ACCESS_CLOSE_UNAUTHORIZED, "Signed out");
    options.logger.info("webAccess.sessionsRevoked", {});
    const status = snapshot();
    emit();
    return status;
  }

  function dispose(): Promise<void> {
    disposed = true;
    return serialize(async () => {
      sessions.revokeAll();
      await stopServer();
      hub.dispose();
    });
  }

  return {
    start,
    getStatus: snapshot,
    configure,
    revokeSessions,
    broadcast: (channel, payload) => hub.broadcast(channel, payload),
    setDispatcher: (next) => {
      dispatcher = next;
    },
    dispose,
  };
}

/** Structural check of the untrusted IPC input; value rules live in shared. */
function parseConfigureInput(raw: unknown): WebAccessConfigureInput {
  if (!isRecord(raw)) throw invalidArgument("input");
  const tls = raw.tls;
  if (!isRecord(tls)) throw invalidArgument("input");
  const { enabled, bind, port, username, password } = raw;
  const { mode, certPath, keyPath } = tls;
  if (
    typeof enabled !== "boolean" ||
    (bind !== "loopback" && bind !== "all") ||
    typeof port !== "number" ||
    typeof username !== "string" ||
    (password !== undefined && typeof password !== "string") ||
    (mode !== "self-signed" && mode !== "custom") ||
    (certPath !== undefined && typeof certPath !== "string") ||
    (keyPath !== undefined && typeof keyPath !== "string")
  ) {
    throw invalidArgument("input");
  }
  return { enabled, bind, port, username, password, tls: { mode, certPath, keyPath } };
}

function accessUrls(bind: WebAccessConfig["bind"], port: number): string[] {
  const hosts = bind === "loopback" ? ["127.0.0.1"] : ["localhost", ...lanIPv4Addresses()];
  return [...new Set(hosts)].map((host) => `https://${host}:${port}`);
}

function describeStartError(error: unknown): string {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
  if (code === "EADDRINUSE") return "The port is already in use.";
  if (code === "EACCES") return "Permission was denied for the port or the certificate files.";
  if (code === "ENOENT") return "The certificate or key file was not found.";
  return describe(error);
}

function invalidArgument(problem: string): Error {
  return Object.assign(new Error(`Invalid web access settings: ${problem}`), {
    errorCode: ErrorCodes.INVALID_ARGUMENT,
    data: { problem },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
