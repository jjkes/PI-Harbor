# ADR 0345: Browser Web Access Runs Plugin Views as Sandboxed Frames

- Status: Proposed
- Date: 2026-11-06
- Related: ADR 0104, ADR 0105, ADR 0342,
  `05-security/03-web-access-security.md`, ADR 0088

## Context

A plugin-contributed work panel view (ADR 0104) is a native
`WebContentsView` composited inside the desktop window. The renderer only
measures a rectangle and drives visibility
(`PluginViewTab.tsx`, `plugin-view-host.ts`), so a browser that serves the
same renderer bundle (ADR 0342) has nothing to put in that rectangle: the
view, and with it the bundled File Manager, is simply absent. Until the
accompanying policy fix, a browser tab could even open a view on the host's
own window through `pluginViewOpen`.

ADR 0342's device boundary is not the obstacle here. Opening a file, browsing
a directory, and editing text inside the project are owner actions that a
signed-in browser may perform; they are not actions on this computer's own
screen. What is missing is a way to run the view's page somewhere the browser
can display, without giving a plugin page the owner's IPC surface.

## Decision

1. **A browser runs a plugin view as a sandboxed frame.** The web renderer
   places an `<iframe sandbox="allow-scripts allow-forms allow-modals">`
   (no `allow-same-origin`, so the document has an opaque origin) where the
   desktop composites the native view. The desktop path is unchanged.
2. **No capability in a URL.** The shell document is served from a fixed
   authenticated route under `/__pi/`; it carries no session, view, or CSRF
   token. The view's HTML and JavaScript bytes travel over the existing
   bridge socket and become `blob:` URLs inside the frame, so ADR 0342's
   "no token ever appears in a URL" rule still holds.
3. **The frame's bridge is a shim, not IPC.** Inside the frame,
   `window.pluginBridge.invoke` and `.on` relay over `postMessage` to the web
   renderer, which forwards them over its bridge socket. Main resolves the
   plugin, the view, and the caller's session exactly as the desktop path
   does (`plugin-panel-host` bridge, plugin permissions, declared file scope)
   against a per-instance identity for that frame. The frame never reaches
   IPC, the bridge socket, the session cookie, or the CSRF token.
4. **Only the web-served document is relaxed.** `injectWebAccess` adds
   `frame-src 'self' blob:` and `worker-src 'self' blob:` to the document it
   serves. The desktop document's CSP is unchanged.
5. **The device boundary is reported to the plugin.** The shim exposes a
   capability flag. Actions that act on the host's screen or devices stay
   unavailable and the view hides them instead of failing: reveal in the OS,
   open with a desktop application, native file and folder pickers, native
   drag-and-drop paths, and audio capture. Clipboard writes go to the
   browser's clipboard through the parent renderer, never the host's.
6. **Lifecycle follows the tab.** The instance ends with the bridge socket,
   the tab, sign-out, session expiry, plugin reload, disable or uninstall, and
   a session or project switch. Nothing is attached to the desktop window.

## Consequences

- The File Manager works in a browser with the same permissions it has on the
  desktop, because the same handler and the same checks serve both callers.
  One implementation is not forked per surface.
- A plugin page in a browser is opaque-origin: it cannot read the app's
  storage, cookies, or DOM, and it cannot fetch on its own behalf.
- Web workers are blocked inside an opaque-origin frame (measured below), so a
  view that needs one runs its fallback path or loses that feature. PDF
  preview depends on this and must be verified against pdf.js's main-thread
  path before it is claimed.
- Clipboard writes cannot come from the frame (`NotAllowedError`, measured
  below), so the shim delegates them to the parent renderer.
- The plugin's JavaScript still runs with the plugin's own permissions. A
  plugin that reads files can read what the owner could read; that is the same
  trust as the desktop surface and is why installation remains a user grant.
- Two surfaces can show the same view at once, each with its own state. The
  desktop window and a browser tab must not share view state, bounds, or
  lifecycle.

## Spike evidence

Measured with the shipped `pi.file-manager` 0.9.1 view bundle in a headless
Chromium 157, in a frame with `sandbox="allow-scripts allow-forms
allow-modals"` served from a fixed same-origin route:

- the frame's origin is `null` and `localStorage` access throws;
- the 6,613,173-byte bundle was delivered over `postMessage` and executed from
  a `blob:` module URL;
- the real view mounted (`#root` had a child) and called
  `app.getAppearance`, `workspace.get`, `fm.hello`, `fm.list` through the shim;
- `new Worker(blobUrl, { type: "module" })` was blocked;
- `navigator.clipboard.writeText` failed with `NotAllowedError` even with
  `allow="clipboard-write"` on the frame.

The implementation run of the same frame with the shipped
`PLUGIN_VIEW_FRAME_HTML` added one constraint the first spike hid: a `blob:`
URL is scoped to the origin that minted it, so a frame with an opaque origin
cannot load one the app created ("Not allowed to load local resource"), and it
must mint its own from the bytes it is handed. With that, the real view mounted
and called `app.getAppearance`, `workspace.get`, `fm.hello`, and `fm.list`.

## Not decided here

- Whether PDF preview is offered in a browser. The shipped path has no web
  worker (blocked in an opaque-origin frame), so it depends on pdf.js's
  main-thread fallback being good enough.
- Plugin-side device actions. Main refuses the host APIs a frame must not use,
  but a plugin-defined channel that spawns a desktop application
  (`pi.file-manager`'s `fm.openWith`) is the plugin's own code. Until the
  bundled plugin reads `pluginBridge.capabilities.hostDevice` and hides those
  entries, clicking one on the web surface reports the failure instead of
  hiding it.
- Streaming the embedded browser's own page surface to a browser is a
  separate decision; ADR 0342 still answers links with the viewer's own tab.
