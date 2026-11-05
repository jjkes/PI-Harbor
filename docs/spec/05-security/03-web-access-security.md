# Browser Web Access Security Specification

- Status: Implemented
- Decision: ADR 0342
- Applies to: the HTTPS listener in Electron Main that serves the desktop
  renderer to a signed-in browser, and the browser bridge it carries
- Does not cover: RACP remote control, specified in
  [02-remote-control-security.md](02-remote-control-security.md)

## 1. Trust model

A signed-in browser is the owner. It is not a separate principal and has no
reduced role: it can do what the desktop window can, except act on this
computer's own screen and devices or change web access itself. The controls
below keep people who are not the owner from signing in, and keep a signed-in
page's authority inside that page.

| Threat | Control |
|---|---|
| Password guessing | 10-character minimum, scrypt, per-address lockout, bounded parallel checks |
| Network eavesdropping | HTTPS only; the self-signed certificate's fingerprint is shown in Settings |
| Cross-site requests and WebSocket hijacking | `SameSite=Strict` cookie, `Origin` must equal `Host`, CSRF subprotocol |
| Token leakage through URLs, logs, or referrers | Tokens travel only in the cookie, the document meta tag, and the subprotocol; `Referrer-Policy: same-origin` |
| Framing | `frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN` |
| A signed-in browser locking the owner out | Web access settings are desktop-only |
| A stalled or abusive tab | Frame and buffer limits, heartbeat |

## 2. Listener

- The listener MUST stay off until the owner enables it and MUST stop when
  the owner turns it off.
- It MUST serve only HTTPS, with TLS 1.2 or newer.
- It binds every interface or the IPv4 loopback address, as the owner
  chooses, on a port from 1024 to 65535.
- The self-signed certificate (ECDSA P-256, 397 days) is generated on first
  start and renewed within 30 days of expiry. Its private key file MUST be
  readable only by the owner. An owner-supplied certificate MUST match its
  private key before the listener starts.
- A request whose `Host` is not a host name or IP literal with an optional
  port MUST be refused.

## 3. Credentials

- There is one account: a username of at most 64 characters without control
  characters, and a password of 10 to 256 characters.
- The password MUST be stored only as scrypt (N = 32768, r = 8, p = 1,
  16-byte salt, 32-byte key) in an owner-only file. A stored hash whose
  parameters exceed N = 2^17, r = 16, or p = 4 MUST be rejected without
  deriving.
- Username and password comparisons MUST be constant-time, and a wrong
  username MUST cost the same scrypt work as a wrong password.

## 4. Sign-in throttling

- Each attempt MUST reserve a slot before the password is checked, so
  parallel requests cannot run ahead of the failure count.
- Five failures from one client address MUST lock that address out for 15
  minutes. IPv6 addresses count by their /64 prefix; IPv4-mapped addresses
  count as IPv4.
- At most four sign-ins are checked at once; further attempts are answered
  "busy". A sign-in body MUST NOT exceed 8 KiB.

## 5. Sessions

- A session token is 32 random bytes. The host MUST keep only its SHA-256
  hash, in memory.
- The cookie MUST be `__Host-pi-web-session`, `Secure`, `HttpOnly`,
  `SameSite=Strict`, and `Path=/`, without `Domain`.
- A session MUST end after 24 hours without activity, 7 days after sign-in,
  on sign-out, and on app restart. Every session MUST end when the username
  or password changes, when web access is turned off, and when the owner
  signs every browser out. Ending a session MUST close its bridge sockets
  with code 4401.

## 6. Request integrity

- Sign-in, sign-out, and the WebSocket upgrade MUST require an `Origin` equal
  to `https://` followed by `Host`.
- The upgrade MUST require a live session cookie and that session's CSRF
  token, offered as the `pi-csrf.<token>` subprotocol beside `pi-web.v1`.
  The token comparison MUST be constant-time.
- The CSRF token MUST be delivered only in the authenticated document. No
  session or CSRF token may appear in a URL.
- Every response MUST carry `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin`, `X-Frame-Options: SAMEORIGIN`,
  `Content-Security-Policy: frame-ancestors 'self'`, and
  `Cross-Origin-Opener-Policy: same-origin`. Documents and API responses
  MUST NOT be cached. The sign-in page MUST run no script.
- A signed-out navigation MUST be redirected to the sign-in page; any other
  signed-out request MUST receive 401.

## 7. Channel and event policy

- The bridge MUST dispatch only `IPC.invoke` channels that the renderer
  dispatcher registers, minus the denied set in `channel-policy.ts`. Event
  channel names and unknown names MUST answer `UNSUPPORTED` without reaching
  a handler.
- The denied set MUST include native dialogs, window and devtools control,
  quitting, revealing or opening paths in the OS, the embedded browser panel,
  voice capture, storage relocation, and the `webAccess` namespace.
- Opening a plugin view or a plugin panel window MUST be denied, because each
  creates a native window on this computer. Closing a plugin view, setting its
  bounds, and showing or hiding it MUST answer success without reaching a
  handler, so a browser cannot change a native view.
- A browser frame of a plugin view MUST reach the plugin only through
  `pluginWebViewOpen`, `pluginWebViewAsset`, `pluginWebViewInvoke`, and
  `pluginWebViewClose`. Main resolves the plugin, view, and session from the
  instance it issued, so a frame cannot name another plugin or session.
- `pluginWebViewInvoke` MUST refuse the channels that act on this computer's
  screen or devices: `fs.reveal`, `fs.openDefault`, `fs.openInBrowser`,
  `fs.registerDropped`, and `app.launchURL`.
- The web access settings IPC MUST require the main window as sender.
- `webAccessChanged` and `liveVoicePort` MUST NOT be forwarded to browsers.

## 8. Resource bounds

- A bridge frame MUST NOT exceed 64 MiB.
- A tab whose unsent data exceeds 32 MiB MUST be disconnected.
- Each socket MUST be pinged every 30 seconds and dropped when it misses a
  ping or its session has ended.

## 9. Logging

Sign-in successes, failures, and lockouts are logged with the client address
key. Passwords, submitted usernames, cookies, CSRF tokens, and request bodies
MUST NOT be logged.

## 10. Residual risks

- Anyone who learns the password controls this computer through the agent,
  within the owner's permission settings.
- Accepting the self-signed certificate warning without comparing the
  fingerprint exposes the first connection to interception on a hostile
  network.
- Sessions are not bound to a client address: a stolen cookie works from
  anywhere until the session ends.
- DNS rebinding lets a hostile page reach the listener under the attacker's
  host name, but that page has no session cookie and still has to sign in.
