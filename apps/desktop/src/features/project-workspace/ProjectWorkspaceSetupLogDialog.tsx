import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ProjectWorkspaceSetupLog,
  ProjectWorkspaceSummary,
} from "@pi-harbor/shared";
import { Button } from "../../components/ui";
import { api } from "../../lib/api";
import { WorktreeDialogFrame } from "../worktree/WorktreeDialogFrame";
import { projectWorkspaceErrorMessage } from "./project-workspace-errors";

/** Output of the setup command that ran in a workspace (design §4.6). */
export function ProjectWorkspaceSetupLogDialog({
  workspace,
  onClose,
}: {
  workspace: ProjectWorkspaceSummary;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [log, setLog] = useState<ProjectWorkspaceSetupLog | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api
      .getProjectWorkspaceSetupLog(workspace.id)
      .then((result) => current && setLog(result))
      .catch((error: unknown) => {
        if (current) setFailure(projectWorkspaceErrorMessage(error, t));
      });
    return () => {
      current = false;
    };
  }, [workspace.id, t]);

  const status = log?.setupStatus;
  const summary =
    status === "running"
      ? t("projectWorkspace.setupLog.running")
      : status === "ok"
        ? t("projectWorkspace.setupLog.ok")
        : status === "failed"
          ? t("projectWorkspace.setupLog.failed")
          : t("projectWorkspace.setupLog.none");

  return (
    <WorktreeDialogFrame
      id="project-workspace-setup-log"
      title={t("projectWorkspace.setupLog.title")}
      subtitle={workspace.name}
      onClose={onClose}
      actions={
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("common.close")}
        </Button>
      }
    >
      {failure ? (
        <p role="alert">{failure}</p>
      ) : (
        <>
          <p>{summary}</p>
          {log?.log ? <pre className="worktree-setup-log">{log.log}</pre> : null}
        </>
      )}
    </WorktreeDialogFrame>
  );
}
