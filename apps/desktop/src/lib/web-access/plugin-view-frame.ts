/**
 * The sandboxed frame a browser uses instead of a native plugin view
 * (ADR 0345).
 *
 * The desktop composites a `WebContentsView` with the plugin's preload bridge.
 * A browser cannot, so it mounts the same view document in an iframe with an
 * opaque origin and supplies `window.pluginBridge` from inside the frame. The
 * frame's only channel is `postMessage` to the renderer, which relays each call
 * over the authenticated bridge; the frame never sees IPC, the session cookie,
 * or the CSRF token.
 *
 * Asset bytes are mounted *inside* the frame: a `blob:` URL is scoped to the
 * origin that minted it, and an opaque origin cannot load one the app made, so
 * the frame builds its own from the bytes it is handed.
 */

/** Messages from the frame to the renderer. */
export const PLUGIN_VIEW_FRAME_SOURCE = "pi-plugin-view";
/** Messages from the renderer to the frame. */
export const PLUGIN_VIEW_HOST_SOURCE = "pi-host";

/**
 * What the frame's document may do. `allow-same-origin` is deliberately absent:
 * without it the document has an opaque origin, so it cannot read the app's
 * storage, cookies, or DOM.
 */
export const PLUGIN_VIEW_FRAME_SANDBOX = "allow-scripts allow-forms allow-modals";

const BLOB_TYPES: Record<string, string> = {
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  map: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  txt: "text/plain",
};

/** The `Blob` type for one plugin-relative path; binary by default. */
export function blobTypeFor(path: string): string {
  const extension = path.split(/[?#]/)[0]?.split(".").pop()?.toLowerCase() ?? "";
  return BLOB_TYPES[extension] ?? "application/octet-stream";
}

/** One document reference, ready to become a `blob:` URL inside the frame. */
export type PluginViewFrameAsset = {
  /** The literal attribute value, e.g. `./assets/index.js`. */
  reference: string;
  /** The `Blob` type for those bytes. */
  type: string;
  bytes: ArrayBuffer;
};

/**
 * The frame's own document.
 *
 * It is injected with `srcdoc`, so it has no URL: there is nothing to put a
 * capability in. It installs `pluginBridge` before the view's script runs,
 * relays calls, forwards events, and mounts the view's document and assets on
 * request. `navigator.clipboard.writeText` is delegated to the renderer because
 * a sandboxed frame cannot write the browser's clipboard from its opaque
 * origin.
 */
export const PLUGIN_VIEW_FRAME_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; height: 100%; }
    </style>
  </head>
  <body>
    <script>
      (() => {
        const SOURCE = "${PLUGIN_VIEW_FRAME_SOURCE}";
        const HOST = "${PLUGIN_VIEW_HOST_SOURCE}";
        const pending = new Map();
        const listeners = new Map();
        const mounted = [];
        let nextId = 1;
        const post = (message) => parent.postMessage(message, "*");

        const bridge = {
          // A browser frame reaches no host device (ADR 0345); a view hides what
          // it cannot do instead of failing on click.
          capabilities: { hostDevice: false, clipboard: "browser" },
          invoke(channel, payload) {
            return new Promise((resolve, reject) => {
              const id = nextId++;
              pending.set(id, { resolve, reject });
              post({ source: SOURCE, kind: "invoke", id, channel: String(channel), payload });
            });
          },
          on(event, handler) {
            const set = listeners.get(event) || new Set();
            set.add(handler);
            listeners.set(event, set);
            return () => set.delete(handler);
          },
        };
        window.pluginBridge = bridge;

        try {
          if (navigator.clipboard) {
            navigator.clipboard.writeText = (text) => {
              post({ source: SOURCE, kind: "clipboard", text: String(text) });
              return Promise.resolve();
            };
          }
        } catch (error) {
          // A clipboard the frame cannot redirect stays unavailable; the view
          // reports its own failure when it uses it.
        }

        const mount = (message) => {
          document.documentElement.dataset.theme = message.theme || "dark";
          if (message.locale) document.documentElement.lang = message.locale;
          const urls = new Map();
          for (const asset of message.assets || []) {
            try {
              const url = URL.createObjectURL(
                new Blob([asset.bytes], { type: asset.type || "application/octet-stream" }),
              );
              urls.set(asset.reference, url);
              mounted.push(url);
            } catch (error) {
              // An asset the frame cannot turn into a URL is one the document
              // will go without; the view reports what it cannot do.
            }
          }
          let parsed;
          try {
            parsed = new DOMParser().parseFromString(String(message.html || ""), "text/html");
          } catch (error) {
            post({ source: SOURCE, kind: "failed", message: "view document could not be parsed" });
            return;
          }
          for (const node of Array.from(parsed.body ? parsed.body.childNodes : [])) {
            document.body.appendChild(document.importNode(node, true));
          }
          for (const link of Array.from(parsed.querySelectorAll('link[rel~="stylesheet"]'))) {
            const url = urls.get(link.getAttribute("href") || "");
            if (!url) continue;
            const styled = document.createElement("link");
            styled.rel = "stylesheet";
            styled.href = url;
            document.head.appendChild(styled);
          }
          for (const script of Array.from(parsed.querySelectorAll("script[src]"))) {
            const url = urls.get(script.getAttribute("src") || "");
            if (!url) continue;
            const element = document.createElement("script");
            if (script.type) element.type = script.type;
            for (const attribute of Array.from(script.attributes)) {
              if (attribute.name === "src" || attribute.name === "type") continue;
              element.setAttribute(attribute.name, attribute.value);
            }
            element.src = url;
            document.head.appendChild(element);
          }
          post({ source: SOURCE, kind: "mounted" });
        };

        addEventListener("message", (event) => {
          const data = event.data;
          if (!data || data.source !== HOST) return;
          if (data.kind === "result") {
            const entry = pending.get(data.id);
            if (!entry) return;
            pending.delete(data.id);
            if (data.ok) entry.resolve(data.value);
            else entry.reject(new Error(String(data.message || "plugin bridge call failed")));
            return;
          }
          if (data.kind === "event") {
            for (const handler of listeners.get(data.event) || []) {
              try {
                handler(data.payload);
              } catch (error) {
                // One subscriber that throws must not starve the others.
              }
            }
            return;
          }
          if (data.kind === "mount") mount(data);
        });

        post({ source: SOURCE, kind: "ready" });
      })();
    </script>
  </body>
</html>`;

/** A message the frame sent; anything else is ignored. */
export type PluginViewFrameMessage =
  | { source: typeof PLUGIN_VIEW_FRAME_SOURCE; kind: "ready" }
  | { source: typeof PLUGIN_VIEW_FRAME_SOURCE; kind: "mounted" }
  | { source: typeof PLUGIN_VIEW_FRAME_SOURCE; kind: "failed"; message?: string }
  | {
      source: typeof PLUGIN_VIEW_FRAME_SOURCE;
      kind: "invoke";
      id: number;
      channel: string;
      payload?: unknown;
    }
  | { source: typeof PLUGIN_VIEW_FRAME_SOURCE; kind: "clipboard"; text: string };

/** Narrow an inbound `postMessage` payload to a message this component serves. */
export function isPluginViewFrameMessage(value: unknown): value is PluginViewFrameMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { source?: unknown; kind?: unknown };
  if (message.source !== PLUGIN_VIEW_FRAME_SOURCE) return false;
  return (
    message.kind === "ready" ||
    message.kind === "mounted" ||
    message.kind === "failed" ||
    message.kind === "invoke" ||
    message.kind === "clipboard"
  );
}
