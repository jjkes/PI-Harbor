import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-harbor/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/*
 * What the session context viewer shows for each load state, rendered through
 * the real component and the English catalog. The data path below it is
 * covered by session-context-ipc.test.mjs.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function withViewRender(run) {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { SessionContextView } = await server.ssrLoadModule(
      "/src/features/chat/context-usage/SessionContextDialog.tsx",
    );
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (state) => renderToStaticMarkup(
      createElement(I18nextProvider, { i18n }, createElement(SessionContextView, { state, onRetry: () => {} })),
    );
    await run(render);
  } finally {
    await server.close();
  }
}

const ready = (tools) => ({
  status: "loaded",
  snapshot: {
    status: "ready",
    sessionId: "s1",
    systemPrompt: "You are Pi.\n\nUse skills.",
    tools,
    updatedAt: "2026-11-05T01:00:02.000Z",
  },
});

test("a ready snapshot shows the system prompt, its size, a copy action, and the tool count", async () => {
  await withViewRender((render) => {
    const html = render(ready([{ name: "Read", description: "Read a file.", parameters: { type: "object" } }]));
    assert.match(html, /<pre class="session-context-prompt"[^>]*>You are Pi\.\n\nUse skills\.<\/pre>/);
    assert.match(html, /24 characters/);
    assert.match(html, /aria-label="Copy system prompt"/);
    // A toggle group with pressed state; the panel is a section named by its view.
    assert.match(html, /role="group" aria-label="Context sections"/);
    assert.match(html, /aria-pressed="true"[^>]*>System prompt</);
    assert.match(html, /<section aria-label="System prompt"/);
    assert.doesNotMatch(html, /role="tab/);
    assert.match(html, /Tools \(1\)/);
    assert.match(html, /Recorded /);
  });
});

test("every other state explains itself instead of showing an empty panel", async () => {
  await withViewRender((render) => {
    assert.match(render({ status: "loading" }), /role="status"[^>]*>Loading…/);
    assert.match(
      render({ status: "loaded", snapshot: { status: "empty", sessionId: "s1" } }),
      /No system context is recorded for this session yet\. It is saved with the next model request\./,
    );
    assert.match(
      render({ status: "loaded", snapshot: { status: "unavailable", sessionId: "remote:h:s", reason: "remote" } }),
      /remote session&#x27;s context is kept on its host/,
    );
    assert.match(
      render({ status: "loaded", snapshot: { status: "unavailable", sessionId: "native-pi:s", reason: "native" } }),
      /Pi CLI sessions keep their own context/,
    );
    const failed = render({ status: "failed", message: "host unavailable" });
    assert.match(failed, /role="alert"/);
    assert.match(failed, /Couldn&#x27;t load the session context\./);
    assert.match(failed, /host unavailable/);
    assert.match(failed, />Retry</);
  });
});

test("a snapshot without tools still offers the tools tab with a zero count", async () => {
  await withViewRender((render) => {
    assert.match(render(ready([])), /Tools \(0\)/);
  });
});
