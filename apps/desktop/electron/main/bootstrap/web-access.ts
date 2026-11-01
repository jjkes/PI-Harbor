import { join } from "node:path";
import { IPC } from "@pi-harbor/shared";
import type { Logger } from "../logger";
import { getModuleDirectory } from "../module-path";
import { createWebAccessController, type WebAccessController } from "../web-access/controller";

/**
 * Electron Main wiring for browser web access (ADR 0342). The listener serves
 * the renderer the desktop window loads: the built bundle in `out/renderer`,
 * or the Vite dev server when `ELECTRON_RENDERER_URL` is set.
 */
export function createDesktopWebAccess(options: {
  dataDir: string;
  logger: Logger;
  sendToRenderer: (channel: string, payload: unknown) => void;
}): WebAccessController {
  const { logger } = options;
  const devOrigin = process.env.ELECTRON_RENDERER_URL;
  return createWebAccessController({
    dataDir: options.dataDir,
    renderer: devOrigin
      ? { kind: "dev-server", origin: devOrigin }
      : { kind: "bundle", root: join(getModuleDirectory(import.meta.url), "../renderer") },
    logger: {
      info: (event, data) => logger.app("lifecycle", "info", event, { event, data }),
      warn: (event, data) => logger.app("lifecycle", "warn", event, { event, data }),
    },
    onStatusChanged: (status) => options.sendToRenderer(IPC.event.webAccessChanged, status),
  });
}

/** Starts the listener after the renderer dispatcher is registered. */
export function startDesktopWebAccess(controller: WebAccessController, logger: Logger): void {
  controller.start().catch((error: unknown) => {
    logger.app("lifecycle", "error", "web access failed to start", {
      event: "webAccess.startFailed",
      data: { message: describe(error) },
    });
  });
}

/** Stops the listener at quit; web access must never outlive the app. */
export function stopDesktopWebAccess(controller: WebAccessController | null, logger: Logger): void {
  controller?.dispose().catch((error: unknown) => {
    logger.app("lifecycle", "warn", "web access did not stop cleanly", {
      event: "webAccess.disposeFailed",
      data: { message: describe(error) },
    });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
