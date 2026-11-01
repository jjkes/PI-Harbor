import { catalogs, resolveLocale, type AppLocale } from "@pi-harbor/i18n";

/**
 * The sign-in page for web access (ADR 0342). It is plain HTML with no
 * script; its only request is the same-origin form post.
 */
export type LoginNotice = "invalid" | "locked" | "busy" | "signedOut";

export const LOGIN_NOTICES: readonly LoginNotice[] = ["invalid", "locked", "busy", "signedOut"];

export const LOGIN_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export function preferredLocale(acceptLanguage: string | undefined): AppLocale {
  const first = (acceptLanguage ?? "").split(",")[0]?.split(";")[0]?.trim() ?? "";
  return resolveLocale(first);
}

export function renderLoginPage(
  locale: AppLocale,
  notice: LoginNotice | null,
  action: string,
): string {
  const copy = catalogs[locale].webAccess.login;
  const message = notice
    ? `<p class="notice${notice === "signedOut" ? "" : " error"}" role="${notice === "signedOut" ? "status" : "alert"}">${escapeHtml(copy[notice])}</p>`
    : "";
  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(copy.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(copy.heading)}</h1>
<p class="subtitle">${escapeHtml(copy.subtitle)}</p>
${message}
<form method="post" action="${escapeHtml(action)}">
<label for="username">${escapeHtml(copy.username)}</label>
<input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus />
<label for="password">${escapeHtml(copy.password)}</label>
<input id="password" name="password" type="password" autocomplete="current-password" required />
<button type="submit">${escapeHtml(copy.submit)}</button>
</form>
<p class="warning">${escapeHtml(copy.warning)}</p>
</main>
</body>
</html>
`;
}

const STYLE = `
:root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
main { width: min(360px, calc(100vw - 32px)); padding: 32px 24px; border: 1px solid GrayText; border-radius: 12px; }
h1 { margin: 0 0 8px; font-size: 20px; }
.subtitle { margin: 0 0 16px; font-size: 13px; opacity: 0.75; }
.warning { margin: 16px 0 0; font-size: 12px; opacity: 0.75; }
.notice { margin: 0 0 16px; font-size: 13px; }
.notice.error { font-weight: 600; }
form { display: grid; gap: 8px; }
label { font-size: 13px; font-weight: 600; }
input { font: inherit; padding: 8px 10px; border: 1px solid GrayText; border-radius: 8px; background: Field; color: FieldText; }
button { margin-top: 8px; font: inherit; font-weight: 600; padding: 9px 12px; border: 0; border-radius: 8px; background: ButtonText; color: ButtonFace; cursor: pointer; }
`;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}
