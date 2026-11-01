import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import type { ProjectWorkspaceSummary, SessionSummary } from "@pi-harbor/shared";
import { IconChevronDown } from "../../components/icons";
import { SidebarMenuPanel, sidebarMenuKeyDown } from "../../components/SidebarMenuPanel";
import { TooltipButton } from "../../components/ui";
import { portalToBody } from "../../lib/portal-visibility";
import {
  placeSidebarFloatingMenuTop,
  SIDEBAR_FLOATING_MENU_MAX_HEIGHT,
  SIDEBAR_MENU_VIEWPORT_PADDING,
} from "../../lib/sidebar-floating-menu";
import {
  groupSessionsByWorkspace,
  normalizeProjectPath,
} from "../../lib/sidebar-session-groups";
import {
  ProjectWorkspaceNode,
  useProjectWorkspaceCreateMenuItems,
  useProjectWorkspaceNodeMenuItems,
} from "./ProjectWorkspaceSidebarParts";
import { useProjectWorkspaceStore } from "./project-workspace-store";
import "../../styles/project-workspace.css";

/**
 * What the sidebar mounts for project workspaces (design §4.8).
 *
 * `Sidebar.tsx` is a declared architecture hotspot, so the menu state, the
 * anchoring and the per-project data split live here and the sidebar only
 * places the three exported pieces.
 */

type MenuPosition = { top: number; left: number };

/** Viewport position of a menu opened from `trigger`, as the sidebar places its own. */
function anchorMenuTo(trigger: HTMLElement): MenuPosition {
  const rect = trigger.getBoundingClientRect();
  return {
    top: placeSidebarFloatingMenuTop(
      { top: rect.top, bottom: rect.bottom },
      SIDEBAR_FLOATING_MENU_MAX_HEIGHT,
      window.innerHeight,
    ),
    left: Math.max(SIDEBAR_MENU_VIEWPORT_PADDING, rect.right + 4),
  };
}

/**
 * One open menu at a time, anchored to the button that opened it. Clicking the
 * same trigger again closes it, a pointer anywhere else dismisses it, and Esc
 * is handled by the panel's own key contract.
 */
function useAnchoredMenu(): {
  openId: string | null;
  position: MenuPosition | null;
  toggle: (id: string, trigger: HTMLElement) => void;
  close: (restoreFocus?: boolean) => void;
  menuRef: RefObject<HTMLDivElement | null>;
  firstItemRef: RefObject<HTMLButtonElement | null>;
} {
  const [open, setOpen] = useState<{ id: string; position: MenuPosition } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback((restoreFocus = true) => {
    if (restoreFocus) triggerRef.current?.focus();
    triggerRef.current = null;
    setOpen(null);
  }, []);

  const toggle = useCallback((id: string, trigger: HTMLElement) => {
    setOpen((current) => {
      if (current?.id === id) {
        triggerRef.current = null;
        return null;
      }
      triggerRef.current = trigger;
      return { id, position: anchorMenuTo(trigger) };
    });
  }, []);

  // Move focus into the panel when it opens, matching the sidebar's menus.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => firstItemRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // The panel is portaled to the body, so it is not a DOM descendant of
      // the trigger; both have to be excluded explicitly.
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close]);

  return {
    openId: open?.id ?? null,
    position: open?.position ?? null,
    toggle,
    close,
    menuRef,
    firstItemRef,
  };
}

/** Mounted only while open, so a project is probed on demand and not per render. */
function ProjectWorkspaceCreateMenu({
  projectPath,
  projectName,
  position,
  menuRef,
  firstItemRef,
  onClose,
}: {
  projectPath: string;
  projectName: string;
  position: MenuPosition;
  menuRef: RefObject<HTMLDivElement | null>;
  firstItemRef: RefObject<HTMLButtonElement | null>;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const { t } = useTranslation();
  const items = useProjectWorkspaceCreateMenuItems({
    projectPath,
    projectName,
    onDone: () => onClose(false),
  });
  return portalToBody(
    <SidebarMenuPanel
      menuRef={menuRef}
      firstItemRef={firstItemRef}
      className="sidebar-section-menu"
      position={position}
      onKeyDown={(event) => sidebarMenuKeyDown(event, onClose)}
      content={{
        label: t("projectWorkspace.createActions", { name: projectName }),
        items,
      }}
    />,
  );
}

/**
 * Second half of a project row's "+": the plain button still creates a
 * project-root session, this caret offers "New workspace…".
 */
export function ProjectWorkspaceCreateAction({
  projectPath,
  projectName,
}: {
  projectPath: string;
  projectName: string;
}) {
  const { t } = useTranslation();
  const menu = useAnchoredMenu();
  const open = menu.openId === projectPath;
  const label = t("projectWorkspace.createActions", { name: projectName });
  return (
    <>
      <TooltipButton
        type="button"
        className="thread-item-more"
        tooltip={label}
        ariaLabel={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-action="project-workspace-create-menu"
        onClick={(event) => {
          event.stopPropagation();
          menu.toggle(projectPath, event.currentTarget);
        }}
      >
        <IconChevronDown size={12} />
      </TooltipButton>
      {open && menu.position ? (
        <ProjectWorkspaceCreateMenu
          projectPath={projectPath}
          projectName={projectName}
          position={menu.position}
          menuRef={menu.menuRef}
          firstItemRef={menu.firstItemRef}
          onClose={menu.close}
        />
      ) : null}
    </>
  );
}

/** Delete / Repair / Remove / Reveal / Setup log for the open workspace node. */
function ProjectWorkspaceNodeMenu({
  workspace,
  position,
  menuRef,
  firstItemRef,
  onClose,
}: {
  workspace: ProjectWorkspaceSummary;
  position: MenuPosition;
  menuRef: RefObject<HTMLDivElement | null>;
  firstItemRef: RefObject<HTMLButtonElement | null>;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const { t } = useTranslation();
  const items = useProjectWorkspaceNodeMenuItems({
    workspace,
    onDone: () => onClose(false),
  });
  return portalToBody(
    <SidebarMenuPanel
      menuRef={menuRef}
      firstItemRef={firstItemRef}
      className="sidebar-row-menu"
      position={position}
      onKeyDown={(event) => sidebarMenuKeyDown(event, onClose)}
      content={{
        label: t("projectWorkspace.nodeActions", { name: workspace.name }),
        items,
      }}
    />,
  );
}

/** The workspace sub-folder nodes of one project, each with its own sessions. */
export function ProjectWorkspaceNodes({
  workspaces,
  sessionsByWorkspace,
  renderSessions,
}: {
  workspaces: readonly ProjectWorkspaceSummary[];
  sessionsByWorkspace: Record<string, SessionSummary[]>;
  renderSessions: (sessions: SessionSummary[]) => ReactNode;
}) {
  const menu = useAnchoredMenu();
  const openWorkspace = workspaces.find((candidate) => candidate.id === menu.openId);
  return (
    <>
      {workspaces.map((workspace) => (
        <ProjectWorkspaceNode
          key={workspace.id}
          workspace={workspace}
          sessions={sessionsByWorkspace[workspace.id] ?? []}
          menuOpen={menu.openId === workspace.id}
          onOpenMenu={menu.toggle}
          renderSessions={renderSessions}
        />
      ))}
      {openWorkspace && menu.position ? (
        <ProjectWorkspaceNodeMenu
          workspace={openWorkspace}
          position={menu.position}
          menuRef={menu.menuRef}
          firstItemRef={menu.firstItemRef}
          onClose={menu.close}
        />
      ) : null}
    </>
  );
}

/** One project's workspace nodes and the session split between them. */
export type ProjectWorkspaceSidebarGroup = {
  workspaces: ProjectWorkspaceSummary[];
  /** Sessions that live at the project root, i.e. without a `workspaceId`. */
  projectSessions: SessionSummary[];
  sessionsByWorkspace: Record<string, SessionSummary[]>;
};

/**
 * Reads the workspace rows of every visible project once and returns the
 * splitter the sidebar calls per project row. The store de-duplicates
 * concurrent and repeated reads, so this does not refetch on every render.
 */
export function useProjectWorkspaceSidebarData(
  projectPaths: readonly string[],
): (projectPath: string, sessions: readonly SessionSummary[]) => ProjectWorkspaceSidebarGroup {
  const byProject = useProjectWorkspaceStore((state) => state.byProject);
  const load = useProjectWorkspaceStore((state) => state.load);
  // Keyed by the joined paths so adding or removing a project reloads, while
  // re-rendering the same list does not.
  const pathKey = projectPaths.join("\u0000");
  useEffect(() => {
    for (const path of pathKey ? pathKey.split("\u0000") : []) void load(path);
  }, [pathKey, load]);

  return useCallback(
    (projectPath, sessions) => {
      const key = normalizeProjectPath(projectPath);
      const workspaces = (key ? byProject[key] : undefined) ?? [];
      const { projectSessions, byWorkspace } = groupSessionsByWorkspace(
        sessions,
        workspaces.map((workspace) => workspace.id),
      );
      return { workspaces, projectSessions, sessionsByWorkspace: byWorkspace };
    },
    [byProject],
  );
}
