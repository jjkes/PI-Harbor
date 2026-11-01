# 项目工作区：项目内的命名 git worktree

本文是 [`2026-10-30-project-workspaces-design.md`](2026-10-30-project-workspaces-design.md)
的中文译本，当前覆盖 §5.9 至 §11；更早的小节以英文原文为准。

### 5.9 项目身份与 `.pi` 归属

与 ADR 0329 保持一致：`projectPath` 仍是项目根目录，因此记忆、技能、插件、MCP 作用域、子代理目录和群组上下文由项目及其所有工作区共享。

| 范围 | 工作区会话的解析方式 |
| --- | --- |
| 工具根目录、Bash cwd、文件工具、Grep/Glob | 工作区（加 prefix） |
| `AGENTS.md` / `CLAUDE.md` 链 | 工作区分支中的副本，在工作区根目录处停止；不继承父检出目录的修改。全局 `~/.pi/agent/AGENTS.md` 仍然生效 |
| `.pi/prompts`（输入框 `/` 模板） | **项目路径，而非会话根目录。** 加载器调用 `optionalWorkspaceRoot()`（`apps/desktop/electron/main/ipc/register.ts:241` → 主机 `workspace.get`），返回当前活动项目，忽略会话。工作区维持现状；隔离会话已是这种行为 |
| `.pi/extensions`、`.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md` | 项目路径。`customSystemPromptDirs` 的参数名为 `workspaceRoot`，但调用点传入的是 `localInstructionRoot = projectPath`（`runtime/session-launch.ts:453`、`:471`） |
| `.pi/plan`、`.pi/goal` 产物 | **项目路径，而非工作区。** Plan/Goal 使用独立的解析器 `resolve_plan_workspace` → `resolve_persisted_project_workspace`（`crates/host-core/src/rpc/mod.rs:1510`、`:1321`），它返回 `sessions.project_path`，从不查询 worktree |
| MCP 服务、插件服务 | 按项目作用域，与现在相同 |

目前没有加载器会递归扫描 `.pi/**`（扩展和提示词只扫描单层，Plan 产物的类型是固定的），因此 `.pi/worktree/` 不会与现有 `.pi` 使用方冲突。产物路径守卫（`crates/host-core/src/plans/artifact.rs:155`）不受影响，因为它把第二段路径固定为产物类型。

有两行容易被误认，因此单独说明：工作区会话的 Plan/Goal 产物和输入框 `/` 模板都从**项目**解析，而不是从工作区解析。这不是回归，ADR 0329 的隔离会话已经如此。Plan 产物由宿主内部写入（`publish_artifact`），不是 Write 工具调用，因此不受会话的工具隔离约束。工作区是否应拥有自己的 Plan 产物，留待 §11 决定。

### 5.10 忽略与隔离规则

各现有层各自实现同一套规则：

- **git**：托管的 `info/exclude` 块（见 §5.2）。
- **宿主核心工具遍历**：在无作用域的 Glob/Grep 以及从项目根目录使用的遍历器中，按**路径**跳过 `.pi/worktree`，而不是按目录名。不要把裸的 `worktree` 或 `.pi` 加入 `DEFAULT_IGNORE_DIRS`，否则会隐藏用户无关的目录。工作区内的限定范围遍历不受影响。
- **文件索引 / 文件树**：`git ls-files` 路径已由 `info/exclude` 覆盖；手动遍历的回退逻辑和文件树的忽略集合（`packages/host-runtime/src/workspace-files.ts:12`）需要显式跳过 `.pi/worktree`。
- **插件 glob**：`apps/desktop/electron/main/plugin-runtime.ts:813` 中的 `GLOB_SKIP_DIRS` 为 `{.git, node_modules, .venv, __pycache__}`，并且在 `:6043` 和 `:6117` 的递归作用域遍历中按目录名匹配。如果插件从项目根目录执行 glob，会进入 `.pi/worktree`。这里同样需要基于路径的跳过逻辑。`packages/plugin-devkit/src/walk.ts` 不在范围内：其中的 `IGNORED_DIR_NAMES` 用于遍历正在构建的插件包，从不遍历项目目录树。

### 5.11 生命周期

- **`project_workspaces` 的启动对账**：`creating` 状态的行会被回滚；根路径不是目录或被链接替换的，标记为 `missing`；其余情况在仓库锁下运行 `git worktree repair <path>`。
- **项目移动或重命名**：如果保存的 `path` 与项目当前位置不一致，则根据项目路径 + prefix + 名称重新计算，然后运行 `git worktree repair <重新计算的路径…>`，使两个方向的链接都恢复。必须传入路径：从移动后的父目录直接运行不带参数的 `git worktree repair` 会返回 0 但不修复任何内容，因为注册的 gitdir 仍指向旧位置（见 §6）。会话仍可正常工作，因为其根目录是推导出来的，而不是存储的。
- **目录缺失**：节点显示"文件夹缺失"；其会话以 `WORKSPACE_MISSING` 失败，而不是悄悄使用项目根目录。节点菜单提供**修复**（若记录的分支仍存在，则从该分支/提交重新添加）和**从列表移除**。
- **删除工作区**：若其中任何会话正在运行，则阻止删除（`WORKSPACE_HAS_RUNNING_SESSIONS`）。确认对话框显示 `pendingWork` 摘要，并说明该工作区的会话及其转录记录将被删除。删除时会以链接安全的方式移除目录；只有勾选 `deleteBranch`（默认关闭）时才删除本地分支；先删除会话，再删除行记录；若这是最后一个工作区，则同时清理 `info/exclude` 块。对于已消失目录的锁定 worktree，按 §6 的 `git worktree remove --force --force` 语义移除；分支删除按 `remove.rs` 的方式通过公共 git 目录进行。
- **删除项目**：用户契约保持不变，会话和转录记录会被删除，磁盘上的文件夹保留。工作区行随项目行级联删除；`.pi/worktree/` 目录仍保留在磁盘上，重新添加项目时可以重新发现（重新导入会扫描 `.pi/worktree/*`，并与已注册的 worktree 匹配）。
- **隔离会话与团队委派**：`workspaceId` 与 `isolated` 互斥（见 §5.5）。委派的 worktree 必须保持其数据目录位置。`delegate.rs` 目前从会话 worktree 的父目录推导委派路径，因此实现时必须断言委派 worktree 不能创建在 `.pi/worktree/` 内，并且工作区会话的委派应走非隔离路径。

## 6. 设计所依据的已验证行为

所有实验都使用一次性仓库完成，并隔离了全局 git 配置，项目本身未被改动。使用 git 2.54.0、tsc 5.9.3、vitest 4.1.11、rg 15.2.0。

| 实验 | 结果 |
| --- | --- |
| 在 `.pi/worktree/<name>` 中执行 `git worktree add`，没有忽略规则 | 可以工作；父仓库的 `git status` 显示 `?? .pi/`；`git add -A` 会把嵌套检出作为 gitlink（`160000`）加入，并给出"embedded git repository"警告 |
| 在 `.git/info/exclude` 中使用锚定规则 `/.pi/worktree/` | `git status` 干净；`git ls-files -co --exclude-standard` 排除了它；`rg --files --hidden` 也排除了它；由于链接工作树共享公共目录，该规则从链接工作树中也可见 |
| 子目录项目 | 仅靠根锚定规则不够，规则必须是 `/<prefix>/.pi/worktree/` |
| 不带 `--hidden` 的 `rg --files` | 从不进入 `.pi` |
| `tsc` 默认 include（`**/*`） | **不**包含 `.pi/worktree/**`；只有显式的 `.pi/**/*` include 才会包含 |
| `vitest list` 默认发现 | **会**发现 `.pi/worktree/<name>/src/*.test.ts`；显式的 `exclude: ["**/.pi/worktree/**"]` 可以去掉它们 |
| `git clean -fdx`（单个 `-f`） | 输出 `Skipping repository .pi/worktree/<name>`；检出目录保留 |
| `git clean -ffdx`（两个 `-f`） | **会删除整个 `.pi` 目录树，包括工作区检出**；分支保留，worktree 被报告为 prunable |
| 父仓库中执行 `git stash push -u` | 输出 `Ignoring path .pi/worktree/<name>/`；工作区仍是有效检出，文件保持完好 |
| 在没有自己 `node_modules` 的工作区中解析 Node 模块 | 解析到父检出的 `node_modules` |
| 对已移走文件夹的 worktree 先 `git worktree lock`，再 `git worktree prune` | 锁定条目保留；未锁定的条目会被删除（`Removing …: gitdir file points to non-existent location`） |
| 对锁定且缺失的 worktree 执行 `git worktree remove` 和 `remove --force` | 两者都被拒绝：`cannot remove a locked working tree, lock reason: … use 'remove -f -f' to override`。`--force --force` 会删除条目并保留分支 |
| 移动项目文件夹 | 工作区的 `git status` 失败，提示 `not a git repository`，条目被列为 `prunable`；不带参数的 `git worktree repair` 返回 0 但什么也没修复；在新位置执行 `git worktree repair <显式路径>` 可恢复每个检出 |
| `git worktree add -b <new> <path> <remote>/<branch>`（默认跟踪） | 上游变成源远程分支，`git push` 因上游名称不匹配而失败；`--no-track` 不设置上游 |
| 复用已被检出的分支 | `fatal: '<branch>' is already used by worktree at …` |
| `git check-ref-format --branch` | 接受 `feat/ok`；拒绝空格、`..`、前导 `-`、`*.lock`、`HEAD`、`~` |
| 分支枚举 | `for-each-ref refs/remotes/origin` 可离线列出远程分支；必须过滤掉 `origin/HEAD` |

## 7. 风险与缓解

| 风险 | 严重程度 | 缓解措施 |
| --- | --- | --- |
| 在父仓库中执行 `git clean -ffdx` 会删除工作区检出 | **高：数据丢失** | 锁定每个工作区（可防止 prune 删除）；在工作区菜单和用户文档中说明此风险；提供 `missing` 状态和修复流程；宿主核心从不运行 `clean`。工作区内未提交的工作无法防止用户手动运行 `git clean -ffdx`；这是采用所要求布局的已接受代价 |
| 测试运行器（已用 vitest 验证）在 `.pi/worktree` 下发现重复测试 | 中 | 提供有文档的排除配置片段；在 setup 命令中加入提示；不静默修改用户配置。`tsc` 和 ripgrep 的默认设置是安全的（见 §6） |
| 监听器或 monorepo 的 glob 仍可能遍历 `.pi/worktree` | 中 | 同样通过文档说明；工作区不进入应用自己的文件树和索引，因此应用不会在那里添加监听器 |
| 依赖解析泄漏到父仓库的 `node_modules` | 中 | 复用 setup 命令（例如 `pnpm install`）和 `.worktreeinclude`；文档说明每个工作区需要各自安装依赖，才能保证正确隔离 |
| 项目根会话无需外部路径提示即可编辑工作区文件 | 中 | 这是刻意的设计（子文件夹语义）；在无作用域遍历中隐藏；文档说明它与隔离会话不同 |
| 多个检出会成倍增加磁盘占用和 `node_modules` | 低 | worktree 的预期代价；无需处理 |
| Windows 长路径 / 连接点（junction） | 中 | 复用 ADR 0329 中的链接安全删除和 `core.longpaths` 处理；增加超过 260 字符的删除测试 |
| 与现有"Workspace"术语重名 | 低 | 遵守 §5.1 的命名规则；使用新的 i18n 命名空间 |
| ADR 0329 将项目内 worktree 列为已否决方案 | 流程 | 新增 ADR，记录 §6 的证据，并为本功能取代该备选方案；ADR 0329 本身对会话隔离仍然有效 |

## 8. 实现影响

| 领域 | 文件 |
| --- | --- |
| Schema | `crates/host-core/src/db.rs`（v28）、新增 `db/project_workspace_migration.rs`、`db/repositories.rs`（分支与全新 schema）、`db/schema.rs`（`sessions.workspace_id`）、`db/tests.rs` |
| 宿主领域 | 新增 `crates/host-core/src/project_workspaces/`（创建、分支、注册表、生命周期、错误），复用 `session_worktrees/{git,probe,include,remove,repo_lock}.rs` 和抽取出的端口分配器 |
| 宿主 RPC | `rpc/mod.rs`（分发分支、`session.create`/`session.update`、`resolve_tool_workspace`）、新增 `rpc/project_workspace_rpc.rs`、`sessions.rs`（摘要附加） |
| 工具忽略 | `tools/ignore_rules.rs`、`tools/mod.rs` 遍历器 |
| 共享契约 | `packages/shared/src/protocol.ts`、`types/sessions.ts`、新增 `types/project-workspace.ts`、`rpc-timeouts.ts`（fetch/create 超时） |
| 主进程 | 新增 `ipc/project-workspace-ipc.ts`、`ipc/register.ts`、`runtime/session-launch.ts`、`runtime/sidecar.ts`、`ipc/workspace-ipc.ts`、`services/plugin-services.ts`、`plugin-runtime.ts`（glob 跳过） |
| 渲染进程 | 新增 `features/project-workspace/*`、`components/Sidebar.tsx`（仅组合）、`components/ConversationTopbar.tsx`、§5.8 中列出的会话作用域辅助函数 |
| 索引/文件树 | `packages/host-runtime/src/fs-index.ts`、`workspace-files.ts` |
| i18n | `packages/i18n/src/locales/*/index.ts`（9 种语言） |
| 实现相关文档 | 新增 ADR，`docs/spec/03-runtime/01-ipc-protocol.md`、`04-data-storage.md`、`06-host-rpc-protocol.md`、`08-error-codes.md`、`02-agent-runtime.md`、`03-tools-and-permissions.md`、`15-workspace-ignore-rules.md`、`docs/spec/04-ux/01-ui-ia.md`、`docs/spec/06-delivery/04-e2e-test-plan.md`（以及 zh-CN 镜像） |

## 9. 测试

宿主核心测试使用带 `file://` origin 的真实临时仓库：

- 使用新分支创建（上游未设置，源提交一致）；创建跟踪已存在远程分支的工作区；复用已存在的本地分支；当分支已在主检出中被检出时拒绝；
- 名称和分支名校验、名称重复、路径重复、`check-ref-format` 失败、回滚时只删除自己创建的分支；
- `info/exclude` 块：在 add 之前写入、幂等、子目录项目使用带前缀的锚定规则、最后一次删除后清理、父仓库 `git status` 保持干净；
- 离线列出分支，过滤 `origin/HEAD`，`refresh` 执行 fetch，fetch 失败映射为 `WORKSPACE_FETCH_FAILED` 且不挂起；
- 项目、工作区、隔离会话的工具根目录解析，`WORKSPACE_NOT_READY`、`WORKSPACE_MISSING`，不回退到项目根目录；
- `creating` 行、目录缺失、项目移动加 `git worktree repair`、锁定 worktree 的 prune 安全性的启动对账；
- 带或不带删除分支的删除、正在运行会话时拒绝、会话级联删除、孤儿清理后 `project_workspaces` 保持不变；
- 在已有数据的数据库上完成 v27→v28 迁移，全新 schema 等价性，降级安全的失败模式；
- Windows 连接点上的链接安全删除，以及超过 260 字符路径的情况。

契约与主进程测试：

- `session.create` 传入 `workspaceId`、同时传入 `workspaceId` 和 `isolated`、两者都不传（保持原有行为）；
- IPC 通道注册、参数校验、面向渲染进程的载荷中不含路径、`projectWorkspace.location` 仅限主进程调用；
- 四个根消费方解析工作区根目录并重新计算聊天引用的基准。

渲染进程测试：

- "+" 默认操作保持不变；下拉菜单可打开对话框；
- 完整的创建对话框用户路径：名称校验、分支搜索、刷新、勾选复选框后显示必填分支字段、提交、错误展示；
- 树形分组（项目会话与工作区会话）、折叠状态持久化、每个工作区的"+"；
- 项目与工作区之间的空会话复用及 Mod+N 作用域；
- 九种语言的 i18n 目录一致性及渲染进程键检查。

E2E：新增 `scripts/e2e-project-workspace-live.mjs`，风格与 `e2e-worktree-live.mjs` 一致，使用真实宿主核心、真实代理运行时和一次性 git origin，覆盖：创建工作区 → 在其中创建会话 → 代理的文件落在工作区中，而父检出保持干净。现有 worktree E2E 必须保持通过。

## 10. 交付阶段

1. 宿主核心：schema、领域模块、RPC、工具忽略规则、宿主测试。
2. 契约与主进程：共享类型、通道、根目录解析、IPC 测试。
3. 渲染进程：入口、对话框、树、作用域、i18n、组件测试。
4. 生命周期加固（移动/修复/删除）、E2E、ADR 与规范更新、文档。

第 1–2 阶段可以独立审阅，且不改动 UI；该功能在第 3 阶段之前保持隐藏。

## 11. 已确定的设计决策与待解问题

本设计已确定以下事项（请确认）：

1. 布局严格为 `.pi/worktree/<name>`；排除规则写在 `.git/info/exclude` 中，而不是受版本控制的 `.gitignore` 中。
2. "+" 变为分体按钮；保留一键创建会话的行为。
3. 不勾选"创建新分支"时，工作区直接检出所选分支；如果该分支已被检出（例如项目当前位于 `main`），创建会失败并给出明确错误，而不是静默使用分离 HEAD。此时对话框应引导用户选择"创建新分支"。
4. 新分支不设置上游（`--no-track`）。
5. 删除工作区会删除其会话和转录记录，默认保留本地分支，并在有会话运行时拒绝删除。
6. 工作区在 v1 中不提供合并、同步或落后检测机制；它们就是普通检出。
7. 工作区会话不能同时是隔离会话。
8. 内部命名全部使用 `projectWorkspace`，以避免与现有"workspace"术语混淆。

待解问题：

1. 删除工作区时应提供"保留文件夹"（仅从列表中移除），还是删除并保留分支就够了？
2. 重新添加项目时，是否需要在 v1 中重新导入孤立的 `.pi/worktree/*` 目录，还是可以改为手动"添加已有工作区"？
3. 是否需要为下一次创建对话框记住每个项目的默认源分支？
4. 工作区会话的 Plan/Goal 产物是否应跟随工作区而不是项目（§5.9）？保持项目根目录是现状，并且在工作区删除后仍然可用；改为跟随工作区则需要第二个解析器，以及现有产物的迁移方案。
