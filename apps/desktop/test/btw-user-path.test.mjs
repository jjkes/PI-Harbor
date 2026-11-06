import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { IPC } from "@pi-harbor/shared";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/**
 * The BTW user path (ADR 0344): `/btw` typed in the main composer opens the
 * read-only side-question tab and asks there, never in the main turn.
 */

const desktopSession = {
  id: "session-desktop",
  source: "desktop",
  title: "Main task",
  messageCount: 2,
  mode: "agent",
  thinkingLevel: "off",
  permissionMode: "ask",
  capabilities: {
    canPrompt: true,
    canStop: true,
    canRefresh: true,
    canAttach: true,
    canUseLocalTools: true,
    canConfigureModel: true,
  },
};

/** A bridge that records renderer IPC calls and answers each invoke with `ok`. */
function stubBridge(t, data = { accepted: true }) {
  const invoked = [];
  globalThis.window = {
    piDesktop: {
      platform: "darwin",
      invoke: async (channel, payload) => {
        invoked.push([channel, payload]);
        return { ok: true, data };
      },
      on: () => () => {},
    },
    matchMedia: () => ({ matches: false }),
  };
  t.after(() => {
    delete globalThis.window;
  });
  return invoked;
}

/** The composer's send orchestration, with the main turn wired to fail loudly. */
async function composerSubmit(ssr, { value, localCommandsAllowed = true }) {
  const { useComposerSubmit } = await ssr.load(
    "/src/features/chat/composer/hooks/useComposerSubmit.ts",
  );
  const calls = [];
  const cleared = [];
  const controller = useComposerSubmit({
    value,
    draftKey: desktopSession.id,
    activeSessionId: desktopSession.id,
    modelReady: true,
    sendBlocked: false,
    localCommandsAllowed,
    steeringAllowed: true,
    invalidateComposerTransforms() {},
    pasting: false,
    activeFileReferences: [],
    t: (key) => key,
    showToast: (message) => calls.push(["toast", message]),
    sendPrompt: async (text) => {
      calls.push(["prompt", text]);
      return true;
    },
    steerPrompt: async () => {
      throw new Error("a side question must never be steered into the main turn");
    },
    sendQueuedNow: async () => {},
    queuedPrompts: [],
    draft: {
      ref: { current: null },
      draftRevision: () => 1,
      draftSnapshot: (text) => ({ text, fileReferences: [] }),
      clearDraftForKey: (...args) => cleared.push(args),
      restoreDraftForKey() {},
    },
  });
  return { controller, calls, cleared };
}

async function seedDesktopSession(ssr) {
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  Object.assign(useAppStore.getInitialState(), {
    sessions: [desktopSession],
    activeSessionId: desktopSession.id,
    messages: [{ id: "m1", role: "user", content: "Ship the feature", createdAt: 1 }],
    workspace: { path: "/work/app", name: "app" },
  });
  return useAppStore;
}

test("/btw with a question opens the side panel and asks there", async (t) => {
  const ssr = await slotSsr(t);
  const invoked = stubBridge(t);
  const useAppStore = await seedDesktopSession(ssr);
  const { controller, calls, cleared } = await composerSubmit(ssr, {
    value: "/btw why do we cap retries?",
  });

  await controller.submit();

  const ask = invoked.find(([channel]) => channel === IPC.invoke.btwAsk);
  assert.ok(ask, "the question must travel over the side-question channel");
  assert.equal(ask[1].sessionId, desktopSession.id);
  assert.equal(ask[1].question, "why do we cap retries?");
  assert.deepEqual(ask[1].history, []);
  assert.match(ask[1].runId, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(
    invoked.some(([channel]) => channel === IPC.invoke.agentPrompt),
    false,
    "a side question is never a main prompt",
  );
  assert.deepEqual(calls, [], "nothing reached the main turn");
  assert.equal(cleared.length, 1, "an accepted question clears the draft");

  const state = useAppStore.getState();
  assert.deepEqual(state.workPanelTabs.map((tab) => tab.kind), ["btw"]);
  assert.equal(state.workPanelOpen, true);

  const { btwStore } = await ssr.load("/src/features/chat/btw/btw-controller.ts");
  const thread = btwStore.getState().threads[desktopSession.id];
  assert.equal(thread.turns[0].question, "why do we cap retries?");
  assert.equal(thread.activeRunId, ask[1].runId);
});

test("a bare /btw opens the tab without asking anything", async (t) => {
  const ssr = await slotSsr(t);
  const invoked = stubBridge(t);
  const useAppStore = await seedDesktopSession(ssr);
  const { controller, cleared } = await composerSubmit(ssr, { value: "/btw" });

  await controller.submit();

  assert.deepEqual(invoked, []);
  assert.equal(cleared.length, 1);
  assert.deepEqual(useAppStore.getState().workPanelTabs.map((tab) => tab.kind), ["btw"]);
});

test("a rejected question keeps the composer draft", async (t) => {
  const ssr = await slotSsr(t);
  globalThis.window = {
    piDesktop: {
      platform: "darwin",
      invoke: async () => ({
        ok: false,
        error: { code: "BTW_CONTEXT_FULL", message: "too long" },
      }),
      on: () => () => {},
    },
    matchMedia: () => ({ matches: false }),
  };
  t.after(() => {
    delete globalThis.window;
  });
  const useAppStore = await seedDesktopSession(ssr);
  const { controller, cleared } = await composerSubmit(ssr, { value: "/btw why?" });

  await controller.submit();

  assert.equal(cleared.length, 0, "a rejected question keeps the draft");
  const toasts = useAppStore.getState().toasts;
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].variant, "error");
  // The renderer catalog is not loaded here, so the shared error message is
  // the fallback; the localized copy is covered by the controller tests.
  assert.match(toasts[0].message, /too long/);
  const { btwStore } = await ssr.load("/src/features/chat/btw/btw-controller.ts");
  const thread = btwStore.getState().threads[desktopSession.id];
  assert.equal(thread?.turns.length ?? 0, 0);
  assert.deepEqual(useAppStore.getState().workPanelTabs.map((tab) => tab.kind), ["btw"]);
});

test("a remote session sends /btw as ordinary prompt text", async (t) => {
  const ssr = await slotSsr(t);
  const invoked = stubBridge(t);
  await seedDesktopSession(ssr);
  const { controller, calls } = await composerSubmit(ssr, {
    value: "/btw why?",
    localCommandsAllowed: false,
  });

  await controller.submit();

  assert.deepEqual(calls, [["prompt", "/btw why?"]]);
  assert.deepEqual(invoked, []);
});

test("the palette command opens the side-question tab", async (t) => {
  const ssr = await slotSsr(t);
  stubBridge(t);
  const useAppStore = await seedDesktopSession(ssr);
  const { runPaletteCommand } = await ssr.load("/src/lib/commands.ts");

  await runPaletteCommand("builtin.session.btw");

  const state = useAppStore.getState();
  assert.deepEqual(state.workPanelTabs, [{ id: "btw", kind: "btw" }]);
  assert.equal(state.activeWorkPanelTabId, "btw");
  assert.equal(state.workPanelOpen, true);
});

test("the tab renders the thread, its tool rows, and how stale the answer is", async (t) => {
  const ssr = await slotSsr(t);
  stubBridge(t);
  const useAppStore = await seedDesktopSession(ssr);
  Object.assign(useAppStore.getInitialState(), {
    messages: [
      { id: "m1", role: "user", content: "Ship the feature", createdAt: 1 },
      { id: "m2", role: "assistant", content: "Done", createdAt: 2, status: "complete" },
      { id: "m3", role: "user", content: "Now document it", createdAt: 3 },
    ],
  });
  const { btwStore } = await ssr.load("/src/features/chat/btw/btw-controller.ts");
  Object.assign(btwStore.getInitialState(), {
    threads: {
      [desktopSession.id]: {
        turns: [
          {
            runId: "run-1",
            question: "Why cap retries?",
            answer: "**Three** failures end the turn.",
            status: "done",
            tools: [
              { toolCallId: "btw:run-1:a", toolName: "Read", summary: "src/retry.ts", state: "ok" },
              {
                toolCallId: "btw:run-1:b",
                toolName: "Bash",
                state: "failed",
                errorCode: "TOOL_DISABLED_IN_READ_ONLY",
              },
            ],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            providerId: "provider-a",
            modelId: "model-a",
            baseline: { lastMessageId: "m1", settledCount: 1, compactionCount: 0, mainRunning: false },
            lastSeq: 3,
            askedAt: Date.UTC(2026, 10, 6, 3, 4),
          },
        ],
        activeRunId: null,
        draft: "",
      },
    },
    focusSessionId: null,
  });
  const { BtwTab } = await ssr.load("/src/components/workpanel/BtwTab.tsx");

  const html = ssr.render(createElement(BtwTab, { sessionId: desktopSession.id }));

  assert.match(html, /class="btw-tab"/);
  assert.match(html, />BTW</);
  assert.match(html, /Read-only/);
  assert.match(html, />Clear</);
  assert.match(html, /Following the main conversation/);
  assert.match(html, /Why cap retries\?/);
  assert.match(html, /Three<\/strong> failures end the turn\./);
  assert.match(html, /Read/);
  assert.match(html, /src\/retry\.ts/);
  assert.match(html, /Not allowed in read-only mode/);
  assert.match(html, /model-a/);
  assert.match(html, /15 tokens/);
  assert.match(html, /2 new messages in the main conversation since/);
  assert.match(html, /aria-label="Side question"/);
  assert.match(html, /placeholder="Ask about the main conversation…"/);
  assert.doesNotMatch(html, /Ask a side question/);
});

test("an empty thread explains that the main conversation is still empty", async (t) => {
  const ssr = await slotSsr(t);
  stubBridge(t);
  const useAppStore = await seedDesktopSession(ssr);
  Object.assign(useAppStore.getInitialState(), { messages: [] });
  const { BtwTab } = await ssr.load("/src/components/workpanel/BtwTab.tsx");

  const html = ssr.render(createElement(BtwTab, { sessionId: desktopSession.id }));

  assert.match(html, /Ask a side question/);
  assert.match(html, /The main conversation is still empty\./);
  assert.doesNotMatch(html, /class="btw-turn"/);
});

test("a failed answer offers a retry and reads out the shared error copy", async (t) => {
  const ssr = await slotSsr(t);
  stubBridge(t);
  await seedDesktopSession(ssr);
  const { btwStore } = await ssr.load("/src/features/chat/btw/btw-controller.ts");
  Object.assign(btwStore.getInitialState(), {
    threads: {
      [desktopSession.id]: {
        turns: [
          {
            runId: "run-1",
            question: "Why cap retries?",
            answer: "",
            status: "error",
            tools: [],
            error: { code: "BTW_RUNTIME_EXITED", message: "runtime exited", retriable: true },
            baseline: { lastMessageId: "m1", settledCount: 1, compactionCount: 0, mainRunning: false },
            lastSeq: 1,
            askedAt: Date.UTC(2026, 10, 6, 3, 4),
          },
        ],
        activeRunId: null,
        draft: "",
      },
    },
    focusSessionId: null,
  });
  const { BtwTab } = await ssr.load("/src/components/workpanel/BtwTab.tsx");

  const html = ssr.render(createElement(BtwTab, { sessionId: desktopSession.id }));

  assert.match(html, /The AI runtime stopped during the side question\. Try again\./);
  assert.match(html, /aria-label="Try again"/);
  assert.match(html, /Answer ready|Stopped|side question failed/);
});
