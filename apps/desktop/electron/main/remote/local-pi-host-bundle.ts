/**
 * A pi-host bundle the user already has on disk.
 *
 * The bootstrap normally downloads the tarball the release publishes, but a
 * build that was never published (a local build, or a target the release has no
 * lane for) leaves that URL dead. Dropping the tarball into this directory is
 * enough to install over SSH: the digest is computed from the bytes we are about
 * to send, so the remote install still verifies end to end.
 *
 * Directory: `<dataDir>/pi-host-bundles/`
 * File name: the release name, `pi-host-<version>-<platform>-<arch>.tar.gz`.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { piHostArtifactName, type PiHostTarget } from "./pi-host-release.js";

export type LocalPiHostBundle = { path: string; sha256: string };

/** Where a user drops release tarballs the desktop should install from disk. */
export function localBundleDirectory(dataDir: string): string {
  return join(dataDir, "pi-host-bundles");
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * The bundle for exactly this target, or `undefined` when the user has not put
 * one there. Only a regular file counts: a stale symlink or a directory named
 * like the tarball must not be sent to a remote machine.
 */
export async function readLocalPiHostBundle(
  dataDir: string,
  version: string,
  target: PiHostTarget,
): Promise<LocalPiHostBundle | undefined> {
  const path = join(localBundleDirectory(dataDir), piHostArtifactName(version, target));
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return undefined;
    return { path, sha256: await digest(path) };
  } catch {
    return undefined;
  }
}
