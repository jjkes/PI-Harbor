import { useCallback, useEffect, useRef, useState } from "react";
import { parseRemoteSessionId } from "@pi-harbor/shared";
import { api } from "../../lib/api";

/**
 * `detached` means the host connection dropped while the host-side PTY stayed
 * alive: the terminal id is kept so the next `remote.reconnected` can re-attach
 * with the output ring the host replayed. It is deliberately not `closed`,
 * because the shell process still exists on the remote machine.
 */
export type TerminalStatus = "idle" | "open" | "detached" | "closed" | "error";

export type TerminalLine = {
  id: string;
  text: string;
  /** stderr streams can be tinted differently in the UI. */
  stream?: "stdout" | "stderr";
};

export type UseTerminalResult = {
  status: TerminalStatus;
  terminalId: string | null;
  lines: TerminalLine[];
  /** Fatal: the terminal could not be opened and there is nothing to show. */
  error: string | null;
  /**
   * Non-fatal: an input, interrupt, or re-attach attempt failed while the
   * terminal stayed open. The UI must show this without replacing the output.
   */
  actionError: string | null;
  pending: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  open: () => Promise<void>;
  /** Re-attach an existing host-side terminal, e.g. after a reconnect. */
  reattach: () => Promise<void>;
  close: () => Promise<void>;
  sendInput: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  dismissActionError: () => void;
};

const MAX_LINES = 1000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Approximate character cell size for the terminal font. */
const CELL_WIDTH = 9;
const CELL_HEIGHT = 17;
const RESIZE_DEBOUNCE_MS = 100;

let terminalSequence = 0;

function nextTerminalId(): string {
  terminalSequence += 1;
  return `term-${Date.now().toString(36)}-${terminalSequence.toString(36)}`;
}

function base64Encode(text: string): string {
  if (typeof window !== "undefined" && "btoa" in window) {
    return btoa(unescape(encodeURIComponent(text)));
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(text, "utf8").toString("base64");
  }
  throw new Error("no base64 encoder available");
}

function base64Decode(data: string): string {
  if (typeof window !== "undefined" && "atob" in window) {
    return decodeURIComponent(escape(atob(data)));
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data, "base64").toString("utf8");
  }
  throw new Error("no base64 decoder available");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sanitize raw PTY output for the lightweight renderer.
 *
 * ANSI escape sequences and other dangerous C0 control characters (BEL,
 * backspace, vertical tab, form feed, and the rest of the non-printable range)
 * are removed. Tab, carriage return, and line feed are preserved so the output
 * keeps its structure without fabricating characters.
 */
function sanitizeTerminalOutput(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "");
}

function pushLines(
  previous: TerminalLine[],
  text: string,
  stream: "stdout" | "stderr",
): TerminalLine[] {
  const normalized = sanitizeTerminalOutput(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const segments = normalized.split("\n");
  const next = [...previous];
  segments.forEach((segment, index) => {
    if (index === 0 && next.length > 0) {
      const last = next[next.length - 1];
      if (last.stream === stream) {
        next[next.length - 1] = { ...last, text: last.text + segment };
        return;
      }
      next.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, text: segment, stream });
      return;
    }
    next.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}-${index}`, text: segment, stream });
  });
  if (next.length > MAX_LINES) {
    return next.slice(next.length - MAX_LINES);
  }
  return next;
}

export function useTerminal(sessionId: string | undefined): UseTerminalResult {
  const [status, setStatus] = useState<TerminalStatus>("idle");
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const terminalSessionIdRef = useRef<string | null | undefined>(sessionId);
  const sessionIdRef = useRef(sessionId);
  const cleanupRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  /** Latest re-attach closure, so the host-event subscription never re-binds. */
  const reattachRef = useRef<(() => Promise<void>) | null>(null);

  const cleanup = useCallback(() => {
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
  }, []);

  /** Current terminal size, or the defaults when the container is not laid out. */
  const measure = useCallback(() => {
    const container = containerRef.current;
    const cols = container?.clientWidth
      ? Math.max(20, Math.floor(container.clientWidth / CELL_WIDTH))
      : DEFAULT_COLS;
    const rows = container?.clientHeight
      ? Math.max(5, Math.floor(container.clientHeight / CELL_HEIGHT))
      : DEFAULT_ROWS;
    return { cols, rows };
  }, []);

  const closeTerminal = useCallback(async () => {
    const id = terminalIdRef.current;
    const sid = terminalSessionIdRef.current;
    if (!id || !sid) return;
    cleanup();
    terminalIdRef.current = null;
    terminalSessionIdRef.current = null;
    setTerminalId(null);
    setLines([]);
    setActionError(null);
    setPending(true);
    try {
      await api.terminalClose({ sessionId: sid, terminalId: id });
    } catch (err) {
      // The process may already be gone; surface is closed regardless.
      setError(errorMessage(err));
    } finally {
      setPending(false);
      setStatus("closed");
    }
  }, [cleanup]);

  const open = useCallback(
    async () => {
      if (!sessionId) {
        setError("no session");
        setStatus("error");
        return;
      }
      if (terminalIdRef.current) return;
      setPending(true);
      setError(null);
      setActionError(null);
      try {
        const { cols, rows } = measure();
        const result = await api.terminalOpen({
          sessionId,
          cols,
          rows,
          userConfirmed: true,
        });
        const id = typeof result.terminalId === "string" ? result.terminalId : nextTerminalId();
        // If the component unmounted or the session changed while the open was
        // in flight, close the orphan terminal instead of wiring it to a stale
        // renderer session.
        if (!mountedRef.current || sessionIdRef.current !== sessionId) {
          cleanup();
          await api.terminalClose({ sessionId, terminalId: id }).catch(() => {
            // The terminal may have already exited; ignore close failures.
          });
          return;
        }
        terminalIdRef.current = id;
        terminalSessionIdRef.current = sessionId;
        setTerminalId(id);
        setStatus("open");
        if (typeof result.replay === "string" && result.replay) {
          setLines((prev) => pushLines(prev, base64Decode(result.replay as string), "stdout"));
        }
      } catch (err) {
        cleanup();
        setStatus("error");
        setError(errorMessage(err));
      } finally {
        setPending(false);
      }
    },
    [sessionId, cleanup, measure],
  );

  /**
   * Re-attach the host-side terminal that survived a transport drop.
   *
   * The id is forwarded so Main skips the confirmation the first open already
   * answered, and the host replays its output ring — which is why the local
   * buffer is replaced rather than appended to. A failed re-attach keeps
   * `detached` instead of erroring: the PTY may still be alive on the host, and
   * the next reconnect event retries.
   */
  const reattach = useCallback(async () => {
    const id = terminalIdRef.current;
    const sid = terminalSessionIdRef.current;
    if (!id || !sid) return;
    setPending(true);
    try {
      const { cols, rows } = measure();
      const result = await api.terminalOpen({
        sessionId: sid,
        cols,
        rows,
        userConfirmed: true,
        terminalId: id,
      });
      if (!mountedRef.current || sessionIdRef.current !== sid) return;
      const nextId =
        typeof result.terminalId === "string" && result.terminalId ? result.terminalId : id;
      terminalIdRef.current = nextId;
      setTerminalId(nextId);
      setStatus("open");
      setActionError(null);
      setError(null);
      if (typeof result.replay === "string" && result.replay) {
        setLines(() => pushLines([], base64Decode(result.replay as string), "stdout"));
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setStatus("detached");
      setActionError(errorMessage(err));
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }, [measure]);

  reattachRef.current = reattach;

  const sendInput = useCallback(
    async (text: string) => {
      const id = terminalIdRef.current;
      const sid = terminalSessionIdRef.current;
      if (!id || !sid || status !== "open" || text === "") return;
      setPending(true);
      try {
        // PTYs expect a carriage return to execute a command, not a bare line.
        const payload = text.endsWith("\r") ? text : `${text}\r`;
        await api.terminalInput({
          sessionId: sid,
          terminalId: id,
          data: base64Encode(payload),
        });
        setActionError(null);
      } catch (err) {
        // Keep the terminal open and its output on screen: the command failed,
        // the session did not. The UI surfaces this beside the composer.
        setActionError(errorMessage(err));
      } finally {
        setPending(false);
      }
    },
    [status],
  );

  const interrupt = useCallback(async () => {
    const id = terminalIdRef.current;
    const sid = terminalSessionIdRef.current;
    if (!id || !sid || status !== "open") return;
    setPending(true);
    try {
      await api.terminalInterrupt({ sessionId: sid, terminalId: id });
      setActionError(null);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }, [status]);

  const dismissActionError = useCallback(() => {
    setActionError(null);
  }, []);

  const close = useCallback(async () => {
    await closeTerminal();
  }, [closeTerminal]);

  // Track mount state so stale async results never mutate an unmounted session.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Subscribe to output and lifecycle events while a terminal is open.
  useEffect(() => {
    if (!sessionId || !terminalId || terminalSessionIdRef.current !== sessionId) return;
    const id = terminalId;

    const removeOutput = api.onTerminalOutput((event) => {
      if (event.sessionId !== sessionId || event.terminalId !== id) return;
      const stream = event.stream === "stderr" ? "stderr" : "stdout";
      const text = typeof event.data === "string" ? base64Decode(event.data) : "";
      setLines((prev) => pushLines(prev, text, stream));
    });

    const removeChanged = api.onTerminalChanged((event) => {
      if (event.sessionId !== sessionId || event.terminalId !== id) return;
      if (event.state === "exited" || event.state === "closed") {
        cleanup();
        setStatus("closed");
        setTerminalId(null);
        terminalIdRef.current = null;
        terminalSessionIdRef.current = null;
        setActionError(null);
      }
    });

    cleanupRef.current = () => {
      removeOutput();
      removeChanged();
    };

    return () => {
      removeOutput();
      removeChanged();
    };
  }, [sessionId, terminalId, cleanup]);

  /**
   * Follow the host connection for a remote terminal.
   *
   * Main stamps every `remote.*` session change with the host key, so a drop on
   * one host never marks a terminal on another. A reconnect re-attaches without
   * user action; the host-side PTY and its ring are what make that lossless.
   */
  useEffect(() => {
    if (!sessionId || !terminalId) return;
    const hostKey = parseRemoteSessionId(sessionId)?.hostKey;
    if (!hostKey) return;
    return api.onSessionsChanged((event) => {
      if (event.hostKey !== hostKey) return;
      if (terminalSessionIdRef.current !== sessionId) return;
      if (event.reason === "remote.disconnected" || event.reason === "remote.recovery.failed") {
        setStatus((previous) => (previous === "open" ? "detached" : previous));
        return;
      }
      if (event.reason === "remote.reconnected" || event.reason === "remote.resync") {
        void reattachRef.current?.();
      }
    });
  }, [sessionId, terminalId]);

  // Resize observer: relay terminal dimensions to the backend.
  useEffect(() => {
    if (!sessionId || !terminalId || typeof ResizeObserver === "undefined") return;
    const id = terminalId;
    const container = containerRef.current;
    if (!container) return;

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const rect = entry.contentRect;
      // Skip resize when the container is hidden (zero size) so switching tabs
      // does not shrink the PTY to the minimum while it stays alive.
      if (rect.width === 0 || rect.height === 0) return;
      const cols = Math.max(20, Math.floor(rect.width / CELL_WIDTH));
      const rows = Math.max(5, Math.floor(rect.height / CELL_HEIGHT));
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        void api.terminalResize({ sessionId, terminalId: id, cols, rows }).catch(() => {
          // Ignore resize failures for terminals that closed mid-debounce. A
          // dropped transport must not turn a resize into a visible error.
        });
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      observer.disconnect();
    };
  }, [sessionId, terminalId]);

  // Close the terminal when the session changes or the component unmounts.
  useEffect(() => {
    sessionIdRef.current = sessionId;
    terminalSessionIdRef.current = sessionId;
    return () => {
      void closeTerminal();
    };
  }, [sessionId, closeTerminal]);

  // On pagehide/reload, do our best to close the PTY and detach listeners
  // synchronously; the async close may not complete before the renderer exits.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPageHide = () => {
      cleanup();
      const id = terminalIdRef.current;
      const sid = terminalSessionIdRef.current;
      terminalIdRef.current = null;
      terminalSessionIdRef.current = null;
      setTerminalId(null);
      setStatus("closed");
      setLines([]);
      setActionError(null);
      if (id && sid) {
        void api.terminalClose({ sessionId: sid, terminalId: id });
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [cleanup]);

  return {
    status,
    terminalId,
    lines,
    error,
    actionError,
    pending,
    containerRef,
    open,
    reattach,
    close,
    sendInput,
    interrupt,
    dismissActionError,
  };
}
