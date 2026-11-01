# ADR 0342: Browser Web Access Serves the Desktop Renderer to the Signed-In Owner

- Status: Accepted
- Date: 2026-11-01
- Related: ADR 0203, ADR 0205,
  `05-security/03-web-access-security.md`,
  `05-security/02-remote-control-security.md`

## Context

The owner wants to use the desktop interface from a browser on another
device: open an address, sign in with a username and password, and work as in
the desktop window.

The renderer reaches Electron Main only through the preload bridge
(`window.piDesktop`), which forwards whitelisted IPC channels. A browser has
no preload bridge. ADR 0205 rejected exposing that IPC for remote agent
control: RACP clients are separate principals with roles, a permission
ceiling, and shared-session semantics, and generic IPC would bypass those
boundaries and make the Electron process a public backend.

Browser web access is a different trust problem. The browser is not a second
principal. Whoever signs in is the owner of this installation, with the same
authority as the person at the desktop. The question is how to give the owner
that interface from elsewhere without weakening anything for people who never
sign in.

## Decision

1. **Opt-in HTTPS listener in Electron Main.** The Web access card in
   Settings turns on a listener that is off by default. The owner chooses the
   network scope (every interface, the default once enabled, or loopback
   only), the port (default 39321), the account, and the certificate. Only
   HTTPS is served, with TLS 1.2 or newer.
2. **Same renderer, replacement bridge.** The listener serves the renderer
   bundle, or proxies the Vite dev server in development. The served document
   carries the session's CSRF token and the host's `process.platform` as meta
   tags. `src/lib/web-access/install.ts`, the first import of `main.tsx`,
   installs a `window.piDesktop` whose `invoke` and `on` run over one
   WebSocket (`/__pi/bridge`). The wire codec in
   `packages/shared/src/web-access.ts` keeps what structured clone keeps
   (`undefined`, non-finite numbers, dates, binary data, maps, sets, errors)
   and rejects what it rejects.
3. **One dispatcher.** `register.ts` builds a single renderer dispatcher
   (remote-host routing plus the `Result` wrapper) for every channel
   registered through `handle()`. `ipcMain.handle` and the browser bridge
   both call it. Events reach browsers through `sendToRenderer`, the fan-out
   the desktop window already uses.
4. **Owner-equivalent, with a device boundary.** A signed-in browser reaches
   every channel in that dispatcher except those that act on this computer's
   own screen or devices, or on web access itself: native dialogs, window and
   devtools control, quitting, revealing or opening paths in the OS, the
   embedded browser panel, voice capture, storage relocation, and the web
   access settings. `channel-policy.ts` holds that list. Desktop layout
   signals (work panel reservation, background color, renderer-ready
   handshakes) answer as no-ops. Channels registered with `handleWithEvent`
   or directly on `ipcMain` are not in the dispatcher and answer
   `UNSUPPORTED`.
5. **Single owner account.** One username and a password of 10 to 256
   characters, stored only as a scrypt hash in an owner-only file under the
   data directory. Sessions live in Main's memory and end on restart, after
   24 hours idle, 7 days after sign-in, on sign-out, when the credentials
   change, when web access is turned off, and when the owner signs every
   browser out from Settings. Five failed sign-ins from one address lock it
   out for 15 minutes.
6. **Browser request integrity.** The session cookie is `__Host-` prefixed,
   `Secure`, `HttpOnly`, and `SameSite=Strict`. Sign-in, sign-out, and the
   WebSocket upgrade require `Origin` to match `Host`. The upgrade also
   requires the session's CSRF token, offered as the `pi-csrf.<token>`
   subprotocol. No token ever appears in a URL.
7. **Desktop-only settings.** The web access IPC requires the main window as
   sender, and its namespace is denied on the bridge, so a signed-in browser
   cannot change its own credentials, listener, or certificate.

## Consequences

- The account password is the boundary between the network and full control
  of this computer: whoever signs in can run commands and change files
  through the agent, within the owner's permission settings. The feature is
  therefore off by default, TLS-only, throttled, and requires a long
  password. ADR 0205 and its security specification keep governing RACP;
  browser web access is specified separately in
  `05-security/03-web-access-security.md`.
- The default self-signed certificate (ECDSA P-256, 397 days, renewed within
  30 days of expiry) makes browsers warn once. Settings shows its SHA-256
  fingerprint so the owner can compare it before accepting. An owner-supplied
  PEM certificate and key avoid the warning.
- In a browser these are unavailable: native file and folder pickers (adding
  a project by folder, installing a plugin from disk, importing a skill), the
  embedded browser panel, plugin views that rely on desktop protocols, live
  voice and dictation, storage settings, and window controls. OAuth sign-ins
  open the system browser on the host. Links open in a new browser tab.
- The desktop window and each browser tab keep their own renderer state, as
  ADR 0205 notes for the renderer prompt queue. Acting on one session from
  two places at once can race.
- A tab that loses its connection rejects pending calls, checks its session,
  and reloads after reconnecting instead of replaying missed events.
