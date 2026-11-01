# 15. Workspace Ignore Rules

## 1. Goal

Prevent tools from scanning/reading/writing sensitive or useless paths by
default, while allowing an explicit, visible permission decision when a task
intentionally targets a path outside the session workspace.

## 2. Rule layers (priority high → low)

1. **Security denylist** (always on, not user-disable in MVP)
2. **App defaults** (shipped)
3. **Workspace rules** (`.pi-desktopignore` at the workspace root)
4. **User global ignore** (`<data_dir>/ignore`, i.e. `~/.pi-desktop/ignore`
   by default)
5. Explicit tool path still subject to the security denylist and the
   outside-path permission gate

An explicit `path` argument on `Glob`/`Grep` opts that walk out of layers 2–4
(the same way it already bypasses parent `.gitignore` rules), so a caller who
names `node_modules/pkg` or `dist` can still search it. Layer 1 applies to
every walk and every explicit path.

## 3. Security denylist (always)

Outside-workspace read/write/search is denied by default. An explicit
`Read`/`Glob`/`Grep`/`Write`/`Edit` path may proceed only after the host applies
the permission mode: `auto` allows it, while `ask` and `accept-edits` ask the
user. An implicit recursive walk never gains outside-workspace access.

Also deny inside workspace (and inside the scratch or an approved external
root) for:
- `.git/objects/**`
- private key patterns: `*.pem`, `*.key`, `id_rsa`, `id_ed25519`
- `.env`, `.env.*` — except the documentation variants `.env.example`,
  `.env.sample`, and `.env.template`, which hold no secrets and are what a
  coding task usually needs
- credential files: `*.p12`, `*.pfx`, `credentials.json` (Google), `.npmrc` with tokens (best-effort)

File-name matching is case-insensitive. `Glob` and `Grep` drop matching files
from their results silently; an explicit `Read`, `Write`, or `Edit` (including
the `Edit` move destination) fails with `WORKSPACE_PATH_DENIED`, and an
outside-path grant does not lift the denial. `Bash` is not filtered (§6).

> Read may be allowed with an explicit permission prompt in a later revision;
> MVP fails closed.

## 4. Default ignore (app)

```gitignore
.git/
node_modules/
dist/
build/
.target/
target/
.venv/
venv/
__pycache__/
.pytest_cache/
.mypy_cache/
.DS_Store
*.log
coverage/
.turbo/
.next/
.cache/
```

### 4a. Project workspaces (ADR 0340)

A project workspace is a named git worktree at
`<project>/.pi/worktree/<name>`: a second checkout of the same repository,
holding another branch's files. An unscoped walk from the project root must
not descend into it, or every workspace would contribute a near-copy of the
project tree to the results.

The container `.pi/worktree` is therefore part of the app-default layer
(layer 2), matched **by path relative to the walk root** and never by
directory name:

- the in-process walker skips the directory whose path relative to the ignore
  root is exactly `.pi/worktree`, which prunes everything under it;
- the system `rg` fast path adds the anchored glob `!/.pi/worktree`, which rg
  matches against the path relative to the search root.

Matching by path is what keeps a user's own directory called `worktree`, or a
`.pi/worktree` further down the tree, visible. Because the skip lives in
layer 2, an explicit `path` argument into a workspace opts back in, and a walk
already rooted inside a workspace is unaffected — a workspace session's own
`Glob`/`Grep` see their checkout normally.

git sees the same rule through a different mechanism: host-core maintains an
anchored `/.pi/worktree/` line (or `/<prefix>/.pi/worktree/` for a
sub-directory project) in the managed block of the repository's common
`info/exclude`, never in the user's tracked `.gitignore`. That one rule covers
`git status`, `git ls-files --exclude-standard`, and ripgrep's own gitignore
handling in the parent checkout. The composer file index and the work-panel
file tree skip the same relative path explicitly, because their manual-walk
fallback does not consult git.

## 5. Workspace file

Support:

```text
.pi-desktopignore
```

Syntax: gitignore-compatible subset.

## 6. Tool behavior

| tool | ignore application |
|---|---|
| Glob | unscoped walk: layers 1–4 filter results; explicit `path`: layer 1 only |
| Grep | unscoped walk: layers 1–4 filter the file set (in-process walker and the system `rg` fast path alike); explicit `path`: layer 1 only |
| Read | `WORKSPACE_PATH_DENIED` on a denylisted file; otherwise permission-gated when the explicit path is outside; `TOOL_DENIED` after denial |
| Write/Edit | `WORKSPACE_PATH_DENIED` on a denylisted file or move destination; otherwise permission-gated when the explicit path is outside; `TOOL_DENIED` after denial |
| Bash | path sandbox still enforced by host; ignore file does not expand bash powers |

## 7. Diagnostics

Tools should return stable errors:
- `PATH_OUTSIDE_WORKSPACE` — path escapes the workspace root before an
  outside-path permission decision
- `TOOL_DENIED` — outside-path permission was denied, timed out, or cancelled
- `WORKSPACE_PATH_DENIED` — an explicit path hit the security denylist (see
  [08-error-codes §3.3](08-error-codes.md))

UI can show “hidden by ignore rules” counts for Glob/Grep optionally later.

## 8. Acceptance criteria

- [x] outside paths require permission in non-auto modes and are allowed in Auto
- [x] default ignores hide node_modules from Glob/Grep
- [x] workspace ignore file honored
- [x] security denylist cannot be disabled from UI in MVP
