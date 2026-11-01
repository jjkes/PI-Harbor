/**
 * Project-workspace channels: named git worktrees at
 * `<project>/.pi/worktree/<name>` that own their own sessions.
 *
 * Distinct from two neighbours that already use the word "workspace":
 * `worktree*` is the per-session isolated worktree of ADR 0329, and
 * `workspace*` is the active project of the window.
 *
 * A thin pass-through to host-core's `projectWorkspace.*` methods: host-core
 * owns every git command, every path, and every naming rule. The renderer
 * names a project or a workspace id and never receives an absolute path;
 * "Reveal" resolves the path here and hands it straight to the OS file
 * manager. Host errors are re-thrown untouched so the renderer can map their
 * `WORKSPACE_*` / `WORKTREE_*` `errorCode` to a message.
 */
import { ErrorCodes, IPC } from "@pi-harbor/shared";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { IpcRegistrar } from "./types";

export type ProjectWorkspaceIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  logger: Pick<Logger, "app">;
  openPath: (path: string) => Promise<string>;
  stripWinLongPrefix: (path: string) => string;
};

function fields(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

/** A required non-empty string field. */
function requiredText(input: unknown, field: string): string {
  const value = fields(input)[field];
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw invalid(`${field} required`);
  return text;
}

/**
 * An optional string field. Present-but-wrong-type is rejected rather than
 * coerced, so a malformed renderer payload never reaches host-core as a
 * plausible-looking value.
 */
function optionalText(input: unknown, field: string): string | undefined {
  const value = fields(input)[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalid(`${field} must be a string`);
  const text = value.trim();
  return text ? text : undefined;
}

/** An optional boolean field; only real booleans are accepted. */
function optionalFlag(input: unknown, field: string): boolean | undefined {
  const value = fields(input)[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw invalid(`${field} must be a boolean`);
  return value;
}

export function registerProjectWorkspaceIpc({
  registrar,
  getHost,
  logger,
  openPath,
  stripWinLongPrefix,
}: ProjectWorkspaceIpcDependencies): void {
  const host = (): HostProcess => {
    const current = getHost();
    if (!current) {
      throw Object.assign(new Error("host unavailable"), {
        errorCode: ErrorCodes.HOST_UNAVAILABLE,
      });
    }
    return current;
  };

  registrar.handle(IPC.invoke.projectWorkspaceList, async (input: unknown) => {
    const result = await host().call<{ workspaces?: unknown }>("projectWorkspace.list", {
      projectPath: requiredText(input, "projectPath"),
    });
    return result.workspaces ?? [];
  });

  registrar.handle(IPC.invoke.projectWorkspaceProbe, async (input: unknown) =>
    host().call("projectWorkspace.probe", {
      projectPath: requiredText(input, "projectPath"),
    }),
  );

  registrar.handle(IPC.invoke.projectWorkspaceBranches, async (input: unknown) => {
    const remote = optionalText(input, "remote");
    const refresh = optionalFlag(input, "refresh");
    return host().call("projectWorkspace.branches", {
      projectPath: requiredText(input, "projectPath"),
      ...(remote ? { remote } : {}),
      ...(refresh === undefined ? {} : { refresh }),
    });
  });

  registrar.handle(IPC.invoke.projectWorkspaceCreate, async (input: unknown) => {
    const projectPath = requiredText(input, "projectPath");
    const name = requiredText(input, "name");
    const sourceBranch = requiredText(input, "sourceBranch");
    const remote = optionalText(input, "remote");
    const createBranch = optionalFlag(input, "createBranch");
    const newBranch = optionalText(input, "newBranch");
    // The checkbox and its revealed field travel together; host-core validates
    // the branch name itself (`git check-ref-format`).
    if (createBranch && !newBranch) throw invalid("newBranch required when createBranch is set");
    const result = await host().call<{ workspace?: { id?: string } }>(
      "projectWorkspace.create",
      {
        projectPath,
        name,
        sourceBranch,
        ...(remote ? { remote } : {}),
        ...(createBranch === undefined ? {} : { createBranch }),
        ...(newBranch ? { newBranch } : {}),
      },
    );
    logger.app("session", "info", "project workspace created", {
      data: { workspaceId: result.workspace?.id, createdBranch: Boolean(createBranch) },
    });
    return result;
  });

  registrar.handle(IPC.invoke.projectWorkspaceDelete, async (input: unknown) => {
    const workspaceId = requiredText(input, "workspaceId");
    const deleteBranch = optionalFlag(input, "deleteBranch");
    const keepFolder = optionalFlag(input, "keepFolder");
    const outcome = await host().call("projectWorkspace.delete", {
      workspaceId,
      ...(deleteBranch === undefined ? {} : { deleteBranch }),
      ...(keepFolder === undefined ? {} : { keepFolder }),
    });
    logger.app("session", "info", "project workspace deleted", { data: { workspaceId } });
    return outcome;
  });

  registrar.handle(IPC.invoke.projectWorkspacePendingWork, async (input: unknown) =>
    host().call("projectWorkspace.pendingWork", {
      workspaceId: requiredText(input, "workspaceId"),
    }),
  );

  registrar.handle(IPC.invoke.projectWorkspaceRepair, async (input: unknown) => {
    const workspaceId = requiredText(input, "workspaceId");
    const result = await host().call<{ workspace?: unknown }>("projectWorkspace.repair", {
      workspaceId,
    });
    logger.app("session", "info", "project workspace repaired", { data: { workspaceId } });
    return result.workspace ?? null;
  });

  registrar.handle(IPC.invoke.projectWorkspaceSetupLog, async (input: unknown) =>
    host().call("projectWorkspace.setupLog", {
      workspaceId: requiredText(input, "workspaceId"),
    }),
  );

  registrar.handle(IPC.invoke.projectWorkspaceReveal, async (input: unknown) => {
    const result = await host().call<{ path?: string }>("projectWorkspace.reveal", {
      workspaceId: requiredText(input, "workspaceId"),
    });
    const path = typeof result.path === "string" ? result.path.trim() : "";
    if (!path) throw new Error("project workspace location unavailable");
    const openError = await openPath(stripWinLongPrefix(path));
    if (openError) throw new Error(openError);
    return { ok: true };
  });
}
