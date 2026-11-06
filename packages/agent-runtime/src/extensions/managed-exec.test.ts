import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { managedExec } from "./managed-exec.js";

it("cancels an owned process tree after an explicit readiness signal", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-owned-exec-"));
  const ready = join(root, "ready.json");
  const owner = new AbortController();
  const childSource = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify([process.ppid,process.pid])); setInterval(()=>{},1000);`;
  const parentSource = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'inherit'}); setInterval(()=>{},1000);`;
  const pending = managedExec(process.execPath, ["-e", parentSource], root, owner.signal);
  try {
    await expect.poll(() => existsSync(ready)).toBe(true);
    const pids: number[] = JSON.parse(readFileSync(ready, "utf8"));
    owner.abort();
    expect((await pending).killed).toBe(true);
    for (const pid of pids) await expect.poll(() => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }).toBe(false);
  } finally {
    owner.abort();
    await pending;
    rmSync(root, { recursive: true, force: true });
  }
});

it("never starts an already-cancelled exec and keeps normal command output", async () => {
  const owner = new AbortController();
  expect(await managedExec(process.execPath, ["-e", "process.stdout.write('ok')"], tmpdir(), owner.signal))
    .toMatchObject({ stdout: "ok", code: 0, killed: false });
  owner.abort();
  expect(() => managedExec(process.execPath, ["-e", "process.exit(9)"], tmpdir(), owner.signal))
    .toThrow();
});

it("decodes a multibyte character split across stdout chunks", async () => {
  const owner = new AbortController();
  const result = await managedExec(process.execPath, [
    "-e",
    // 中 = e4 b8 ad; split between its second and third bytes.
    "process.stdout.write(Buffer.from([0xe4,0xb8]));setTimeout(()=>process.stdout.write(Buffer.from([0xad])),50);",
  ], tmpdir(), owner.signal);
  expect(result.stdout).toBe("中");
  expect(result.truncated).toBe(false);
});

it("flags truncation without splitting a surrogate pair", async () => {
  const owner = new AbortController();
  const result = await managedExec(process.execPath, [
    "-e",
    "process.stdout.write(\"a\".repeat(8)+\"😀😀\")",
  ], tmpdir(), owner.signal, { maxBuffer: 10 });
  // 8 ascii + the first emoji fills the 10-unit budget exactly; the second is
  // dropped, and the kept emoji must stay a valid pair, never a lone surrogate.
  expect(result.stdout).toBe("a".repeat(8) + "😀");
  expect(result.stdout).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  expect(result.truncated).toBe(true);
});

it("backs off a surrogate pair that would straddle the cap", async () => {
  const owner = new AbortController();
  const result = await managedExec(process.execPath, [
    "-e",
    "process.stdout.write(\"a\".repeat(8)+\"😀😀\")",
  ], tmpdir(), owner.signal, { maxBuffer: 9 });
  // The 9th unit would be the high half of the first emoji; drop the whole pair.
  expect(result.stdout).toBe("a".repeat(8));
  expect(result.truncated).toBe(true);
});

it("keeps a contiguous prefix after truncation", async () => {
  const owner = new AbortController();
  const result = await managedExec(process.execPath, [
    "-e",
    "process.stdout.write(\"a\".repeat(8)+\"😀\");setTimeout(()=>process.stdout.write(\"b\"),50);",
  ], tmpdir(), owner.signal, { maxBuffer: 9 });
  // The back-off leaves one free unit; a later chunk must not fill it.
  expect(result.stdout).toBe("a".repeat(8));
  expect(result.truncated).toBe(true);
});

it("flushes a trailing incomplete UTF-8 sequence as a replacement character", async () => {
  const owner = new AbortController();
  const result = await managedExec(process.execPath, [
    "-e",
    "process.stdout.write(Buffer.from([0x61,0xe4]))",
  ], tmpdir(), owner.signal);
  expect(result.stdout).toBe("a\uFFFD");
  expect(result.truncated).toBe(false);
});

it("does not flag truncation when output fits", async () => {
  const owner = new AbortController();
  const result = await managedExec(process.execPath, ["-e", "process.stdout.write(\"ok\")"], tmpdir(), owner.signal);
  expect(result.stdout).toBe("ok");
  expect(result.truncated).toBe(false);
});
