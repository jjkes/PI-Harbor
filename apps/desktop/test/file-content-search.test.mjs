import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  __mount,
  __render,
  useCallback,
  useMemo,
  useState,
} from "./helpers/react-hook-stub.mjs";

function loadHook() {
  const file = new URL(
    "../src/components/workpanel/use-file-content-search.ts",
    import.meta.url,
  );
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      if (id === "react") {
        return { useState, useMemo, useCallback };
      }
      if (id === "../../lib/session-search") {
        return {
          searchMatchRanges: (text, query) => {
            const needle = query.trim().toLowerCase();
            if (!needle) return [];
            const folded = text.toLowerCase();
            const ranges = [];
            let from = 0;
            while (from < folded.length) {
              const index = folded.indexOf(needle, from);
              if (index < 0) break;
              ranges.push([index, index + needle.length]);
              from = index + needle.length;
            }
            return ranges;
          },
        };
      }
      throw new Error(`unmocked dependency: ${id}`);
    },
    module.exports,
    module,
  );
  return module.exports;
}

const { useFileContentSearch } = loadHook();

test("empty query returns no matches", () => {
  const search = __mount(() => useFileContentSearch("Hello world\nSecond line"));
  assert.equal(search.hasQuery, false);
  assert.equal(search.count, 0);
  assert.deepEqual(search.matches, []);
});

test("search is case-insensitive and reports match positions", () => {
  const content = "Hello WORLD\nhello again";
  let search = __mount(() => useFileContentSearch(content));
  search.setQuery("hello");
  search = __render(() => useFileContentSearch(content));
  assert.equal(search.count, 2);
  assert.deepEqual(search.matches, [
    { line: 0, start: 0, end: 5 },
    { line: 1, start: 0, end: 5 },
  ]);
});

test("no-results state is reported when query matches nothing", () => {
  const search = __mount(() => useFileContentSearch("alpha beta gamma"));
  search.setQuery("delta");
  const afterSet = __render(() => useFileContentSearch("alpha beta gamma"));
  assert.equal(afterSet.hasQuery, true);
  assert.equal(afterSet.count, 0);
});

test("next and previous cycle through matches", () => {
  const content = "one two one three one";
  let search = __mount(() => useFileContentSearch(content));
  search.setQuery("one");
  search = __render(() => useFileContentSearch(content));
  assert.equal(search.count, 3);
  assert.equal(search.activeIndex, 0);

  search.next();
  search = __render(() => useFileContentSearch(content));
  assert.equal(search.activeIndex, 1);

  search.next();
  search = __render(() => useFileContentSearch(content));
  assert.equal(search.activeIndex, 2);

  search.next();
  search = __render(() => useFileContentSearch(content));
  assert.equal(search.activeIndex, 0);

  search.previous();
  search = __render(() => useFileContentSearch(content));
  assert.equal(search.activeIndex, 2);

  search.previous();
  search = __render(() => useFileContentSearch(content));
  assert.equal(search.activeIndex, 1);
});

test("changing the query resets active index to zero", () => {
  const content = "foo bar foo baz";
  let search = __mount(() => useFileContentSearch(content));
  search.setQuery("foo");
  search = __render(() => useFileContentSearch(content));
  search.next();
  search = __render(() => useFileContentSearch(content));
  assert.equal(search.activeIndex, 1);

  search.setQuery("bar");
  search = __render(() => useFileContentSearch(content));
  assert.equal(search.activeIndex, 0);
  assert.equal(search.count, 1);
});

test("search matches only the content the viewer renders (line cap consistency)", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1} has needle`);
  const fullContent = lines.join("\n");
  const cap = 5;
  const visibleContent = lines.slice(0, cap).join("\n");

  let fullSearch = __mount(() => useFileContentSearch(fullContent));
  let cappedSearch = __mount(() => useFileContentSearch(visibleContent));
  fullSearch.setQuery("needle");
  cappedSearch.setQuery("needle");
  fullSearch = __render(() => useFileContentSearch(fullContent));
  cappedSearch = __render(() => useFileContentSearch(visibleContent));

  assert.equal(fullSearch.count, 10);
  assert.equal(cappedSearch.count, 5);
  assert.deepEqual(
    cappedSearch.matches.map((m) => m.line),
    [0, 1, 2, 3, 4],
  );
});
