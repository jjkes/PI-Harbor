import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-harbor/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("a Task search hit resolves to its delegation summary owner", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const globals = {
    CSS: { escape: (value) => value, highlights: new Map() },
    performance: { now: () => 100 },
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    document: {
      createTreeWalker: () => ({ nextNode: () => null }),
      createRange: () => ({ setStart() {}, setEnd() {} }),
    },
    window: { setTimeout: () => 1, clearTimeout() {} },
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  t.after(async () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await server.close();
  });

  const { ActivityGroup } = await server.ssrLoadModule(
    "/src/features/chat/transcript/ActivityGroup.tsx",
  );
  const { TranscriptSearchContext } = await server.ssrLoadModule(
    "/src/lib/transcript-search-context.ts",
  );
  const { installTranscriptSearchFocus } = await server.ssrLoadModule(
    "/src/hooks/use-transcript-search-focus.ts",
  );
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
  const task = (id) => ({
    kind: "tool",
    message: {
      id,
      role: "tool",
      toolName: "Task",
      toolCallId: `${id}-call`,
      content: "",
      toolArgs: { task: `needle ${id}` },
    },
  });
  const items = [task("task-1"), task("task-2")];
  const target = { sessionId: "s", messageId: "task-2", query: "needle", requestId: 7 };
  const html = renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        TranscriptSearchContext.Provider,
        { value: target },
        createElement(ActivityGroup, { items, isActive: false }),
      ),
    ),
  );

  // The first Task is the stable reading-position anchor. Search aliases retain
  // ownership for the other Task rows that the single summary replaced.
  assert.match(html, /class="delegation-summary" data-message-id="task-1"/);
  assert.match(html, /data-search-message-ids="task-1 task-2"/);
  assert.equal(html.match(/class="delegation-summary"/g)?.length, 1);

  const scroller = {
    scrollTop: 0,
    clientHeight: 600,
    getBoundingClientRect: () => ({ top: 10 }),
    addEventListener() {},
    removeEventListener() {},
  };
  const classes = new Set();
  const ownerRow = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
  };
  const summary = {
    querySelectorAll: () => [],
    closest: (selector) => selector === ".message-row" ? ownerRow : null,
    getBoundingClientRect: () => ({ top: 500 }),
  };
  const selectors = [];
  const content = {
    querySelector: (selector) => {
      selectors.push(selector);
      return selector.includes('data-search-message-ids~="task-2"') ? summary : null;
    },
  };
  const navigations = [];
  const cleanup = installTranscriptSearchFocus({
    target,
    source: "needle task-2",
    scroller,
    content,
    position: { current: { requestId: 0, alignUntil: 0 } },
    onNavigate: (fresh) => navigations.push(fresh),
  });

  assert.equal(typeof cleanup, "function", "the aliased Task hit must reach the summary");
  assert.ok(selectors.some((selector) => selector.includes("data-search-message-ids")));
  assert.deepEqual(navigations, [true]);
  assert.equal(scroller.scrollTop, 330);
  assert.ok(classes.has("transcript-search-target"));
  cleanup();
  assert.equal(classes.size, 0);
});
