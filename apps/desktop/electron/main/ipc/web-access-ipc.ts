import { IPC } from "@pi-harbor/shared";
import type { WebAccessController } from "../web-access/controller";
import type { IpcRegistrar } from "./types";

/**
 * Web access settings are desktop-only (ADR 0342). Each handler requires the
 * main window as sender, and the browser bridge never dispatches this
 * namespace, so a signed-in browser cannot change its own credentials or
 * listener.
 */
export function registerWebAccessIpc({
  registrar,
  controller,
}: {
  registrar: IpcRegistrar;
  controller: WebAccessController;
}): void {
  registrar.handleWithEvent(IPC.invoke.webAccessGetStatus, async (event) => {
    registrar.assertMainWindowSender(event);
    return controller.getStatus();
  });
  registrar.handleWithEvent(IPC.invoke.webAccessConfigure, async (event, input: unknown) => {
    registrar.assertMainWindowSender(event);
    return controller.configure(input);
  });
  registrar.handleWithEvent(IPC.invoke.webAccessRevokeSessions, async (event) => {
    registrar.assertMainWindowSender(event);
    return controller.revokeSessions();
  });
}
