import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const hostRuntime = readFileSync(
  join(here, "..", "electron", "main", "runtime", "host.ts"),
  "utf8",
);

/**
 * Extract the body of an `else if (method === "...") { ... }` branch from the
 * host notification handler. The match stops at the next `} else if` or `});`
 * at the same nesting level.
 */
function branchBody(source, method) {
  const marker = `} else if (method === "${method}") {`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `branch for ${method} not found`);
  const bodyStart = source.indexOf("{", start) + 1;
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index);
    }
  }
  throw new Error(`unbalanced braces in ${method} branch`);
}

test("configSync.progress forwards progress to the renderer", () => {
  const body = branchBody(hostRuntime, "configSync.progress");
  assert.match(
    body,
    /sendToRenderer\s*\(\s*IPC\.event\.configSyncProgress\s*,\s*params\s*\)/,
  );
});

test("terminal.output normalizes and forwards output to the renderer", () => {
  const body = branchBody(hostRuntime, "terminal.output");
  assert.match(body, /normalizeTerminalOutput\s*\(\s*params\s*\)/);
  assert.match(
    body,
    /sendToRenderer\s*\(\s*IPC\.event\.terminalOutput\s*,\s*event\s*\)/,
  );
});

test("terminal.changed normalizes and forwards lifecycle to the renderer", () => {
  const body = branchBody(hostRuntime, "terminal.changed");
  assert.match(body, /normalizeTerminalChanged\s*\(\s*params\s*\)/);
  assert.match(
    body,
    /sendToRenderer\s*\(\s*IPC\.event\.terminalChanged\s*,\s*event\s*\)/,
  );
});

test("configSync.progress and terminal branches do not swallow each other", () => {
  const progressIdx = hostRuntime.indexOf('} else if (method === "configSync.progress") {');
  const outputIdx = hostRuntime.indexOf('} else if (method === "terminal.output") {');
  const changedIdx = hostRuntime.indexOf('} else if (method === "terminal.changed") {');
  assert.ok(progressIdx >= 0, "configSync.progress branch exists");
  assert.ok(outputIdx >= 0, "terminal.output branch exists");
  assert.ok(changedIdx >= 0, "terminal.changed branch exists");
  assert.ok(
    progressIdx < outputIdx && outputIdx < changedIdx,
    "branches are ordered and distinct",
  );

  const progressBody = branchBody(hostRuntime, "configSync.progress");
  const outputBody = branchBody(hostRuntime, "terminal.output");
  assert.match(
    progressBody,
    /IPC\.event\.configSyncProgress/,
    "configSync.progress keeps its own event channel",
  );
  assert.match(
    outputBody,
    /IPC\.event\.terminalOutput/,
    "terminal.output keeps its own event channel",
  );
});
