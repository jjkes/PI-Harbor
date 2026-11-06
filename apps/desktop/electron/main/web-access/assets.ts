import { readFile, stat } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { WEB_ACCESS_CSRF_META, WEB_ACCESS_PLATFORM_META } from "@pi-harbor/shared";

/**
 * Serves the renderer to a signed-in browser (ADR 0342): the built bundle in
 * a packaged app, or the Vite dev server during development. Every HTML
 * document gets the session's CSRF token and a CSP that allows the bridge.
 */
export type RendererSource =
  | { kind: "bundle"; root: string }
  | { kind: "dev-server"; origin: string };

export type HtmlTransform = (html: string) => string;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/**
 * Adds the session's CSRF token and the host platform as meta tags, and lets
 * the page's CSP reach the bridge socket. `host` is the validated `Host`
 * header, so it is safe in both places.
 */
export function injectWebAccess(
  html: string,
  page: { csrfToken: string; host: string; platform: NodeJS.Platform },
): string {
  const meta = [
    `<meta name="${WEB_ACCESS_CSRF_META}" content="${page.csrfToken}" />`,
    `<meta name="${WEB_ACCESS_PLATFORM_META}" content="${page.platform}" />`,
  ].join("\n    ");
  const head = /<head(?:\s[^>]*)?>/i;
  const withMeta = head.test(html)
    ? html.replace(head, (tag) => `${tag}\n    ${meta}`)
    : `${meta}\n${html}`;
  const bridged = withMeta.replace(/connect-src /, () => `connect-src wss://${page.host} `);
  // A browser runs a plugin view in a sandboxed frame instead of a native view
  // (ADR 0345): the frame is same-origin, and its document and scripts arrive
  // as blob URLs. Only this served document is relaxed; the desktop document
  // keeps its own policy, which admits neither.
  return bridged.replace(
    "frame-src pi-genui:",
    "frame-src pi-genui: 'self' blob:; worker-src 'self' blob:",
  );
}

/** Maps a URL path inside the bundle root; null for anything that escapes it. */
export function resolveBundlePath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const target = decoded === "/" || decoded === "" ? "/index.html" : decoded;
  const base = resolve(root);
  const file = resolve(base, `.${target}`);
  const fromRoot = relative(base, file);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return null;
  }
  return file;
}

export async function serveBundle(
  root: string,
  pathname: string,
  method: string,
  response: ServerResponse,
  transformHtml: HtmlTransform,
): Promise<void> {
  const file = resolveBundlePath(root, pathname);
  if (!file) return sendStatus(response, 404);
  let body: Buffer;
  try {
    if (!(await stat(file)).isFile()) return sendStatus(response, 404);
    body = await readFile(file);
  } catch {
    return sendStatus(response, 404);
  }
  const extension = extname(file).toLowerCase();
  const contentType = CONTENT_TYPES[extension] ?? "application/octet-stream";
  if (extension === ".html") {
    const html = Buffer.from(transformHtml(body.toString("utf8")), "utf8");
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": html.length,
      "cache-control": "no-store",
    });
    response.end(method === "HEAD" ? undefined : html);
    return;
  }
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": pathname.startsWith("/assets/")
      ? "private, max-age=31536000, immutable"
      : "no-cache",
  });
  response.end(method === "HEAD" ? undefined : body);
}

/** Development only: forwards GET/HEAD to the local Vite server. */
export function proxyDevServer(
  origin: string,
  request: IncomingMessage,
  pathAndQuery: string,
  response: ServerResponse,
  transformHtml: HtmlTransform,
): void {
  const base = new URL(origin);
  const target = new URL(pathAndQuery, base);
  if (target.origin !== base.origin || target.protocol !== "http:") {
    sendStatus(response, 502);
    return;
  }
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  const upstream = httpRequest(
    target,
    { method, headers: { accept: request.headers.accept ?? "*/*" } },
    (reply) => {
      const status = reply.statusCode ?? 502;
      const contentType = String(reply.headers["content-type"] ?? "");
      if (contentType.includes("text/html")) {
        const chunks: Buffer[] = [];
        reply.on("data", (chunk: Buffer) => chunks.push(chunk));
        reply.on("error", () => sendStatus(response, 502));
        reply.on("end", () => {
          const html = Buffer.from(transformHtml(Buffer.concat(chunks).toString("utf8")), "utf8");
          response.writeHead(status, {
            "content-type": contentType,
            "content-length": html.length,
            "cache-control": "no-store",
          });
          response.end(method === "HEAD" ? undefined : html);
        });
        return;
      }
      const headers: Record<string, string> = { "cache-control": "no-cache" };
      if (contentType) headers["content-type"] = contentType;
      response.writeHead(status, headers);
      reply.pipe(response);
    },
  );
  upstream.on("error", () => sendStatus(response, 502));
  upstream.end();
}

export function sendStatus(response: ServerResponse, status: number): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(String(status));
}
