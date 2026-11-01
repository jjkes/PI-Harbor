# ADR 0340: Project workspaces are named git worktrees inside the project

- Status: Accepted
- Date: 2026-10-31
- Deciders: PI-Desktop maintainers
- Related: ADR 0329 (session worktree isolation), ADR 0338 (Team nested
  worktrees), ADR 0016 (sidebar organization), ADR 0037 / 0044 (project
  instruction chain),
  `docs/spec/03-runtime/15-workspace-ignore-rules.md`,
  `docs/superpowers/specs/2026-10-30-project-workspaces-design.md`
- Supersedes: the rejected "worktrees inside the project" alternative in
  ADR 0329 *for this feature only*. Per-session isolated worktrees keep their
  data-directory placement unchanged.

## Context

ADR 0329 isolates a *session* in a machine-named worktree under the data
directory. The user cannot name that checkout, cannot open it as a durable
place to work, and cannot group several sessions in it: the worktree is an
implementation detail of one session and disappears with it.

The requested unit is different. A user wants a named branch checkout that
belongs to the project, lives at a predictable path inside it, is visible in
the file manager and in other tools, and owns however many sessions the task
needs. That is a *project workspace*, not session isolation.

ADR 0329 rejected in-project worktrees on the grounds that test runners,
`tsc`, watchers, and `git clean -ffdx` would see or delete the copies. That
objection was re-tested rather than inherited, because the layout is what the
feature is for.

### Evidence (design §5)

Measured in throwaway repositories with global git configuration isolated;
git 2.54.0, tsc 5.9.3, vitest 4.1.11, rg 15.2.0.

| Claim | Measured result |
| --- | --- |
| `git status` sees the nested checkout | True without an ignore rule (`?? .pi/`); one anchored `/.pi/worktree/` line in the common git dir's `info/exclude` makes `git status`, `git ls-files -co --exclude-standard`, and `rg --files --hidden` all exclude it |
| A root-anchored rule is enough | False for a project that is a repository sub-directory; the rule must be `/<prefix>/.pi/worktree/` |
| `tsc` default `include: **/*` picks the copies up | False; only an explicit `.pi/**/*` include does |
| `rg --files` descends into `.pi` | False without `--hidden` |
| vitest default discovery picks the copies up | **True**; `exclude: ["**/.pi/worktree/**"]` removes them |
| `git clean -fdx` deletes the checkouts | False — prints `Skipping repository …` |
| `git clean -ffdx` deletes the checkouts | **True**; the whole `.pi` tree goes, the branch survives |
| `git stash push -u` in the parent disturbs them | False — prints `Ignoring path …` |
| `git worktree prune` discards a moved checkout | True when unlocked; a `git worktree lock`ed entry survives |
| A bare `git worktree repair` fixes a moved project | False — exits 0 and repairs nothing; the explicit paths must be passed |
| Default tracking is safe for a new branch | False; the upstream becomes the *source* remote branch and `git push` fails with the upstream-name mismatch. `--no-track` yields no upstream |
| Node resolves modules from inside a workspace | Resolves the **parent** checkout's `node_modules` when the workspace has none |

So three of ADR 0329's four objections do not hold with one anchored exclude
rule; vitest discovery and `git clean -ffdx` do, and are carried as accepted
risks below.

## Decision

### 1. In-project layout, host-owned

A workspace is a linked git worktree at `<project>/.pi/worktree/<name>`.
`<name>` is the user-typed name validated as one safe path segment (1–64
characters, NFC-normalized, no `/`, `\`, `..`, control characters, no leading
`.`, no leading/trailing space, no trailing `.`, none of `: * ? " < > |`, no
Windows reserved stem). It is not slugified: what the user types is what
appears on disk. Branch names are validated with `git check-ref-format
--branch`.

host-core owns every path and every git command. No `projectWorkspace.*`
method accepts a workspace path; callers name a project or a workspace id, and
every path in a result is produced by the host.

### 2. One anchored `info/exclude` rule per project prefix

host-core maintains a managed block in the repository's **common** git
directory, shared by every linked worktree, never in the user's tracked
`.gitignore`:

```
# >>> pi-desktop workspaces
/.pi/worktree/
# <<< pi-desktop workspaces
```

A project that is a repository sub-directory gets `/<prefix>/.pi/worktree/`.
The block is written **before** `git worktree add`, so the parent checkout
never sees the new directory as untracked; it is idempotent, preserves the
user's own `info/exclude` lines, and is removed only once no workspace row of
that prefix remains **and** nothing but dot-entries is left under
`<project>/.pi/worktree`. A folder kept by "remove from list" still holds a
checkout, so the rule outlives the row and `git add -A` in the parent cannot
stage it as an embedded repository.

### 3. Every workspace is locked

`git worktree lock --reason "PI-Desktop workspace <name>"` runs immediately
after creation, so `git worktree prune` cannot discard a workspace whose
folder was temporarily moved. Removal therefore needs
`git worktree remove --force --force` (the first `--force` overrides a dirty
tree, the second the lock).

### 4. No merge, sync, or behind machinery

A workspace is an ordinary checkout. There is no preview/merge, no "sync from
project", and no behind-count — the user integrates with git as they would in
any checkout. New branches are created with `--no-track` and start with no
upstream; the user publishes with `git push -u`. A branch already checked out
anywhere in the repository, including the main checkout, is refused with
`WORKSPACE_BRANCH_IN_USE`.

### 5. No nesting with isolated sessions

`workspaceId` and `isolated` are mutually exclusive on `session.create`
(`WORKSPACE_ISOLATED_CONFLICT`). Nesting a per-session worktree inside a
workspace would put a second checkout under a directory the workspace itself
owns. Delegate worktrees keep their data-directory placement:
`ensure_under_worktrees_dir` (`session_worktrees/delegate.rs:212`) asserts that
a delegate path resolves under `<data_dir>/worktrees/` and refuses anything
else with `WORKTREE_NOT_ISOLATED` before a directory is created, so a delegate
can never land beside a workspace inside `.pi/worktree/`.

That refusal, not a runtime check, is what routes a workspace session's
delegates to the non-isolated path. `delegateNeedsWorktree` fires for any
session that has a `workspaceRoot`, and a workspace session has one, so the
runtime still asks for a delegate worktree; a workspace session has no
`worktrees` row, so host-core refuses with the same code. On exactly
`WORKTREE_NOT_ISOLATED` the runtime runs the delegate in the session's own
root; any other error fails the subagent. A workspace session's `Write`/`Edit`
delegate therefore works directly in `.pi/worktree/<name>`, with no
`delegationId`, no settle, and no worktree note in its report.

This is a cross-package contract: agent-runtime routes on that exact string.
Renaming it, or returning a different code for a session that has no isolated
worktree, would silently fail every `Write`/`Edit` delegate of a workspace
session instead of running it.

### 6. Derived roots, never a fallback

A workspace session's tool root is derived from its binding (workspace path
plus the project's repository prefix), never from a client-sent path, and it
never falls back to the project root: a vanished workspace fails with
`WORKSPACE_MISSING` and a half-created one with `WORKSPACE_NOT_READY`. Plan
and Goal artifacts of a workspace session are written under the workspace
root, so the document travels with the branch it describes:
`resolve_plan_workspace` → `resolve_persisted_project_workspace` consults the
binding before the project fallback and never falls back to the project root
for a bound session. This resolves design §10 open question 4, and the
design's §4.9 table records the same answer.

Project identity is unchanged from ADR 0329: memory, skills, plugins, MCP
scope, the subagent catalog, `.pi/prompts`, `.pi/extensions`, and `SYSTEM.md`
stay keyed by the project path.

## Consequences

- A user-run `git clean -ffdx` in the parent checkout **deletes workspace
  checkouts and any uncommitted work in them**. The lock makes them
  prune-safe, not clean-safe. This is the accepted cost of the requested
  layout; the branch survives, and the workspace reappears as `missing` with a
  Repair action.
- Test runners that walk the project root discover duplicate tests under
  `.pi/worktree`. vitest is verified to do so; the documented remedy is
  `exclude: ["**/.pi/worktree/**"]` in the project's own config. The app does
  not silently edit user configuration. `tsc` and ripgrep defaults are safe.
- A workspace without its own `node_modules` resolves the parent checkout's
  modules, so a stale or incompatible parent install can affect a workspace
  run. The per-project setup command is the place to install.
- Watchers and monorepo globs owned by the user may still traverse
  `.pi/worktree`; the same documented exclude applies.
- Schema v28 adds the `project_workspaces` table and the nullable
  `sessions.workspace_id` column, which references `project_workspaces(id)`
  `ON DELETE CASCADE` rather than `SET NULL`: a NULLed binding would silently
  turn a workspace session into a project-root session, which item 6 forbids.
  Deleting a workspace removes its sessions and their transcripts explicitly
  before the row, so the cascade is only a backstop. The migration is additive,
  keeps a v27 backup, and leaves every existing session unbound.
- The word "workspace" was already taken twice (the active project, and
  ADR 0329's per-session worktree), so this feature is named
  `project_workspace` / `projectWorkspace` in every identifier and never
  "workspace" alone.

## Validation

host-core `project_workspaces` tests run against real temporary repositories
with a local bare remote: name validation, the managed exclude block, creation
from a remote branch with a clean parent checkout and a locked worktree,
`--no-track`, every refusal code, tool-root resolution and its missing /
not-ready failures, deletion with and without the branch and the folder,
re-import, reconciliation, and a project move. `projectWorkspace.*` contract
tests cover the RPC surface, and renderer tests cover the sidebar node and the
create dialog. `pnpm test:e2e:project-workspace`
(`scripts/e2e-project-workspace.mjs`) runs the lifecycle at protocol level
against a real host-core with a throwaway repository, bare remote, and data
directory — no model and no network.
