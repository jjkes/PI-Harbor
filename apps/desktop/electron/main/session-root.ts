/**
 * Where a session's file tools run.
 *
 * Three roots are possible and host-core owns all of them:
 * - an isolated session's own git worktree (ADR 0329), via `worktree.location`;
 * - a project workspace (`.pi/worktree/<name>`), via
 *   `projectWorkspace.location`;
 * - otherwise the session's project path.
 *
 * Electron main never builds either path. It names the session and takes the
 * path back, so a renderer-supplied string can never become a tool root. A
 * binding that cannot be resolved fails the caller instead of falling back to
 * the project root: silently running a workspace session against the parent
 * checkout would write to the wrong branch.
 *
 * Project *identity* is deliberately not affected (design §4.9, ADR 0329).
 * Memory, skills, plugins, MCP scope, the subagent catalog, group context,
 * `.pi/prompts`, `.pi/extensions`, `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md`
 * stay keyed by the project path. Only the tool root, the Bash cwd and the
 * file tools follow the workspace.
 */
import { ErrorCodes, ProjectWorkspaceErrorCodes } from "@pi-harbor/shared";

/** The part of `HostProcess` this module needs. */
export type SessionRootHost = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
};

/**
 * The binding fields of a host session record. Both are optional and, by
 * contract, never set together.
 */
export type SessionRootBinding = {
  /** Present only for an isolated session (ADR 0329). */
  worktree?: unknown;
  /** Present only for a session bound to a project workspace. */
  workspaceId?: unknown;
};

function nonEmptyText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : undefined;
}

/**
 * `workspaceId` and `isolated` are mutually exclusive (design §4.5), enforced
 * by host-core at `session.create`. Observing both means the stored record is
 * inconsistent, so fail loudly rather than picking a root.
 */
export function assertSingleSessionBinding(
  sessionId: string,
  session: SessionRootBinding | null | undefined,
): void {
  if (session?.worktree && nonEmptyText(session.workspaceId)) {
    throw Object.assign(
      new Error(
        `session ${sessionId} is bound to both an isolated worktree and a project workspace`,
      ),
      { errorCode: ProjectWorkspaceErrorCodes.ISOLATED_CONFLICT },
    );
  }
}

/**
 * The host-resolved root of a bound session, or `undefined` when the session
 * has no binding and the caller should use its project path.
 *
 * Throws when a binding exists but the host cannot resolve it — including a
 * workspace that is still `creating` (`WORKSPACE_NOT_READY`) or whose folder
 * is gone (`WORKSPACE_MISSING`).
 */
export async function resolveBoundSessionRoot(
  host: SessionRootHost,
  sessionId: string,
  session: SessionRootBinding | null | undefined,
): Promise<string | undefined> {
  assertSingleSessionBinding(sessionId, session);
  if (session?.worktree) {
    const result = await host.call<{ path?: string }>("worktree.location", { sessionId });
    const root = nonEmptyText(result.path);
    if (!root) throw new Error("isolated worktree location unavailable");
    return root;
  }
  if (nonEmptyText(session?.workspaceId)) {
    const result = await host.call<{ path?: string }>("projectWorkspace.location", {
      sessionId,
    });
    const root = nonEmptyText(result.path);
    if (!root) {
      throw Object.assign(new Error("project workspace location unavailable"), {
        errorCode: ProjectWorkspaceErrorCodes.MISSING,
      });
    }
    return root;
  }
  return undefined;
}

/**
 * Load the session record and resolve its bound root in one step, for callers
 * that do not already hold the record.
 */
export async function resolveSessionFileRoot(
  host: SessionRootHost,
  sessionId: string,
): Promise<string | null> {
  const res = await host.call<{
    session: (SessionRootBinding & { projectPath?: string }) | null;
  }>("session.get", { id: sessionId });
  const session = res?.session;
  if (!session) return null;
  const bound = await resolveBoundSessionRoot(host, sessionId, session);
  if (bound) return bound;
  return nonEmptyText(session.projectPath) ?? null;
}

/** `HOST_UNAVAILABLE` as the IPC layer reports it. */
export function hostUnavailable(): Error {
  return Object.assign(new Error("host unavailable"), {
    errorCode: ErrorCodes.HOST_UNAVAILABLE,
  });
}
