import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/*
 * A plugin tool narrating its own work (D682).
 *
 * `ctx.progress` is an optional host capability: the child forwards each line
 * to this process, this process routes it by invocation id, and the call's own
 * return value is unchanged. A host that offers nothing gets no preview and no
 * error — the tool still runs exactly as before.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const hostEntry = fileURLToPath(
  new URL("../electron/main/plugin-host-process.mjs", import.meta.url),
);

const PLUGIN = `
  module.exports = {
    onLoad: async () => pi.agent.registerTool({
      name: "narrate",
      description: "Narrate its own work",
      schema: { type: "object" },
      execute: async (args, ctx) => {
        ctx.progress?.("step one");
        ctx.progress?.("step two");
        return { done: true, hadProgress: typeof ctx.progress === "function" };
      },
    }),
  };
`;

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-progress-"));
  const id = "demo.progress";
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: "0.0.1",
      main: "main.js",
      permissions: ["agent.tool.register"],
    }),
  );
  writeFileSync(join(dir, "main.js"), PLUGIN);
  const runtime = new PluginRuntime({
    hostEntry,
    spawnProcess({ entry }) {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return {
        postMessage: (message) => {
          if (child.connected) child.send(message);
        },
        onMessage: (handler) => child.on("message", handler),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
    getSessionContext: async (sessionId) => ({ sessionId, messages: [], truncated: false }),
  });
  t.after(async () => {
    await runtime.unload(id);
    rmSync(dir, { recursive: true, force: true });
  });
  await runtime.loadFromPath(dir, ["agent.tool.register"]);
  const tool = runtime.getTools().find((entry) => entry.name === "narrate");
  assert.ok(tool, "the plugin tool registered");
  return { tool };
}

test("a plugin tool's own progress crosses the child boundary while it runs", { timeout: 5000 }, async (t) => {
  const { tool } = await fixture(t);
  const lines = [];
  const result = await tool.execute({}, {
    sessionId: "session-a",
    turnId: "turn-a",
    progress: (text) => lines.push(text),
  });
  assert.deepEqual(lines, ["step one", "step two"]);
  assert.deepEqual(result, { done: true, hadProgress: true });
});

test("a host without a progress hook gets the same result and no error", { timeout: 5000 }, async (t) => {
  const { tool } = await fixture(t);
  const result = await tool.execute({}, { sessionId: "session-a", turnId: "turn-a" });
  assert.deepEqual(result, { done: true, hadProgress: true });
});
