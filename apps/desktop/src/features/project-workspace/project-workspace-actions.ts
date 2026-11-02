import type {
  ProjectWorkspaceCreateInput,
  ProjectWorkspaceSummary,
} from "@pi-harbor/shared";
import type { TFunction } from "i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { projectWorkspaceErrorMessage } from "./project-workspace-errors";
import { useProjectWorkspaceStore } from "./project-workspace-store";

/**
 * Workflows of the workspace nodes: create a session inside a workspace,
 * delete, repair and reveal. Each one reports through the shared toast and
 * refreshes the list it changed, so the sidebar stays a pure view.
 */

function reportError(error: unknown, t: TFunction): void {
  useAppStore
    .getState()
    .showToast(projectWorkspaceErrorMessage(error, t), { variant: "error" });
}

/**
 * The create dialog's submit. Normalizes the name to NFC so the directory on
 * disk matches what the user typed on either platform (design §4.2), then
 * reloads the project's nodes and reports what `.worktreeinclude` copied.
 */
export async function createProjectWorkspace(
  input: ProjectWorkspaceCreateInput,
  t: TFunction,
): Promise<ProjectWorkspaceSummary> {
  const created = await api.createProjectWorkspace({
    ...input,
    name: input.name.normalize("NFC"),
    ...(input.newBranch ? { newBranch: input.newBranch.normalize("NFC") } : {}),
  });
  const store = useProjectWorkspaceStore.getState();
  store.upsert(created.workspace);
  // A newly created workspace becomes the destination of the next New Task,
  // including the still-unpersisted home draft.
  useAppStore.getState().setNewSessionScope({
    projectPath: created.workspace.projectPath,
    workspaceId: created.workspace.id,
  });
  void store.load(input.projectPath);
  const toast = useAppStore.getState().showToast;
  toast(t("projectWorkspace.created", { name: created.workspace.name }), {
    variant: "success",
  });
  if (created.included.copied.length > 0) {
    toast(
      t("projectWorkspace.includedFiles", { count: created.included.copied.length }),
      { variant: "info" },
    );
  }
  return created.workspace;
}

/** A new session whose tools run in this workspace rather than the project. */
export async function createProjectWorkspaceSession(
  workspace: Pick<ProjectWorkspaceSummary, "id" | "projectPath">,
  t: TFunction,
): Promise<void> {
  try {
    await useAppStore.getState().newSession({
      projectPath: workspace.projectPath,
      workspaceId: workspace.id,
    });
    useAppStore.getState().setNewSessionScope({
      projectPath: workspace.projectPath,
      workspaceId: workspace.id,
    });
  } catch (error) {
    reportError(error, t);
  }
}

/**
 * Delete or drop a workspace. `keepFolder` is the "Remove from list" arm: the
 * checkout stays on disk while the row and its sessions go away. The host
 * refuses with `WORKSPACE_HAS_RUNNING_SESSIONS` while a session still runs.
 */
export async function deleteProjectWorkspace(
  workspace: Pick<ProjectWorkspaceSummary, "id" | "name" | "projectPath">,
  options: { deleteBranch: boolean; keepFolder: boolean },
  t: TFunction,
): Promise<void> {
  await api.deleteProjectWorkspace({
    workspaceId: workspace.id,
    deleteBranch: options.deleteBranch,
    keepFolder: options.keepFolder,
  });
  const store = useProjectWorkspaceStore.getState();
  store.remove(workspace.id);
  if (useAppStore.getState().newSessionScope?.workspaceId === workspace.id) {
    useAppStore.getState().setNewSessionScope(null);
  }
  void store.load(workspace.projectPath);
  // The deleted workspace's sessions are gone from the host as well.
  void useAppStore.getState().refreshSessions();
  useAppStore
    .getState()
    .showToast(
      options.keepFolder
        ? t("projectWorkspace.delete.removed", { name: workspace.name })
        : t("projectWorkspace.delete.done", { name: workspace.name }),
      { variant: "success" },
    );
}

/** Re-link a workspace whose folder was moved or replaced (design §4.11). */
export async function repairProjectWorkspace(
  workspace: Pick<ProjectWorkspaceSummary, "id" | "name" | "projectPath">,
  t: TFunction,
): Promise<void> {
  try {
    const repaired = await api.repairProjectWorkspace(workspace.id);
    const store = useProjectWorkspaceStore.getState();
    // `null` means the host dropped the row; the reload below settles the tree.
    if (repaired) store.upsert(repaired);
    void store.load(workspace.projectPath);
    useAppStore
      .getState()
      .showToast(t("projectWorkspace.repair.done", { name: workspace.name }), {
        variant: "success",
      });
  } catch (error) {
    reportError(error, t);
  }
}

/** Open the workspace folder in the OS file manager; no path reaches us. */
export async function revealProjectWorkspace(
  workspaceId: string,
  t: TFunction,
): Promise<void> {
  try {
    await api.revealProjectWorkspace(workspaceId);
  } catch (error) {
    reportError(error, t);
  }
}
