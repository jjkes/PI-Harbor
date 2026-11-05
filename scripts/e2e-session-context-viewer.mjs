#!/usr/bin/env node
// E2E-SESSION-CONTEXT-viewer: View context in the built app, end to end.
//
// A loopback model answers the session's first request with a ToolSearch call,
// so the session's system state changes between its first and last request.
// The viewer has to show the last one: Main reads it through Host
// `session.contextTranscript` and the agent runtime's replay, the renderer
// renders it. No real provider, no credentials.
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { check, runScenario, shortText } from "./e2e/desktop-app.mjs";

const MODEL = "context-viewer-fixture";
const PERSONA = "You are PI-Harbor Desktop, a coding agent.";
const SEARCH = "BrowserPreview";

/** A Chat Completions model: ToolSearch first, then a plain answer. */
async function startModel() {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const agent = (payload.tools ?? []).some((tool) => tool.function?.name === "ToolSearch");
    const answered = payload.messages?.some((message) => message.role === "tool");
    const chunk = (delta, finish = null, usage) => `data: ${JSON.stringify({
      id: `chatcmpl-${requests.length}`, object: "chat.completion.chunk", created: 1, model: MODEL,
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
    })}\n\n`;
    const usage = { prompt_tokens: 1200, completion_tokens: 8, total_tokens: 1208 };
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (agent && !answered) {
      res.write(chunk({ role: "assistant", tool_calls: [{
        index: 0, id: "call_search", type: "function",
        function: { name: "ToolSearch", arguments: JSON.stringify({ query: SEARCH }) },
      }] }));
      res.write(chunk({}, "tool_calls", usage));
    } else {
      res.write(chunk({ role: "assistant", content: "Context fixture ready." }));
      res.write(chunk({}, "stop", usage));
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  server.unref();
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

const toolNames = (payload) => (payload.tools ?? []).map((tool) => tool.function?.name).sort();
const agentRequests = (model) =>
  model.requests.filter((payload) => toolNames(payload).includes("ToolSearch"));

/** What the open viewer shows: section, prompt text, listed tools, status. */
function viewerState(app) {
  return app.evaluate(`(() => {
    const dialog = document.querySelector(".session-context-dialog[role=dialog]");
    if (!dialog) return null;
    const pressed = dialog.querySelector('[role=group] [aria-pressed="true"]');
    return {
      section: pressed ? pressed.textContent.trim() : null,
      prompt: dialog.querySelector(".session-context-prompt")?.textContent ?? null,
      tools: [...dialog.querySelectorAll(".session-context-tool-name")].map((node) => node.textContent),
      status: dialog.querySelector(".session-context-status")?.textContent.trim() ?? null,
    };
  })()`);
}

/** Open the composer context inspector and choose View context. */
async function openViewer(app) {
  await app.click(".context-inspector-trigger", { label: "context inspector trigger" });
  await app.click(".context-inspector-popover.is-open .context-inspector-actions button", {
    text: "View context", label: "View context",
  });
  return app.waitFor(async () => {
    const state = await viewerState(app);
    return state && (state.prompt !== null || (state.status && state.status !== "Loading…")) ? state : null;
  }, "the context viewer content");
}

/** Escape closes the viewer and returns focus to the inspector trigger. */
async function closeViewer(app) {
  await app.pressKey("Escape", "Escape", 27);
  await app.waitFor(() => app.evaluate(`!document.querySelector(".session-context-dialog")
    && document.activeElement === document.querySelector(".context-inspector-trigger")`),
  "the viewer closed with focus on the inspector trigger");
}

/** Type into the real composer and submit with Enter. */
async function sendPrompt(app, text) {
  await app.waitFor(() => app.evaluate(`Boolean(document.querySelector('.composer-input[contenteditable="true"]'))`),
    "an editable composer");
  await app.evaluate(`document.querySelector(".composer-input").focus()`);
  await app.renderer.send("Input.insertText", { text });
  await app.pressKey("Enter", "Enter", 13);
}

const EMPTY = "No system context is recorded for this session yet. It is saved with the next model request.";
const model = await startModel();
const state = {};

async function seed(host, app) {
  state.workspace = join(app.tempRoot, "workspace");
  await mkdir(state.workspace, { recursive: true });
  await host.call("settings.set", { language: "en" });
  await host.call("workspace.set", { path: state.workspace });
}

const lastRequest = {
  id: "E2E-SESSION-CONTEXT-viewer:last-request",
  run: async (app) => {
    const { provider } = await app.invoke("providersCreate", {
      name: "Context viewer fixture", authKind: "none", baseUrl: model.baseUrl, apiStyle: "chat_completions",
      defaultModelId: MODEL,
      models: [{ id: MODEL, contextWindow: 128_000, maxTokens: 8_192, thinkingLevels: ["off"], defaultThinkingLevel: "off" }],
    });
    state.provider = provider;
    const { session } = await app.invoke("sessionCreate", {
      title: "Context viewer", mode: "agent", projectPath: state.workspace,
      providerId: provider.id, modelId: MODEL, permissionMode: "auto",
    });
    state.sessionId = session.id;
    // A reload boots the store again, with the new provider and session.
    await app.reload();
    await app.selectSession(session.id);
    await sendPrompt(app, "Show the context fixture.");
    let status = null;
    await app.waitFor(async () => {
      status = (await app.invoke("agentGetStatus", session.id))?.status ?? null;
      return agentRequests(model).length >= 2 && status?.isRunning === false;
    }, "the turn to finish", 90_000).catch((error) => {
      throw new Error(`${error.message}; ${model.requests.length} model request(s), status ${shortText(status)}`);
    });
    const requests = agentRequests(model);
    const first = toolNames(requests[0]);
    state.request = requests.at(-1);
    state.tools = toolNames(state.request);
    state.activated = state.tools.filter((name) => !first.includes(name));
    check(state.activated.length > 0, `ToolSearch activated nothing; last request tools: ${shortText(state.tools)}`);

    const viewer = await openViewer(app);
    check(viewer.prompt?.startsWith(PERSONA), `viewer prompt: ${shortText(viewer.prompt)}`);
    await app.click(".session-context-dialog [role=group] button", {
      text: `Tools (${state.tools.length})`, label: "the Tools section",
    });
    const shown = await app.waitFor(async () => (await viewerState(app))?.tools, "the tool list");
    check(JSON.stringify([...shown].sort()) === JSON.stringify(state.tools),
      `viewer tools ${shortText(shown)} differ from the last request's ${shortText(state.tools)}`);
    return `${state.tools.length} tools, ${state.activated.join(", ")} activated after the first request`;
  },
};

const toolAndCopy = {
  id: "E2E-SESSION-CONTEXT-viewer:tool-and-copy",
  run: async (app) => {
    const name = state.activated[0];
    const expanded = await app.evaluate(`(() => {
      const row = [...document.querySelectorAll(".session-context-tool")]
        .find((node) => node.querySelector(".session-context-tool-name")?.textContent === ${JSON.stringify(name)});
      row?.querySelector("summary")?.click();
      return row ? { open: row.open, schema: row.querySelector(".session-context-schema")?.textContent } : null;
    })()`);
    check(expanded?.open === true, `${name} did not expand: ${shortText(expanded)}`);
    const declared = state.request.tools.find((tool) => tool.function?.name === name).function.parameters;
    const keys = (schema) => Object.keys(schema?.properties ?? {}).sort().join(",");
    check(keys(JSON.parse(expanded.schema)) === keys(declared),
      `${name} schema ${shortText(expanded.schema)} differs from the request's ${shortText(declared)}`);

    await app.click(".session-context-dialog [role=group] button", { text: "System prompt", label: "the prompt section" });
    await app.waitFor(async () => (await viewerState(app))?.prompt, "the prompt section");
    await app.evaluate(`(() => {
      // The system clipboard is the external edge: record what would be written.
      window.__copied = null;
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true, value: async (text) => { window.__copied = text; },
      });
    })()`);
    await app.click(".session-context-copy", { label: "Copy system prompt" });
    const copied = await app.waitFor(() => app.evaluate(`document.querySelector(".session-context-copy")
      ?.getAttribute("aria-label") === "Copied" ? window.__copied : null`), "the Copied confirmation");
    check(copied === (await viewerState(app)).prompt, "the copied text is not the shown prompt");
    return `${name} schema shown, ${copied.length} characters copied`;
  },
};

const closeReturnsFocus = { id: "E2E-SESSION-CONTEXT-viewer:close", run: (app) => closeViewer(app) };

const noContextYet = {
  id: "E2E-SESSION-CONTEXT-viewer:empty",
  run: async (app) => {
    const before = model.requests.length;
    const { session } = await app.invoke("sessionCreate", {
      title: "No request yet", mode: "agent", projectPath: state.workspace, providerId: state.provider.id, modelId: MODEL,
    });
    // An imported reply: the inspector has usage to show, but no request was made.
    await app.invoke("sessionReplaceMessages", { sessionId: session.id, messages: [
      { id: "imported-user", role: "user", content: "Earlier question", createdAt: new Date().toISOString() },
      { id: "imported-reply", role: "assistant", content: "Earlier answer", createdAt: new Date().toISOString(),
        status: "complete", providerId: state.provider.id, modelId: MODEL,
        usage: { inputTokens: 900, outputTokens: 12, totalTokens: 912 } },
    ] });
    await app.reload();
    await app.selectSession(session.id);
    const viewer = await openViewer(app);
    check(viewer.status === EMPTY, `empty session status: ${shortText(viewer)}`);
    check(model.requests.length === before, "opening the viewer sent a model request");
    await closeViewer(app);
  },
};

const elsewhere = {
  id: "E2E-SESSION-CONTEXT-viewer:unavailable",
  run: async (app) => {
    // Main answers for a Pi CLI session without a Host read.
    const native = await app.invoke("sessionContextGet", { sessionId: "native-pi:fixture" });
    check(native.status === "unavailable" && native.reason === "native", `native-pi: ${shortText(native)}`);
    // The backend router keeps a remote call remote, even with no paired host,
    // so the renderer explains a remote session itself, before any IPC.
    const remote = await app.invokeResult("sessionContextGet", { sessionId: "remote:fixture-host:abc" });
    check(remote?.ok === false && remote.error?.code === "AGENT_UNAVAILABLE", `remote: ${shortText(remote)}`);
  },
};

await runScenario("session-context-viewer", { seed }, [lastRequest, toolAndCopy, closeReturnsFocus, noContextYet, elsewhere]);
