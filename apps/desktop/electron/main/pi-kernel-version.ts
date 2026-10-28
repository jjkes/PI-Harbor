declare const __PI_KERNEL_VERSION__: string;

/**
 * Pi kernel release (`@earendil-works/pi-*`) this build bundles.
 *
 * `electron.vite.config.ts` replaces the identifier above with the release
 * installed at build time, so the reported value follows the pinned dependency
 * instead of being restated here. The `typeof` guard keeps a build that lost the
 * define from taking the main process down over a version label.
 */
export const PI_KERNEL_VERSION: string =
  typeof __PI_KERNEL_VERSION__ === "string" && __PI_KERNEL_VERSION__
    ? __PI_KERNEL_VERSION__
    : "unknown";
