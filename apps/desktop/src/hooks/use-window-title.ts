import { useEffect, useRef } from "react";
import { conversationWindowTitle } from "../lib/conversation-title";

/** The document surface this hook needs; a test can pass a plain object. */
export type TitleDocument = { title: string };

/**
 * Names the OS window after the conversation on screen.
 *
 * Electron mirrors `document.title` onto the BrowserWindow through
 * `page-title-updated`, and nothing in the main process intercepts it for the
 * main window, so writing the document title here is the whole mechanism — no
 * IPC channel, no main-process change.
 *
 * `defaultTitle` is the title the window already carried (from `index.html`),
 * captured rather than hard-coded, and restored whenever there is no
 * conversation to name. Returns the restore function so the caller — and the
 * test — can undo the write.
 */
export function applyWindowTitle(
  doc: TitleDocument,
  breadcrumbTitle: string | null,
  defaultTitle: string,
): () => void {
  doc.title = conversationWindowTitle(breadcrumbTitle, defaultTitle);
  return () => {
    doc.title = defaultTitle;
  };
}

/**
 * Keeps the window title on the conversation crumb while this component is
 * mounted, and puts the app's own default title back when it unmounts or when
 * `breadcrumbTitle` is null (no conversation is being shown).
 */
export function useWindowTitle(breadcrumbTitle: string | null) {
  /* Captured before the first write, so the baseline is the real default and
     not a title this hook set on an earlier render. */
  const defaultTitleRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (defaultTitleRef.current === null) defaultTitleRef.current = document.title;
    return applyWindowTitle(document, breadcrumbTitle, defaultTitleRef.current);
  }, [breadcrumbTitle]);
}
