import type { ProjectWorkspaceSummary } from "@pi-harbor/shared";
import { create } from "zustand";
import { useEffect } from "react";
import { api } from "../../lib/api";
import { normalizeProjectPath } from "../../lib/sidebar-session-groups";
import {
  loadProjectWorkspaceCollapse,
  saveProjectWorkspaceCollapse,
} from "../../lib/sidebar-preferences";

/** The one workspace dialog that is open, if any. */
export type ProjectWorkspaceDialog =
  | { kind: "create"; projectPath: string; projectName: string }
  | { kind: "delete"; workspace: ProjectWorkspaceSummary; keepFolder: boolean }
  | { kind: "setupLog"; workspace: ProjectWorkspaceSummary };

type ProjectWorkspaceState = {
  /** Workspace nodes per normalized project path. */
  byProject: Record<string, ProjectWorkspaceSummary[]>;
  /** Projects whose list is being read right now. */
  loading: Record<string, boolean>;
  dialog: ProjectWorkspaceDialog | null;
  /**
   * Collapse state keyed by workspace id, not by path, so it survives a
   * project move (design §4.8). Mirrored into the sidebar-preferences blob.
   */
  collapsed: Record<string, boolean>;
  load: (projectPath: string) => Promise<void>;
  upsert: (workspace: ProjectWorkspaceSummary) => void;
  remove: (workspaceId: string) => void;
  open: (dialog: ProjectWorkspaceDialog) => void;
  close: () => void;
  setCollapsed: (workspaceId: string, collapsed: boolean) => void;
};

function sortByName(
  workspaces: ProjectWorkspaceSummary[],
): ProjectWorkspaceSummary[] {
  return [...workspaces].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/**
 * Workspace nodes, dialog and collapse state for the sidebar.
 *
 * Deliberately outside the central app store: the design keeps this feature's
 * workflow out of `app-store.ts` (root AGENTS.md §7/§8), and the sidebar reads
 * it as plain view data.
 */
export const useProjectWorkspaceStore = create<ProjectWorkspaceState>((set, get) => ({
  byProject: {},
  loading: {},
  dialog: null,
  collapsed: loadProjectWorkspaceCollapse(),

  load: async (projectPath) => {
    const key = normalizeProjectPath(projectPath);
    if (!key) return;
    if (get().loading[key]) return;
    set((state) => ({ loading: { ...state.loading, [key]: true } }));
    try {
      const workspaces = await api.listProjectWorkspaces(projectPath);
      set((state) => ({
        byProject: { ...state.byProject, [key]: sortByName(workspaces) },
      }));
    } catch {
      // A project that cannot host workspaces simply has none. The create
      // action reports the reason through the probe, so this stays silent.
      set((state) => (state.byProject[key] ? {} : { byProject: { ...state.byProject, [key]: [] } }));
    } finally {
      set((state) => {
        const loading = { ...state.loading };
        delete loading[key];
        return { loading };
      });
    }
  },

  upsert: (workspace) => {
    const key = normalizeProjectPath(workspace.projectPath);
    if (!key) return;
    set((state) => {
      const current = state.byProject[key] ?? [];
      const next = current.some((candidate) => candidate.id === workspace.id)
        ? current.map((candidate) => (candidate.id === workspace.id ? workspace : candidate))
        : [...current, workspace];
      return { byProject: { ...state.byProject, [key]: sortByName(next) } };
    });
  },

  remove: (workspaceId) => {
    set((state) => {
      const byProject: Record<string, ProjectWorkspaceSummary[]> = {};
      for (const [key, workspaces] of Object.entries(state.byProject)) {
        byProject[key] = workspaces.filter((candidate) => candidate.id !== workspaceId);
      }
      const collapsed = { ...state.collapsed };
      delete collapsed[workspaceId];
      saveProjectWorkspaceCollapse(collapsed);
      return { byProject, collapsed };
    });
  },

  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),

  setCollapsed: (workspaceId, collapsed) => {
    set((state) => {
      const next = { ...state.collapsed, [workspaceId]: collapsed };
      saveProjectWorkspaceCollapse(next);
      return { collapsed: next };
    });
  },
}));

/** Workspace nodes of one project, stable across unrelated store writes. */
export function projectWorkspacesFor(
  state: Pick<ProjectWorkspaceState, "byProject">,
  projectPath: string,
): ProjectWorkspaceSummary[] {
  const key = normalizeProjectPath(projectPath);
  return (key ? state.byProject[key] : undefined) ?? [];
}

/**
 * The display name of the workspace a session is bound to, or `null` while it
 * is unknown. Pure, so the topbar's crumb can be tested without a store.
 */
export function projectWorkspaceName(
  state: Pick<ProjectWorkspaceState, "byProject">,
  projectPath: string | null | undefined,
  workspaceId: string | null | undefined,
): string | null {
  if (!projectPath || !workspaceId) return null;
  return (
    projectWorkspacesFor(state, projectPath).find((workspace) => workspace.id === workspaceId)
      ?.name ?? null
  );
}

/**
 * The workspace name of a session, for the conversation topbar. The sidebar
 * reads a project's workspaces as it renders the project; a session opened from
 * search or a notification can arrive first, so this reads them once when that
 * project was never read. A failed read stores an empty list, so it never loops.
 */
export function useProjectWorkspaceName(
  projectPath: string | null | undefined,
  workspaceId: string | null | undefined,
): string | null {
  const name = useProjectWorkspaceStore((state) =>
    projectWorkspaceName(state, projectPath, workspaceId),
  );
  const known = useProjectWorkspaceStore((state) => {
    const key = normalizeProjectPath(projectPath);
    return key ? key in state.byProject : true;
  });
  useEffect(() => {
    if (!projectPath || !workspaceId || known) return;
    void useProjectWorkspaceStore.getState().load(projectPath);
  }, [projectPath, workspaceId, known]);
  return name;
}
