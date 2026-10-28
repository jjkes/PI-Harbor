/**
 * The pinned Pi kernel release (`@earendil-works/pi-*`) a build bundles.
 *
 * The Pi packages move as one release group (`scripts/check-pi-dependencies.mjs`
 * pins them to the same version) and are bundled into the Electron main bundle,
 * so their manifests are not shipped with the installed app. The version is
 * therefore read from the installed package at build time instead of restated as
 * a constant that can silently drift from `package.json`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Pi package whose manifest carries the kernel release the build ships. */
export const PI_KERNEL_PACKAGE = "@earendil-works/pi-ai";

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Read the installed Pi kernel version below `root` (a package directory that
 * resolves `@earendil-works/pi-*`).
 */
export function readPiKernelVersion(root) {
  const manifestPath = join(root, "node_modules", ...PI_KERNEL_PACKAGE.split("/"), "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Cannot read the Pi kernel version: ${PI_KERNEL_PACKAGE} is not installed under ${root}. Install dependencies before building.`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
    throw new Error(
      `${manifestPath} has no usable version; found ${JSON.stringify(manifest.version)}`,
    );
  }
  return manifest.version;
}
