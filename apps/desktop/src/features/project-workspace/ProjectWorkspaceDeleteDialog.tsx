import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ProjectWorkspacePendingWork,
  ProjectWorkspaceSummary,
} from "@pi-harbor/shared";
import { Button, Checkbox } from "../../components/ui";
import { api } from "../../lib/api";
import { WorktreeDialogFrame } from "../worktree/WorktreeDialogFrame";
import { deleteProjectWorkspace } from "./project-workspace-actions";
import { projectWorkspaceErrorMessage } from "./project-workspace-errors";

/**
 * Delete confirmation for a workspace (design §4.11).
 *
 * `keepFolder` splits the two destructive shapes the node menu offers:
 * "Remove from list" keeps the checkout on disk, "Delete workspace" does not.
 * Both delete the workspace's sessions and transcripts, which the body states
 * plainly. The `pendingWork` summary is read when the dialog opens so the user
 * sees what the deletion would lose before confirming.
 */
export function ProjectWorkspaceDeleteDialog({
  workspace,
  keepFolder,
  onClose,
}: {
  workspace: ProjectWorkspaceSummary;
  keepFolder: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const alive = useRef(true);
  const [pending, setPending] = useState<ProjectWorkspacePendingWork | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    api
      .getProjectWorkspacePendingWork(workspace.id)
      .then((result) => {
        if (alive.current) setPending(result);
      })
      .catch((error: unknown) => {
        if (alive.current) setFailure(projectWorkspaceErrorMessage(error, t));
      });
  }, [workspace.id, t]);

  const confirm = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await deleteProjectWorkspace(workspace, { deleteBranch, keepFolder }, t);
      if (alive.current) onClose();
    } catch (error) {
      if (!alive.current) return;
      setFailure(projectWorkspaceErrorMessage(error, t));
      setBusy(false);
    }
  };

  // The host refuses the delete while a session runs; saying so up front is
  // clearer than letting the user press a button that cannot succeed.
  const blocked = (pending?.runningSessions ?? 0) > 0;

  return (
    <WorktreeDialogFrame
      id="project-workspace-delete"
      title={
        keepFolder
          ? t("projectWorkspace.delete.removeTitle", { name: workspace.name })
          : t("projectWorkspace.delete.title", { name: workspace.name })
      }
      subtitle={workspace.branch}
      busy={busy}
      onClose={onClose}
      actions={
        <>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || blocked}
            data-action="project-workspace-delete-confirm"
            onClick={() => void confirm()}
          >
            {busy
              ? t("projectWorkspace.delete.deleting")
              : keepFolder
                ? t("projectWorkspace.delete.removeConfirm")
                : t("projectWorkspace.delete.confirm")}
          </Button>
        </>
      }
    >
      <p>
        {keepFolder
          ? t("projectWorkspace.delete.removeBody", { path: workspace.relativePath })
          : t("projectWorkspace.delete.body", { path: workspace.relativePath })}
      </p>
      {pending ? (
        <ul className="project-workspace-pending">
          <li>{t("projectWorkspace.delete.pendingSessions", { count: pending.sessions })}</li>
          {!pending.gitReadable ? (
            <li>{t("projectWorkspace.delete.pendingUnreadable")}</li>
          ) : pending.uncommittedChanges || pending.unpushedCommits > 0 ? (
            <>
              {pending.uncommittedChanges ? (
                <li>{t("projectWorkspace.delete.pendingUncommitted")}</li>
              ) : null}
              {pending.unpushedCommits > 0 ? (
                <li>
                  {t("projectWorkspace.delete.pendingUnpushed", {
                    count: pending.unpushedCommits,
                  })}
                </li>
              ) : null}
            </>
          ) : (
            <li>{t("projectWorkspace.delete.pendingClean")}</li>
          )}
        </ul>
      ) : (
        <p role="status">{t("projectWorkspace.delete.pendingLoading")}</p>
      )}
      {/* Opt-in and off by default: the branch usually outlives the checkout. */}
      {keepFolder ? null : (
        <Checkbox
          label={t("projectWorkspace.delete.deleteBranch", { branch: workspace.branch })}
          checked={deleteBranch}
          disabled={busy}
          data-field="project-workspace-delete-branch"
          onChange={(event) => setDeleteBranch(event.target.checked)}
        />
      )}
      {blocked ? (
        <div className="project-workspace-field-error" role="alert">
          {t("projectWorkspace.errors.hasRunningSessions")}
        </div>
      ) : null}
      {failure ? (
        <div className="project-workspace-field-error" role="alert">
          {failure}
        </div>
      ) : null}
    </WorktreeDialogFrame>
  );
}
