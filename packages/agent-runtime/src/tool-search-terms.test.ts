/**
 * Desktop's ToolSearch is its own implementation (`runtime.ts`
 * `findDeferredTools`), not pi's `tool_search`. Pi 1.5.0 fixed non-ASCII
 * queries in its own search; these tests pin the same behavior for Desktop:
 * Chinese queries without spaces match tools described in Chinese, while
 * ASCII rankings stay identical to the previous separator-only tokenizer.
 */
import { describe, expect, it } from "vitest";
import { normalizeSearchText, rankToolSearch, toolSearchTerms } from "./tool-search-terms.js";

/** The ranking before non-ASCII support, kept verbatim as the parity oracle. */
function legacyRank(query: string, candidates: Array<{ name: string; description: string }>): string[] {
  const normalizedQuery = query.toLowerCase();
  if (!normalizedQuery) return [];
  const terms = normalizedQuery.split(/[\s,;|/]+/).filter(Boolean);
  return candidates
    .map(({ name, description }) => {
      const normalizedName = name.toLowerCase();
      const lowered = description.toLowerCase();
      let score = 0;
      if (normalizedName === normalizedQuery) score += 10_000;
      else if (normalizedName.includes(normalizedQuery)) score += 2_000;
      for (const term of terms) {
        if (normalizedName.includes(term)) score += 300;
        if (lowered.includes(term)) score += 25;
      }
      return { name, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((candidate) => candidate.name);
}

const catalog = [
  { name: "Read", description: "Read a file from the workspace." },
  { name: "Grep", description: "Search file contents with a regex." },
  { name: "Glob", description: "List files by glob pattern." },
  { name: "mcp__radius__search", description: "Search the Radius knowledge base." },
  { name: "mcp__peekaboo__app", description: "Control a macOS app window." },
  { name: "WebFetch", description: "Fetch a URL and read the page." },
  { name: "Write", description: "Write a file." },
];

describe("rankToolSearch", () => {
  it.each([
    "Read", "read, grep", "mcp__radius__search", "peekaboo app", "file", "search|fetch",
    "a/b", "Write; read", "zzz", "  ", "",
  ])("ranks ASCII query %j exactly like the legacy tokenizer", (query) => {
    expect(rankToolSearch(query, catalog)).toEqual(legacyRank(query, catalog));
  });

  it("matches a Chinese query without spaces word by word", () => {
    const tools = [...catalog, { name: "history", description: "搜索项目中的历史记录" }];
    // The old tokenizer kept "搜索记录" as one opaque term and found nothing.
    expect(legacyRank("搜索记录", tools)).toEqual([]);
    expect(rankToolSearch("搜索记录", tools)).toEqual(["history"]);
  });

  it("folds full-width forms in both the query and the catalog", () => {
    expect(normalizeSearchText("Ｒｅａｄ")).toBe("read");
    expect(rankToolSearch("Ｒｅａｄ", catalog)[0]).toBe("Read");
    expect(rankToolSearch("window", [{ name: "app", description: "Control a ｗｉｎｄｏｗ." }])).toEqual(["app"]);
  });
});

describe("toolSearchTerms", () => {
  it("splits on full-width and ideographic punctuation", () => {
    expect(toolSearchTerms("ｒｅａｄ，ｇｒｅｐ")).toEqual(["read", "grep"]);
    expect(toolSearchTerms("搜索、记录")).toEqual(["搜索", "记录"]);
  });

  it("keeps separator splitting when no word segmenter is available", () => {
    expect(toolSearchTerms("搜索。记录", null)).toEqual(["搜索", "记录"]);
    expect(toolSearchTerms("搜索记录", null)).toEqual(["搜索记录"]);
  });

  it("returns no terms for a blank query", () => {
    expect(toolSearchTerms("   ")).toEqual([]);
    expect(toolSearchTerms("")).toEqual([]);
  });
});
