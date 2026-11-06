import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  ErrorCodes,
  type PluginWebViewAssetRef,
  type PluginWebViewEvent,
  type PluginWebViewInvokeRequest,
  type PluginWebViewOpenRequest,
  type PluginWebViewOpenResult,
} from "@pi-harbor/shared";

/**
 * Browser-side plugin views (ADR 0345).
 *
 * On the desktop a plugin view is a native `WebContentsView` the main process
 * composites; a browser cannot host one, so it runs the same page in a
 * sandboxed frame instead. That frame has no IPC, no bridge socket, and no
 * file system: it calls the four channels in `pluginWebView*` and this host
 * answers them.
 *
 * The host owns the identity a frame cannot be trusted to name. An instance
 * remembers which plugin, which view, and which session opened it, so every
 * later asset read and bridge call is answered for that identity rather than
 * for whatever the frame asks for. Asset paths are confined to the plugin
 * package, and the plugin bridge call goes through the same handler the desktop
 * view uses, so permissions, declared file scope, and audit are unchanged.
 */

/** A file a web view could not be given: a frame renders a page, not a disk. */
const MAX_ASSET_BYTES = 32 * 1024 * 1024;

/**
 * Plugin channels that act on this computer's own screen or devices.
 *
 * A bridge call from a browser frame reaches the same plugin as the desktop
 * does, and some of what a plugin can ask for only makes sense on the machine
 * in front of the owner: revealing a path in the OS, handing a file to a
 * desktop application, opening the host's browser, or registering a native
 * drag-and-drop path. The frame is refused those here (ADR 0342's device
 * boundary, applied to plugins).
 */
const HOST_DEVICE_CHANNELS: ReadonlySet<string> = new Set<string>([
  "fs.reveal",
  "fs.openDefault",
  "fs.openInBrowser",
  "fs.registerDropped",
  "app.launchURL",
]);

/** What this host needs from the plugin runtime; no Electron type leaks in. */
export type PluginWebViewSource = {
  path: string;
  permissions: ReadonlySet<string>;
  manifest: {
    contributes?: {
      views?: readonly { id?: string; entry?: string }[];
    };
  };
};

export type PluginWebViewHostDependencies = {
  getLoaded: (pluginId: string) => PluginWebViewSource | undefined;
  pluginActiveInProject: (pluginId: string) => boolean;
  /**
   * The plugin's own bridge, exactly as a docked view calls it. `sessionId` is
   * the session the view belongs to, so session-scoped plugin APIs keep
   * working for a browser caller.
   */
  bridge: (
    pluginId: string,
    channel: string,
    payload: Record<string, unknown> | undefined,
    context: { sessionId?: string },
  ) => Promise<unknown>;
  locale: () => string;
  theme: () => string;
  readTextFile: (absolutePath: string) => Promise<string>;
  readFile: (absolutePath: string) => Promise<Uint8Array>;
  exists: (absolutePath: string) => boolean;
  /** Overridable so a test can name instances. */
  randomId?: () => string;
};

type Instance = {
  pluginId: string;
  viewId: string;
  /** The session whose work panel opened this view, when one did. */
  sessionId?: string;
  /** Absolute plugin package root; every asset read is confined to it. */
  root: string;
};

function failure(code: string, message: string): Error {
  // Main's error shape carries the code the renderer shows (see ipc/register).
  return Object.assign(new Error(message), { errorCode: code });
}

/**
 * The references a view's document makes to files in its own package.
 *
 * Only same-package references are resolved: a scheme, a protocol-relative
 * URL, or a root-absolute path says the document expects a network the frame
 * does not have, and is left for the frame's CSP to refuse.
 */
export function referencedAssets(html: string, entryDir: string): PluginWebViewAssetRef[] {
  const found = new Map<string, string>();
  const tag = /<(script|link)\b([^>]*)>/gi;
  for (const match of html.matchAll(tag)) {
    const name = (match[1] ?? "").toLowerCase();
    const attributes = match[2] ?? "";
    const read = (key: string): string | null => {
      const attribute = new RegExp(`\\b${key}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attributes);
      if (!attribute) return null;
      return attribute[2] ?? attribute[3] ?? "";
    };
    const reference =
      name === "script"
        ? read("src")
        : /(^|\s)stylesheet(\s|$)/i.test(read("rel") ?? "")
          ? read("href")
          : null;
    if (!reference) continue;
    const path = resolveReference(reference, entryDir);
    if (path) found.set(reference, path);
  }
  return [...found].map(([reference, path]) => ({ reference, path }));
}

/**
 * A document reference as a plugin-relative path, or null when it does not
 * name a file in the package. The query and fragment are dropped: they address
 * the document, not a different file.
 */
function resolveReference(reference: string, entryDir: string): string | null {
  if (!reference || reference.startsWith("#")) return null;
  if (reference.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) return null;
  if (reference.startsWith("/")) return null;
  const pathOnly = reference.split(/[?#]/)[0] ?? "";
  const joined = normalize(join(entryDir, pathOnly));
  if (joined === ".." || joined.startsWith(`..${sep}`)) return null;
  if (isAbsolute(joined)) return null;
  return joined;
}

export class PluginWebViewHost {
  private deps: PluginWebViewHostDependencies;
  private instances = new Map<string, Instance>();
  private counter = 0;

  constructor(deps: PluginWebViewHostDependencies) {
    this.deps = deps;
  }

  /** Resolve, load, and register one frame's view. */
  async open(request: PluginWebViewOpenRequest): Promise<PluginWebViewOpenResult> {
    const pluginId = String(request?.pluginId ?? "").trim();
    const viewId = String(request?.viewId ?? "").trim();
    if (!pluginId || !viewId) {
      throw failure(ErrorCodes.INVALID_ARGUMENT, "a plugin view needs a plugin and a view");
    }
    const loaded = this.deps.getLoaded(pluginId);
    if (!loaded) throw failure(ErrorCodes.NOT_FOUND, "plugin not loaded");
    if (!loaded.permissions.has("ui.view")) {
      throw failure("PERMISSION_DENIED", "PERMISSION_DENIED: ui.view");
    }
    if (!this.deps.pluginActiveInProject(pluginId)) {
      throw failure("PERMISSION_DENIED", "plugin is not active in this project");
    }
    const view = (loaded.manifest.contributes?.views ?? []).find(
      (candidate) => String(candidate?.id ?? "") === viewId,
    );
    const entry = String(view?.entry ?? "").trim();
    if (!entry) throw failure(ErrorCodes.NOT_FOUND, "plugin has no such view");
    const htmlPath = this.resolveInside(loaded.path, entry);
    if (!htmlPath || !this.deps.exists(htmlPath)) {
      throw failure(ErrorCodes.NOT_FOUND, "view entry missing");
    }
    const html = await this.deps.readTextFile(htmlPath);
    const instanceId = this.deps.randomId?.() ?? `web-view-${++this.counter}`;
    this.instances.set(instanceId, {
      pluginId,
      viewId,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      root: resolve(loaded.path),
    });
    const entryDir = normalize(dirname(entry));
    return {
      instanceId,
      html,
      assets: referencedAssets(html, entryDir === "." ? "" : entryDir),
      locale: this.deps.locale(),
      theme: this.deps.theme(),
    };
  }

  /** One file the frame asked for, by plugin-relative path. */
  async asset(request: { instanceId?: string; path?: string }): Promise<Uint8Array> {
    const instance = this.requireInstance(request?.instanceId);
    const path = String(request?.path ?? "");
    const absolute = this.resolveInside(instance.root, path);
    if (!absolute || !this.deps.exists(absolute)) {
      throw failure(ErrorCodes.NOT_FOUND, "view asset not found");
    }
    const bytes = await this.deps.readFile(absolute);
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw failure(ErrorCodes.UNSUPPORTED, "view asset is too large");
    }
    return bytes;
  }

  /** One plugin bridge call, as the view's own plugin identity. */
  async invoke(request: PluginWebViewInvokeRequest): Promise<unknown> {
    const instance = this.requireInstance(request?.instanceId);
    const channel = String(request?.channel ?? "").trim();
    if (!channel) throw failure(ErrorCodes.INVALID_ARGUMENT, "a plugin bridge call needs a channel");
    if (HOST_DEVICE_CHANNELS.has(channel)) {
      throw failure(
        ErrorCodes.UNSUPPORTED,
        `${channel} acts on this computer's screen and is unavailable in web access`,
      );
    }
    const payload =
      request.payload && typeof request.payload === "object" ? request.payload : undefined;
    return this.deps.bridge(instance.pluginId, channel, payload, {
      ...(instance.sessionId ? { sessionId: instance.sessionId } : {}),
    });
  }

  /** Drop one instance. Closing an unknown instance is a no-op, not an error. */
  close(request: { instanceId?: string }): { ok: true } {
    const instanceId = String(request?.instanceId ?? "");
    if (instanceId) this.instances.delete(instanceId);
    return { ok: true };
  }

  /** Drop every instance a plugin owns — reload, disable, uninstall, crash. */
  closePlugin(pluginId: string): void {
    for (const [instanceId, instance] of [...this.instances]) {
      if (instance.pluginId === pluginId) this.instances.delete(instanceId);
    }
  }

  closeAll(): void {
    this.instances.clear();
  }

  /** How many frames are live; a test asserts cleanup, production never asks. */
  get size(): number {
    return this.instances.size;
  }

  /**
   * One one-way plugin event, addressed to the frames it belongs to.
   *
   * The desktop path writes the event straight into each view's web contents.
   * A browser frame is not a web contents, so the renderer relays these the
   * same way it relays calls.
   */
  broadcast(
    event: string,
    payload: unknown,
    filter?: (pluginId: string) => boolean,
  ): PluginWebViewEvent[] {
    const frames: PluginWebViewEvent[] = [];
    for (const [instanceId, instance] of this.instances) {
      if (filter && !filter(instance.pluginId)) continue;
      frames.push({ instanceId, event, payload });
    }
    return frames;
  }

  private requireInstance(instanceId: unknown): Instance {
    const id = String(instanceId ?? "");
    const instance = id ? this.instances.get(id) : undefined;
    if (!instance) throw failure(ErrorCodes.NOT_FOUND, "plugin view is not open");
    return instance;
  }

  /**
   * An absolute path inside `root`, or null.
   *
   * The frame names a path, so the answer must never leave the package: a
   * scheme, an absolute path, or a `..` that climbs out has no file behind it.
   */
  private resolveInside(root: string, path: string): string | null {
    if (!path || path.startsWith("/") || path.startsWith("\\")) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
    const base = resolve(root);
    const absolute = resolve(base, path);
    const fromRoot = relative(base, absolute);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      return null;
    }
    return absolute;
  }
}
