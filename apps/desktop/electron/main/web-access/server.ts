import { STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { Duplex } from "node:stream";
import {
  WEB_ACCESS_BRIDGE_PROTOCOL,
  WEB_ACCESS_CSRF_PROTOCOL_PREFIX,
  WEB_ACCESS_ROUTES,
} from "@pi-harbor/shared";
import {
  injectWebAccess,
  proxyDevServer,
  sendStatus,
  serveBundle,
  type RendererSource,
} from "./assets";
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  clientKey,
  readCookie,
  sameSecret,
  sessionCookie,
  type LoginRateLimiter,
  type SessionStore,
} from "./auth";
import type { BridgeHub } from "./bridge";
import {
  LOGIN_NOTICES,
  LOGIN_PAGE_CSP,
  preferredLocale,
  renderLoginPage,
  type LoginNotice,
} from "./login-page";

/**
 * The HTTPS listener of browser web access (ADR 0342): the sign-in page, the
 * session cookie, the renderer files, and the WebSocket upgrade to the bridge.
 * Every route except sign-in requires a live session.
 */
export type WebAccessLogger = {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
};

export type WebAccessServerOptions = {
  /** Interface to listen on; `undefined` listens on every interface. */
  host: string | undefined;
  port: number;
  cert: string;
  key: string;
  renderer: RendererSource;
  /** Host OS, reported to the page so path and shell defaults stay the host's. */
  platform: NodeJS.Platform;
  sessions: SessionStore;
  limiter: LoginRateLimiter;
  hub: BridgeHub;
  verifyLogin: (username: string, password: string) => Promise<boolean>;
  logger: WebAccessLogger;
};

export type WebAccessServer = {
  readonly port: number;
  close(): Promise<void>;
};

const MAX_LOGIN_BODY_BYTES = 8 * 1024;
/** scrypt is memory-hard; bound how many password checks run at once. */
const MAX_CONCURRENT_LOGINS = 4;
const CLOSE_GOING_AWAY = 1001;
const HOST_PATTERN = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

export async function startWebAccessServer(
  options: WebAccessServerOptions,
): Promise<WebAccessServer> {
  let loginsInFlight = 0;

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    setBaseHeaders(response);
    const host = request.headers.host;
    const url = parseRequestUrl(request.url);
    if (!isValidHost(host) || !url) return sendStatus(response, 400);
    const method = request.method ?? "GET";
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);

    if (url.pathname === WEB_ACCESS_ROUTES.login) {
      if (method === "POST") return signIn(request, response, host);
      if (method === "GET" || method === "HEAD") {
        return sendLoginPage(request, response, url, token, method);
      }
      return sendStatus(response, 405);
    }
    if (url.pathname === WEB_ACCESS_ROUTES.logout) {
      if (method !== "POST") return sendStatus(response, 405);
      if (!isSameOrigin(request, host)) return sendStatus(response, 403);
      options.sessions.revoke(token);
      response.setHeader("set-cookie", clearedSessionCookie());
      return redirectToLogin(response, "signedOut");
    }
    if (method !== "GET" && method !== "HEAD") return sendStatus(response, 405);
    if (url.pathname === WEB_ACCESS_ROUTES.session) {
      return sendStatus(response, options.sessions.touch(token) ? 204 : 401);
    }

    const session = options.sessions.touch(token);
    if (!session) {
      if (acceptsHtml(request)) return redirectToLogin(response, null);
      return sendStatus(response, 401);
    }
    if (url.pathname.startsWith("/__pi/")) return sendStatus(response, 404);
    const transform = (html: string) =>
      injectWebAccess(html, {
        csrfToken: session.csrfToken,
        host,
        platform: options.platform,
      });
    if (options.renderer.kind === "dev-server") {
      proxyDevServer(
        options.renderer.origin,
        request,
        `${url.pathname}${url.search}`,
        response,
        transform,
      );
      return;
    }
    await serveBundle(options.renderer.root, url.pathname, method, response, transform);
  };

  const signIn = async (
    request: IncomingMessage,
    response: ServerResponse,
    host: string,
  ): Promise<void> => {
    if (!isSameOrigin(request, host)) return sendStatus(response, 403);
    if (!isFormRequest(request)) return sendStatus(response, 415);
    if (loginsInFlight >= MAX_CONCURRENT_LOGINS) return redirectToLogin(response, "busy");
    const client = clientKey(request.socket.remoteAddress);
    if (!options.limiter.begin(client)) {
      options.logger.warn("webAccess.loginLocked", { client });
      return redirectToLogin(response, "locked");
    }
    loginsInFlight += 1;
    let succeeded = false;
    try {
      const form = await readForm(request);
      if (form) {
        succeeded = await options.verifyLogin(
          form.get("username") ?? "",
          form.get("password") ?? "",
        );
      }
    } finally {
      loginsInFlight -= 1;
      options.limiter.finish(client, succeeded);
    }
    if (!succeeded) {
      options.logger.warn("webAccess.loginFailed", { client });
      return redirectToLogin(response, "invalid");
    }
    const { token } = options.sessions.create();
    options.logger.info("webAccess.loginSucceeded", { client });
    response.writeHead(303, { location: "/", "set-cookie": sessionCookie(token) });
    response.end();
  };

  const sendLoginPage = (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    token: string | null,
    method: string,
  ): void => {
    if (options.sessions.peek(token)) {
      response.writeHead(303, { location: "/" });
      response.end();
      return;
    }
    const requested = url.searchParams.get("notice");
    const notice = LOGIN_NOTICES.find((entry) => entry === requested) ?? null;
    const html = renderLoginPage(
      preferredLocale(request.headers["accept-language"]),
      notice,
      WEB_ACCESS_ROUTES.login,
    );
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": LOGIN_PAGE_CSP,
    });
    response.end(method === "HEAD" ? undefined : html);
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on("error", () => socket.destroy());
    const host = request.headers.host;
    const url = parseRequestUrl(request.url);
    if (!isValidHost(host) || !url) return rejectUpgrade(socket, 400);
    if (url.pathname !== WEB_ACCESS_ROUTES.bridge) return rejectUpgrade(socket, 404);
    if (!isSameOrigin(request, host)) return rejectUpgrade(socket, 403);
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const session = options.sessions.touch(token);
    if (!token || !session) return rejectUpgrade(socket, 401);
    const offered = offeredProtocols(request.headers["sec-websocket-protocol"]);
    const csrf = offered.find((value) => value.startsWith(WEB_ACCESS_CSRF_PROTOCOL_PREFIX));
    if (
      !offered.includes(WEB_ACCESS_BRIDGE_PROTOCOL) ||
      !csrf ||
      !sameSecret(csrf.slice(WEB_ACCESS_CSRF_PROTOCOL_PREFIX.length), session.csrfToken)
    ) {
      return rejectUpgrade(socket, 403);
    }
    options.hub.handleUpgrade(request, socket, head, token);
  };

  const server = createServer(
    { cert: options.cert, key: options.key, minVersion: "TLSv1.2" },
    (request, response) => {
      handleRequest(request, response).catch((error: unknown) => {
        options.logger.warn("webAccess.requestFailed", { message: describe(error) });
        if (!response.headersSent) sendStatus(response, 500);
        else response.destroy();
      });
    },
  );
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 256;
  server.on("upgrade", handleUpgrade);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
  server.on("error", (error) => {
    options.logger.warn("webAccess.serverError", { message: describe(error) });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        options.hub.closeAll(CLOSE_GOING_AWAY, "Web access stopped");
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function setBaseHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  // `same-origin` keeps the Origin header on same-origin form posts, which
  // sign-in and sign-out check; `no-referrer` would turn it into `null`.
  response.setHeader("referrer-policy", "same-origin");
  response.setHeader("x-frame-options", "SAMEORIGIN");
  response.setHeader("content-security-policy", "frame-ancestors 'self'");
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("cache-control", "no-store");
}

function parseRequestUrl(raw: string | undefined): URL | null {
  if (!raw || !raw.startsWith("/")) return null;
  try {
    return new URL(raw, "https://web-access.invalid");
  } catch {
    return null;
  }
}

function isValidHost(host: string | undefined): host is string {
  return typeof host === "string" && host.length <= 255 && HOST_PATTERN.test(host);
}

function isSameOrigin(request: IncomingMessage, host: string): boolean {
  const origin = request.headers.origin;
  return typeof origin === "string" && origin.toLowerCase() === `https://${host.toLowerCase()}`;
}

function isFormRequest(request: IncomingMessage): boolean {
  const type = request.headers["content-type"] ?? "";
  return type.split(";")[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

function acceptsHtml(request: IncomingMessage): boolean {
  return (request.headers.accept ?? "").includes("text/html");
}

function redirectToLogin(response: ServerResponse, notice: LoginNotice | null): void {
  const location = notice
    ? `${WEB_ACCESS_ROUTES.login}?notice=${notice}`
    : WEB_ACCESS_ROUTES.login;
  response.writeHead(303, { location });
  response.end();
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_LOGIN_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function offeredProtocols(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function rejectUpgrade(socket: Duplex, status: number): void {
  const reason = STATUS_CODES[status] ?? "Error";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
