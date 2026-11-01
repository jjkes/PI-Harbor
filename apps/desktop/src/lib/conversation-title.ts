import type { SessionSummary } from "@pi-harbor/shared";
import { isRemoteSession } from "./remote-session-safety";
import type { ProjectMeta } from "./sidebar-preferences";
import { normalizeProjectPath } from "./sidebar-session-groups";

/** `Project / Workspace`: the workspace is read as a child of its project. */
const CRUMB_SEPARATOR = " / ";
/** Separates the location crumb from the task it contains. */
const TASK_SEPARATOR = " · ";
/** Separates the conversation from the application name in the OS title. */
const APP_SEPARATOR = " — ";

export type ConversationTitleInput = {
  /** The conversation on screen, or null before a first prompt creates one. */
  session: SessionSummary | null | undefined;
  /** Renderer display names, keyed by normalized project path. */
  projectMeta: Record<string, ProjectMeta>;
  /** Name of the project workspace this session is bound to, when it has one. */
  workspaceName: string | null;
  /** The active workspace, which names a draft that has no session yet. */
  workspace?: { path?: string | null; name?: string | null } | null;
  /** `chat.untitledTask`. The helper coins no user-visible words of its own. */
  untitledTask: string;
};

export type ConversationTitleParts = {
  /** The project the conversation lives in, or null when it names none. */
  project: string | null;
  /**
   * The workspace segment actually shown, or null. The topbar renders its
   * workspace chip from this, so the chip and the crumb cannot disagree.
   */
  workspaceName: string | null;
  /** The committed session title — never the inline-rename draft. */
  taskTitle: string;
  /** `Project / Workspace`, `Project`, or null when there is no project. */
  crumb: string | null;
  /** The crumb and the task joined: the topbar tooltip and window title text. */
  breadcrumbTitle: string;
};

/** Last path segment of a project directory, unless a display name exists. */
export function projectName(path?: string | null, name?: string | null) {
  if (name) return name;
  if (!path) return null;
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

/**
 * A title the host generated for a fresh task carries no information, so the
 * crumb shows the localized placeholder instead. Both locales are matched
 * because the title is persisted in whatever language created it.
 */
export function isDefaultSessionTitle(title?: string | null) {
  const trimmed = (title || "").trim().toLowerCase();
  if (!trimmed) return true;
  return ["new task", "new chat", "新建任务", "新对话"].includes(trimmed);
}

/**
 * Single source of truth for the conversation crumb: the topbar renders these
 * parts, uses `breadcrumbTitle` as its hover title, and the window title is
 * derived from the same value (`conversationWindowTitle`).
 *
 * The crumb names the project the conversation lives in, not the workspace the
 * app happens to show: a task can be opened from a project other than the
 * active one. A remote session carries its display-only label; a local one
 * resolves its project path through the sidebar's naming preferences, and a
 * temporary session keeps the plain title. Before the first prompt there is no
 * session yet, so the active workspace names the draft.
 */
export function conversationTitleParts({
  session,
  projectMeta,
  workspaceName,
  workspace,
  untitledTask,
}: ConversationTitleInput): ConversationTitleParts {
  const taskTitle = isDefaultSessionTitle(session?.title)
    ? untitledTask
    : session?.title || untitledTask;
  const remote = isRemoteSession(session);
  const projectKey = remote ? null : normalizeProjectPath(session?.projectPath);
  const project = remote
    ? session?.remoteWorkspaceLabel?.trim() || null
    : projectKey
      ? projectMeta[projectKey]?.name?.trim() || projectName(session?.projectPath)
      : session
        ? null
        : projectName(workspace?.path, workspace?.name);
  /*
   * A workspace session also names its workspace: the same conversation can
   * live in the project root or in any of its workspaces. Without a project
   * there is nothing for the workspace to qualify, so the segment is dropped
   * rather than shown on its own.
   */
  const workspaceSegment = project ? workspaceName : null;
  const crumb = workspaceSegment
    ? `${project}${CRUMB_SEPARATOR}${workspaceSegment}`
    : project;
  return {
    project,
    workspaceName: workspaceSegment,
    taskTitle,
    crumb,
    breadcrumbTitle: crumb ? `${crumb}${TASK_SEPARATOR}${taskTitle}` : taskTitle,
  };
}

/**
 * The OS window title: the conversation crumb followed by the application
 * name the window carries by default. `null` asks for that default back —
 * there is no conversation to name.
 */
export function conversationWindowTitle(
  breadcrumbTitle: string | null,
  defaultTitle: string,
): string {
  if (!breadcrumbTitle) return defaultTitle;
  return `${breadcrumbTitle}${APP_SEPARATOR}${defaultTitle}`;
}
