import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionExecOptions, ExtensionExecResult } from "./runner.js";

/** Own the process group created through pi.exec; direct Node spawns are unowned. */
export function managedExec(command: string, args: string[], cwd: string,
  owner: AbortSignal, options?: ExtensionExecOptions): Promise<ExtensionExecResult> {
  const signal = options?.signal ? AbortSignal.any([owner, options.signal]) : owner;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd ?? cwd,
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const maxBuffer = options?.maxBuffer ?? 10 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    // UTF-8 sequences may straddle chunks; decode incrementally per stream so a
    // multibyte character split across writes never becomes a replacement char.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let killed = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown, code?: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", kill);
      if (error) reject(error);
      else resolve({ stdout, stderr, code: code ?? (killed ? 143 : 0), killed, truncated: stdoutTruncated || stderrTruncated });
    };
    const kill = () => {
      if (killed || settled) return;
      killed = true;
      killTimer = setTimeout(() => finish(new Error("Extension process cleanup timed out")), 5_000);
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore", windowsHide: true,
        });
        killer.once("error", (error) => { child.kill(); finish(error); });
        killer.once("exit", (code) => {
          if (code !== 0 && child.exitCode === null) {
            child.kill();
            finish(new Error(`Extension process-tree cleanup failed (${code})`));
          }
        });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) finish(error);
        }
      }
    };
    signal.addEventListener("abort", kill, { once: true });
    if (signal.aborted) kill();
    if (options?.timeout) timeout = setTimeout(kill, options.timeout);
    const append = (decoded: string, current: string, truncated: boolean): { text: string; truncated: boolean } => {
      // Once a stream hits its cap, drop everything after it so the kept text
      // stays a contiguous prefix of the real output.
      if (truncated || !decoded) return { text: current, truncated };
      const remaining = Math.max(0, maxBuffer - current.length);
      if (decoded.length <= remaining) return { text: current + decoded, truncated: false };
      // Never split a surrogate pair: back off one unit rather than keep a lone
      // high surrogate at the boundary.
      let cut = remaining;
      if (cut > 0 && /[\uD800-\uDBFF]/.test(decoded.charAt(cut - 1))) cut -= 1;
      return { text: current + decoded.slice(0, cut), truncated: true };
    };
    const onStdout = (decoded: string) => {
      const next = append(decoded, stdout, stdoutTruncated);
      stdout = next.text;
      stdoutTruncated = next.truncated;
    };
    const onStderr = (decoded: string) => {
      const next = append(decoded, stderr, stderrTruncated);
      stderr = next.text;
      stderrTruncated = next.truncated;
    };
    child.stdout.on("data", (chunk: Buffer) => onStdout(stdoutDecoder.write(chunk)));
    child.stderr.on("data", (chunk: Buffer) => onStderr(stderrDecoder.write(chunk)));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      // Flush a trailing incomplete sequence as U+FFFD, as chunk.toString did.
      onStdout(stdoutDecoder.end());
      onStderr(stderrDecoder.end());
      finish(undefined, code);
    });
  });
}
