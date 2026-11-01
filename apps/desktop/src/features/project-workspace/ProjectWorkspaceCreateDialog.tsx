import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectWorkspaceBranches } from "@pi-harbor/shared";
import { IconRefresh } from "../../components/icons";
import { Button, Checkbox, Field, Input, Select, TooltipButton } from "../../components/ui";
import { api } from "../../lib/api";
import { WorktreeDialogFrame } from "../worktree/WorktreeDialogFrame";
import { ProjectWorkspaceBranchPicker } from "./ProjectWorkspaceBranchPicker";
import { createProjectWorkspace } from "./project-workspace-actions";
import {
  pickProjectWorkspaceSourceBranch,
  projectWorkspaceCreateFormState,
} from "./project-workspace-create-form";
import { projectWorkspaceErrorMessage } from "./project-workspace-errors";
import {
  normalizeProjectWorkspaceName,
  projectWorkspacePathPreview,
} from "./project-workspace-names";

/** Remote branch list plus the non-blocking warning of a failed fetch. */
type BranchState = {
  data: ProjectWorkspaceBranches | null;
  loading: boolean;
  /** Set when a fetch failed; the cached list stays usable offline. */
  warning: string | null;
};

/**
 * "New workspace" (design §4.8). Built on `WorktreeDialogFrame`, so it
 * inherits the blocking overlay, Esc handling and focus restore of the other
 * worktree dialogs. The host re-validates everything; the inline rules here
 * only keep the user from submitting a request that cannot succeed.
 */
export function ProjectWorkspaceCreateDialog({
  projectPath,
  projectName,
  onClose,
}: {
  projectPath: string;
  projectName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const alive = useRef(true);

  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [remote, setRemote] = useState("");
  const [branch, setBranch] = useState("");
  const [createBranch, setCreateBranch] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [newBranchTouched, setNewBranchTouched] = useState(false);
  const [branches, setBranches] = useState<BranchState>({
    data: null,
    loading: true,
    warning: null,
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * Read the branch list. `refresh` runs `git fetch` on the host; a failure is
   * reported beside the field and never clears the cached list, so a workspace
   * can still be created offline (design §4.6).
   */
  const loadBranches = useCallback(
    async (options: { remote?: string; refresh?: boolean } = {}) => {
      setBranches((previous) => ({ ...previous, loading: true, warning: null }));
      try {
        const result = await api.getProjectWorkspaceBranches({
          projectPath,
          ...(options.remote ? { remote: options.remote } : {}),
          ...(options.refresh ? { refresh: true } : {}),
        });
        if (!alive.current) return;
        setBranches({
          data: result,
          loading: false,
          warning: result.warning
            ? projectWorkspaceErrorMessage(result.warning, t)
            : null,
        });
        setRemote(result.remote);
        // The host remembers the last source branch per project; otherwise the
        // remote's default branch is the sensible preselection.
        setBranch((current) => pickProjectWorkspaceSourceBranch(current, result));
      } catch (error) {
        if (!alive.current) return;
        // Keep whatever list we already had: an offline refresh must not
        // empty the picker.
        setBranches((previous) => ({
          data: previous.data,
          loading: false,
          warning: projectWorkspaceErrorMessage(error, t),
        }));
      }
    },
    [projectPath, t],
  );

  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  const { nameProblem, branchProblem, canSubmit } = projectWorkspaceCreateFormState({
    name,
    sourceBranch: branch,
    createBranch,
    newBranch,
    busy,
  });
  const nameError =
    nameTouched && nameProblem
      ? t(`projectWorkspace.create.nameErrors.${nameProblem}`)
      : null;
  const branchError =
    newBranchTouched && branchProblem
      ? t(`projectWorkspace.create.branchErrors.${branchProblem}`)
      : null;

  const submit = async () => {
    setNameTouched(true);
    setNewBranchTouched(true);
    if (!canSubmit) return;
    setBusy(true);
    setFailure(null);
    try {
      await createProjectWorkspace(
        {
          projectPath,
          name,
          ...(remote ? { remote } : {}),
          sourceBranch: branch,
          ...(createBranch ? { createBranch: true, newBranch } : {}),
        },
        t,
      );
      if (alive.current) onClose();
    } catch (error) {
      if (!alive.current) return;
      setFailure(projectWorkspaceErrorMessage(error, t));
      setBusy(false);
    }
  };

  const remotes = branches.data?.remotes ?? [];
  const fetchedNote = branches.data?.lastFetchedAt
    ? t("projectWorkspace.create.fetchedAt", {
        time: new Date(branches.data.lastFetchedAt).toLocaleString(),
      })
    : t("projectWorkspace.create.neverFetched");

  return (
    <WorktreeDialogFrame
      id="project-workspace-create"
      title={t("projectWorkspace.create.title")}
      subtitle={projectName}
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
            disabled={!canSubmit}
            data-action="project-workspace-create"
            onClick={() => void submit()}
          >
            {busy
              ? t("projectWorkspace.create.submitting")
              : t("projectWorkspace.create.submit")}
          </Button>
        </>
      }
    >
      <Field label={t("projectWorkspace.create.nameLabel")}>
        <Input
          id={`${fieldId}-name`}
          value={name}
          disabled={busy}
          maxLength={120}
          autoFocus
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${fieldId}-name-error` : `${fieldId}-path`}
          placeholder={t("projectWorkspace.create.namePlaceholder")}
          data-field="project-workspace-name"
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setNameTouched(true)}
        />
      </Field>
      <div id={`${fieldId}-path`} className="project-workspace-path-preview">
        {t("projectWorkspace.create.pathPreview", {
          path: projectWorkspacePathPreview(
            normalizeProjectWorkspaceName(name) || t("projectWorkspace.create.namePlaceholder"),
          ),
        })}
      </div>
      {nameError ? (
        <div id={`${fieldId}-name-error`} className="project-workspace-field-error" role="alert">
          {nameError}
        </div>
      ) : null}

      {/* A single remote needs no choice; `origin` is already preselected. */}
      {remotes.length > 1 ? (
        <Field label={t("projectWorkspace.create.remoteLabel")}>
          <Select
            value={remote}
            disabled={busy || branches.loading}
            data-field="project-workspace-remote"
            onChange={(event) => {
              setRemote(event.target.value);
              setBranch("");
              void loadBranches({ remote: event.target.value });
            }}
          >
            {remotes.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <Field label={t("projectWorkspace.create.branchLabel")}>
        <div className="project-workspace-branch-row">
          <ProjectWorkspaceBranchPicker
            id={`${fieldId}-branch`}
            branches={branches.data?.branches ?? []}
            value={branch}
            disabled={busy}
            loading={branches.loading}
            describedBy={`${fieldId}-branch-note`}
            onChange={(next) => {
              setBranch(next);
              // The new branch defaults to the workspace name, so a user who
              // only picked a source branch does not have to retype it.
              if (createBranch && !newBranchTouched) setNewBranch(name);
            }}
          />
          <TooltipButton
            type="button"
            className="project-workspace-refresh"
            tooltip={t("projectWorkspace.create.refresh")}
            ariaLabel={t("projectWorkspace.create.refresh")}
            disabled={busy || branches.loading}
            aria-busy={branches.loading || undefined}
            data-action="project-workspace-refresh-branches"
            onClick={() => void loadBranches({ remote, refresh: true })}
          >
            <IconRefresh size={14} />
          </TooltipButton>
        </div>
      </Field>
      <div id={`${fieldId}-branch-note`} className="project-workspace-field-note">
        {branches.loading ? t("projectWorkspace.create.refreshing") : fetchedNote}
      </div>
      {/* Non-blocking: the cached list is still offered. */}
      {branches.warning ? (
        <div className="project-workspace-field-warning" role="status">
          {branches.warning}
        </div>
      ) : null}

      <Checkbox
        label={t("projectWorkspace.create.createBranch")}
        checked={createBranch}
        disabled={busy}
        data-field="project-workspace-create-branch"
        onChange={(event) => {
          const checked = event.target.checked;
          setCreateBranch(checked);
          if (checked && !newBranch) setNewBranch(name);
        }}
      />
      {createBranch ? (
        <Field label={t("projectWorkspace.create.newBranchLabel")}>
          <Input
            id={`${fieldId}-new-branch`}
            value={newBranch}
            disabled={busy}
            maxLength={200}
            aria-invalid={branchError ? true : undefined}
            aria-describedby={branchError ? `${fieldId}-new-branch-error` : undefined}
            placeholder={t("projectWorkspace.create.newBranchPlaceholder")}
            data-field="project-workspace-new-branch"
            onChange={(event) => setNewBranch(event.target.value)}
            onBlur={() => setNewBranchTouched(true)}
          />
        </Field>
      ) : null}
      {branchError ? (
        <div
          id={`${fieldId}-new-branch-error`}
          className="project-workspace-field-error"
          role="alert"
        >
          {branchError}
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
