import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectWorkspaceSummary, SessionSummary } from "@pi-harbor/shared";
import {
  IconBranch,
  IconChevronDown,
  IconFileText,
  IconFolderOpen,
  IconMore,
  IconNewSession,
  IconTrash,
  IconWrench,
} from "../../components/icons";
import { Badge, TooltipButton } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import {
  sidebarMenuAction,
  type SidebarMenuActionItem,
} from "../../lib/sidebar-menu";
import {
  createProjectWorkspaceSession,
  repairProjectWorkspace,
  revealProjectWorkspace,
} from "./project-workspace-actions";
import {
  projectWorkspaceAvailability,
  type ProjectWorkspaceProbeState,
} from "./project-workspace-errors";
import { useProjectWorkspaceStore } from "./project-workspace-store";

/**
 * Sidebar surface of project workspaces (design §4.8).
 *
 * `Sidebar.tsx` is a declared architecture hotspot, so the node, its menu rows
 * and the probe gating live here and the sidebar only composes them.
 */

/** Branch and state of one workspace node, as a row of badges. */
function ProjectWorkspaceNodeBadges({ workspace }: { workspace: ProjectWorkspaceSummary }) {
  const { t } = useTranslation();
  const state =
    workspace.status === "creating"
      ? (["neutral", t("projectWorkspace.status.creating")] as const)
      : workspace.status === "missing"
        ? (["error", t("projectWorkspace.status.missing")] as const)
        : workspace.setupStatus === "failed"
          ? (["warning", t("projectWorkspace.status.setupFailed")] as const)
          : null;
  return (
    <>
      <span
        className="project-workspace-branch"
        title={t("projectWorkspace.branchTitle", { branch: workspace.branch })}
      >
        <IconBranch size={11} aria-hidden />
        <span>{workspace.branch}</span>
      </span>
      {state ? <Badge tone={state[0]}>{state[1]}</Badge> : null}
    </>
  );
}

/**
 * Menu rows of one workspace node: reveal, the setup log when one exists,
 * Repair and Remove from list for a broken checkout, and the delete.
 */
export function useProjectWorkspaceNodeMenuItems({
  workspace,
  onDone,
}: {
  workspace: ProjectWorkspaceSummary;
  onDone: () => void;
}): SidebarMenuActionItem[] {
  const { t } = useTranslation();
  const open = useProjectWorkspaceStore((s) => s.open);
  const missing = workspace.status === "missing";
  return [
    ...(missing
      ? [
          sidebarMenuAction({
            id: "project-workspace-repair",
            label: t("projectWorkspace.repair.menu"),
            icon: <IconWrench size={14} />,
            onSelect: () => {
              onDone();
              void repairProjectWorkspace(workspace, t);
            },
          }),
        ]
      : []),
    sidebarMenuAction({
      id: "project-workspace-reveal",
      label: t("projectWorkspace.reveal"),
      icon: <IconFolderOpen size={14} />,
      disabled: missing,
      onSelect: () => {
        onDone();
        void revealProjectWorkspace(workspace.id, t);
      },
    }),
    ...(workspace.setupStatus && workspace.setupStatus !== "none"
      ? [
          sidebarMenuAction({
            id: "project-workspace-setup-log",
            label: t("projectWorkspace.setupLog.menu"),
            icon: <IconFileText size={14} />,
            onSelect: () => {
              onDone();
              open({ kind: "setupLog", workspace });
            },
          }),
        ]
      : []),
    sidebarMenuAction({
      id: "project-workspace-remove",
      label: t("projectWorkspace.delete.removeMenu"),
      icon: <IconTrash size={14} />,
      separatorBefore: true,
      onSelect: () => {
        onDone();
        open({ kind: "delete", workspace, keepFolder: true });
      },
    }),
    sidebarMenuAction({
      id: "project-workspace-delete",
      label: t("projectWorkspace.delete.menu"),
      icon: <IconTrash size={14} />,
      danger: true,
      onSelect: () => {
        onDone();
        open({ kind: "delete", workspace, keepFolder: false });
      },
    }),
  ];
}

/**
 * One workspace node under a project: its own header, its own "+" that creates
 * a session bound to this workspace, and its own session list.
 */
export function ProjectWorkspaceNode({
  workspace,
  sessions,
  menuOpen,
  onOpenMenu,
  renderSessions,
}: {
  workspace: ProjectWorkspaceSummary;
  sessions: SessionSummary[];
  menuOpen: boolean;
  onOpenMenu: (workspaceId: string, anchor: HTMLElement) => void;
  renderSessions: (sessions: SessionSummary[]) => ReactNode;
}) {
  const { t } = useTranslation();
  const collapsed = useProjectWorkspaceStore((s) => s.collapsed[workspace.id] ?? false);
  const setCollapsed = useProjectWorkspaceStore((s) => s.setCollapsed);
  const setNewSessionScope = useAppStore((s) => s.setNewSessionScope);
  const nodeId = `project-workspace-${workspace.id}`;
  // A workspace still being created or whose folder is gone cannot host a
  // session; the host would refuse with NOT_READY / MISSING.
  const canCreate = workspace.status === "active";
  return (
    <section
      className="project-workspace-node"
      aria-labelledby={`${nodeId}-title`}
      data-project-workspace={workspace.id}
      data-project-workspace-status={workspace.status}
    >
      <div className="project-workspace-node-header">
        <button
          type="button"
          id={`${nodeId}-title`}
          className="project-workspace-node-title"
          aria-expanded={!collapsed}
          aria-controls={`${nodeId}-sessions`}
          title={workspace.relativePath}
          onClick={() => {
            // Disclosure also chooses the destination of the next New Task;
            // it does not add a second selected-row navigation state.
            setNewSessionScope({
              projectPath: workspace.projectPath,
              workspaceId: workspace.id,
            });
            setCollapsed(workspace.id, !collapsed);
          }}
        >
          <IconChevronDown
            size={12}
            className={`sidebar-disclosure-icon ${collapsed ? "collapsed" : ""}`}
            aria-hidden
          />
          <span className="project-workspace-node-name">{workspace.name}</span>
          <ProjectWorkspaceNodeBadges workspace={workspace} />
        </button>
        <TooltipButton
          type="button"
          className="thread-item-more"
          tooltip={t("projectWorkspace.nodeActions", { name: workspace.name })}
          ariaLabel={t("projectWorkspace.nodeActions", { name: workspace.name })}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-action="project-workspace-menu"
          onClick={(event) => {
            event.stopPropagation();
            onOpenMenu(workspace.id, event.currentTarget);
          }}
        >
          <IconMore size={13} />
        </TooltipButton>
        <TooltipButton
          type="button"
          className="sidebar-session-group-add"
          tooltip={t("projectWorkspace.newSessionHere", { name: workspace.name })}
          ariaLabel={t("projectWorkspace.newSessionHere", { name: workspace.name })}
          disabled={!canCreate}
          data-action="project-workspace-new-session"
          onClick={() => void createProjectWorkspaceSession(workspace, t)}
        >
          <IconNewSession size={12} />
        </TooltipButton>
      </div>
      <div
        id={`${nodeId}-sessions`}
        className={`project-workspace-node-body ${collapsed ? "collapsed" : ""}`}
        role="region"
        aria-label={t("projectWorkspace.sessions", { name: workspace.name })}
        aria-hidden={collapsed}
        inert={collapsed ? true : undefined}
      >
        {sessions.length > 0 ? (
          renderSessions(sessions)
        ) : (
          <div className="sidebar-session-empty">{t("projectWorkspace.noSessions")}</div>
        )}
      </div>
    </section>
  );
}

/**
 * Probe answers per project path, kept for the process lifetime: whether a
 * project can host a workspace depends on the repository's shape, not on the
 * sidebar. Without it, every menu open would re-probe the same project.
 */
const probeCache = new Map<string, ProjectWorkspaceProbeState>();

/**
 * The project "+" split action's secondary row: "New workspace…", disabled
 * with the probe reason for a project that cannot host one. The probe runs
 * only while the menu is open, like the isolated-session row does.
 */
export function useProjectWorkspaceCreateMenuItems({
  projectPath,
  projectName,
  onDone,
}: {
  projectPath: string;
  projectName: string;
  onDone: () => void;
}): SidebarMenuActionItem[] {
  const { t } = useTranslation();
  const open = useProjectWorkspaceStore((s) => s.open);
  const reasonId = useId();
  const [probe, setProbe] = useState<{
    projectPath: string;
    state: ProjectWorkspaceProbeState;
  }>({ projectPath: "", state: "checking" });
  // A new project starts disabled until its own answer arrives, so the
  // previous project's verdict never leaks into this row.
  useEffect(() => {
    if (!projectPath) {
      setProbe({ projectPath: "", state: "checking" });
      return;
    }
    const cached = probeCache.get(projectPath);
    if (cached) {
      setProbe({ projectPath, state: cached });
      return;
    }
    let current = true;
    setProbe({ projectPath, state: "checking" });
    api
      .probeProjectWorkspace(projectPath)
      .then((result) => {
        // Only a definite answer is cached; a failed probe is retried the next
        // time the menu opens.
        probeCache.set(projectPath, result);
        if (current) setProbe({ projectPath, state: result });
      })
      .catch(() => current && setProbe({ projectPath, state: "unknown" }));
    return () => {
      current = false;
    };
  }, [projectPath]);
  const probeState = probe.projectPath === projectPath ? probe.state : "checking";
  const { disabled, reason } = projectWorkspaceAvailability(probeState, t);
  return [
    sidebarMenuAction({
      id: "new-project-workspace",
      label: t("projectWorkspace.newWorkspace"),
      icon: <IconBranch size={14} />,
      disabled,
      busy: probeState === "checking",
      describedBy: reason ? reasonId : undefined,
      title: reason,
      onSelect: () => {
        onDone();
        open({ kind: "create", projectPath, projectName });
      },
    }),
  ];
}
