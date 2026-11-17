import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readMainModuleSync } from "./helpers/source-contracts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  clearLocalFileGrants,
  confirmLocalFile,
  grantedLocalFile,
  grantLocalFile,
  localChatRefMatch,
} = await import("../electron/main/local-file-grants.ts");

/*
 * Files a transcript link names but no allowed root contains.
 *
 * The reported defect: an agent wrote a draft to `/tmp/pi-draft-demo.txt` and
 * printed the path, and clicking it answered "not in a location this app can
 * access" — an access limit the user has no way to satisfy, for a file the app
 * can plainly read. The contract under test is the replacement: the reference
 * completes, and the user's own open unlocks that one canonical file while
 * everything else stays refused.
 */

function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `pi-local-grant-${name}-`));
}

function writeFile(dir, name, body = `${name}\n`) {
  const target = join(dir, name);
  writeFileSync(target, body);
  return target;
}

beforeEach(() => {
  clearLocalFileGrants();
});

test("a local reference completes and its open unlocks that one file", async () => {
  const outside = tempDir("open");
  const target = writeFile(outside, "pi-draft-demo.txt");
  const canonical = await realpath(target);

  const match = await localChatRefMatch(target, true);
  assert.deepEqual(match, {
    root: "local",
    relativePath: target,
    absolutePath: target,
    matchedBy: "exact-absolute",
  });
  assert.equal(await grantedLocalFile(target), canonical);
});

test("reporting a local reference paints the link without unlocking the file", async () => {
  const outside = tempDir("verify");
  const target = writeFile(outside, "report.md");

  // Rendering a transcript verifies a reference; it must not widen what the
  // renderer may read.
  const match = await localChatRefMatch(target, false);
  assert.equal(match?.root, "local");
  assert.equal(match?.absolutePath, target);
  assert.equal(await grantedLocalFile(target), null);
});

test("only the confirmed file is unlocked, not its folder or its neighbours", async () => {
  const outside = tempDir("neighbour");
  const opened = writeFile(outside, "a.txt");
  const neighbour = writeFile(outside, "b.txt");

  await grantLocalFile(opened);
  assert.notEqual(await grantedLocalFile(opened), null);
  assert.equal(await grantedLocalFile(neighbour), null);
  assert.equal(await grantedLocalFile(outside), null, "the containing folder is not a file");
});

test("a reference that names nothing, a folder, or a relative path is refused", async () => {
  const outside = tempDir("refuse");
  const folder = join(outside, "nested");
  mkdirSync(folder);

  assert.equal(await confirmLocalFile(join(outside, "missing.txt")), null);
  assert.equal(await confirmLocalFile(folder), null);
  assert.equal(await confirmLocalFile("pi-draft-demo.txt"), null);
  assert.equal(await confirmLocalFile("./pi-draft-demo.txt"), null);
  assert.equal(await grantLocalFile(""), null);
  assert.equal(await grantedLocalFile("pi-draft-demo.txt"), null);
});

test("a control character cannot smuggle a different path into a grant", async () => {
  const outside = tempDir("control");
  const target = writeFile(outside, "a.txt");

  assert.equal(await grantLocalFile(`${target}\u0000.png`), null);
  await grantLocalFile(target);
  assert.equal(await grantedLocalFile(`${target}\u0000.png`), null);
});

test("a grant stops applying when the spelling resolves to a different file", async () => {
  const outside = tempDir("swap");
  const target = writeFile(outside, "draft.txt", "the draft\n");
  const other = writeFile(outside, "secret.txt", "something else\n");

  await grantLocalFile(target);
  assert.notEqual(await grantedLocalFile(target), null);

  // The same spelling, now a link to a file the user never opened.
  rmSync(target);
  symlinkSync(other, target);
  assert.equal(await grantedLocalFile(target), null);
});

test("the grant list stays bounded and drops the oldest entry", async () => {
  const outside = tempDir("bounded");
  const first = writeFile(outside, "000.txt");
  const paths = [];
  for (let index = 1; index < 260; index += 1) {
    paths.push(writeFile(outside, `${String(index).padStart(3, "0")}.txt`));
  }

  for (const path of [first, ...paths]) await grantLocalFile(path);

  assert.equal(await grantedLocalFile(first), null, "the oldest grant was evicted");
  assert.notEqual(await grantedLocalFile(paths.at(-1)), null, "the newest grant survives");
});

test("the file channels consult the grant the transcript open recorded", () => {
  const workspaceIpc = readMainModuleSync("ipc/workspace-ipc.ts");

  // Completion confirms an out-of-root reference instead of reporting an access
  // limit, and only an actual open records the grant.
  assert.match(
    workspaceIpc,
    /return \{ match: await localChatRefMatch\(ref, input\.open === true\) \};/,
  );

  // The read path serves the confirmed canonical file before the workspace and
  // remote containment checks that would otherwise refuse it.
  const readHandler = workspaceIpc.slice(
    workspaceIpc.indexOf("IPC.invoke.fsRead,"),
    workspaceIpc.indexOf("IPC.invoke.fsReadImageDataUrl,"),
  );
  const grantedReadIndex = readHandler.indexOf("const opened = await grantedLocalFile(requested);");
  assert.ok(grantedReadIndex >= 0, "fs/read consults the grant");
  assert.ok(
    grantedReadIndex < readHandler.indexOf('readRemoteFiles(remote, "read"'),
    "the confirmed file is served before the containment checks",
  );

  // Both OS handoffs accept a granted file after their own containment check.
  assert.equal(
    (workspaceIpc.match(/\)\) \?\? \(await grantedLocalFile\(requested\)\)/g) ?? []).length,
    2,
  );
});
