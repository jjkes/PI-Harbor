import {
  WEB_ACCESS_CSRF_META,
  WEB_ACCESS_PLATFORM_META,
  WEB_ACCESS_ROUTES,
} from "@pi-harbor/shared";
import { createWebAccessBridge } from "./bridge-client";

/**
 * Installs the web access bridge before any other renderer module reads
 * `window.piDesktop` (ADR 0342). `main.tsx` imports this module first. In the
 * desktop window the preload bridge already exists and nothing happens.
 */
const PLATFORMS: readonly NodeJS.Platform[] = [
  "aix",
  "android",
  "cygwin",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
];

function readMeta(name: string): string | null {
  return document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? null;
}

function hostPlatform(value: string | null): NodeJS.Platform {
  return PLATFORMS.find((platform) => platform === value) ?? "linux";
}

const csrfToken = typeof document === "undefined" ? null : readMeta(WEB_ACCESS_CSRF_META);
if (csrfToken && !window.piDesktop) {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  window.piDesktop = createWebAccessBridge({
    csrfToken,
    url: `${scheme}//${window.location.host}${WEB_ACCESS_ROUTES.bridge}`,
    platform: hostPlatform(readMeta(WEB_ACCESS_PLATFORM_META)),
    locale: navigator.language,
  });
  document.documentElement.dataset.webAccess = "true";
}
