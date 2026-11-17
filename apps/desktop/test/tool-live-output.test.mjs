import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

/*
 * Live tool output (D682).
 *
 * A running call shows the output it has produced so far. These tests lock the
 * three pieces that make that true: the frame's producer-shaped payload is
 * unwrapped to display text, the text is bounded with both ends kept, and the
 * settled row keeps that body instead of reprinting the final result, while
 * anything the stream never delivered still reaches the reader.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  MAX_LIVE_TOOL_OUTPUT_CHARS,
  LIVE_TOOL_OUTPUT_TRUNCATION_MARKER,
  clipLiveToolOutput,
  liveToolOutput,
  toolProgressText,
  toolRowOpensWithLiveOutput,
} = await import("../src/lib/tool-live-output.ts");
const { buildToolPresentation, toolResultChips } = await import(
  "../src/lib/tool-presentation.ts"
);

const runtimeText = (text) => ({
  content: [{ type: "text", text }],
  details: { output: text },
});

test("a progress frame's text is unwrapped from every producer shape", () => {
  // The runtime's own envelope: accumulated output lives in `details.output`.
  assert.equal(toolProgressText(runtimeText("npm install\n")), "npm install\n");
  // pi's native session forwards a content list without details.
  assert.equal(
    toolProgressText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    "ab",
  );
  // A plain string producer needs no unwrapping.
  assert.equal(toolProgressText("plain"), "plain");
  // Anything unexpected still renders something instead of throwing.
  assert.match(toolProgressText(42), /42/);
});

test("live output is bounded with both ends kept and a marker between", () => {
  const head = "HEAD".repeat(4);
  const body = "x".repeat(MAX_LIVE_TOOL_OUTPUT_CHARS * 2);
  const tail = "TAIL".repeat(4);
  const clipped = clipLiveToolOutput(`${head}${body}${tail}`);
  assert.ok(clipped.length <= MAX_LIVE_TOOL_OUTPUT_CHARS);
  assert.match(clipped, /HEAD/);
  assert.match(clipped, /TAIL/);
  assert.ok(clipped.includes(LIVE_TOOL_OUTPUT_TRUNCATION_MARKER));
  // Nothing to clip: the text is returned untouched.
  assert.equal(clipLiveToolOutput("small"), "small");
});

test("a row opens for a live body only, and keeps it after settling", () => {
  assert.equal(toolRowOpensWithLiveOutput({}), false);
  assert.equal(toolRowOpensWithLiveOutput({ toolLiveOutput: "" }), false);
  assert.equal(toolRowOpensWithLiveOutput({ toolLiveOutput: "one line" }), true);
  assert.equal(liveToolOutput({}), null);
  assert.equal(liveToolOutput({ toolLiveOutput: "one line" }), "one line");
});

test("a run row shows the stream it watched, not the reprint of its result", () => {
  const whileRunning = buildToolPresentation({
    toolName: "Bash",
    toolArgs: { command: "npm test" },
    toolResult: runtimeText("PASS auth\n"),
    toolLiveOutput: "PASS auth\n",
    toolStatus: "running",
  });
  const stdout = whileRunning.filter((block) => block.role === "stdout");
  assert.equal(stdout.length, 1);
  assert.equal(stdout[0].text, "PASS auth\n");

  // Settled: the body is still what the reader watched, and the final result
  // contributes the ending (exit code) rather than the same text twice.
  const settled = buildToolPresentation({
    toolName: "Bash",
    toolArgs: { command: "npm test" },
    toolResult: {
      content: [{ type: "text", text: "PASS auth\n" }],
      details: { stdout: "PASS auth\n", stderr: "", exitCode: 0 },
    },
    toolLiveOutput: "PASS auth\n",
    toolStatus: "success",
  });
  assert.equal(settled.filter((block) => block.role === "stdout").length, 1);
  assert.equal(
    settled.filter((block) => block.role === "stdout")[0].text,
    "PASS auth\n",
  );
  assert.equal(
    settled.filter((block) => block.role === "stderr").length,
    0,
    "stderr the stream already showed is not printed again",
  );
  assert.deepEqual(
    toolResultChips({
      toolName: "Bash",
      toolArgs: { command: "npm test" },
      toolResult: {
        content: [{ type: "text", text: "PASS auth\n" }],
        details: { stdout: "PASS auth\n", stderr: "", exitCode: 0 },
      },
      toolLiveOutput: "PASS auth\n",
      toolStatus: "success",
    }),
    [],
    "a successful exit is implied by the row status",
  );
});

test("a failure the stream never delivered still reaches the row", () => {
  const blocks = buildToolPresentation({
    toolName: "Bash",
    toolArgs: { command: "npm test" },
    toolResult: {
      content: [{ type: "text", text: "PASS auth\n" }],
      details: {
        stdout: "PASS auth\n",
        stderr: "1 failing test\n",
        exitCode: 1,
        truncated: true,
      },
    },
    toolLiveOutput: "PASS auth\n",
    toolStatus: "error",
  });
  const stderr = blocks.find((block) => block.role === "stderr");
  assert.ok(stderr, "stderr that never streamed is rendered");
  assert.match(stderr.text, /1 failing test/);
  const chips = toolResultChips({
    toolName: "Bash",
    toolArgs: { command: "npm test" },
    toolResult: {
      content: [{ type: "text", text: "PASS auth\n" }],
      details: { stdout: "PASS auth\n", stderr: "1 failing test\n", exitCode: 1, truncated: true },
    },
    toolLiveOutput: "PASS auth\n",
    toolStatus: "error",
  });
  assert.deepEqual(
    chips.map((chip) => chip.role).sort(),
    ["exit", "truncated"],
  );
});

test("a call that never streamed renders exactly its result", () => {
  const blocks = buildToolPresentation({
    toolName: "Bash",
    toolArgs: { command: "ls" },
    toolResult: {
      content: [{ type: "text", text: "a.txt\n" }],
      details: { stdout: "a.txt\n", stderr: "", exitCode: 0 },
    },
    toolStatus: "success",
  });
  const stdout = blocks.filter((block) => block.role === "stdout");
  assert.equal(stdout.length, 1);
  assert.equal(stdout[0].text, "a.txt\n");
});

test("an opaque tool keeps its live body and still shows what settled", () => {
  const running = buildToolPresentation({
    toolName: "plugin_demo_query",
    toolArgs: {},
    toolResult: runtimeText("row 1\nrow 2\n"),
    toolLiveOutput: "row 1\nrow 2\n",
    toolStatus: "running",
  });
  assert.equal(running.length, 1);
  assert.equal(running[0].role, "output");
  assert.equal(running[0].text, "row 1\nrow 2\n");

  const settled = buildToolPresentation({
    toolName: "plugin_demo_query",
    toolArgs: {},
    toolResult: { details: { output: "row 1\nrow 2\n", rows: 2 } },
    toolLiveOutput: "row 1\nrow 2\n",
    toolStatus: "success",
  });
  const outputs = settled.filter((block) => block.role === "output");
  assert.equal(outputs.length, 1, "the streamed body is not printed twice");
  assert.equal(outputs[0].text, "row 1\nrow 2\n");
  assert.ok(
    settled.some((block) => block.kind === "fields"),
    "the settled payload still contributes its own fields",
  );
});

test("the tool row derives its disclosure from the live body", () => {
  const source = readFileSync(
    new URL("../src/features/chat/transcript/ToolRow.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /toolRowOpensWithLiveOutput\(message\)/);
  assert.doesNotMatch(
    source,
    /useAutomaticDisclosure\(\s*false\s*,\s*revealRequest,\s*disclosureKey\("tool"/,
    "a streamed call no longer starts closed unconditionally",
  );
});

test("a body cut to its budget reports itself once, in every locale", async () => {
  const { clipLiveToolOutputWithFlag } = await import("../src/lib/tool-live-output.ts");
  const cut = clipLiveToolOutputWithFlag("z".repeat(MAX_LIVE_TOOL_OUTPUT_CHARS + 1));
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.length <= MAX_LIVE_TOOL_OUTPUT_CHARS);
  assert.deepEqual(
    clipLiveToolOutputWithFlag("short"),
    { text: "short", truncated: false },
  );

  // The head says the body is a preview; the label lives in i18n, not in the
  // output text, and every shipped locale carries it (D682).
  const chips = toolResultChips({
    toolName: "Bash",
    toolArgs: { command: "npm test" },
    toolResult: { details: { stdout: "z", stderr: "", exitCode: 0 } },
    toolLiveOutput: cut.text,
    toolLiveOutputTruncated: true,
    toolStatus: "running",
  });
  assert.deepEqual(chips, [{ role: "liveTruncated" }]);

  const locales = ["de", "en", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];
  for (const locale of locales) {
    const messages = (await import(`../../../packages/i18n/src/locales/${locale}/index.ts`)).default;
    const label = Object.values(messages).find((group) =>
      group && typeof group === "object" && "toolChipLiveTruncated" in group,
    )?.toolChipLiveTruncated;
    assert.equal(typeof label, "string", `${locale} carries the live truncation label`);
    assert.ok(label.length > 0, `${locale} label is not empty`);
  }
});
