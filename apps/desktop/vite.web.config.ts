/**
 * Vite config for the plan-debate web harness (`apps/desktop/web`).
 *
 * Deliberately separate from `electron.vite.config.ts`: this config serves a
 * debug page in a normal browser, so it has no main/preload bundles, no
 * electron-vite plugin and no CSP tightening. It is not part of `build` or
 * `pack`, and nothing under `web/` is reachable from the packaged app
 * (electron-builder ships `out/**` only).
 *
 * The renderer's module resolution is repeated here on purpose rather than
 * exported, so the aliases cannot drift silently: `@renderer` and the three
 * `@pi-harbor/i18n` source aliases are the same ones the renderer build uses.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const i18nRoot = resolve(packageRoot, "../../packages/i18n/src");

export default defineConfig({
  root: resolve(packageRoot, "web"),
  // A debug page has no static assets of its own.
  publicDir: false,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5199,
    // A busy port must fail loudly: a second harness on another port is how two
    // people end up reading different fixtures.
    // Bind IPv4 loopback explicitly: the documented URL is 127.0.0.1:5199, and
    // the default `localhost` binding can end up on ::1 only.
    host: "127.0.0.1",
    strictPort: true,
    open: false,
  },
  resolve: {
    // Same order as the renderer config: the exact-match aliases come first,
    // and the bare package alias last, or it would swallow the subpaths.
    alias: [
      { find: "@renderer", replacement: resolve(packageRoot, "src") },
      {
        find: /^@pi-harbor\/i18n\/locales\/([^/]+)$/,
        replacement: resolve(i18nRoot, "locales/$1/index.ts"),
      },
      {
        find: "@pi-harbor/i18n/locale-info",
        replacement: resolve(i18nRoot, "locale-info.ts"),
      },
      {
        find: "@pi-harbor/i18n",
        replacement: resolve(i18nRoot, "index.ts"),
      },
    ],
  },
});
