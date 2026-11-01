import { WEB_ACCESS_ROUTES } from "@pi-harbor/shared";

/** True when this renderer runs in a browser through web access (ADR 0342). */
export function isWebAccessClient(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.webAccess === "true";
}

/** Ends this browser's web access session and returns to the sign-in page. */
export async function signOutOfWebAccess(): Promise<void> {
  try {
    await fetch(WEB_ACCESS_ROUTES.logout, {
      method: "POST",
      credentials: "same-origin",
      referrerPolicy: "same-origin",
    });
  } finally {
    window.location.assign(`${WEB_ACCESS_ROUTES.login}?notice=signedOut`);
  }
}
