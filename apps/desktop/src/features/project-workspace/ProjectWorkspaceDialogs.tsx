import { ProjectWorkspaceCreateDialog } from "./ProjectWorkspaceCreateDialog";
import { ProjectWorkspaceDeleteDialog } from "./ProjectWorkspaceDeleteDialog";
import { ProjectWorkspaceSetupLogDialog } from "./ProjectWorkspaceSetupLogDialog";
import { useProjectWorkspaceStore } from "./project-workspace-store";

/**
 * Renders whichever workspace dialog the store has open, mirroring the
 * `WorktreeDialogs` host. Mounted once by the app shell, so the sidebar does
 * not have to own dialog state.
 */
export function ProjectWorkspaceDialogs() {
  const dialog = useProjectWorkspaceStore((state) => state.dialog);
  const close = useProjectWorkspaceStore((state) => state.close);
  if (!dialog) return null;
  if (dialog.kind === "create") {
    return (
      <ProjectWorkspaceCreateDialog
        projectPath={dialog.projectPath}
        projectName={dialog.projectName}
        onClose={close}
      />
    );
  }
  if (dialog.kind === "delete") {
    return (
      <ProjectWorkspaceDeleteDialog
        workspace={dialog.workspace}
        keepFolder={dialog.keepFolder}
        onClose={close}
      />
    );
  }
  return <ProjectWorkspaceSetupLogDialog workspace={dialog.workspace} onClose={close} />;
}
