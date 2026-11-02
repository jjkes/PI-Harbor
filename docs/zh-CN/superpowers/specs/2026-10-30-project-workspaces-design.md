# 项目工作区：项目内的命名 git worktree

## 状态与范围

- 状态：已提出。本文档仅为设计阶段，不涉及代码变更。
- 日期：2026-10-30。
- 分支：在 worktree `worktrees/docs-project-workspaces` 中的 `docs/project-workspaces-design` 分支。
- 检查基线：`0eed9fe10`（ intake 时 `origin/main` 与本地 `main` 一致）。
- 交付物：问题陈述、当前行为证据、选定方案、风险、实现影响与验收测试。
- 相关文档：ADR 0329（会话 worktree 隔离）、ADR 0338（团队嵌套 worktree）、ADR 0016（侧边栏组织）、ADR 0037 / 0044（项目指令链）、`docs/spec/03-runtime/15-workspace-ignore-rules.md`。
- 方法：三轮只读探索（host-core、Electron main + 共享契约、renderer），并在项目外部使用临时 git 仓库进行验证。§5 中引用的每一项 git 行为均实际执行，而非假设。

## 1. 问题

侧边栏项目行只有一个 "+" 操作，且始终创建一个工作目录为项目文件夹的会话。用户若想在另一分支上并行工作，要么使用按会话隔离的 worktree（ADR 0329，机器命名，每个会话一个，存储在项目外部），要么自行管理 `git worktree`。

需求行为：

1. "+" 默认仍在项目文件夹中创建会话，并提供第二个操作：**新建工作区**。
2. 工作区创建在 `<project>/.pi/worktree/<name>`，名称为用户输入。
3. 创建对话框选择一个**远程分支**，旁边带有刷新按钮，以及一个**创建新分支**复选框。勾选后显示必填的**分支名称**字段。点击创建后，将所选远程分支实例化；若勾选复选框，则基于源分支创建新分支。
4. 工作区在侧边栏中作为项目下的子文件夹节点显示，拥有独立的会话列表与独立的"创建会话"操作。
5. 在工作区内创建的会话以该工作区为工作目录；在项目层级创建的会话仍使用项目根目录。

## 2. 当前行为

| 层级 | 当前行为 | 证据 |
| --- | --- | --- |
| 侧边栏 "+" | 单一操作，无菜单：`createProjectSession(entry.path)` | `apps/desktop/src/components/Sidebar.tsx:2436`, `:2441`, `:1579` |
| 侧边栏树 | `ProjectEntry` 是扁平结构（仅 `sessions`）；会话→项目分组依据规范化路径相等 | `Sidebar.tsx:131`, `apps/desktop/src/lib/sidebar-session-groups.ts:19` |
| 隔离会话入口 | 仅在项目菜单的 Git 子菜单中，通过 `probeWorktree` 禁用 | `apps/desktop/src/features/worktree/WorktreeSidebarParts.tsx:72`, `:109` |
| 创建契约 | `CreateSessionInput = Partial<SessionSummary> & { isolated?: boolean }`；main 将输入原样转发给 `session.create`；host 读取 `isolated` 并要求 `projectPath` | `apps/desktop/src/lib/api.ts:388`, `apps/desktop/electron/main/ipc/session-ipc.ts:232`, `crates/host-core/src/rpc/mod.rs:2658` |
| 工具根目录 | `resolve_tool_workspace` 先询问 `lifecycle::tool_root`，再回退到 `project_path`，最后到 scratch。隔离会话永远不会回退到主 checkout | `crates/host-core/src/rpc/mod.rs:1350`, `crates/host-core/src/session_worktrees/lifecycle.rs:136` |
| 注册表 | `worktrees` 表每个 `(session_id, delegation_id)` 一行；`path` 唯一；孤立行筛选条件为 `session_id IS NULL` | `crates/host-core/src/db/worktree_migration.rs:14`, `crates/host-core/src/session_worktrees/registry.rs:233` |
| Worktree 位置 | `<data_dir>/worktrees/<project-key>/<short-id>`，分支为 `pi-harbor/<short-id>`，基线为项目分支 tip；使用 `git worktree lock`、`.worktreeinclude`、setup 命令、`PI_PORT` | `lifecycle.rs:289`, `:301`, `:312`, `:336`, `:349` |
| 数据迁移 | 数据目录迁移会重写 `worktrees.path`，假设所有 worktree 都位于数据目录下 | `crates/host-core/src/data_relocation.rs:347` |
| Git 能力 | host-core 中无 `git fetch`、分支枚举、远程默认分支读取、`check-ref-format` | 对 `crates/host-core` 全仓库 grep |
| Git 运行器 | 关闭 hooks，`core.fsmonitor=false`，`safe.bareRepository=explicit`，`GIT_TERMINAL_PROMPT=0`，login-shell PATH，120 秒超时 | `crates/host-core/src/session_worktrees/git.rs:204`, `:216`, `:25` |
| 指令链 | 从目标目录向上遍历并在会话根目录停止；worktree 会话不会读取父 checkout 的 `AGENTS.md` | `packages/agent-runtime/src/project-instructions.ts:129` |
| 工具忽略 | `DEFAULT_IGNORE_DIRS` 不含 `.pi`；walker 使用 `git_ignore(true)`；文件树与插件 glob 有各自硬编码集合 | `crates/host-core/src/tools/ignore_rules.rs:32`, `crates/host-core/src/tools/mod.rs:1959`, `packages/host-runtime/src/workspace-files.ts:12`, `apps/desktop/electron/main/plugin-runtime.ts:813` |
| 文件索引 | `git ls-files -co --exclude-standard`，并有人工遍历兜底 | `packages/host-runtime/src/fs-index.ts:54` |
| main 中的根目录消费者 | 四个调用点根据 `session.worktree` 分支并调用 `worktree.location` | `apps/desktop/electron/main/runtime/session-launch.ts:311`, `runtime/sidecar.ts:375`, `ipc/workspace-ipc.ts:798`, `services/plugin-services.ts:685` |
| 命名 | `ProjectWorkspace` 已表示当前活动项目；`settings.groupWorkspace` 为 "Workspace" / "工作区"；工作面板浏览器为 "工作区浏览器" | `packages/shared/src/types/workspace.ts:24`, `packages/i18n/src/locales/zh-CN/index.ts:1031`, `:1554` |

## 3. 目标与非目标

目标：

1. 在项目作用域内提供命名的、用户可见的工作区，位于 `.pi/worktree/<name>`，可从选定远程分支创建，并可选择基于新分支。
2. 工作区是侧边栏中的持久节点，拥有多个会话；会话根目录由其工作区绑定派生，而非客户端发送的路径。
3. 不存在工作区时，项目层级行为保持不变。
4. 工作区不会污染父 checkout 的 `git status`、文件索引、文件树或无范围工具遍历。
5. 项目身份（memory、skills、plugins、MCP、subagent 目录、group context）仍以项目路径为键，与 ADR 0329 一致。

非目标（v1）：

- 不提供工作区的合并/同步/落后检测工作流。工作区是普通 checkout：用户与 agent 使用 git 进行 commit、push、pull。
- 不支持嵌套：工作区会话不能同时是隔离会话。
- 不支持 detached HEAD 工作区、本地分支源、远程项目。
- 不自动编辑用户的构建/测试配置。
- 不移动已有会话在项目与工作区之间。

## 4. 选定方案

### 4.1 术语

- 用户可见：**工作区** / **Workspace** 作为新节点；现有隔离会话功能仍称为 "Isolated session" / "隔离会话"。
- 代码标识符：`ProjectWorkspace*` 类型、`project_workspaces` 表、`projectWorkspace.*` host RPC、`projectWorkspace/*` IPC、renderer 功能文件夹 `features/project-workspace/`。不要复用 `workspace.*`（活动项目）或 `worktree.*`（ADR 0329 会话 worktree）。
- 内部注释约定：在共享代码中，单独的 "workspace" 一词永不表示本功能；始终使用 `projectWorkspace` / `project_workspace`。

### 4.2 磁盘布局与 git 规则

```
<project>/.pi/worktree/<name>/     # 每个工作区一个 linked worktree
```

这是需求的布局。§5 显示 ADR 0329 中记录的反对意见在今天只有部分成立：`tsc` 的默认 include 与 ripgrep 的默认遍历不会进入点目录，且一条锚定的 `.git/info/exclude` 规则即可将嵌套 checkout 从 `git status`、`git ls-files` 与 ripgrep 中排除。Vitest 发现机制与 `git clean -ffdx` 仍是真实风险，将在 §6 中处理。

`<name>` 为用户输入名称，验证为单个安全路径段：1–64 个字符，不含 `/`、 `\`、 `..`、控制字符、不以 `.` 开头、非 Windows 保留名，并进行 NFC 规范化。不会进行 slugify；用户输入即磁盘显示。`check-ref-format` 仅用于分支名。

host-core 在仓库的**公共** git 目录中维护一个托管块（所有 linked worktree 共享），绝不写入用户已跟踪的 `.gitignore`：

```
# >>> pi-desktop workspaces
/.pi/worktree/
# <<< pi-desktop workspaces
```

对于仓库子目录项目，规则锚定在仓库相对前缀：`/<prefix>/.pi/worktree/`。该块在 `git worktree add` 之前写入（因此 `git status` 不会看到中间状态），具有幂等性，并仅在同一前缀的最后一个工作区删除后移除。这一条规则即可覆盖 `git status`、`git ls-files --exclude-standard` 与 ripgrep，且不会隐藏工作区内部内容（§5）。

每个工作区在创建后立即锁定：`git worktree lock --reason "PI-Desktop workspace <name>"`，因此 `git worktree prune` 无法丢弃它。

分支/checkout 情况（`<src>` = `<remote>/<sourceBranch>`）：

| 情况 | 条件 | 命令 |
| --- | --- | --- |
| 新分支 | `createBranch = true` | `git worktree add -q --no-track -b <newBranch> <path> <src>` |
| 已有分支 | 本地分支不存在 | `git worktree add -q --track -b <sourceBranch> <path> <src>` |
| 已有分支 | 本地分支存在 | `git worktree add -q --force <path> <sourceBranch>` |

`--force` 让第二行对"已被 checkout 的分支"同样成立——无论是在主 checkout 还是另一个工作区：git 默认会拒绝（`fatal: '<branch>' is already used by worktree at …`）。因此同一个分支可以同时存在于多个 worktree，一个分支指针对所有检出指向同一个 commit；绝不会退化为 detached HEAD。

新分支使用 `--no-track` 是刻意的：若使用默认 tracking，新分支的上游会变成*源*远程分支，导致 `git push` 失败并提示 "upstream branch … does not match the name of your current branch"（§5）。新的工作区分支从无上游开始；用户通过 `git push -u` 发布。当 `createBranch = true` 且该名称的本地分支已存在时，创建在创建任何目录前便以 `WORKSPACE_BRANCH_EXISTS` 失败。这与上表第 3 行不同：第 3 行是*源*分支已存在本地并被原样复用。

### 4.3 创建流程（host-core，新增 `project_workspaces` 模块）

1. `ensure_local_project` + 现有 `probe`（git ≥ 2.29、非 bare、有 commit），复用 `WORKTREE_*` probe 错误码。
2. 验证名称（§4.2）、源分支与新分支名（使用 `git check-ref-format --branch`，新验证；目前不存在）。
3. 将源分支解析为 `refs/remotes/<remote>/<sourceBranch>` 并记录其 commit。若对话框执行了 fetch，则 fetch 已刷新；否则使用缓存的远程跟踪引用并如实报告。
4. 获取 `repo_lock::lock(common_dir)`；在锁内重新检查名称、路径与分支可用性。
5. 写入/修复 `info/exclude` 块；插入状态为 `creating` 的注册表行；分配 `PI_PORT` 块。
6. 执行 §4.2 中的 `git worktree add` 变体，然后执行 `git worktree lock`。
7. 复制 `.worktreeinclude` 并运行项目的 setup 命令，环境变量为 `PI_PROJECT_ROOT`、`PI_WORKTREE_ROOT`、`PI_PORT`，复用现有 include/setup 实现及其超时与日志限制。
8. 标记为 `active`。任何失败时，安全移除目录链接、**仅当本次调用创建了分支时**删除分支、并删除行；若清理本身失败，则保留 `creating` 行供启动时对账处理。

端口分配器提取为 helper，由 `worktrees` 与 `project_workspaces` 共享，通过查询两张表及现有存活探针保证跨表唯一性。

### 4.4 持久化（schema v27 → v28）

新增表与迁移模块，遵循 `worktree_migration.rs` 模式（共享 DDL const、备份、`user_version`、`db/repositories.rs` 分支、fresh-schema 路径、迁移测试）：

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
  created_branch INTEGER NOT NULL DEFAULT 0, -- 仅在我们创建分支时才删除分支
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

影响：

- `worktrees` 表及其孤立行清理保持不动；工作区永远不会成为该清理的孤立行。
- `data_relocation.rs` 继续只重写 `worktrees.path`。工作区路径是项目相对的，改在项目移动时修复（§4.11）。
- `sessions.workspace_id` 可为空；已有行与已有 `session.create` 调用者不受影响。

### 4.5 会话绑定与工具根目录

`session.create` 增加可选参数 `workspaceId`。`workspaceId` 与 `isolated: true` 同时存在为 `INVALID_PARAMS`。工作区会话仍像之前一样将项目存入 `project_id`，并额外存入 `workspace_id`。

`resolve_tool_workspace` 顺序变为：

1. 隔离会话 worktree（`lifecycle::tool_root`）—— 不变；
2. 工作区绑定 → `<workspace path>/<prefix>`；
3. 项目路径；
4. scratch。

工作区状态镜像隔离会话契约：`creating` → `WORKSPACE_NOT_READY`，`missing` → `WORKSPACE_MISSING`，工作区会话永远不会回退到项目根目录或主 checkout。隔离机制本身不变：工作区是会话的根，因此父 checkout 对该会话而言是外部路径，遵循现有 outside-workspace 权限流程。反向则刻意与 ADR 0329 不同：对于*项目*会话，工作区位于其根内部，因此允许显式路径进入（通过无范围遍历隐藏，§4.10）。这符合"子文件夹"心智模型，并在 §6 中说明。

`SessionSummary` 增加 `workspace?: { id, name, branch, status }`（不含 path），在与附加 worktree 徽章相同的列表/单个摘要路径中填充（`crates/host-core/src/sessions.rs:1327`, `:1348`, `:1531`）。`session.update` 拒绝更改已绑定会话的项目或工作区（`WORKSPACE_MOVE_UNSUPPORTED`）。

### 4.6 RPC 与 IPC 表面

新增 host 方法（在 `rpc/mod.rs:3948` 旁边新增 dispatch 分支），在 `packages/shared/src/protocol.ts` 现有 `worktree/*` 块（`:148`）旁边注册新的 IPC 频道，以及像 `worktree-ipc.ts` 一样的薄转发处理器。Preload 无需更改（仅频道白名单）。

| 方法 | 用途 |
| --- | --- |
| `projectWorkspace.probe({projectPath})` | 资格检查 + 已配置远程 |
| `projectWorkspace.branches({projectPath, remote?, refresh?})` | 远程分支列表；`refresh: true` 先执行 `git fetch <remote> --prune`。返回 `{branches, defaultRemote, defaultBranch, fetchedAt, stale}` |
| `projectWorkspace.create({projectPath, name, remote, sourceBranch, createBranch, newBranch?})` | §4.3；返回摘要 + include/setup 报告 |
| `projectWorkspace.list({projectPath})` | 侧边栏节点 |
| `projectWorkspace.pendingWork({workspaceId})` | 未提交更改、未推送提交、会话数 —— 用于删除对话框 |
| `projectWorkspace.remove({workspaceId, deleteBranch})` | §4.11 |
| `projectWorkspace.setupLog({workspaceId})` | 与 worktree setup log 相同契约 |
| `projectWorkspace.reveal({workspaceId})` | 在操作系统文件管理器中打开文件夹 |
| `projectWorkspace.location({sessionId})` | **仅限 main 进程**：会话的工作区根目录，镜像 `worktree.location` |

分支列表使用 `git for-each-ref refs/remotes/<remote>`（离线，无网络）；默认分支来自 `git symbolic-ref refs/remotes/<remote>/HEAD`。Fetch 是唯一新增的网络操作：继承用户环境（SSH agent、credential helper），保持 `GIT_TERMINAL_PROMPT=0`，并有显式超时与 `WORKSPACE_FETCH_FAILED` 错误，避免挂起。不存储或记录凭据。没有任何面向 renderer 的方法返回绝对路径。

新增错误码为 `WORKSPACE_*`（`NAME_INVALID`、`NAME_TAKEN`、`BRANCH_INVALID`、`BRANCH_EXISTS`、`SOURCE_BRANCH_NOT_FOUND`、`FETCH_FAILED`、`NOT_FOUND`、`NOT_READY`、`MISSING`、`BUSY`、`MOVE_UNSUPPORTED`、`HAS_RUNNING_SESSIONS`、`PATH_EXISTS`、`IO`）；git/probe 失败复用现有 `WORKTREE_GIT_*` 家族，使 renderer 错误映射保持精简。

### 4.7 Electron main

Main 保持薄编排层，自身从不构建工作区路径。四个 `session.worktree` 调用点（§2）新增兄弟分支：当存在 `session.workspace` 时，通过 `projectWorkspace.location` 解析根目录。具体如下：

- `runtime/session-launch.ts`：根目录解析器返回顺序为 隔离根 → 工作区根 → 项目路径；`projectPath` 保持 ADR 0329 中的项目身份含义。解析失败即启动失败（无静默回退）。
- `runtime/sidecar.ts`：为指令预检注册相同的根。
- `ipc/workspace-ipc.ts`：`workspaceRootInfo` 返回工作区根，并将项目路径视为 rebase 父级，因此聊天 `@`-引用在工作区内部解析，与隔离会话一致。
- `services/plugin-services.ts`：插件工作区隔离使用相同的已解析根。

### 4.8 Renderer

新增功能文件夹 `apps/desktop/src/features/project-workspace/`（组件、小型本地 store、actions 模块），遵循 `features/worktree/` 模式。`Sidebar.tsx`（2898 行）只接收组合点；树节点、菜单项与对话框均位于功能文件夹内。不扩展中央 store 的工作流逻辑。

- **入口**："+" 保持一键创建会话行为；相邻的 chevron 打开 **New session** 与 **New workspace…**。将 "+" 本身改为菜单会被拒绝，因为这会给现有默认操作增加一次点击。**New workspace…** 项在非 git、无 commit 或远程项目时根据 probe 原因禁用。
- **创建对话框**（基于 `WorktreeDialogFrame`）：
  - *Name* —— 必填，内联验证，只读路径预览 `.pi/worktree/<name>`。
  - *Remote* —— 仅存在多个远程时显示；默认 `origin`。
  - *Source branch* —— 功能本地可搜索组合框（`BranchPicker`，`role="combobox"`/`listbox`，`aria-activedescendant`，键盘导航，参考 `SearchDialog`）。目前不存在共享可搜索选择原语，因此保持功能本地，避免过早添加 `ui.tsx` 原语。
  - *Refresh button* 位于分支字段旁 —— 触发 `refresh: true`；fetch 时显示 spinner，列表过期时显示非阻塞警告。
  - *Create new branch* 复选框 —— 显示 *Branch name*，必填，使用与 git 相同规则验证，默认填入工作区名称。
  - 无效时禁用创建；创建期间对话框为 `busy`（Esc/遮罩禁用），失败以 `role="alert"` 内联渲染。
- **树**：`ProjectEntry` 增加 `workspaces: ProjectWorkspaceEntry[]`，每个工作区有自己的会话与自己的 "+"（在此工作区创建会话）。分组键变为 `projectPath + workspaceId`；项目级行仅包含无 `workspaceId` 的会话。折叠状态按 workspace id 存储在现有 sidebar-preferences blob 中，而非按路径，因此项目移动后仍可保留。
- **会话作用域**：`newSessionScopeKey`、`latestSessionInScope`、`sessionIsReusableEmpty` 与草稿会话实例化路径均考虑工作区，因此空项目会话绝不会被工作区请求复用，反之亦然（`apps/desktop/src/stores/slices/session-slice.ts:656`、`stores/runtime/session-runtime.ts:405`、`stores/runtime/session-coordination.ts:348`、`apps/desktop/src/lib/session-create.ts:18`）。Mod+N 继承当前活动会话的工作区；项目 "+" 始终表示无工作区。
- **标签**：工作区会话在对话顶部栏与窗口标题显示 `Project / Workspace`；侧边栏节点显示分支及 `creating` / `missing` / `setup failed` 状态。
- **i18n**：在所有九种语言中新增 `projectWorkspace.*` 命名空间，以及菜单/顶部栏字符串。不要复用 `settings.groupWorkspace`（"工作区"）或工作面板 "工作区浏览器" 键。

### 4.9 项目身份与 `.pi` 所有权

与 ADR 0329 一致：`projectPath` 保持为项目根，因此 memory、skills、plugins、MCP 作用域、subagent 目录与 group context 由项目及其所有工作区共享。

| 表面 | 工作区会话的解析位置 |
| --- | --- |
| 工具根目录、Bash cwd、文件工具、Grep/Glob | 工作区（+prefix） |
| `AGENTS.md` / `CLAUDE.md` 链 | 来自其分支的工作区副本，在工作区根停止；不继承父 checkout 的编辑。全局 `~/.pi/agent/AGENTS.md` 仍然适用 |
| `.pi/prompts`（composer `/` 模板） | **项目路径，非会话根。** loader 使用 `optionalWorkspaceRoot()`（`apps/desktop/electron/main/ipc/register.ts:241` → host `workspace.get`），即活动项目，忽略会话。对工作区保持不变；隔离会话已如此行为 |
| `.pi/extensions`、`.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md` | 项目路径。`customSystemPromptDirs` 的参数名为 `workspaceRoot`，但调用处传入 `localInstructionRoot = projectPath`（`runtime/session-launch.ts:453`, `:471`） |
| `.pi/plan`、`.pi/goal` 工件 | **项目路径，非工作区。** Plan/Goal 使用自有解析器 —— `resolve_plan_workspace` → `resolve_persisted_project_workspace`（`crates/host-core/src/rpc/mod.rs:1510`, `:1321`）—— 返回 `sessions.project_path`，从不咨询 worktree |
| MCP 服务器、插件服务 | 项目作用域，与今天一致 |

目前没有加载器会递归扫描 `.pi/**`（extensions 与 prompts 为单级，Plan 工件为固定 kind），因此 `.pi/worktree/` 不会与现有 `.pi` 消费者冲突。工件路径守卫（`crates/host-core/src/plans/artifact.rs:155`）不受影响，因为它将第二级固定为工件 kind。

上表中有两行容易误判，因此特别指出：工作区会话的 Plan/Goal 工件与 composer `/` 模板均从**项目**而非工作区解析。这并非回归 —— ADR 0329 隔离会话已如此行为 —— 且 Plan 工件写入是 host 内部操作（`publish_artifact`），不是 Write-tool 调用，因此不受会话工具隔离约束。工作区是否应拥有独立的 Plan 工件留待开放讨论（§10）。

### 4.10 忽略与隔离规则

一套规则，在现有各层实现：

- **git**：托管 `info/exclude` 块（§4.2）。
- **host-core 工具遍历**：在无范围 Glob/Grep 与从项目根使用的 walker 中按*路径*跳过 `.pi/worktree`，而非按目录名；`DEFAULT_IGNORE_DIRS` 不添加裸 `worktree` 或 `.pi` 项，以免隐藏无关用户目录。工作区内部的有范围遍历不受影响。
- **文件索引 / 文件树**：`git ls-files` 路径已被 `info/exclude` 覆盖；人工遍历兜底与文件树忽略集合（`packages/host-runtime/src/workspace-files.ts:12`）显式跳过 `.pi/worktree`。
- **插件 glob**：`apps/desktop/electron/main/plugin-runtime.ts:813` 的 `GLOB_SKIP_DIRS` 为 `{.git, node_modules, .venv, __pycache__}`，并在 `:6043` 与 `:6117` 的递归作用域遍历中按目录名匹配，因此插件 glob 项目根时会进入 `.pi/worktree`。需要在那里添加相同的路径感知跳过。`packages/plugin-devkit/src/walk.ts` 超出范围：其 `IGNORED_DIR_NAMES` 遍历的是正在构建的插件包，而非项目树。

### 4.11 生命周期

- **`project_workspaces` 启动对账**：回滚 `creating` 行；非目录或链接被替换的根变为 `missing`；否则在仓库锁下运行 `git worktree repair <path>`。
- **项目移动/重命名**：当存储的 `path` 与项目当前位置不符时，根据项目路径 + prefix + 名称重新计算，然后 `git worktree repair <recomputed paths…>` 重新链接双向关系。必须传入路径：从移动后的父目录执行裸 `git worktree repair` 会退出 0 但什么也不修复，因为注册的 gitdir 仍指向旧位置（§5）。会话继续工作，因为它们的根是派生而非存储的。
- **目录缺失**：节点显示 "Folder missing"；其会话以 `WORKSPACE_MISSING` 失败，而非静默回退到项目根；节点菜单提供 **Repair**（当分支仍存在时从记录的分支/commit 重新添加）与 **Remove from list**。
- **删除工作区**：任何会话正在运行时阻塞（`WORKSPACE_HAS_RUNNING_SESSIONS`）；确认对话框显示 `pendingWork` 摘要，并说明工作区的会话及其聊天记录将被删除。删除时安全移除目录链接；仅当勾选 `deleteBranch` 时（默认不勾选）删除本地分支；删除会话再删除行；当它是最后一个工作区时修剪 `info/exclude` 块。文件夹已消失的锁定 worktree 使用 `git worktree remove --force --force` 语义移除（§5），分支删除通过公共 git 目录进行，与 `remove.rs` 一致。
- **删除项目**：用户契约不变 —— 删除会话与聊天记录，保留磁盘文件夹。工作区行随项目行级联删除；`.pi/worktree/` 目录保留在磁盘上，重新添加项目时可被重新发现（重新导入扫描 `.pi/worktree/*` 并匹配到已注册 worktree）。
- **隔离会话与团队委托**：`workspaceId` 与 `isolated` 互斥（§4.5）。委托 worktree 必须保持其数据目录位置；`delegate.rs` 当前从会话 worktree 的父目录派生委托路径，因此实现必须断言不能在 `.pi/worktree/` 内创建委托 worktree，并将工作区会话的委托路由到非隔离路径。

## 5. 设计背后的验证行为

所有运行均使用全局 git 配置隔离的临时仓库；未触碰项目中的任何内容。git 2.54.0、tsc 5.9.3、vitest 4.1.11、rg 15.2.0。

| 实验 | 结果 |
| --- | --- |
| 无忽略规则时 `git worktree add` 到 `.pi/worktree/<name>` | 成功；父 `git status` 显示 `?? .pi/`；`git add -A` 会添加嵌套 checkout 为 gitlink（`160000`）并提示 "embedded git repository" |
| `.git/info/exclude` 中锚定 `/.pi/worktree/` | `git status` 干净，`git ls-files -co --exclude-standard` 排除它，`rg --files --hidden` 排除它；linked worktree 共享公共目录，因此规则对它们可见 |
| 子目录项目 | 根锚定规则不够；规则必须为 `/<prefix>/.pi/worktree/` |
| 无 `--hidden` 的 `rg --files` | 根本不会进入 `.pi` |
| `tsc` 默认 include（`**/*`） | **不会**包含 `.pi/worktree/**`；只有显式 `.pi/**/*` include 才会 |
| `vitest list` 默认发现 | **会**发现 `.pi/worktree/<name>/src/*.test.ts`；显式 `exclude: ["**/.pi/worktree/**"]` 可移除 |
| `git clean -fdx`（单 `-f`） | 打印 `Skipping repository .pi/worktree/<name>`；checkout 保留 |
| `git clean -ffdx`（双 `-f`） | **删除整个 `.pi` 树，包括工作区 checkout**；分支保留，worktree 被报告为可 prune |
| 父目录中 `git stash push -u` | 打印 `Ignoring path .pi/worktree/<name>/`；工作区保持有效 checkout，文件完好 |
| 工作区内无自身 `node_modules` 时的 Node 模块解析 | 解析到父 checkout 的 `node_modules` |
| `git worktree lock` 后，文件夹被移走时 `git worktree prune` | 锁定条目在 prune 中保留；未锁定条目被移除（`Removing …: gitdir file points to non-existent location`） |
| 对锁定且缺失的工作树执行 `git worktree remove` 与 `remove --force` | 均被拒绝：`cannot remove a locked working tree, lock reason: … use 'remove -f -f' to override`。`--force --force` 移除条目并保留分支 |
| 移动项目文件夹 | 工作区 `git status` 失败并提示 `not a git repository`，条目被列为 `prunable`；裸 `git worktree repair` 退出 0 但不修复；从新位置执行 `git worktree repair <explicit paths>` 可恢复每个 checkout |
| `git worktree add -b <new> <path> <remote>/<branch>`（默认 tracking） | 上游变为源远程分支，`git push` 因上游名称不匹配失败；`--no-track` 无上游 |
| 复用已被 checkout 的分支 | `fatal: '<branch>' is already used by worktree at …`；`git worktree add --force` 可覆盖该拒绝并再次 checkout 该分支 |
| `git check-ref-format --branch` | 接受 `feat/ok`，拒绝空格、`..`、前导 `-`、`*.lock`、`HEAD`、`~` |
| 分支枚举 | `for-each-ref refs/remotes/origin` 离线列出远程分支；必须过滤 `origin/HEAD` |

## 6. 风险与缓解

| 风险 | 严重程度 | 缓解 |
| --- | --- | --- |
| 父目录中 `git clean -ffdx` 删除工作区 checkout | **高 — 数据丢失** | 锁定每个工作区（prune 安全）；在工作区菜单与用户文档中记录该风险；`missing` 状态 + Repair 流程；host-core 永不运行 `clean`。工作区内部的未提交工作无法防御用户执行的 `git clean -ffdx`；这是需求布局的 accepted cost |
| 测试运行器（已验证 vitest）在 `.pi/worktree` 下发现重复测试 | 中 | 提供文档化的 exclude 片段；setup 命令提示；不静默编辑用户配置。`tsc` 与 ripgrep 默认安全（§5） |
| 文件监视器 / monorepo glob 仍可能遍历 `.pi/worktree` | 中 | 同上文档；保持工作区不在应用自身的文件树与索引中，因此应用不会在那里添加监视器 |
| 依赖解析泄漏到父 `node_modules` | 中 | 复用 setup 命令（例如 `pnpm install`）与 `.worktreeinclude`；文档说明每个工作区需要独立安装以获得正确隔离 |
| 项目根会话可在无外部路径提示的情况下编辑工作区文件 | 中 | 刻意为之（子文件夹语义）；从无范围遍历中隐藏；文档说明这与隔离会话不同 |
| 多个 checkout 增加磁盘占用与 `node_modules` | 低 | worktree 的预期行为；无需处理 |
| Windows 长路径 / junction | 中 | 复用 ADR 0329 的 link-safe 移除与 `core.longpaths` 处理；添加 >260 字符删除测试 |
| 与现有 "Workspace" 词汇命名冲突 | 低 | §4.1 命名规则；新 i18n 命名空间 |
| ADR 0329 将项目内 worktree 列为已拒绝 | 流程 | 新 ADR 记录 §5 证据并取代该 feature 的该替代方案；ADR 0329 本身对会话隔离仍然有效 |

## 7. 实现影响

| 区域 | 文件 |
| --- | --- |
| Schema | `crates/host-core/src/db.rs`（v28）、新增 `db/project_workspace_migration.rs`、`db/repositories.rs`（分支 + fresh schema）、`db/schema.rs`（`sessions.workspace_id`）、`db/tests.rs` |
| Host 领域 | 新增 `crates/host-core/src/project_workspaces/`（create、branches、registry、lifecycle、errors），复用 `session_worktrees/{git,probe,include,remove,repo_lock}.rs` 与提取后的端口分配器 |
| Host RPC | `rpc/mod.rs`（dispatch 分支、`session.create`/`session.update`、`resolve_tool_workspace`）、新增 `rpc/project_workspace_rpc.rs`、`sessions.rs`（摘要附加） |
| 工具忽略 | `tools/ignore_rules.rs`、`tools/mod.rs` walker |
| 共享契约 | `packages/shared/src/protocol.ts`、`types/sessions.ts`、新增 `types/project-workspace.ts`、`rpc-timeouts.ts`（fetch/create 超时） |
| Main | 新增 `ipc/project-workspace-ipc.ts`、`ipc/register.ts`、`runtime/session-launch.ts`、`runtime/sidecar.ts`、`ipc/workspace-ipc.ts`、`services/plugin-services.ts`、`plugin-runtime.ts`（glob 跳过） |
| Renderer | 新增 `features/project-workspace/*`、`components/Sidebar.tsx`（仅组合）、`components/ConversationTopbar.tsx`、§4.8 列出的会话作用域 helper |
| 索引/树 | `packages/host-runtime/src/fs-index.ts`、`workspace-files.ts` |
| i18n | `packages/i18n/src/locales/*/index.ts`（9 种语言） |
| 实现文档 | 新 ADR、`docs/spec/03-runtime/01-ipc-protocol.md`、`04-data-storage.md`、`06-host-rpc-protocol.md`、`08-error-codes.md`、`02-agent-runtime.md`、`03-tools-and-permissions.md`、`15-workspace-ignore-rules.md`、`docs/spec/04-ux/01-ui-ia.md`、`docs/spec/06-delivery/04-e2e-test-plan.md`（+ zh-CN 镜像） |

## 8. 测试

Host-core，针对带有 `file://` origin 的真实临时仓库：

- 基于新分支创建（上游未设置、源 commit 匹配）、跟踪已有远程分支创建、复用已有本地分支、同一分支同时在项目与两个工作区中 checkout；
- 名称与分支名验证、重复名称、重复路径、`check-ref-format` 失败、回滚仅删除其创建的分支；
- `info/exclude` 块：在 add 之前写入、幂等、子目录项目锚定前缀、最后删除后修剪、父 `git status` 干净；
- 分支列表离线、`origin/HEAD` 过滤、`refresh` 执行 fetch、fetch 失败映射为 `WORKSPACE_FETCH_FAILED` 且不挂起；
- 项目/工作区/隔离会话的工具根目录解析、`WORKSPACE_NOT_READY`、`WORKSPACE_MISSING`、不回退到项目根；
- `creating` 行启动对账、缺失目录、项目移动 + `git worktree repair`、锁定 worktree prune 安全；
- 删除时带/不带分支删除、运行中会话拒绝、会话级联、孤立行清理不触碰 `project_workspaces`；
- 在已填充数据库上迁移 v27→v28、fresh-schema 等价性、降级安全失败模式；
- Windows junction 上的 link-safe 移除与 >260 字符路径场景。

契约与 main：

- `session.create` 带 `workspaceId`、同时带 `workspaceId` 与 `isolated`、两者皆无（行为不变）；
- IPC 频道注册、参数验证、面向 renderer 的 payload 不含路径、`projectWorkspace.location` 限制在 main；
- 四个根目录消费者解析工作区根并 rebase 聊天引用。

Renderer：

- "+" 默认行为不变；chevron 菜单打开对话框；
- 完整创建对话框用户路径：名称验证、分支搜索、刷新、复选框显示必填分支字段、提交、错误显示；
- 树分组（项目会话 vs 工作区会话）、折叠状态持久化、每个工作区的 "+"；
- 空会话复用与 Mod+N 作用域跨越项目与工作区；
- 所有九种语言的 i18n 目录对等与 renderer-key 检查。

E2E：新增 `scripts/e2e-project-workspace-live.mjs`，风格同 `e2e-worktree-live.mjs` —— 真实 host-core、真实 agent runtime、临时 git origin —— 覆盖 创建工作区 → 在其中创建会话 → agent 文件落入工作区且父 checkout 保持干净。现有 worktree E2E 必须保持绿色。

## 9. 交付阶段

1. Host-core：schema、领域模块、RPC、工具忽略、host 测试。
2. 契约 + main：共享类型、频道、根目录解析、IPC 测试。
3. Renderer：入口、对话框、树、作用域、i18n、组件测试。
4. 生命周期加固（移动/修复/删除）、E2E、ADR + spec 更新、文档。

阶段 1–2 可独立评审且不触及 UI；功能到阶段 3 才显现。

## 10. 决策与开放问题

本设计中已决定（请确认）：

1. 布局严格为 `.pi/worktree/<name>`；排除规则位于 `.git/info/exclude`，而非已跟踪的 `.gitignore`。
2. "+" 变为 split button；一键创建会话得以保留。
3. 不勾选 "Create new branch" 时，工作区直接 checkout 所选分支；若该分支已被 checkout（例如项目位于 `main`），会在自己的 worktree 中再次 checkout，而不是静默使用 detached HEAD。因此同一个分支可以被检出多次。
4. 新分支从无上游开始（`--no-track`）。
5. 删除工作区会删除其会话与聊天记录，默认保留本地分支，并在有运行中会话时拒绝。
6. v1 中工作区无合并/同步/落后机制；它们是普通 checkout。
7. 工作区会话不能同时是隔离会话。
8. 内部命名处处使用 `projectWorkspace`，以避免与现有 "workspace" 词汇冲突。

开放问题：

1. 删除工作区时是否应提供 "保留文件夹"（仅从列表分离），还是 "删除并保留分支" 已足够？
2. 重新添加项目时，是否需要自动重新导入孤立的 `.pi/worktree/*` 目录，还是可手动 "Add existing workspace"？
3. 是否需要记住每个项目的默认源分支以供下次创建对话框使用？
4. 工作区会话的 Plan/Goal 工件是否应跟随工作区而非项目（§4.9）？保持项目根是现状，且能在工作区删除后保留工件；跟随工作区需要第二解析器与现有工件的迁移方案。
