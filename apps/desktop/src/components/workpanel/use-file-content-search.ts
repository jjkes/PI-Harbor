import { useCallback, useMemo, useState } from "react";
import { searchMatchRanges } from "../../lib/session-search";

export type FileSearchMatch = {
  /** 0-based line index. */
  line: number;
  /** 0-based column index within the line. */
  start: number;
  /** 0-based exclusive column index within the line. */
  end: number;
};

export type FileContentSearch = {
  query: string;
  setQuery: (value: string) => void;
  matches: FileSearchMatch[];
  activeIndex: number;
  count: number;
  hasQuery: boolean;
  next: () => void;
  previous: () => void;
};

function matchesForLines(
  lines: string[],
  ranges: [number, number][],
): FileSearchMatch[] {
  const matches: FileSearchMatch[] = [];
  let offset = 0;
  let rangeIndex = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const lineStart = offset;
    const lineEnd = offset + line.length;
    while (rangeIndex < ranges.length) {
      const [rangeStart, rangeEnd] = ranges[rangeIndex];
      if (rangeStart >= lineEnd) break;
      if (rangeEnd <= lineStart) {
        rangeIndex += 1;
        continue;
      }
      matches.push({
        line: lineIndex,
        start: Math.max(0, rangeStart - lineStart),
        end: Math.min(line.length, rangeEnd - lineStart),
      });
      if (rangeEnd > lineEnd) break;
      rangeIndex += 1;
    }
    offset = lineEnd + 1;
  }
  return matches;
}

export function useFileContentSearch(content: string): FileContentSearch {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const lines = useMemo(() => content.split("\n"), [content]);
  const matches = useMemo<FileSearchMatch[]>(() => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    return matchesForLines(lines, searchMatchRanges(content, trimmed));
  }, [content, lines, query]);

  const count = matches.length;

  const setQueryAndReset = useCallback((value: string) => {
    setQuery(value);
    setActiveIndex(0);
  }, []);

  const next = useCallback(() => {
    setActiveIndex((index) => (count === 0 ? 0 : (index + 1) % count));
  }, [count]);

  const previous = useCallback(() => {
    setActiveIndex((index) => (count === 0 ? 0 : (index - 1 + count) % count));
  }, [count]);

  return {
    query,
    setQuery: setQueryAndReset,
    matches,
    activeIndex,
    count,
    hasQuery: query.trim().length > 0,
    next,
    previous,
  };
}
