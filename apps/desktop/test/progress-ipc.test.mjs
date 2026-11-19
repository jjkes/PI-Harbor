import assert from "node:assert/strict";
import test from "node:test";

const { IPC } = await import("@pi-harbor/shared");
const { createProgressRuns, registerProgressIpc } = await import(
  "../electron/main/ipc/progress-ipc.ts"
);

const REPORT = JSON.stringify({
  completed: ["read the design", "wrote the shared contract"],
  inProgress: ["wiring the host tables"],
  next: ["electron main handler"],
  remainingSteps: 4,
  remainingMinutes: 18,
  confidence: "medium",
});

function fakeSender(id = 7) {
  const listeners = new Map();
  const add = (event, listener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  };
  return {
    id,
    on: add,
    once: add,
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

function harness({
  session = {
    id: "s1",
    source: "desktop",
    providerId: "p1",
    modelId: "m1",
    mode: "agent",
    permissionMode: "default",
    messageEnd: 86,
  },
  messages = [
    { id: "m-1", role: "user", content: "Add a progress report", createdAt: "2026-11-19T10:00:00Z" },
    { id: "m-2", role: "assistant", content: "On it", createdAt: "2026-11-19T10:00:05Z" },
  ],
  latest = null,
  completionText = REPORT,
  completionGate = null,
  providers = { providers: [{ id: "p1", modelId: "m1", hasSecret: true }] },
} = {}) {
  const handlers = new Map();
  const calls = [];
  const appended = [];
  const completions = [];
  const runs = createProgressRuns();
  let nextId = 0;

  registerProgressIpc({
    registrar: { handleWithEvent: (channel, fn) => handlers.set(channel, fn) },
    getHost: () => ({
      call: async (method, params) => {
        calls.push([method, params]);
        switch (method) {
          case "session.get":
            // The host answers `{ session }` and the bounded window is a field of
            // `SessionDetail`, not a sibling of it (ADR 0350 regression).
            return { session: { ...session, messages } };
          case "todos.get":
            return {
              sessionId: session.id,
              todos: [{ content: "wire the tables", status: "in_progress", priority: "high" }],
              revision: 3,
              updatedAt: 1,
            };
          case "settings.get":
            return { theme: "dark" };
          case "providers.list":
            return providers;
          case "progress.reports.latest":
            return latest;
          case "progress.reports.list":
            return { reports: [], nextCursor: null };
          case "progress.reports.append":
            appended.push(params);
            return { ...params, id: params.runId, body: params.body, usage: null };
          case "progress.settings.get":
            return { sessionId: session.id, autoEnabled: false, intervalMinutes: 5 };
          case "progress.settings.set":
            return { sessionId: session.id, autoEnabled: true, intervalMinutes: 15 };
          default:
            throw new Error(`unexpected host method ${method}`);
        }
      },
    }),
    resolveAgentRuntimeLaunch: async (sessionId, resolved, settings) => {
      calls.push(["launch", { sessionId, theme: settings.theme }]);
      return {
        providerId: "p1",
        modelId: "m1",
        sidecarParams: { provider: { id: "p1", authKind: "apiKey" }, thinkingLevel: "off" },
      };
    },
    vendorOAuth: { resolveAuth: async () => ({}) },
    completeOneShot: async (provider, context, thinkingLevel, options) => {
      completions.push({ provider, context, thinkingLevel, options });
      if (completionGate) await completionGate;
      return { text: completionText, usage: { inputTokens: 900, outputTokens: 120 } };
    },
    runs,
    now: () => 1_700_000_000_000,
  });

  return {
    calls,
    appended,
    completions,
    runs,
    collect: (request, sender = fakeSender()) =>
      handlers.get(IPC.invoke.progressCollect)({ sender }, request),
    cancel: (runId) => handlers.get(IPC.invoke.progressCancel)({ sender: fakeSender() }, { runId }),
    list: (request) => handlers.get(IPC.invoke.progressReportsList)({ sender: fakeSender() }, request),
    settingsSet: (request) =>
      handlers.get(IPC.invoke.progressSettingsSet)({ sender: fakeSender() }, request),
    settingsGet: (request) =>
      handlers.get(IPC.invoke.progressSettingsGet)({ sender: fakeSender() }, request),
  };
}

function request(overrides = {}) {
  return {
    sessionId: "s1",
    runId: `run_${Math.floor(Math.random() * 1e9)}`,
    trigger: "manual",
    model: { followSession: true },
    ...overrides,
  };
}

test("a manual collection stores one report and touches nothing else", async () => {
  const h = harness();
  const result = await h.collect(request({ runId: "run_a" }));

  assert.equal(result.kind, "ok");
  assert.equal(result.report.runId, "run_a");
  assert.equal(h.appended.length, 1);
  const row = h.appended[0];
  assert.equal(row.status, "ok");
  assert.equal(row.body.inProgress[0], "wiring the host tables");
  assert.equal(row.trigger, "manual");
  assert.equal(row.messageCount, 2);
  assert.equal(row.includedMessages, 2);
  assert.equal(row.lastMessageId, "m-2");
  assert.equal(row.inputTokens, 900);
  assert.ok(row.fingerprint.length > 0);

  // Exactly one completion, tool-free, thinking off, bounded output.
  assert.equal(h.completions.length, 1);
  const completion = h.completions[0];
  assert.equal(completion.thinkingLevel, "off");
  assert.equal(completion.options.maxOutputTokens, 1200);
  assert.deepEqual(completion.context.tools, []);
  // The digest the model saw must carry the transcript, not an empty window.
  const digest = String(completion.context.messages[0]?.content ?? "");
  assert.match(digest, /U Add a progress report/);
  assert.match(digest, /A On it/);

  // The host surface this path may use, and nothing else.
  const methods = h.calls.map((call) => call[0]);
  assert.ok(!methods.some((method) => method.startsWith("agent.")));
  assert.ok(!methods.includes("session.configure"));
  assert.ok(!methods.includes("session.appendMessage"));
  assert.deepEqual(methods, [
    "session.get",
    "todos.get",
    "progress.reports.latest",
    "providers.list",
    "settings.get",
    "launch",
    "progress.reports.append",
  ]);
});

test("a second collection for the same session is refused while one is running", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({ completionGate: gate });

  const first = h.collect(request({ runId: "run_slow" }));
  // Let the first run reach the completion before starting the second.
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => h.collect(request({ runId: "run_busy" })),
    /already running for this session/,
  );

  release();
  const result = await first;
  assert.equal(result.kind, "ok");
  assert.equal(h.runs.size(), 0);
});

test("cancel aborts the running collection and reports it as cancelled", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({ completionGate: gate });

  const running = h.collect(request({ runId: "run_c" }));
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await h.cancel("run_c");
  assert.equal(cancelled.aborted, true);
  release();
  const result = await running;
  assert.equal(result.kind, "ok");
});

test("an automatic run with an unchanged fingerprint is skipped without a completion", async () => {
  const h = harness();
  const first = await h.collect(request({ runId: "run_auto_1", trigger: "auto" }));
  assert.equal(first.kind, "ok");

  const fingerprint = h.appended[0].fingerprint;
  const second = harness({
    latest: { ...h.appended[0], fingerprint },
  });
  const skipped = await second.collect(request({ runId: "run_auto_2", trigger: "auto" }));
  assert.equal(skipped.kind, "skipped");
  assert.equal(second.completions.length, 0);
  assert.equal(second.appended.length, 0);
});

test("a manual run ignores the fingerprint and always collects", async () => {
  const composed = harness();
  await composed.collect(request({ runId: "run_m1" }));
  const fingerprint = composed.appended[0].fingerprint;
  const h = harness({ latest: { ...composed.appended[0], fingerprint } });
  const result = await h.collect(request({ runId: "run_m2", trigger: "manual" }));
  assert.equal(result.kind, "ok");
  assert.equal(h.completions.length, 1);
});

test("remote and Pi-native sessions are refused before any host call", async () => {
  for (const sessionId of ["remote:abc", "native-pi:abc"]) {
    const h = harness();
    await assert.rejects(
      () => h.collect(request({ sessionId })),
      /not available for this session/,
    );
    assert.equal(h.calls.length, 0);
  }
});

test("a session whose model is not offered fails before the request is sent", async () => {
  const h = harness({ providers: { providers: [{ id: "p1", hasSecret: true }] } });
  const result = await h.collect(
    request({ model: { providerId: "p1", modelId: "not-offered" } }),
  );
  assert.equal(result.kind, "error");
  assert.equal(result.code, "PROGRESS_MODEL_UNAVAILABLE");
  assert.equal(h.completions.length, 0);
  assert.equal(h.appended.length, 0);
});

test("a provider without a credential fails as model-unavailable", async () => {
  const h = harness({ providers: { providers: [{ id: "p1", modelId: "m1" }] } });
  const result = await h.collect(request());
  assert.equal(result.kind, "error");
  assert.equal(result.code, "PROGRESS_MODEL_UNAVAILABLE");
  assert.equal(h.completions.length, 0);
});

test("an answer that does not match the shape is stored as unparsed", async () => {
  const h = harness({ completionText: "I cannot see the transcript, sorry." });
  const result = await h.collect(request({ runId: "run_u" }));
  assert.equal(result.kind, "ok");
  const row = h.appended[0];
  assert.equal(row.status, "unparsed");
  assert.equal(row.raw, "I cannot see the transcript, sorry.");
  assert.equal(row.body, null);
});

test("history and settings are forwarded without inventing fields", async () => {
  const h = harness();
  await h.list({ sessionId: "s1", limit: 20, before: "run_1" });
  const listCall = h.calls.find((call) => call[0] === "progress.reports.list");
  assert.deepEqual(listCall[1], { sessionId: "s1", before: "run_1", limit: 20 });

  const settings = await h.settingsGet({ sessionId: "s1" });
  assert.equal(settings.intervalMinutes, 5);

  const patched = await h.settingsSet({
    sessionId: "s1",
    patch: { autoEnabled: true, intervalMinutes: 15 },
  });
  assert.equal(patched.intervalMinutes, 15);
  const setCall = h.calls.find((call) => call[0] === "progress.settings.set");
  assert.deepEqual(setCall[1], { sessionId: "s1", autoEnabled: true, intervalMinutes: 15 });
});

test("an unsupported interval never reaches the host", async () => {
  const h = harness();
  await assert.rejects(
    () => h.settingsSet({ sessionId: "s1", patch: { intervalMinutes: 7 } }),
    /intervalMinutes/,
  );
  assert.ok(!h.calls.some((call) => call[0] === "progress.settings.set"));
});
