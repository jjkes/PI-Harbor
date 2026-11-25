import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, afterEach } from "vitest";

import { TerminalService, type TerminalServiceOptions } from "./terminal.js";
import { RACP_MAX_TERMINAL_INPUT_BYTES } from "@pi-harbor/shared";


type FakePty = {
  pid: number;
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  kills: Array<string | undefined>;
  dataListener: ((data: string) => void) | null;
  exitListener: ((event: { exitCode: number; signal?: number }) => void) | null;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
};

function makeFakePtyModule() {
  const spawned: Array<{ file: string; args: string[]; options: Record<string, unknown>; pty: FakePty }> = [];
  let pidCounter = 1000;
  return {
    spawned,
    spawn(file: string, args: string[], options: Record<string, unknown>) {
      const pty: FakePty = {
        pid: ++pidCounter,
        writes: [],
        resizes: [],
        kills: [],
        dataListener: null,
        exitListener: null,
        write(data: string) { this.writes.push(data); },
        resize(cols: number, rows: number) { this.resizes.push({ cols, rows }); },
        kill(signal?: string) { this.kills.push(signal); },
        onData(listener: (data: string) => void) { this.dataListener = listener; return { dispose: () => undefined }; },
        onExit(listener: (event: { exitCode: number; signal?: number }) => void) { this.exitListener = listener; return { dispose: () => undefined }; },
      };
      spawned.push({ file, args, options, pty });
      return pty;
    },
  };
}

function service(overrides: Partial<TerminalServiceOptions> = {}, sessionRoot = async (_sessionId: string) => "/tmp") {
  const fake = makeFakePtyModule();
  const logs: Array<{ level: "info" | "warn"; message: string; data?: Record<string, unknown> }> = [];
  const options: TerminalServiceOptions = {
    pty: fake,
    sessionRoot,
    log: (level, message, data) => logs.push({ level, message, data }),
    ...overrides,
  };
  return { service: new TerminalService(options), fake, logs };
}
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("TerminalService", () => {
  it("opens a pty in the session root and reports its size", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-host-terminal-"));
    tempDirs.push(root);
    const { service: ts, fake } = service({}, async () => root);
    const sink = { output: () => undefined, exit: () => undefined };
    const opened = await ts.open("s1", { cols: 100, rows: 30 }, () => sink);
    expect(opened.terminalId).toMatch(/^term_/);
    expect(opened.cols).toBe(100);
    expect(opened.rows).toBe(30);
    expect(opened.replay).toBe("");
    expect(fake.spawned).toHaveLength(1);
    expect(fake.spawned[0]!.options).toMatchObject({
      cols: 100,
      rows: 30,
      cwd: realpathSync(root),
      env: { TERM: "xterm-256color" },
    });
  });

  it("decodes base64 input and writes it to the pty", async () => {
    const { service: ts, fake } = service();
    const sink = { output: () => undefined, exit: () => undefined };
    const opened = await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
    await ts.input(opened.terminalId, Buffer.from("hello", "utf8").toString("base64"));
    expect(fake.spawned[0]!.pty.writes).toEqual(["hello"]);
  });

  it("tracks size changes and forwards them to the pty", async () => {
    const { service: ts, fake } = service();
    const sink = { output: () => undefined, exit: () => undefined };
    const opened = await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
    await ts.resize(opened.terminalId, 120, 40);
    const snapshot = await ts.attach(opened.terminalId, sink);
    expect(snapshot?.cols).toBe(120);
    expect(snapshot?.rows).toBe(40);
    expect(fake.spawned[0]!.pty.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("sends SIGINT on POSIX and Ctrl+C on Windows", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      const { service: ts, fake } = service();
      const sink = { output: () => undefined, exit: () => undefined };
      const opened = await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
      await ts.interrupt(opened.terminalId);
      expect(fake.spawned[0]!.pty.kills).toEqual(["SIGINT"]);

      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const { service: ts2, fake: fake2 } = service();
      const opened2 = await ts2.open("s2", { cols: 80, rows: 24 }, () => sink);
      await ts2.interrupt(opened2.terminalId);
      expect(fake2.spawned[0]!.pty.kills).toEqual([]);
      expect(fake2.spawned[0]!.pty.writes).toEqual(["\x03"]);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("closes a terminal, kills the pty, and tolerates a late exit event", async () => {
    const { service: ts, fake } = service();
    const sink = { output: () => undefined, exit: () => undefined };
    const opened = await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
    await ts.close(opened.terminalId);
    expect(fake.spawned[0]!.pty.kills).toEqual([undefined]);
    expect(await ts.attach(opened.terminalId, sink)).toBeNull();
    // A late exit event after the record is gone should not throw.
    fake.spawned[0]!.pty.exitListener?.({ exitCode: 0 });
  });

  it("supports attach after detach so a reconnect receives the replay ring", async () => {
    const { service: ts, fake } = service();
    const outputs1: string[] = [];
    const sink1 = { output: (data: string) => outputs1.push(data), exit: () => undefined };
    const opened = await ts.open("s1", { cols: 80, rows: 24 }, () => sink1);
    fake.spawned[0]!.pty.dataListener?.("first");
    ts.detach(opened.terminalId);
    const outputs2: string[] = [];
    const sink2 = { output: (data: string) => outputs2.push(data), exit: () => undefined };
    const snapshot = await ts.attach(opened.terminalId, sink2);
    expect(snapshot?.replay).toBe(Buffer.from("first", "utf8").toString("base64"));
    fake.spawned[0]!.pty.dataListener?.("second");
    expect(outputs2).toHaveLength(1);
  });

  it("caps the replay ring and reports only the newest bytes", async () => {
    const { service: ts, fake } = service({ replayRingBytes: 10 });
    const sink = { output: () => undefined, exit: () => undefined };
    const opened = await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
    fake.spawned[0]!.pty.dataListener?.("0123456789"); // 10 bytes, fills the ring
    fake.spawned[0]!.pty.dataListener?.("abcde"); // 5 bytes, the old whole chunk is dropped
    const snapshot = await ts.attach(opened.terminalId, sink);
    expect(Buffer.from(snapshot!.replay, "base64").toString("utf8")).toBe("abcde");
  });

  it("detaches a sink after repeated failures so the pty keeps running", async () => {
    const { service: ts, fake, logs } = service();
    let calls = 0;
    const sink = {
      output: () => { calls += 1; throw new Error("slow consumer"); },
      exit: () => undefined,
    };
    const opened = await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
    for (let index = 0; index < 5; index += 1) {
      fake.spawned[0]!.pty.dataListener?.(`${index}`);
    }
    expect(calls).toBe(3);
    expect(logs.some((log) => log.message === "terminal sink detached after repeated failures")).toBe(true);
    // After detach, new output does not call the broken sink.
    fake.spawned[0]!.pty.dataListener?.("x");
    expect(calls).toBe(3);
  });

  it("closes all terminals on shutdown", async () => {
    const { service: ts } = service();
    const sink = { output: () => undefined, exit: () => undefined };
    const a = await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
    const b = await ts.open("s2", { cols: 80, rows: 24 }, () => sink);
    await ts.closeAll();
    expect(await ts.attach(a.terminalId, sink)).toBeNull();
    expect(await ts.attach(b.terminalId, sink)).toBeNull();
  });

  it("limits open terminals per session", async () => {
    const { service: ts } = service({ maxPerSession: 1 });
    const sink = { output: () => undefined, exit: () => undefined };
    await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
    await expect(ts.open("s1", { cols: 80, rows: 24 }, () => sink)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("refuses operations on an unknown or exited terminal", async () => {
    const { service: ts, fake } = service();
    await expect(ts.input("term_nope", "")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ts.interrupt("term_nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const sink = { output: () => undefined, exit: () => undefined };
    const opened = await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
    fake.spawned[0]!.pty.exitListener?.({ exitCode: 1 });
    await expect(ts.input(opened.terminalId, "")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("never logs the input data itself", async () => {
    const { service: ts, fake, logs } = service();
    const sink = { output: () => undefined, exit: () => undefined };
    const opened = await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
    await ts.input(opened.terminalId, Buffer.from("secret-password", "utf8").toString("base64"));
    const logged = logs.map((log) => JSON.stringify(log)).join("\n");
    expect(logged).not.toContain("secret-password");
    expect(fake.spawned[0]!.pty.writes).toEqual(["secret-password"]);
  });

  it("uses cmd.exe on Windows when no shell is configured", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const { service: ts, fake } = service();
      const sink = { output: () => undefined, exit: () => undefined };
      await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
      expect(fake.spawned[0]!.file).toBe("cmd.exe");
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("emits exit through the sink when closed", async () => {
    const { service: ts } = service();
    const exits: Array<number | null> = [];
    const sink = { output: () => undefined, exit: (code: number | null) => exits.push(code) };
    const opened = await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
    await ts.close(opened.terminalId);
    expect(exits).toEqual([0]);
  });

  it("catches interrupt fallback write errors on Windows", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const { service: ts, fake, logs } = service();
      const sink = { output: () => undefined, exit: () => undefined };
      const opened = await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
      fake.spawned[0]!.pty.write = () => { throw new Error("write failed"); };
      await ts.interrupt(opened.terminalId);
      expect(logs.some((log) => log.message === "terminal interrupt write failed")).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("bounds the live queue and drains to a new sink", async () => {
    const { service: ts, fake } = service({ maxLiveQueue: 2 });
    const sink = { output: () => undefined, exit: () => undefined };
    const opened = await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
    ts.detach(opened.terminalId);
    for (let index = 0; index < 5; index += 1) {
      fake.spawned[0]!.pty.dataListener?.(`${index}`);
    }
    const received: string[] = [];
    await ts.attach(opened.terminalId, { output: (data: string) => received.push(data), exit: () => undefined });
    expect(received).toHaveLength(2);
    expect(received[0]).toBe(Buffer.from("3", "utf8").toString("base64"));
    expect(received[1]).toBe(Buffer.from("4", "utf8").toString("base64"));
  });

  it("reports an aggregated dropped count when the live queue overflows", async () => {
    const { service: ts, fake, logs } = service({ maxLiveQueue: 2 });
    const sink = { output: () => undefined, exit: () => undefined };
    const opened = await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
    ts.detach(opened.terminalId);
    for (let index = 0; index < 5; index += 1) {
      fake.spawned[0]!.pty.dataListener?.(`${index}`);
    }
    const received: string[] = [];
    await ts.attach(opened.terminalId, { output: (data: string) => received.push(data), exit: () => undefined });
    expect(received).toHaveLength(2);
    const warning = logs.find((log) => log.message === "terminal live queue dropped data");
    expect(warning).toBeDefined();
    expect(warning!.data).toMatchObject({ terminalId: opened.terminalId, sessionId: "s1", droppedCount: 3 });
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain(Buffer.from("0", "utf8").toString("base64"));
    expect(logged).not.toContain(Buffer.from("1", "utf8").toString("base64"));
    expect(logged).not.toContain(Buffer.from("2", "utf8").toString("base64"));
  });

  it("uses a safe environment whitelist and keeps secrets out of the shell", async () => {
    const secret = "super-secret-token";
    process.env.SUPER_SECRET_TOKEN = secret;
    try {
      const { service: ts, fake } = service();
      const sink = { output: () => undefined, exit: () => undefined };
      await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
      const env = fake.spawned[0]!.options.env as Record<string, string | undefined>;
      expect(env.SUPER_SECRET_TOKEN).toBeUndefined();
      expect(env.TERM).toBe("xterm-256color");
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.SUPER_SECRET_TOKEN;
    }
  });

  it("rejects decoded input larger than the configured limit", async () => {
    const { service: ts, fake } = service();
    const sink = { output: () => undefined, exit: () => undefined };
    const opened = await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
    const tooBig = Buffer.alloc(RACP_MAX_TERMINAL_INPUT_BYTES + 1, "a");
    await expect(ts.input(opened.terminalId, tooBig.toString("base64"))).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(fake.spawned[0]!.pty.writes).toHaveLength(0);
  });

  it("validates the session root with realpath and rejects missing or non-directory paths", async () => {
    const { service: ts } = service({}, async () => "/does/not/exist");
    const sink = { output: () => undefined, exit: () => undefined };
    await expect(ts.open("s1", { cols: 80, rows: 24 }, () => sink)).rejects.toMatchObject({ code: "REMOTE_PATH_NOT_FOUND" });
    const file = join(tmpdir(), `pi-host-terminal-file-${Date.now()}`);
    writeFileSync(file, "");
    tempDirs.push(file);
    const { service: ts2 } = service({}, async () => file);
    await expect(ts2.open("s1", { cols: 80, rows: 24 }, () => sink)).rejects.toMatchObject({ code: "REMOTE_PATH_NOT_FOUND" });
  });

  it("resolves a symlink session root to its real directory before spawning", async () => {
    const target = mkdtempSync(join(tmpdir(), "pi-host-terminal-target-"));
    tempDirs.push(target);
    const link = join(tmpdir(), `pi-host-terminal-link-${Date.now()}`);
    symlinkSync(target, link);
    tempDirs.push(link);
    const { service: ts, fake } = service({}, async () => link);
    const sink = { output: () => undefined, exit: () => undefined };
    await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
    expect(fake.spawned[0]!.options.cwd).toBe(realpathSync(target));
  });

  it("closes only the terminals owned by the given session", async () => {
    const { service: ts } = service();
    const sink = { output: () => undefined, exit: () => undefined };
    const a = await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
    const b = await ts.open("s1", { cols: 80, rows: 24 }, () => sink);
    const c = await ts.open("s2", { cols: 80, rows: 24 }, () => sink);
    await ts.closeAllForSession("s1");
    expect(await ts.attach(a.terminalId, sink)).toBeNull();
    expect(await ts.attach(b.terminalId, sink)).toBeNull();
    expect(await ts.attach(c.terminalId, sink)).not.toBeNull();
  });
});

