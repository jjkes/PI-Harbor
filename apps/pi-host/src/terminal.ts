import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { realpath, stat } from "node:fs/promises";

import { RacpError } from "@pi-harbor/agent-host";
import type { RacpTerminalAccess, TerminalOpenResult } from "@pi-harbor/racp";
import { RACP_DEFAULT_LIMITS, RACP_MAX_TERMINAL_INPUT_BYTES } from "@pi-harbor/shared";

/** The subset of `node-pty` this module uses; the package is loaded lazily. */
type Pty = {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
};

type PtyModule = {
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }): Pty;
};

type TerminalSink = { output: (data: string) => void; exit: (code: number | null) => void };

const DEFAULT_MAX_LIVE_QUEUE = 256;
const SINK_FAILURE_DETACH_THRESHOLD = 3;
/** Keys that may be passed to a shell child. Everything else (tokens,
 * cloud credentials, parent secrets) is stripped. */
const SHELL_ENV_ALLOWLIST = new Set(
  process.platform === "win32"
    ? [
        "PATH",
        "PATHEXT",
        "ComSpec",
        "SystemRoot",
        "SystemDrive",
        "WINDIR",
        "USERPROFILE",
        "USERNAME",
        "TEMP",
        "TMP",
        "HOMEDRIVE",
        "HOMEPATH",
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "TERM",
      ]
    : [
        "PATH",
        "HOME",
        "USER",
        "SHELL",
        "TERM",
        "LANG",
        "LC_ALL",
        "LOGNAME",
        "TMPDIR",
        "XDG_SESSION_TYPE",
        "XDG_CURRENT_DESKTOP",
        "XDG_CONFIG_DIRS",
        "XDG_DATA_DIRS",
        "XDG_RUNTIME_DIR",
        "XDG_SESSION_DESKTOP",
        "SSH_AUTH_SOCK",
      ],
);

function buildShellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { TERM: "xterm-256color" };
  for (const key of Object.keys(process.env)) {
    if (SHELL_ENV_ALLOWLIST.has(key)) {
      env[key] = process.env[key];
    }
  }
  return env;
}

async function validatedSessionRoot(path: string): Promise<string> {
  if (!path || typeof path !== "string") throw new RacpError("REMOTE_PATH_NOT_FOUND", "session root is missing");
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new RacpError("REMOTE_PATH_NOT_FOUND", `no such directory: ${path}`);
  }
  const info = await stat(real).catch(() => null);
  if (!info?.isDirectory()) throw new RacpError("REMOTE_PATH_NOT_FOUND", `not a directory: ${path}`);
  return real;
}

type TerminalRecord = {
  id: string;
  sessionId: string;
  pty: Pty;
  cols: number;
  rows: number;
  ring: Buffer[];
  ringBytes: number;
  liveQueue: string[];
  maxLiveQueue: number;
  sink: TerminalSink | null;
  sinkFailures: number;
  droppedCount: number;
  exited: number | null;
};

/**
 * Load `node-pty` when it is installed beside the bundle. The Host advertises
 * `terminal: false` when it is not, instead of failing at open time.
 */
export function loadPty(): PtyModule | null {
  try {
    const require = createRequire(import.meta.url);
    return require("node-pty") as PtyModule;
  } catch {
    return null;
  }
}

export type TerminalServiceOptions = {
  pty: PtyModule;
  /** The session's working directory: the Host resolves it, never the client. */
  sessionRoot: (sessionId: string) => Promise<string>;
  shell?: string;
  replayRingBytes?: number;
  maxPerSession?: number;
  maxInputBytes?: number;
  maxLiveQueue?: number;
  log: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
};

/**
 * Session terminals on the Host machine (spec §6.2, security §7): a pty with
 * the session root as cwd, a bounded replay ring per terminal, and at most
 * two open terminals per session. Output is delivered to whichever
 * connection is attached; a dropped connection keeps the pty alive and the
 * next attach receives the ring.
 */
export class TerminalService implements RacpTerminalAccess {
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly ringBytes: number;
  private readonly maxPerSession: number;
  private readonly maxInputBytes: number;
  private readonly maxLiveQueue: number;

  constructor(private readonly options: TerminalServiceOptions) {
    this.ringBytes = options.replayRingBytes ?? RACP_DEFAULT_LIMITS.terminalReplayRingBytes;
    this.maxPerSession = options.maxPerSession ?? RACP_DEFAULT_LIMITS.maxOpenTerminalsPerSession;
    this.maxInputBytes = options.maxInputBytes ?? RACP_MAX_TERMINAL_INPUT_BYTES;
    this.maxLiveQueue = options.maxLiveQueue ?? DEFAULT_MAX_LIVE_QUEUE;
  }

  private snapshot(record: TerminalRecord): TerminalOpenResult {
    return { terminalId: record.id, replay: Buffer.concat(record.ring).toString("base64"), cols: record.cols, rows: record.rows };
  }

  async open(
    sessionId: string,
    size: { cols: number; rows: number },
    sinkFactory: (terminalId: string) => TerminalSink,
  ): Promise<TerminalOpenResult> {
    const open = [...this.terminals.values()].filter((record) => record.sessionId === sessionId && record.exited === null);
    if (open.length >= this.maxPerSession) {
      throw new RacpError("RATE_LIMITED", "terminal limit reached for this session", { details: { limit: this.maxPerSession } });
    }
    const cwd = await validatedSessionRoot(await this.options.sessionRoot(sessionId));
    const shell = this.options.shell ?? (process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : process.env.SHELL ?? "/bin/sh");
    const pty = this.options.pty.spawn(shell, [], { name: "xterm-256color", cols: size.cols, rows: size.rows, cwd, env: buildShellEnv() });
    const record: TerminalRecord = {
      id: `term_${randomUUID()}`,
      sessionId,
      pty,
      cols: size.cols,
      rows: size.rows,
      ring: [],
      ringBytes: 0,
      liveQueue: [],
      maxLiveQueue: this.maxLiveQueue,
      sink: null,
      sinkFailures: 0,
      droppedCount: 0,
      exited: null,
    };
    this.terminals.set(record.id, record);
    // Give the sink closure the real terminal id before any output/exit can fire.
    record.sink = sinkFactory(record.id);
    pty.onData((data) => {
      const chunk = Buffer.from(data, "utf8");
      record.ring.push(chunk);
      record.ringBytes += chunk.length;
      while (record.ringBytes > this.ringBytes && record.ring.length > 0) {
        const dropped = record.ring.shift()!;
        record.ringBytes -= dropped.length;
      }
      this.pushOutput(record, chunk.toString("base64"));
    });
    pty.onExit(({ exitCode }) => {
      this.handleExit(record, exitCode);
    });
    this.options.log("info", "terminal opened", { terminalId: record.id, sessionId, pid: pty.pid });
    return this.snapshot(record);
  }

  async input(terminalId: string, data: string): Promise<void> {
    const decoded = Buffer.from(data, "base64");
    if (decoded.length > this.maxInputBytes) {
      throw new RacpError("PAYLOAD_TOO_LARGE", `terminal input exceeds ${this.maxInputBytes} bytes`);
    }
    this.require(terminalId).pty.write(decoded.toString("utf8"));
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    const record = this.require(terminalId);
    record.cols = cols;
    record.rows = rows;
    record.pty.resize(cols, rows);
  }

  async interrupt(terminalId: string): Promise<void> {
    const record = this.require(terminalId);
    if (process.platform === "win32") {
      try {
        record.pty.write("\x03");
      } catch (error) {
        this.options.log("warn", "terminal interrupt write failed", { terminalId: record.id, error: String(error) });
      }
      return;
    }
    try {
      record.pty.kill("SIGINT");
    } catch {
      // Already gone.
    }
  }

  async close(terminalId: string): Promise<void> {
    const record = this.terminals.get(terminalId);
    if (!record || record.exited !== null) return;
    record.exited = 0;
    const sink = record.sink;
    record.sink = null;
    try {
      sink?.exit(0);
    } catch {
      // Already gone.
    }
    this.terminals.delete(terminalId);
    try {
      record.pty.kill();
    } catch {
      // Already gone.
    }
    this.options.log("info", "terminal closed", { terminalId, sessionId: record.sessionId });
  }

  async attach(terminalId: string, sink: TerminalSink): Promise<TerminalOpenResult | null> {
    const record = this.terminals.get(terminalId);
    if (!record || record.exited !== null) return null;
    record.sink = sink;
    record.sinkFailures = 0;
    this.drainLiveQueue(record);
    return this.snapshot(record);
  }

  detach(terminalId: string): void {
    const record = this.terminals.get(terminalId);
    if (record) record.sink = null;
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.terminals.keys()]) await this.close(id);
  }

  async closeAllForSession(sessionId: string): Promise<void> {
    for (const [id, record] of [...this.terminals.entries()]) {
      if (record.sessionId === sessionId && record.exited === null) {
        await this.close(id);
      }
    }
  }

  private require(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId);
    if (!record || record.exited !== null) throw new RacpError("NOT_FOUND", `terminal ${terminalId} is not open`);
    return record;
  }

  private handleExit(record: TerminalRecord, exitCode: number): void {
    if (record.exited !== null) return;
    record.exited = exitCode;
    try {
      record.sink?.exit(exitCode);
    } catch {
      // Best effort: the other side may already be gone.
    }
    this.terminals.delete(record.id);
    this.options.log("info", "terminal exited", { terminalId: record.id, sessionId: record.sessionId, exitCode });
  }

  private pushOutput(record: TerminalRecord, data: string): void {
    record.liveQueue.push(data);
    if (record.liveQueue.length > record.maxLiveQueue) {
      record.liveQueue.shift();
      record.droppedCount += 1;
    }
    this.drainLiveQueue(record);
  }

  private drainLiveQueue(record: TerminalRecord): void {
    while (record.sink && record.liveQueue.length > 0) {
      const next = record.liveQueue[0]!;
      try {
        record.sink.output(next);
        record.liveQueue.shift();
        record.sinkFailures = 0;
      } catch {
        record.sinkFailures += 1;
        if (record.sinkFailures >= SINK_FAILURE_DETACH_THRESHOLD) {
          record.sink = null;
          record.sinkFailures = 0;
          this.options.log("warn", "terminal sink detached after repeated failures", { terminalId: record.id });
        }
        break;
      }
    }
    if (record.droppedCount > 0 && record.liveQueue.length === 0) {
      this.options.log("warn", "terminal live queue dropped data", {
        terminalId: record.id,
        sessionId: record.sessionId,
        droppedCount: record.droppedCount,
      });
      record.droppedCount = 0;
    }
  }
}
