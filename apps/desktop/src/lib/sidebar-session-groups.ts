import type { SessionSummary } from "@pi-harbor/shared";
import { isRemoteSession } from "./remote-session-safety.ts";
import type { ProjectMeta, SessionMeta } from "./sidebar-preferences";

export function normalizeProjectPath(projectPath?: string | null): string | null {
  const value = projectPath?.trim();
  if (!value) return null;

  let normalized = value.replace(/\\/g, "/");
  // Strip the Windows extended-length prefix (`//?/C:/...` → `C:/...`)
  if (/^\/\/\?\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(4);
  }
  // Remove trailing slashes but keep the one after a drive letter (e.g. `C:/`)
  normalized = normalized.replace(/(?<![A-Za-z]:)\/+$/, "");
  return normalized || "/";
}

export function sessionMatchesProject(
  session: Pick<SessionSummary, "projectPath"> & Partial<Pick<SessionSummary, "source" | "id">>,
  projectPath?: string | null,
): boolean {
  if (session.source === "remote" || session.id?.startsWith("remote:")) return false;
  return normalizeProjectPath(session.projectPath) === normalizeProjectPath(projectPath);
}

/**
 * Grouping key of a sidebar row: the project path plus the workspace binding.
 *
 * A project row and each of its workspace nodes are separate groups, so a
 * session bound to `.pi/worktree/<name>` never appears under the project row
 * and vice versa (design §4.8). `\u0000` cannot occur in a path or an id, so it
 * is a safe separator.
 */
export function sidebarSessionGroupKey(
  projectPath?: string | null,
  workspaceId?: string | null,
): string {
  const path = normalizeProjectPath(projectPath) ?? "";
  return workspaceId ? `${path}\u0000${workspaceId}` : path;
}

/**
 * Whether a session belongs to one project-or-workspace group. Passing no
 * `workspaceId` asks for the project's own rows, which excludes every
 * workspace-bound session.
 */
export function sessionMatchesProjectWorkspace(
  session: Pick<SessionSummary, "projectPath"> &
    Partial<Pick<SessionSummary, "source" | "id" | "workspaceId">>,
  projectPath?: string | null,
  workspaceId?: string | null,
): boolean {
  if (!sessionMatchesProject(session, projectPath)) return false;
  return (session.workspaceId ?? null) === (workspaceId ?? null);
}

/** Split a project's sessions into its own rows and one list per workspace. */
export function groupSessionsByWorkspace<
  T extends Partial<Pick<SessionSummary, "workspaceId">>,
>(
  sessions: readonly T[],
  workspaceIds: readonly string[],
): { projectSessions: T[]; byWorkspace: Record<string, T[]> } {
  const known = new Set(workspaceIds);
  const byWorkspace: Record<string, T[]> = {};
  for (const id of workspaceIds) byWorkspace[id] = [];
  const projectSessions: T[] = [];
  for (const session of sessions) {
    const id = session.workspaceId;
    // A session whose workspace row is gone (deleted or not loaded yet) stays
    // out of the project rows: it is not a project-root session.
    if (id) {
      if (known.has(id)) byWorkspace[id].push(session);
      continue;
    }
    projectSessions.push(session);
  }
  return { projectSessions, byWorkspace };
}

/** Return normalized project paths belonging to sessions added by a refresh. */
export function projectPathsForNewSessions(
  previousSessions: readonly Pick<SessionSummary, "id">[],
  nextSessions: readonly (Pick<SessionSummary, "id" | "projectPath"> & Partial<Pick<SessionSummary, "source">>)[],
): string[] {
  const previousIds = new Set(previousSessions.map((session) => session.id));
  const paths = new Set<string>();
  for (const session of nextSessions) {
    if (isRemoteSession(session)) continue;
    if (previousIds.has(session.id)) continue;
    const path = normalizeProjectPath(session.projectPath);
    if (path) paths.add(path);
  }
  return [...paths];
}

export function groupSidebarSessions(
  sessions: SessionSummary[],
  projectPath?: string | null,
): {
  projectSessions: SessionSummary[];
  temporarySessions: SessionSummary[];
} {
  const normalizedProjectPath = normalizeProjectPath(projectPath);

  return {
    projectSessions: normalizedProjectPath
      ? sessions.filter(
          (session) => normalizeProjectPath(session.projectPath) === normalizedProjectPath,
        )
      : [],
    temporarySessions: sessions.filter(
      (session) => normalizeProjectPath(session.projectPath) === null,
    ),
  };
}

export function sessionArchived(session: SessionSummary, meta: SessionMeta | undefined): boolean {
  return Boolean(meta?.archived || (session as SessionSummary & { archived?: boolean }).archived);
}

export function sessionPinned(session: SessionSummary, meta: SessionMeta | undefined): boolean {
  return Boolean(meta?.pinned || (session as SessionSummary & { pinned?: boolean }).pinned);
}

/** Pins are global shortcuts; project retention and dates do not limit discovery. */
export function getGlobalPinnedSessions(
  sessions: SessionSummary[],
  sessionMeta: Record<string, SessionMeta>,
  projectMeta: Record<string, ProjectMeta>,
  showArchived: boolean,
): SessionSummary[] {
  return sessions.filter((session) => {
    if (!sessionPinned(session, sessionMeta[session.id])) return false;
    const path = normalizeProjectPath(session.projectPath);
    const project = path ? (projectMeta[path] ?? projectMeta[session.projectPath!]) : undefined;
    return (
      showArchived || (!sessionArchived(session, sessionMeta[session.id]) && !project?.archived)
    );
  });
}
