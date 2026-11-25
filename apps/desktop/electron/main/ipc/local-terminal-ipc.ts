/**
 * Local interactive terminal channels (P5).
 *
 * A thin pass-through to host-core's `terminal.*` methods. Host-core owns the
 * PTY lifecycle, output ring, and audit log. Electron Main only registers the
 * local handlers; remote sessions continue through `backend-router` and the
 * RACP remote backend, which intercepts these same channels before this handler
 * runs.
 */
import {
  ErrorCodes,
  IPC,
  NATIVE_PI_SESSION_PREFIX,
  REMOTE_SESSION_PREFIX,
} from "@pi-harbor/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export type LocalTerminalIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  /** Main-process confirmation for opening a local interactive terminal. */
  confirmTerminalOpen: () => Promise<boolean>;
  /**
   * Injectable platform gate. Local terminals are Linux-only; tests may override
   * this to exercise the handlers on other platforms.
   */
  checkPlatform?: () => boolean;
};

function requiredText(input: unknown, field: string): string {
  const value =
    input && typeof input === "object" ? (input as Record<string, unknown>)[field] : undefined;
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw Object.assign(new Error(`${field} required`), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
  return text;
}

function requiredUnsigned(input: unknown, field: string): number {
  const value =
    input && typeof input === "object" ? (input as Record<string, unknown>)[field] : undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw Object.assign(new Error(`${field} must be a positive integer`), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
  return value;
}

function optionalTerminalSize(
  input: unknown,
  field: "cols" | "rows",
  defaultValue: number,
): number {
  if (!input || typeof input !== "object") return defaultValue;
  const record = input as Record<string, unknown>;
  if (!(field in record)) return defaultValue;
  const value = record[field];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 1000
  ) {
    throw Object.assign(
      new Error(`${field} must be an integer between 1 and 1000`),
      { errorCode: ErrorCodes.INVALID_ARGUMENT },
    );
  }
  return value;
}

function assertLocalSession(sessionId: string): void {
  if (
    sessionId.startsWith(REMOTE_SESSION_PREFIX) ||
    sessionId.startsWith(NATIVE_PI_SESSION_PREFIX)
  ) {
    throw Object.assign(
      new Error("Local terminals are not available for remote or native-pi sessions"),
      { errorCode: ErrorCodes.INVALID_ARGUMENT },
    );
  }
}

export function registerLocalTerminalIpc({
  registrar,
  getHost,
  confirmTerminalOpen,
  checkPlatform = () => process.platform === "linux",
}: LocalTerminalIpcDependencies): void {
  const assertPlatformSupported = (): void => {
    if (!checkPlatform()) {
      throw Object.assign(new Error("local terminals are only supported on Linux"), {
        errorCode: ErrorCodes.CAPABILITY_UNAVAILABLE,
      });
    }
  };

  const host = (): HostProcess => {
    const current = getHost();
    if (!current) throw new Error("host unavailable");
    return current;
  };

  registrar.handle(IPC.invoke.terminalOpen, async (input: unknown) => {
    assertPlatformSupported();
    const sessionId = requiredText(input, "sessionId");
    assertLocalSession(sessionId);
    const cols = optionalTerminalSize(input, "cols", 80);
    const rows = optionalTerminalSize(input, "rows", 24);
    const confirmed = await confirmTerminalOpen();
    if (!confirmed) {
      throw Object.assign(new Error("terminal open cancelled by user"), {
        errorCode: "CANCELLED",
      });
    }
    return host().call("terminal.open", {
      sessionId,
      cols,
      rows,
      userConfirmed: true,
    });
  });

  registrar.handle(IPC.invoke.terminalInput, async (input: unknown) => {
    assertPlatformSupported();
    const sessionId = requiredText(input, "sessionId");
    assertLocalSession(sessionId);
    const terminalId = requiredText(input, "terminalId");
    const data = requiredText(input, "data");
    return host().call("terminal.input", { sessionId, terminalId, data });
  });

  registrar.handle(IPC.invoke.terminalResize, async (input: unknown) => {
    assertPlatformSupported();
    const sessionId = requiredText(input, "sessionId");
    assertLocalSession(sessionId);
    const terminalId = requiredText(input, "terminalId");
    const cols = requiredUnsigned(input, "cols");
    const rows = requiredUnsigned(input, "rows");
    return host().call("terminal.resize", { sessionId, terminalId, cols, rows });
  });

  registrar.handle(IPC.invoke.terminalInterrupt, async (input: unknown) => {
    assertPlatformSupported();
    const sessionId = requiredText(input, "sessionId");
    assertLocalSession(sessionId);
    const terminalId = requiredText(input, "terminalId");
    return host().call("terminal.interrupt", { sessionId, terminalId });
  });

  registrar.handle(IPC.invoke.terminalClose, async (input: unknown) => {
    assertPlatformSupported();
    const sessionId = requiredText(input, "sessionId");
    assertLocalSession(sessionId);
    const terminalId = requiredText(input, "terminalId");
    return host().call("terminal.close", { sessionId, terminalId });
  });
}

export function closeAllLocalTerminalsForSession(
  host: HostProcess,
  sessionId: string,
): Promise<unknown> {
  assertLocalSession(sessionId);
  return host.call("terminal.closeAllForSession", { sessionId });
}
