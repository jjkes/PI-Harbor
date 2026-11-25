import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import type { FsEntry, FsReadResult } from "@pi-harbor/shared";
import { useAppStore } from "../../stores/app-store";
import { useRevealChatFile } from "../../hooks/use-preview-target";
import { api } from "../../lib/api";
import { Markdown } from "../Markdown";
import { fileDirOf } from "../../lib/chat-links";
import { Button, cx, Input } from "../ui";
import { TooltipButton } from "../ui";
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconChevronDown,
  IconClose,
  IconExternal,
  IconFileText,
  IconFolder,
  IconSearch,
} from "../icons";
import { useFileContentSearch, type FileSearchMatch } from "./use-file-content-search";
import { WorkTabEmpty } from "./WorkTabEmpty";
import {
  ensureLang,
  getHighlightVersion,
  resolveLang,
  subscribeHighlighter,
  themeForMode,
  tokenizeIncremental,
  type LineCache,
} from "../../lib/shiki";

const VIEWER_LINE_CAP = 5000;

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  rs: "rust",
  py: "python",
  go: "go",
  sh: "shellscript",
  zsh: "shellscript",
  bash: "shellscript",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  swift: "swift",
  kt: "kotlin",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
};

function langForPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const lang = EXT_LANG[ext] ?? ext;
  return resolveLang(lang);
}

function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path);
}

function isMp4(path: string, mimeType?: string): boolean {
  return /\.mp4$/i.test(path) || (
    /(?:^|[\\/])attachments[\\/][0-9a-f]{64}$/i.test(path) &&
    mimeType?.toLowerCase() === "video/mp4"
  );
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function useThemeMode(): "light" | "dark" {
  return useSyncExternalStore(
    (notify) => {
      const observer = new MutationObserver(notify);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      return () => observer.disconnect();
    },
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
  );
}

type LineSegment = {
  start: number;
  end: number;
  text: string;
  color?: string;
};

function buildSegments(
  base: LineSegment[],
  matches: FileSearchMatch[],
  activeMatch: FileSearchMatch | null,
): Array<LineSegment & { highlighted: boolean; active: boolean }> {
  let segments: Array<LineSegment & { highlighted: boolean; active: boolean }> =
    base.map((seg) => ({ ...seg, highlighted: false, active: false }));
  for (const match of matches) {
    const next: Array<LineSegment & { highlighted: boolean; active: boolean }> = [];
    const active =
      activeMatch !== null &&
      match.line === activeMatch.line &&
      match.start === activeMatch.start &&
      match.end === activeMatch.end;
    for (const seg of segments) {
      if (match.start >= seg.end || match.end <= seg.start) {
        next.push(seg);
        continue;
      }
      if (match.start > seg.start) {
        next.push({
          ...seg,
          end: match.start,
          text: seg.text.slice(0, match.start - seg.start),
        });
      }
      const overlapStart = Math.max(seg.start, match.start);
      const overlapEnd = Math.min(seg.end, match.end);
      next.push({
        ...seg,
        start: overlapStart,
        end: overlapEnd,
        text: seg.text.slice(
          overlapStart - seg.start,
          overlapEnd - seg.start,
        ),
        highlighted: true,
        active,
      });
      if (match.end < seg.end) {
        next.push({
          ...seg,
          start: match.end,
          text: seg.text.slice(match.end - seg.start),
        });
      }
    }
    segments = next;
  }
  return segments;
}

function renderLine(
  lineText: string,
  tokens: { content: string; color?: string }[] | undefined,
  matches: FileSearchMatch[],
  activeMatch: FileSearchMatch | null,
): React.ReactNode {
  const base: LineSegment[] = tokens?.length
    ? tokens.map((token) => ({
        start: 0,
        end: token.content.length,
        text: token.content,
        color: token.color,
      }))
    : [{ start: 0, end: lineText.length, text: lineText }];
  const segments = buildSegments(base, matches, activeMatch);
  return segments.map((seg, index) =>
    seg.highlighted ? (
      <mark
        key={index}
        className={cx("search-hit", seg.active && "search-hit-active")}
      >
        {seg.color ? (
          <span style={{ color: seg.color }}>{seg.text}</span>
        ) : (
          seg.text
        )}
      </mark>
    ) : seg.color ? (
      <span key={index} style={{ color: seg.color }}>
        {seg.text}
      </span>
    ) : (
      seg.text
    ),
  );
}

function HighlightedText({
  path,
  content,
  capped,
  targetLine,
  searchMatches,
  activeMatch,
}: {
  path: string;
  content: string;
  /** True when the caller truncated the content and the ellipsis is shown. */
  capped?: boolean;
  /** The line a positioned `path:line` reference opened, if any. */
  targetLine?: number;
  searchMatches?: FileSearchMatch[];
  activeMatch?: FileSearchMatch | null;
}) {
  const mode = useThemeMode();
  const highlightVersion = useSyncExternalStore(
    subscribeHighlighter,
    getHighlightVersion,
  );
  const lang = langForPath(path);
  const visibleLines = content.split("\n");

  const tokens = useMemo<LineCache | null>(() => {
    void highlightVersion;
    if (!lang) return null;
    ensureLang(lang);
    return tokenizeIncremental(null, content, lang, themeForMode(mode));
  }, [lang, content, mode, highlightVersion]);

  const matchesByLine = useMemo(() => {
    const map = new Map<number, FileSearchMatch[]>();
    for (const match of searchMatches ?? []) {
      const list = map.get(match.line) ?? [];
      list.push(match);
      map.set(match.line, list);
    }
    return map;
  }, [searchMatches]);

  const rows: React.ReactNode[] = [];
  for (let i = 0; i < visibleLines.length; i += 1) {
    const lineTokens = tokens?.tokens[i];
    rows.push(
      renderLine(
        visibleLines[i],
        lineTokens?.length ? lineTokens : undefined,
        matchesByLine.get(i) ?? [],
        activeMatch ?? null,
      ),
    );
  }

  return (
    <pre className="file-viewer-code">
      {rows.map((row, i) => (
        <div
          className="file-viewer-line"
          data-line={i + 1}
          aria-current={i + 1 === targetLine ? "location" : undefined}
          key={i}
        >
          {row || "\n"}
        </div>
      ))}
      {capped && <div className="file-viewer-cap">…</div>}
    </pre>
  );
}

type DirState = { entries: FsEntry[]; error?: boolean };

// Module-level so a chat preview request fires once, not again on every
// files-tab remount (the tab unmounts when another tool is selected).
let handledFileRequestSeq = 0;

export function FilesTab() {
  const { t } = useTranslation();
  const workspace = useAppStore((s) => s.workspace);
  const fileRequest = useAppStore((s) => s.workPanelFileRequest);
  const showToast = useAppStore((s) => s.showToast);
  const sessionId = useAppStore((state) => state.activeSessionId);
  const remote = workspace?.remote;
  const root = workspace?.path ?? null;
  const scopeRef = useRef({ root, sessionId });
  scopeRef.current = { root, sessionId };

  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedMimeType, setSelectedMimeType] = useState<string | undefined>();
  const [selectedLine, setSelectedLine] = useState<number | undefined>();
  const [file, setFile] = useState<FsReadResult | null>(null);
  const [fileError, setFileError] = useState(false);
  const viewerBodyRef = useRef<HTMLDivElement>(null);
  const fileGeneration = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fileContent = file?.content ?? "";
  const [visibleContent, capped] = useMemo(() => {
    const lines = fileContent.split("\n");
    return lines.length > VIEWER_LINE_CAP
      ? [lines.slice(0, VIEWER_LINE_CAP).join("\n"), true]
      : [fileContent, false];
  }, [fileContent]);
  const { label: revealLabel, reveal: revealFile } = useRevealChatFile();
  const search = useFileContentSearch(visibleContent);

  useEffect(() => {
    search.setQuery("");
  }, [selected, search.setQuery]);

  // Scroll the active search match into view when it changes.
  useEffect(() => {
    if (!file || search.count === 0) return;
    const match = search.matches[search.activeIndex];
    if (!match) return;
    const frame = requestAnimationFrame(() => {
      const lineNode = viewerBodyRef.current?.querySelector(
        `[data-line="${match.line + 1}"]`,
      );
      const hitNode = lineNode?.querySelector(".search-hit-active");
      (hitNode ?? lineNode)?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [file, search.activeIndex, search.count, search.matches]);

  // Workspace switches reset all browsing state. Guarded so it only fires on
  // an actual root change: an unconditional [root] effect also runs on the
  // StrictMode remount, wiping the selection a chat file request just made
  // (first click landed on the tree instead of the file).
  const prevRoot = useRef(root);
  useEffect(() => {
    if (prevRoot.current === root) return;
    prevRoot.current = root;
    setDirs({});
    setExpanded(new Set());
    setSelected(null);
    setSelectedMimeType(undefined);
    setSelectedLine(undefined);
    setFile(null);
    setFileError(false);
  }, [root]);

  const loadDir = useCallback(
    async (rel: string) => {
      if (!root) return;
      try {
        const res = await api.fsList(rel, sessionId);
        if (scopeRef.current.root !== root || scopeRef.current.sessionId !== sessionId) return;
        setDirs((prev) => ({ ...prev, [rel]: { entries: res.entries } }));
      } catch {
        if (scopeRef.current.root !== root || scopeRef.current.sessionId !== sessionId) return;
        setDirs((prev) => ({ ...prev, [rel]: { entries: [], error: true } }));
      }
    },
    [root, sessionId],
  );

  useEffect(() => {
    if (root && !dirs[""]) void loadDir("");
  }, [root, dirs, loadDir]);

  const toggleDir = useCallback(
    (rel: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) {
          next.delete(rel);
        } else {
          next.add(rel);
        }
        return next;
      });
      if (!dirs[rel]) void loadDir(rel);
    },
    [dirs, loadDir],
  );

  const openFile = useCallback(
    async (rel: string, mimeType?: string, position?: { line?: number; column?: number }) => {
      const request = ++fileGeneration.current;
      setSelected(rel);
      setSelectedMimeType(mimeType);
      setSelectedLine(position?.line);
      setFile(null);
      setFileError(false);
      try {
        const result = await api.fsRead(rel, mimeType, sessionId);
        if (request !== fileGeneration.current || scopeRef.current.root !== root || scopeRef.current.sessionId !== sessionId) return;
        setFile(result);
      } catch {
        if (request !== fileGeneration.current || scopeRef.current.root !== root || scopeRef.current.sessionId !== sessionId) return;
        setFileError(true);
      }
    },
    [root, sessionId],
  );

  useEffect(() => {
    if (!file || selectedLine == null) return;
    const frame = requestAnimationFrame(() => {
      const lineNode = viewerBodyRef.current?.querySelector(
        `[data-line="${selectedLine}"]`,
      );
      lineNode?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [file, selectedLine]);

  const openMp4 = useCallback(async () => {
    if (!selected || remote) return;
    try {
      await api.fsOpen(selected, selectedMimeType, sessionId);
    } catch {
      showToast(t("panel.files.openFailed"), { variant: "error" });
    }
  }, [selected, selectedMimeType, sessionId, showToast, t]);

  // Chat-initiated previews: open the file and expand its ancestor folders
  // so "back" lands on a tree that reveals it. Attachment blobs and absolute
  // scratch paths live outside the workspace tree.
  useEffect(() => {
    if (!fileRequest) return;
    if (fileRequest.seq === handledFileRequestSeq) return;
    handledFileRequestSeq = fileRequest.seq;
    const path = fileRequest.path;
    const isExternal =
      path.startsWith("attachments/") ||
      path.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(path) ||
      path.startsWith("\\\\");
    if (root && !isExternal) {
      const parts = path.split("/").slice(0, -1);
      const ancestors: string[] = [];
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        ancestors.push(acc);
      }
      setExpanded((prev) => new Set([...prev, ...ancestors]));
      for (const dir of ancestors) void loadDir(dir);
    }
    void openFile(path, fileRequest.mimeType, {
      line: fileRequest.line,
      column: fileRequest.column,
    });
  }, [fileRequest, root, loadDir, openFile]);

  const renderDir = (rel: string, depth: number): React.ReactNode => {
    const state = dirs[rel];
    if (!state) {
      return (
        <div
          className="file-tree-note"
          style={{ paddingLeft: 12 + depth * 14 }}
          key={`${rel}:loading`}
        >
          {t("panel.files.loading")}
        </div>
      );
    }
    if (state.entries.length === 0) {
      return (
        <div
          className="file-tree-note"
          style={{ paddingLeft: 12 + depth * 14 }}
          key={`${rel}:empty`}
        >
          {state.error ? t("panel.files.error") : t("panel.files.empty")}
        </div>
      );
    }
    return state.entries.map((entry) => {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.kind === "dir") {
        const open = expanded.has(childRel);
        return (
          <div key={childRel}>
            <button
              type="button"
              className="file-tree-row"
              style={{ paddingLeft: 12 + depth * 14 }}
              onClick={() => toggleDir(childRel)}
            >
              <span className={cx("file-tree-caret", open && "open")} aria-hidden>
                <IconChevronRight size={12} />
              </span>
              <IconFolder size={14} />
              <span className="file-tree-name">{entry.name}</span>
            </button>
            {open && renderDir(childRel, depth + 1)}
          </div>
        );
      }
      return (
        <button
          key={childRel}
          type="button"
          className={cx("file-tree-row", selected === childRel && "active")}
          style={{ paddingLeft: 12 + depth * 14 + 16 }}
          onClick={() => void openFile(childRel)}
          title={childRel}
        >
          <IconFileText size={14} />
          <span className="file-tree-name">{entry.name}</span>
        </button>
      );
    });
  };

  if (selected !== null) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-header">
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={t("panel.files.back")}
            ariaLabel={t("panel.files.back")}
            onClick={() => {
              setSelected(null);
              setSelectedMimeType(undefined);
              setSelectedLine(undefined);
              setFile(null);
            }}
          >
            <IconChevronLeft size={14} />
          </TooltipButton>
          <span className="file-viewer-path" title={selected}>
            {selected}
          </span>
          {file && file.kind === "text" && (
            <div className="file-viewer-search-bar">
              <IconSearch size={14} />
              <Input
                ref={searchInputRef}
                type="text"
                value={search.query}
                placeholder={t("panel.files.searchPlaceholder")}
                aria-label={t("panel.files.searchPlaceholder")}
                className="file-viewer-search-input"
                onChange={(event) => search.setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (event.shiftKey) {
                      search.previous();
                    } else {
                      search.next();
                    }
                  }
                }}
              />
              {search.hasQuery && (
                <span
                  className={cx(
                    "file-viewer-search-count",
                    search.count === 0 && "no-results",
                  )}
                  aria-live="polite"
                >
                  {search.count === 0
                    ? t("panel.files.searchNoResults")
                    : `${search.activeIndex + 1} / ${search.count}`}
                </span>
              )}
              {search.hasQuery && search.count > 0 && (
                <>
                  <TooltipButton
                    type="button"
                    className="icon-btn icon-btn-square"
                    tooltip={t("panel.files.searchPrevious")}
                    ariaLabel={t("panel.files.searchPrevious")}
                    onClick={() => search.previous()}
                  >
                    <IconChevronUp size={14} />
                  </TooltipButton>
                  <TooltipButton
                    type="button"
                    className="icon-btn icon-btn-square"
                    tooltip={t("panel.files.searchNext")}
                    ariaLabel={t("panel.files.searchNext")}
                    onClick={() => search.next()}
                  >
                    <IconChevronDown size={14} />
                  </TooltipButton>
                </>
              )}
              {search.hasQuery && (
                <TooltipButton
                  type="button"
                  className="icon-btn icon-btn-square"
                  tooltip={t("panel.files.searchClear")}
                  ariaLabel={t("panel.files.searchClear")}
                  onClick={() => {
                    search.setQuery("");
                    searchInputRef.current?.focus();
                  }}
                >
                  <IconClose size={14} />
                </TooltipButton>
              )}
            </div>
          )}
          {file && <span className="file-viewer-size">{formatSize(file.size)}</span>}
          {!remote && selected && (
            <TooltipButton
              type="button"
              className="icon-btn icon-btn-square"
              tooltip={revealLabel}
              ariaLabel={revealLabel}
              onClick={() => revealFile(selected, sessionId ?? undefined)}
            >
              <IconExternal size={14} />
            </TooltipButton>
          )}
        </div>
        <div className="file-viewer-body" ref={viewerBodyRef}>
          {fileError ? (
            <WorkTabEmpty icon={IconFileText} title={t("panel.files.error")} />
          ) : !file ? (
            <div className="file-tree-note">{t("panel.files.loading")}</div>
          ) :
          file.kind === "text" &&
          isMarkdownPath(selected) &&
          selectedLine === undefined ? (
            <div className="file-viewer-markdown prose-chat">
              <Markdown source={visibleContent} baseDir={fileDirOf(selected)} />
            </div>
          ) : file.kind === "text" ? (
            <HighlightedText
              path={selected}
              content={visibleContent}
              capped={capped}
              targetLine={selectedLine}
              searchMatches={search.matches}
              activeMatch={search.matches[search.activeIndex] ?? null}
            />
          ) : file.kind === "image" ? (
            <div className="file-viewer-image">
              <img src={file.dataUrl} alt={selected} />
            </div>
          ) : (
            <WorkTabEmpty
              icon={IconFileText}
              title={
                file.kind === "tooLarge"
                  ? t("panel.files.tooLarge")
                  : t("panel.files.binary")
              }
            >
              {!remote && isMp4(selected, selectedMimeType) && (
                <Button type="button" onClick={() => void openMp4()}>
                  {t("chat.openFile")}
                </Button>
              )}
            </WorkTabEmpty>
          )}
        </div>
      </div>
    );
  }

  if (!root) {
    return (
      <WorkTabEmpty
        icon={IconFolder}
        title={t("panel.files.noWorkspace")}
        body={t("panel.files.noWorkspaceHint")}
      />
    );
  }

  return <div className="file-tree">{renderDir("", 0)}</div>;
}
