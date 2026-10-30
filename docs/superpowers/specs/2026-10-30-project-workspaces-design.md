# Project Workspaces: named in-project git worktrees

## Status and scope

- Status: Proposed. Design only; no code is changed by this document.
- Date: 2026-10-30.
- Branch: `docs/project-workspaces-design` in worktree
  `worktrees/docs-project-workspaces`.
- Inspected baseline: `0eed9fe10` (`origin/main` and local `main` were
  identical at intake).
- Deliverable: problem statement, current-behavior evidence, the chosen
  design, risks, implementation impact, and acceptance tests.
- Related: ADR 0329 (session worktree isolation), ADR 0338 (team nested
  worktrees), ADR 0016 (sidebar organization), ADR 0037 / 0044 (project
  instruction chain), `docs/spec/03-runtime/15-workspace-ignore-rules.md`.
- Method: three read-only exploration passes (host-core, Electron main +
  shared contracts, renderer) plus throwaway git repositories outside the
  project. Every git behavior quoted in §5 was executed, not assumed.

## 1. Problem

The sidebar project row has one "+" action, and it always creates a session
whose working directory is the project folder. Users who want to run parallel
work on another branch must either use the per-session isolated worktree
(ADR 0329, machine-named, one per session, stored outside the project) or
manage `git worktree` themselves.

Requested behavior:

1. "+" still creates a session in the project folder by default, and offers a
   second action, **New workspace**.
2. A workspace is created at `<project>/.pi/worktree/<name>`, with the name
   typed by the user.
3. The create dialog selects a **remote branch**, has a refresh button next
   to it, and a **Create new branch** checkbox. Checking it reveals a required
   **branch name** field. Create then materializes the selected remote branch;
   with the checkbox it creates the new branch from that source branch.
4. The workspace appears under the project like a sub-folder node. It has its
   own session list and its own "create session" action.
5. Sessions created inside a workspace run with the workspace as their
   working directory. Sessions created on the project keep the project root.

## 2. Current behavior

| Layer | Behavior today | Evidence |
| --- | --- | --- |
| Sidebar "+" | Direct action, no menu: `createProjectSession(entry.path)` | `apps/desktop/src/components/Sidebar.tsx:2436`, `:2441`, `:1579` |
| Sidebar tree | `ProjectEntry` is flat (`sessions` only); session→project grouping is normalized-path equality | `Sidebar.tsx:131`, `apps/desktop/src/lib/sidebar-session-groups.ts:19` |
| Isolated opt-in | Only in the project menu's Git submenu, disabled via `probeWorktree` | `apps/desktop/src/features/worktree/WorktreeSidebarParts.tsx:72`, `:109` |
| Create contract | `CreateSessionInput = Partial<SessionSummary> & { isolated?: boolean }`; main forwards input verbatim to `session.create`; host reads `isolated` and requires `projectPath` | `apps/desktop/src/lib/api.ts:388`, `apps/desktop/electron/main/ipc/session-ipc.ts:232`, `crates/host-core/src/rpc/mod.rs:2658` |
| Tool root | `resolve_tool_workspace` asks `lifecycle::tool_root` first, then `project_path`, then scratch. An isolated session never falls back to the main checkout | `crates/host-core/src/rpc/mod.rs:1350`, `crates/host-core/src/session_worktrees/lifecycle.rs:136` |
| Registry | `worktrees` is one row per `(session_id, delegation_id)`; `path` is UNIQUE; orphan selection is `session_id IS NULL` | `crates/host-core/src/db/worktree_migration.rs:14`, `crates/host-core/src/session_worktrees/registry.rs:233` |
| Worktree location | `<data_dir>/worktrees/<project-key>/<short-id>`, branch `pi-harbor/<short-id>`, base = project branch tip; `git worktree lock`, `.worktreeinclude`, setup command, `PI_PORT` | `lifecycle.rs:289`, `:301`, `:312`, `:336`, `:349` |
| Relocation | Data-dir relocation rewrites `worktrees.path`, assuming every worktree lives under the data dir | `crates/host-core/src/data_relocation.rs:347` |
| Git capability | No `git fetch`, no branch enumeration, no remote default-branch read, no `check-ref-format` anywhere in host-core | repo-wide grep of `crates/host-core` |
| Git runner | Hooks off, `core.fsmonitor=false`, `safe.bareRepository=explicit`, `GIT_TERMINAL_PROMPT=0`, login-shell PATH, 120 s timeout | `crates/host-core/src/session_worktrees/git.rs:204`, `:216`, `:25` |
| Instruction chain | Walks up from the target directory and stops at the session root; the parent checkout's `AGENTS.md` is not read for a worktree session | `packages/agent-runtime/src/project-instructions.ts:129` |
| Tool ignore | `DEFAULT_IGNORE_DIRS` has no `.pi`; walker uses `git_ignore(true)`; file tree and plugin glob have their own hard-coded sets | `crates/host-core/src/tools/ignore_rules.rs:32`, `crates/host-core/src/tools/mod.rs:1959`, `packages/host-runtime/src/workspace-files.ts:12`, `apps/desktop/electron/main/plugin-runtime.ts:813` |
| File index | `git ls-files -co --exclude-standard` with a manual-walk fallback | `packages/host-runtime/src/fs-index.ts:54` |
| Root consumers in main | Four call sites branch on `session.worktree` and call `worktree.location` | `apps/desktop/electron/main/runtime/session-launch.ts:311`, `runtime/sidecar.ts:375`, `ipc/workspace-ipc.ts:798`, `services/plugin-services.ts:685` |
| Naming | `ProjectWorkspace` already means the active project; `settings.groupWorkspace` is "Workspace" / "工作区"; the work panel browser is "工作区浏览器" | `packages/shared/src/types/workspace.ts:24`, `packages/i18n/src/locales/zh-CN/index.ts:1031`, `:1554` |

## 3. Goals and non-goals

Goals:

1. Named, user-visible, project-scoped workspaces at `.pi/worktree/<name>`,
   created from a chosen remote branch, optionally on a new branch.
2. A workspace is a durable sidebar node that owns many sessions; a session's
   root is derived from its workspace binding, never from a client-sent path.
3. Project-level behavior is unchanged when no workspace exists.
4. Workspaces do not pollute the parent checkout's `git status`, file index,
   file tree, or unscoped tool walks.
5. Project identity (memory, skills, plugins, MCP, subagent catalog, group
   context) stays keyed by the project path, exactly as in ADR 0329.

Non-goals (v1):

- No merge/sync/behind workflow for workspaces. A workspace is a normal
  checkout: the user and the agent commit, push, and pull with git.
- No nesting: a workspace session cannot also be an isolated session.
- No detached-HEAD workspaces, no local-branch sources, no remote projects.
- No automatic editing of the user's build/test configuration.
- No moving an existing session between the project and a workspace.

## 4. Chosen design

### 4.1 Terminology

- User-visible: **Workspace** / **工作区** for the new node; the existing
  isolated-session feature keeps "Isolated session".
- Code identifiers: `ProjectWorkspace*` types, `project_workspaces` table,
  `projectWorkspace.*` host RPC, `projectWorkspace/*` IPC, renderer feature
  folder `features/project-workspace/`. Do not reuse `workspace.*` (active
  project) or `worktree.*` (ADR 0329 session worktrees).
- Internal comment convention: "workspace" alone never means this feature in
  shared code; always `projectWorkspace` / `project_workspace`.

### 4.2 On-disk layout and git rules

```
<project>/.pi/worktree/<name>/     # one linked worktree per workspace
```

This is the requested layout. §5 shows the objections recorded in ADR 0329
are only partly true today: `tsc`'s default include and ripgrep's default walk
do not enter dot-directories, and one anchored `.git/info/exclude` rule removes
the nested checkouts from `git status`, `git ls-files`, and ripgrep. Vitest
discovery and `git clean -ffdx` remain real hazards and are handled in §6.

`<name>` is the user-typed name, validated as a single safe path segment:
1–64 chars, no `/`, `\`, `..`, control characters, no leading `.`, no Windows
reserved names, and NFC-normalized. It is not slugified; what the user types
is what appears on disk. `check-ref-format` is applied to branch names only.

host-core maintains a managed block in the repository's **common** git dir
(shared by all linked worktrees), never in the user's tracked `.gitignore`:

```
# >>> pi-desktop workspaces
/.pi/worktree/
# <<< pi-desktop workspaces
```

For a project that is a repository sub-directory, the rule is anchored at the
repo-relative prefix: `/<prefix>/.pi/worktree/`. The block is written before
`git worktree add` (so no intermediate state is visible to `git status`), is
idempotent, and is removed only when the last workspace of that prefix is
deleted. This one rule covers `git status`, `git ls-files --exclude-standard`,
and ripgrep, and it does not hide anything inside the workspace itself (§5).

Every workspace is locked immediately after creation:
`git worktree lock --reason "PI-Desktop workspace <name>"`, so
`git worktree prune` cannot discard it.

Branch/checkout cases (`<src>` = `<remote>/<sourceBranch>`):

| Case | Condition | Command |
| --- | --- | --- |
| New branch | `createBranch = true` | `git worktree add -q --no-track -b <newBranch> <path> <src>` |
| Existing branch | local branch absent | `git worktree add -q --track -b <sourceBranch> <path> <src>` |
| Existing branch | local branch exists, not checked out | `git worktree add -q <path> <sourceBranch>` |
| Existing branch | branch checked out anywhere (including the main checkout) | fail `WORKSPACE_BRANCH_IN_USE` |

`--no-track` for new branches is deliberate: with default tracking the new
branch's upstream becomes the *source* remote branch, and `git push` then
fails with "upstream branch … does not match the name of your current branch"
(§5). A new workspace branch starts with no upstream; the user publishes it
with `git push -u`. When `createBranch = true` and a local branch of that
name already exists, creation fails with `WORKSPACE_BRANCH_EXISTS` before any
directory is created. That is a different case from row 3 above, where the
*source* branch already exists locally and is reused as-is.

### 4.3 Creation flow (host-core, new `project_workspaces` module)

1. `ensure_local_project` + existing `probe` (git ≥ 2.29, non-bare, has
   commits), reusing `WORKTREE_*` probe error codes.
2. Validate the name (§4.2), the source branch, and the new branch name with
   `git check-ref-format --branch` (new validation; none exists today).
3. Resolve the source to `refs/remotes/<remote>/<sourceBranch>` and record
   its commit. If the dialog fetched, the fetch has already refreshed it;
   otherwise the cached remote-tracking ref is used and reported as such.
4. Take `repo_lock::lock(common_dir)`; re-check name, path, and branch
   availability inside the lock.
5. Write/repair the `info/exclude` block; insert the registry row with status
   `creating`; allocate a `PI_PORT` block.
6. Run the `git worktree add` variant from §4.2, then `git worktree lock`.
7. Copy `.worktreeinclude` and run the project's setup command with
   `PI_PROJECT_ROOT`, `PI_WORKTREE_ROOT`, `PI_PORT`, reusing the existing
   include/setup implementation and its timeout and log caps.
8. Mark `active`. On any failure, remove the directory link-safely, delete
   the branch **only if this call created it**, and drop the row; if cleanup
   itself fails, the `creating` row is left for startup reconciliation.

The port allocator is extracted into a helper shared by `worktrees` and
`project_workspaces`, keeping cross-table uniqueness by querying both tables
plus the existing liveness probe.

### 4.4 Persistence (schema v27 → v28)

New table, new migration module following the `worktree_migration.rs`
pattern (shared DDL const, backup, `user_version`, arm in
`db/repositories.rs`, fresh-schema path, migration tests):

```sql
CREATE TABLE project_workspaces (
  id             TEXT PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  path           TEXT NOT NULL UNIQUE,       -- <project>/.pi/worktree/<name>
  common_dir     TEXT NOT NULL,
  prefix         TEXT NOT NULL DEFAULT '',
  branch         TEXT NOT NULL,
  source_remote  TEXT NOT NULL,
  source_branch  TEXT NOT NULL,
  base_commit    TEXT NOT NULL,
  created_branch INTEGER NOT NULL DEFAULT 0, -- delete the branch only if we made it
  status         TEXT NOT NULL CHECK (status IN ('creating','active','missing')),
  setup_status   TEXT CHECK (setup_status IS NULL
                        OR setup_status IN ('none','running','ok','failed')),
  setup_log      TEXT,
  port_base      INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (project_id, name)
);
ALTER TABLE sessions ADD COLUMN workspace_id TEXT
  REFERENCES project_workspaces(id) ON DELETE SET NULL;
CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
```

Consequences:

- The `worktrees` table and its orphan pass are untouched; a workspace can
  never become an orphan of that pass.
- `data_relocation.rs` keeps rewriting only `worktrees.path`. Workspace paths
  are project-relative and are instead repaired on project move (§4.11).
- `sessions.workspace_id` is nullable; existing rows and existing
  `session.create` callers are unaffected.

### 4.5 Session binding and tool root

`session.create` gains an optional `workspaceId`. `workspaceId` together with
`isolated: true` is `INVALID_PARAMS`. A workspace session stores the project
in `project_id` exactly as before, plus `workspace_id`.

`resolve_tool_workspace` order becomes:

1. isolated session worktree (`lifecycle::tool_root`) — unchanged;
2. workspace binding → `<workspace path>/<prefix>`;
3. project path;
4. scratch.

Workspace states mirror the isolated contract: `creating` →
`WORKSPACE_NOT_READY`, `missing` → `WORKSPACE_MISSING`, and a workspace
session never falls back to the project root or to the main checkout. The
containment rule is unchanged in mechanism: the workspace is the session's
root, so the parent checkout is an external path for that session and follows
the existing outside-workspace permission flow. The reverse direction is
intentionally different from ADR 0329: for a *project* session the workspaces
are inside its root, so explicit paths into them are allowed (they are hidden
from unscoped walks instead, §4.10). This matches the "sub-folder" mental
model and is called out in §6.

`SessionSummary` gains `workspace?: { id, name, branch, status }` (no path),
populated in the same list/single-summary passes that attach worktree badges
(`crates/host-core/src/sessions.rs:1327`, `:1348`, `:1531`).
`session.update` refuses to change the project or workspace of a bound
session (`WORKSPACE_MOVE_UNSUPPORTED`).

### 4.6 RPC and IPC surface

New host methods (new dispatch arm next to `rpc/mod.rs:3948`), new IPC
channels registered in `packages/shared/src/protocol.ts` beside the existing
`worktree/*` block (`:148`), and thin forwarding handlers like
`worktree-ipc.ts`. Preload needs no change (channel whitelist only).

| Method | Purpose |
| --- | --- |
| `projectWorkspace.probe({projectPath})` | Eligibility + configured remotes |
| `projectWorkspace.branches({projectPath, remote?, refresh?})` | Remote branch list; `refresh: true` runs `git fetch <remote> --prune` first. Returns `{branches, defaultRemote, defaultBranch, fetchedAt, stale}` |
| `projectWorkspace.create({projectPath, name, remote, sourceBranch, createBranch, newBranch?})` | §4.3; returns the summary + include/setup report |
| `projectWorkspace.list({projectPath})` | Sidebar nodes |
| `projectWorkspace.pendingWork({workspaceId})` | Uncommitted changes, unpushed commits, session count — for the delete dialog |
| `projectWorkspace.remove({workspaceId, deleteBranch})` | §4.11 |
| `projectWorkspace.setupLog({workspaceId})` | Same contract as the worktree setup log |
| `projectWorkspace.reveal({workspaceId})` | Opens the folder in the OS file manager |
| `projectWorkspace.location({sessionId})` | **Main-process only**: the session's workspace root, mirroring `worktree.location` |

Branch listing uses `git for-each-ref refs/remotes/<remote>` (offline, no
network); the default branch comes from
`git symbolic-ref refs/remotes/<remote>/HEAD`. Fetch is the only new network
operation: it inherits the user's environment (SSH agent, credential helper),
keeps `GIT_TERMINAL_PROMPT=0`, and gets an explicit timeout and a
`WORKSPACE_FETCH_FAILED` error instead of hanging. No credentials are stored
or logged. No renderer-facing method returns an absolute path.

New error codes are `WORKSPACE_*` (`NAME_INVALID`, `NAME_TAKEN`,
`BRANCH_INVALID`, `BRANCH_EXISTS`, `BRANCH_IN_USE`,
`SOURCE_BRANCH_NOT_FOUND`, `FETCH_FAILED`, `NOT_FOUND`, `NOT_READY`,
`MISSING`, `BUSY`, `MOVE_UNSUPPORTED`, `HAS_RUNNING_SESSIONS`,
`PATH_EXISTS`, `IO`); git/probe failures reuse the existing `WORKTREE_GIT_*`
family so the renderer's error mapping stays small.

### 4.7 Electron main

Main stays a thin orchestrator and never builds a workspace path itself.
The four `session.worktree` call sites (§2) gain a sibling branch: when
`session.workspace` is present, resolve the root through
`projectWorkspace.location`. Concretely:

- `runtime/session-launch.ts`: the root resolver returns isolated root →
  workspace root → project path; `projectPath` keeps its ADR 0329 meaning for
  project identity. Failure to resolve fails the launch (no silent fallback).
- `runtime/sidecar.ts`: registers the same root for the instruction preflight.
- `ipc/workspace-ipc.ts`: `workspaceRootInfo` returns the workspace root and
  treats the project path as the rebase parent, so chat `@`-references resolve
  inside the workspace exactly as they do for isolated sessions.
- `services/plugin-services.ts`: plugin workspace containment uses the same
  resolved root.

### 4.8 Renderer

New feature folder `apps/desktop/src/features/project-workspace/` (components,
a small local store, an actions module), following the `features/worktree/`
pattern. `Sidebar.tsx` (2898 LOC) only receives composition points; the tree
node, menu items, and dialogs live in the feature folder. The central store is
not extended with workflow logic.

- **Entry point**: "+" keeps its one-click create-session behavior; an
  adjacent chevron opens **New session** and **New workspace…**. Turning "+"
  itself into a menu was rejected because it adds a click to the existing
  default action. The **New workspace…** item is disabled with the probe
  reason for non-git, commit-less, or remote projects.
- **Create dialog** (built on `WorktreeDialogFrame`):
  - *Name* — required, validated inline, with a read-only path preview
    `.pi/worktree/<name>`.
  - *Remote* — shown only when more than one remote exists; defaults to
    `origin`.
  - *Source branch* — a feature-local searchable combobox (`BranchPicker`,
    `role="combobox"`/`listbox`, `aria-activedescendant`, keyboard navigation,
    modelled on `SearchDialog`). There is no shared searchable-select
    primitive today, so this stays feature-local rather than adding a
    premature `ui.tsx` primitive.
  - *Refresh button* beside the branch field — triggers `refresh: true`;
    shows a spinner while fetching and a non-blocking warning when the list
    is stale.
  - *Create new branch* checkbox — reveals *Branch name*, required, validated
    with the same rules as git, prefilled with the workspace name.
  - Create is disabled while invalid; while creating, the dialog is `busy`
    (Esc/backdrop disabled) and failures render inline with `role="alert"`.
- **Tree**: `ProjectEntry` gains `workspaces: ProjectWorkspaceEntry[]`, each
  with its own sessions and its own "+" (create session in this workspace).
  Grouping key becomes `projectPath + workspaceId`; project-level rows only
  contain sessions with no `workspaceId`. Collapse state is stored per
  workspace id in the existing sidebar-preferences blob, not per path, so it
  survives a project move.
- **Session scoping**: `newSessionScopeKey`, `latestSessionInScope`,
  `sessionIsReusableEmpty`, and the draft-session materialization path all
  take the workspace into account, so an empty project session is never
  reused for a workspace request and vice versa
  (`apps/desktop/src/stores/slices/session-slice.ts:656`,
  `stores/runtime/session-runtime.ts:405`,
  `stores/runtime/session-coordination.ts:348`,
  `apps/desktop/src/lib/session-create.ts:18`). Mod+N inherits the active
  session's workspace; the project "+" always means no workspace.
- **Labels**: workspace sessions show `Project / Workspace` in the
  conversation topbar and window title; the sidebar node shows the branch and
  the `creating` / `missing` / `setup failed` states.
- **i18n**: a new `projectWorkspace.*` namespace in all nine locales, plus the
  menu/topbar strings. Do not reuse `settings.groupWorkspace` ("工作区") or
  the work-panel "工作区浏览器" keys.

### 4.9 Project identity and `.pi` ownership

Unchanged from ADR 0329: `projectPath` remains the project root, so memory,
skills, plugins, MCP scope, subagent catalog, and group context are shared by
the project and all its workspaces.

| Surface | Resolution for a workspace session |
| --- | --- |
| Tool root, Bash cwd, file tools, Grep/Glob | workspace (+prefix) |
| `AGENTS.md` / `CLAUDE.md` chain | workspace copy from its branch, stopping at the workspace root; the parent checkout's edits are not inherited. Global `~/.pi/agent/AGENTS.md` still applies |
| `.pi/prompts` (composer `/` templates) | **project path, not the session root.** The loader is called with `optionalWorkspaceRoot()` (`apps/desktop/electron/main/ipc/register.ts:241` → host `workspace.get`), which is the active project and ignores the session. Unchanged for workspaces; isolated sessions already behave this way |
| `.pi/extensions`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md` | project path. `customSystemPromptDirs` names its parameter `workspaceRoot`, but the call site passes `localInstructionRoot = projectPath` (`runtime/session-launch.ts:453`, `:471`) |
| `.pi/plan`, `.pi/goal` artifacts | **project path, not the workspace.** Plan/Goal use their own resolver — `resolve_plan_workspace` → `resolve_persisted_project_workspace` (`crates/host-core/src/rpc/mod.rs:1510`, `:1321`) — which returns `sessions.project_path` and never consults a worktree |
| MCP servers, plugin services | project-scoped, as today |

No loader scans `.pi/**` recursively today (extensions and prompts are
single-level, Plan artifacts are fixed-kind), so `.pi/worktree/` does not
collide with existing `.pi` consumers. The artifact path guard
(`crates/host-core/src/plans/artifact.rs:155`) is unaffected because it pins
the second component to the artifact kind.

Two rows above are easy to assume wrongly and are therefore called out: a
workspace session's Plan/Goal artifacts and its composer `/` templates both
resolve from the **project**, not from the workspace. Neither is a regression
— ADR 0329 isolated sessions already behave this way — and the Plan artifact
write is host-internal (`publish_artifact`), not a Write-tool call, so it is
not subject to the session's tool containment. Whether a workspace should own
its own Plan artifacts is left open (§10).

### 4.10 Ignore and containment rules

One rule set, implemented at each existing layer:

- **git**: managed `info/exclude` block (§4.2).
- **host-core tool walks**: skip `.pi/worktree` by *path*, not by directory
  name, in unscoped Glob/Grep and in the walker used from a project root;
  `DEFAULT_IGNORE_DIRS` is not given a bare `worktree` or `.pi` entry, which
  would hide unrelated user directories. Scoped walks inside a workspace are
  unaffected.
- **file index / file tree**: the `git ls-files` path is already covered by
  `info/exclude`; the manual-walk fallback and the file-tree ignore set
  (`packages/host-runtime/src/workspace-files.ts:12`) skip `.pi/worktree`
  explicitly.
- **plugin glob**: `GLOB_SKIP_DIRS` in
  `apps/desktop/electron/main/plugin-runtime.ts:813` is
  `{.git, node_modules, .venv, __pycache__}` and is matched by directory name
  during the recursive scope walks at `:6043` and `:6117`, so a plugin
  globbing the project root would descend into `.pi/worktree`. The same
  path-aware skip is needed there. `packages/plugin-devkit/src/walk.ts` is out
  of scope: its `IGNORED_DIR_NAMES` walks a plugin package being built, never
  a project tree.

### 4.11 Lifecycle

- **Startup reconciliation** for `project_workspaces`: `creating` rows are
  rolled back; a non-directory or link-replaced root becomes `missing`;
  otherwise `git worktree repair <path>` runs under the repo lock.
- **Project move/rename**: a stored `path` that no longer matches the
  project's current location is recomputed from the project path + prefix +
  name, then `git worktree repair <recomputed paths…>` re-links both
  directions. Passing the paths is mandatory: a bare `git worktree repair`
  from the moved parent exits 0 and repairs nothing, because the registered
  gitdir still points at the old location (§5). Sessions keep working because
  their root is derived, not stored.
- **Missing directory**: the node shows "Folder missing"; its sessions fail
  with `WORKSPACE_MISSING` instead of silently using the project root, and the
  node menu offers **Repair** (re-add from the recorded branch/commit when the
  branch still exists) and **Remove from list**.
- **Delete workspace**: blocked while any of its sessions is running
  (`WORKSPACE_HAS_RUNNING_SESSIONS`); the confirmation shows the
  `pendingWork` summary and states that the workspace's sessions and their
  transcripts are deleted. Deletion removes the directory link-safely, deletes
  the local branch only when `deleteBranch` is checked (default off), deletes
  the sessions then the row, and prunes the `info/exclude` block when it was
  the last workspace. A locked worktree whose folder vanished is removed with
  `git worktree remove --force --force` semantics (§5), and branch deletion
  goes through the common git dir as in `remove.rs`.
- **Delete project**: unchanged user contract — sessions and transcripts are
  removed, the on-disk folder is kept. Workspace rows cascade with the project
  row; the `.pi/worktree/` directories stay on disk and are re-discoverable by
  re-adding the project (re-import scans `.pi/worktree/*` and matches them to
  registered worktrees).
- **Isolated sessions and team delegates**: `workspaceId` and `isolated` are
  mutually exclusive (§4.5). Delegate worktrees must keep their data-dir
  placement; `delegate.rs` currently derives a delegate path from the session
  worktree's parent directory, so the implementation must assert that no
  delegate worktree can be created inside `.pi/worktree/`, and route
  workspace-session delegates through the non-isolated path.

## 5. Verified behavior behind the design

All runs used throwaway repositories with global git config isolated; nothing
in the project was touched. git 2.54.0, tsc 5.9.3, vitest 4.1.11, rg 15.2.0.

| Experiment | Result |
| --- | --- |
| `git worktree add` into `.pi/worktree/<name>` with no ignore rule | Works; parent `git status` shows `?? .pi/`; `git add -A` would add the nested checkout as a gitlink (`160000`) with an "embedded git repository" warning |
| Anchored `/.pi/worktree/` in `.git/info/exclude` | `git status` clean, `git ls-files -co --exclude-standard` excludes it, `rg --files --hidden` excludes it; the rule is visible from linked worktrees because they share the common dir |
| Sub-directory project | A root-anchored rule is not enough; the rule must be `/<prefix>/.pi/worktree/` |
| `rg --files` without `--hidden` | Never descends into `.pi` at all |
| `tsc` default include (`**/*`) | Does **not** include `.pi/worktree/**`; only an explicit `.pi/**/*` include does |
| `vitest list` default discovery | **Does** discover `.pi/worktree/<name>/src/*.test.ts`; an explicit `exclude: ["**/.pi/worktree/**"]` removes them |
| `git clean -fdx` (single `-f`) | Prints `Skipping repository .pi/worktree/<name>`; the checkout survives |
| `git clean -ffdx` (double `-f`) | **Deletes the whole `.pi` tree including workspace checkouts**; the branch survives and the worktree is reported prunable |
| `git stash push -u` in the parent | Prints `Ignoring path .pi/worktree/<name>/`; the workspace stays a valid checkout with its files intact |
| Node module resolution from inside a workspace without its own `node_modules` | Resolves the parent checkout's `node_modules` |
| `git worktree lock`, then `git worktree prune` after the folder was moved away | The locked entry survives prune; an unlocked one is removed (`Removing …: gitdir file points to non-existent location`) |
| `git worktree remove` and `remove --force` on a locked, missing worktree | Both refused: `cannot remove a locked working tree, lock reason: … use 'remove -f -f' to override`. `--force --force` removes the entry and keeps the branch |
| Moving the project folder | Workspace `git status` fails with `not a git repository` and the entries are listed `prunable`; a bare `git worktree repair` exits 0 and fixes nothing; `git worktree repair <explicit paths>` from the new location restores every checkout |
| `git worktree add -b <new> <path> <remote>/<branch>` (default tracking) | Upstream becomes the source remote branch and `git push` fails with the upstream-name mismatch; `--no-track` yields no upstream |
| Reusing a branch already checked out | `fatal: '<branch>' is already used by worktree at …` |
| `git check-ref-format --branch` | Accepts `feat/ok`, rejects spaces, `..`, leading `-`, `*.lock`, `HEAD`, `~` |
| Branch enumeration | `for-each-ref refs/remotes/origin` lists remote branches offline; `origin/HEAD` must be filtered out |

## 6. Risks and mitigations

| Risk | Severity | Mitigation |
| --- | --- | --- |
| `git clean -ffdx` in the parent deletes workspace checkouts | **High — data loss** | Lock every workspace (prune-safe); document the hazard in the workspace menu and user docs; `missing` state + Repair flow; never run `clean` from host-core. Uncommitted work inside a workspace cannot be protected from a user-run `git clean -ffdx`; this is the accepted cost of the requested layout |
| Test runners (vitest verified) discover duplicate tests under `.pi/worktree` | Medium | Ship a documented exclude snippet; setup-command hint; do not silently edit user config. `tsc` and ripgrep defaults are safe (§5) |
| Watchers / monorepo globs may still traverse `.pi/worktree` | Medium | Same documentation; keep workspaces out of the app's own file tree and index so the app never adds watchers there |
| Dependency resolution leaks into the parent `node_modules` | Medium | Reuse the setup command (e.g. `pnpm install`) and `.worktreeinclude`; document that each workspace needs its own install for correct isolation |
| Project-root sessions can edit workspace files without an outside-path prompt | Medium | Deliberate (sub-folder semantics); hidden from unscoped walks; documented as different from isolated sessions |
| Multiple checkouts multiply disk usage and `node_modules` | Low | Expected for worktrees; no action |
| Windows long paths / junctions | Medium | Reuse the link-safe removal and `core.longpaths` handling from ADR 0329; add the >260-char delete test |
| Naming collision with the existing "Workspace" vocabulary | Low | §4.1 naming rules; new i18n namespace |
| ADR 0329 lists in-project worktrees as rejected | Process | New ADR recording the §5 evidence and superseding that alternative for this feature; ADR 0329 itself remains valid for session isolation |

## 7. Implementation impact

| Area | Files |
| --- | --- |
| Schema | `crates/host-core/src/db.rs` (v28), new `db/project_workspace_migration.rs`, `db/repositories.rs` (arm + fresh schema), `db/schema.rs` (`sessions.workspace_id`), `db/tests.rs` |
| Host domain | new `crates/host-core/src/project_workspaces/` (create, branches, registry, lifecycle, errors), reusing `session_worktrees/{git,probe,include,remove,repo_lock}.rs` and the extracted port allocator |
| Host RPC | `rpc/mod.rs` (dispatch arm, `session.create`/`session.update`, `resolve_tool_workspace`), new `rpc/project_workspace_rpc.rs`, `sessions.rs` (summary attach) |
| Tool ignores | `tools/ignore_rules.rs`, `tools/mod.rs` walker |
| Shared contracts | `packages/shared/src/protocol.ts`, `types/sessions.ts`, new `types/project-workspace.ts`, `rpc-timeouts.ts` (fetch/create timeouts) |
| Main | new `ipc/project-workspace-ipc.ts`, `ipc/register.ts`, `runtime/session-launch.ts`, `runtime/sidecar.ts`, `ipc/workspace-ipc.ts`, `services/plugin-services.ts`, `plugin-runtime.ts` (glob skip) |
| Renderer | new `features/project-workspace/*`, `components/Sidebar.tsx` (composition only), `components/ConversationTopbar.tsx`, session-scoping helpers listed in §4.8 |
| Index/tree | `packages/host-runtime/src/fs-index.ts`, `workspace-files.ts` |
| i18n | `packages/i18n/src/locales/*/index.ts` (9 locales) |
| Docs on implementation | new ADR, `docs/spec/03-runtime/01-ipc-protocol.md`, `04-data-storage.md`, `06-host-rpc-protocol.md`, `08-error-codes.md`, `02-agent-runtime.md`, `03-tools-and-permissions.md`, `15-workspace-ignore-rules.md`, `docs/spec/04-ux/01-ui-ia.md`, `docs/spec/06-delivery/04-e2e-test-plan.md` (+ zh-CN mirrors) |

## 8. Tests

Host-core, against real temporary repositories with a `file://` origin:

- create with a new branch (upstream is unset, source commit matches),
  create tracking an existing remote branch, reuse of an existing local
  branch, refusal when the branch is checked out in the main checkout;
- name and branch-name validation, duplicate name, duplicate path,
  `check-ref-format` failures, rollback deleting only branches it created;
- `info/exclude` block: written before add, idempotent, prefix-anchored for
  sub-directory projects, pruned after the last delete, parent `git status`
  clean;
- branch listing offline, `origin/HEAD` filtered, `refresh` performing a
  fetch, fetch failure mapped to `WORKSPACE_FETCH_FAILED` without hanging;
- tool root resolution for project / workspace / isolated sessions,
  `WORKSPACE_NOT_READY`, `WORKSPACE_MISSING`, no fallback to the project root;
- startup reconciliation of `creating` rows, missing directories, project
  move + `git worktree repair`, locked-worktree prune safety;
- delete with and without branch deletion, running-session refusal, cascade
  of sessions, orphan pass leaving `project_workspaces` untouched;
- migration v27→v28 on a populated database, fresh-schema equivalence,
  downgrade-safe failure mode;
- link-safe removal on Windows junctions and the >260-character path case.

Contracts and main:

- `session.create` with `workspaceId`, with both `workspaceId` and `isolated`,
  and with neither (unchanged behavior);
- IPC channel registration, param validation, no path in renderer-facing
  payloads, `projectWorkspace.location` restricted to main;
- the four root consumers resolving the workspace root and rebasing chat
  references.

Renderer:

- "+" default action unchanged; chevron menu opens the dialog;
- full create-dialog user path: name validation, branch search, refresh,
  checkbox revealing the required branch field, submit, error display;
- tree grouping (project sessions vs workspace sessions), collapse
  persistence, per-workspace "+";
- empty-session reuse and Mod+N scoping across project and workspace;
- i18n catalog parity and renderer-key checks for all nine locales.

E2E: a new `scripts/e2e-project-workspace-live.mjs` in the style of
`e2e-worktree-live.mjs` — real host-core, real agent runtime, throwaway git
origin — covering create workspace → create session in it → the agent's files
land in the workspace while the parent checkout stays clean. Existing
worktree E2E must stay green.

## 9. Delivery phases

1. Host-core: schema, domain module, RPC, tool ignores, host tests.
2. Contracts + main: shared types, channels, root resolution, IPC tests.
3. Renderer: entry point, dialog, tree, scoping, i18n, component tests.
4. Lifecycle hardening (move/repair/delete), E2E, ADR + spec updates, docs.

Phases 1–2 are independently reviewable and leave the UI untouched; the
feature stays hidden until phase 3.

## 10. Decisions and open questions

Decided in this design (please confirm):

1. Layout is exactly `.pi/worktree/<name>`; exclusion lives in
   `.git/info/exclude`, not in the tracked `.gitignore`.
2. "+" becomes a split button; one-click create-session is preserved.
3. Without "Create new branch", the workspace checks out the selected branch
   itself; if that branch is already checked out (e.g. the project is on
   `main`), creation fails with a clear error instead of silently using a
   detached HEAD. The dialog should steer the user to "Create new branch" in
   that case.
4. New branches start with no upstream (`--no-track`).
5. Deleting a workspace deletes its sessions and transcripts, keeps the local
   branch by default, and refuses while sessions are running.
6. Workspaces get no merge/sync/behind machinery in v1; they are ordinary
   checkouts.
7. Workspace sessions cannot also be isolated sessions.
8. Internal naming uses `projectWorkspace` everywhere to avoid the existing
   "workspace" vocabulary.

Open questions:

1. Should deleting a workspace offer "keep the folder" (detach from the list
   only), or is delete-and-keep-branch enough?
2. Is re-importing orphaned `.pi/worktree/*` directories when a project is
   re-added required for v1, or can it be a manual "Add existing workspace"?
3. Do you want a per-project default source branch remembered for the next
   create dialog?
4. Should a workspace session's Plan/Goal artifacts follow the workspace
   instead of the project (§4.9)? Keeping the project root is the status quo
   and survives workspace deletion; following the workspace would need a
   second resolver and a migration story for existing artifacts.
