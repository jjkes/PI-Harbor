import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

/*
 * The live terminal surface (D683).
 *
 * A call that is producing output paints one chrome strip and one sunken plate
 * while it works, so a running row cannot be read as a settled one. The surface
 * is a presentation of the same block list: it never changes what the output
 * says, and it disappears when the call settles.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { isLiveTerminalActive } = await import("../src/lib/tool-live-output.ts");

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

/** Compile the component with the dependencies the render path actually uses. */
function loadTerminal() {
  const source = read("../src/components/ToolLiveTerminal.tsx");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    fileName: "ToolLiveTerminal.tsx",
  });
  const imports = {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
    "./ToolDetails": {
      ToolDetailBlocks: ({ blocks }) =>
        React.createElement(
          "div",
          { "data-stub-blocks": blocks.length },
          blocks.map((block) => block.text ?? block.role).join("|"),
        ),
    },
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unmocked dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports.ToolLiveTerminal;
}

const Terminal = loadTerminal();
const blocks = [
  { kind: "code", role: "stdout", text: "PASS auth", lang: "", highlight: false },
];

test("a running command reads as a command window", () => {
  const html = renderToStaticMarkup(
    React.createElement(Terminal, { command: "npm test", blocks }),
  );
  assert.match(html, /class="tool-live-terminal"/);
  assert.match(html, /aria-label="chat.toolLiveOutput"/);
  assert.match(html, /tool-live-terminal-bar/);
  assert.match(html, /class="tool-live-terminal-prompt"[^>]*>\$/);
  assert.match(html, /npm test/);
  assert.match(html, /chat.toolLiveRunning/);
  assert.match(html, /tool-live-terminal-pulse/);
  // The body is the same block list, inside the surface.
  assert.match(html, /tool-live-terminal-body[\s\S]*data-stub-blocks="1"/);
});

test("a running host tool names itself instead of a shell prompt", () => {
  const html = renderToStaticMarkup(
    React.createElement(Terminal, { label: "Query customers", blocks }),
  );
  assert.match(html, /class="tool-live-terminal-prompt"[^>]*>›/);
  assert.match(html, /Query customers/);
  assert.doesNotMatch(html, /title=/);
});

test("the surface belongs to a running call that has output", () => {
  assert.equal(isLiveTerminalActive({ toolStatus: "running", toolLiveOutput: "a" }), true);
  // Nothing produced yet: there is no terminal to paint.
  assert.equal(isLiveTerminalActive({ toolStatus: "running" }), false);
  assert.equal(isLiveTerminalActive({ toolStatus: "running", toolLiveOutput: "" }), false);
  // Settled rows are history and keep the unframed body (D227).
  assert.equal(isLiveTerminalActive({ toolStatus: "success", toolLiveOutput: "a" }), false);
  assert.equal(isLiveTerminalActive({ toolStatus: "error", toolLiveOutput: "a" }), false);
});

test("the tool row paints the surface only while the call runs", () => {
  const source = read("../src/features/chat/transcript/ToolRow.tsx");
  assert.match(source, /const liveTerminal = variant !== "topology" && isLiveTerminalActive\(message\);/);
  assert.match(source, /\{liveTerminal \? \([\s\S]*?<ToolLiveTerminal/);
  // The settled path still renders the D227 unframed body.
  assert.match(source, /<ToolDetailBlocks blocks=\{blocks\} plain=\{runHead\} streaming=\{status === "running"\} \/>/);
  assert.match(source, /\.\.\.\(runHead \? \{ command \} : \{ label: summary \|\| rawName \}\)/, "a run row shows its command, other tools their own name");
});

test("the surface's chrome and label exist in every locale", async () => {
  const locales = ["de", "en", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];
  for (const locale of locales) {
    const messages = (await import(`../../../packages/i18n/src/locales/${locale}/index.ts`)).default;
    const chat = Object.values(messages).find(
      (group) =>
        group && typeof group === "object" && "toolLiveRunning" in group,
    );
    assert.equal(typeof chat?.toolLiveRunning, "string", `${locale} has the running label`);
    assert.equal(typeof chat?.toolLiveOutput, "string", `${locale} has the surface label`);
  }
});
