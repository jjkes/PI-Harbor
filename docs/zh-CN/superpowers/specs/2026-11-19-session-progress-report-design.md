# 会话进度汇报：从输入框发起的只读进度快照

> 本文是 `docs/superpowers/specs/2026-11-19-session-progress-report-design.md` 的中文译本，两者冲突时以英文原文为准。

## 状态与范围

- 状态：设计提案，2026-11-19，尚未实现。实现时需要新增 ADR（下一个可用编号 0350）、
  决策日志条目（D681），并按 § 13 更新规范。
- 分支：worktree `.pi/worktree/进度汇报` 中的 `feature/进度汇报`。
- 检查基线：`b038dff99`（2026-11-19）。
- 交付物：本文档，以及静态 UI 原型 `docs/design/session-progress-report.html`。原型使用
  `apps/desktop/src/styles/tokens.css` 中的真实 token 值，只用于辅助阅读，不是产品代码。
- 验证：文中的代码引用均通过只读侦察对照基线核实。§ 14.1 列出实现开始前必须确认的事实。
- 范围：仅本地桌面会话（`source: "desktop"`），与 BTW（ADR 0346）的边界相同。远程会话和
  Pi 原生会话不显示触发按钮。
- 产品决策：产品负责人已于 2026-11-19 确认（§ 17）。没有遗留的产品问题，可以直接从 § 15 的 P1
  开始实现。

## 1. 需求

用户的要求：

1. 在输入框内部左下角放一个小的进度汇报按钮。
2. 点击后展开一个小弹层：可以选择撰写汇报的模型，可以立即采集并查看进度，也可以开启
   自动采集并配置采集间隔。
3. 采集完成后，弹层按固定格式显示当前进度：已完成什么、正在做什么、下一步做什么、大约
   还剩多少步骤和多少时间。
4. 采集是异步的：对当前会话上下文拍快照，交给配置的模型处理；弹层显示快照的采集时间。
5. 历史记录默认隐藏；底部按钮可以展开历史，按时间线滚动查看。
6. 采集不能打断会话，也不能影响会话。

## 2. 现状

目前没有进度汇报功能。以下三个相邻的功能决定了设计边界：

| 功能 | 是什么 | 为什么不是本需求 |
| --- | --- | --- |
| TodoDock（ADR 0312） | Agent 写入的清单，显示在输入框停靠区，持久化在 `session_todo` | 由 agent 写入，没有“剩余时间”，其他路径不得写入 |
| BTW（ADR 0346） | 只读旁路提问；基于主运行时快照的临时运行 | 工作面板标签里的自由问答，不持久化，使用会话自身的模型 |
| 实时活动状态（ADR 0175、ADR 0198） | 回合运行时的安静阶段标签 | ADR 0175 否决了常驻的多步骤进度卡片，因为回合没有可靠的步骤或百分比模型 |

基线中可复用的部分：

- `packages/agent-runtime/src/one-shot-complete.ts:83` 的
  `completeOneShot(provider, context, thinkingLevel, options)` 执行一次不带工具的补全。
  Electron Main 已在插件 `agent.complete` API 中使用它
  （`apps/desktop/electron/main/services/plugin-services.ts:457`），调用前先用
  `resolveAgentRuntimeLaunch`（`apps/desktop/electron/main/runtime/session-launch.ts:323`）解析凭据。
- Host RPC `session.get` 可以按窗口读取对话记录（`messageLimit`、`messageBefore`；
  `crates/host-core/src/rpc/mod.rs:3012`），`todos.get` 返回会话清单
  （`crates/host-core/src/rpc/mod.rs:3068`）。
- BTW 在 Main 中的运行登记表会在所属渲染进程导航、崩溃或关闭时中止运行
  （`apps/desktop/electron/main/ipc/btw-ipc.ts:60-74`）。
- `AnchoredMenu`（`apps/desktop/src/components/settings/AnchoredMenu.tsx`）把经过测量、
  固定于视口的浮层挂到 body 上，支持外部点击和 Esc 关闭、打开时移入焦点、关闭时归还焦点。
- `session_team`（`crates/host-core/src/session_team/`）是按会话存储的 host 模块，有自己的
  DDL、repository 和带命名空间的 RPC 分支。当前 schema 版本是 30（`crates/host-core/src/db.rs:10`）。

## 3. 目标与非目标

目标：

- 在首页和对话停靠两种输入框中，于左下角工具栏分组的最前面放一个触发按钮，仅对本地桌面会话显示。
- 随时可以手动采集（包括回合运行期间）；按会话可选开启自动采集，间隔由用户选择。
- 固定四段式汇报（已完成、进行中、下一步、预计剩余），附带采集时间、触发方式、模型，
  以及快照覆盖了会话的多少内容。
- 历史时间线默认隐藏，重启后仍保留。
- 对会话零影响：不改变其对话记录、上下文、运行状态、队列、回合槽位、配置、未读状态或通知，
  也不等待主回合。

非目标：

- 通过汇报去引导、暂停或提示会话。
- 第二份清单。汇报只读取 TodoDock，从不写入（ADR 0312）。
- 百分比、进度条或对话记录里的进度卡片（ADR 0175、ADR 0198）。
- 远程和 Pi 原生会话、应用关闭期间的采集、跨会话看板、导出、toast 和系统通知。
- 恢复 ADR 0064 删除的后台预计算机制。

## 4. 方案对比

### 4.1 功能放在哪里

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| A. 作为核心功能，参照 BTW（ADR 0346） | **采用** | 按钮必须位于左下角分组的最前面。插件出口 `ComposerControlSlots side="left"` 渲染在模式和权限 chip 之后（`apps/desktop/src/features/chat/composer/ComposerToolbar.tsx:236`），插件拿不到这个角落 |
| B. 基于 `agent.complete` 的内置插件 | 否决 | 拿不到角落位置。ADR 0323 把模型生成标题移出核心，是因为它会自动消耗 token 并修改会话；汇报只在用户主动开启后才消耗 token，且不修改任何东西，这与 BTW 留在核心的理由相同 |

### 4.2 汇报如何执行

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| A. 在 Electron Main 中对持久化对话记录的有界摘要发起一次无工具的 `completeOneShot` 调用 | **采用** | 复用 `agent.complete` 的凭据路径，完全不接触运行主回合的 sidecar；会话没有已加载的运行时（例如重启后）也能工作 |
| B. 像 BTW 一样，在 sidecar 中基于 `sideQuestionSnapshot()` 发起临时旁路运行 | 否决 | 需要已加载的运行时：要么为空闲会话启动一个，要么重启后无法汇报；还要新增 sidecar RPC 方法；并且运行在执行主回合的进程里 |
| C. 直接向会话发提示，或派生子会话 | 否决 | 占用回合槽位（ADR 0053），写入对话记录，并产生未读标记（ADR 0107）。ADR 0268 已经移除了旁路对话 |

Main 承载请求，但不拥有汇报逻辑。摘要、提示词、指纹和解析器都是
`packages/agent-runtime/src/progress/` 中的纯函数；Main 只负责组装，就像现在
`plugin-services.ts` 组装 `completeOneShot` 一样。

### 4.3 谁来调度自动采集

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| A. 渲染进程中的服务，配合纯决策函数和可注入时钟 | **采用** | 随窗口一起停止；不给 Main 或 sidecar 增加长期资源；决策表可以单元测试 |
| B. Electron Main 中的定时器 | 否决 | Main 必须保持为轻量编排层；比窗口活得更久的定时器需要自己的生命周期，会变成第二个调度器 |
| C. sidecar 中的定时器 | 否决 | 会重新引入 ADR 0064 删除的后台请求机制 |

### 4.4 历史和设置存在哪里

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| A. host-core 数据表，schema v31，随会话删除级联删除 | **采用** | 重启后保留；删除会话会删除其汇报；SQLite 仍由 host 独占（ADR 0041） |
| B. 渲染进程内存，像 BTW 线程那样 | 否决 | 重载会丢掉已经消耗过 token 的汇报 |
| C. 渲染进程 `localStorage` | 否决 | 不在 host 管辖和配置同步范围内；删除会话时不会级联清理 |

### 4.5 汇报格式

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| A. 单个 JSON 对象，宽容解析，失败时回退原文 | **采用** | 在任何服务商上都能渲染固定布局 |
| B. 自由格式 Markdown | 否决 | 四个分段无法稳定渲染 |
| C. 服务商原生结构化输出 | 暂缓 | 各服务商支持程度不一，以后可以放在 A 之下 |

## 5. 架构

```text
Renderer                        Electron Main                         host-core (SQLite)
ProgressTrigger / Popover
ProgressScheduler ──invoke──▶  progress-ipc.ts
  pi-harbor/progress/collect     validate, register (one run per session)
                                 session.get (window) + todos.get ────▶ read only
                                 fingerprint unchanged? → "skipped"
                                 buildProgressDigest + prompt   (agent-runtime, pure)
                                 completeOneShot ──HTTPS──▶ provider  (no tools)
                                 parseProgressReport
                                 progress.reports.append ────────────▶ session_progress_reports
                  ◀── result ───
```

agent sidecar 和运行中的 `Agent` 都不在这条路径上。Main 不调用任何 `agent.*`、
`session.configure`、`session.appendMessage` 或通知相关方法。

## 6. UI 设计

原型 `docs/design/session-progress-report.html` 用深色和浅色主题渲染了本节的所有状态。

### 6.1 触发按钮

- 位置：`apps/desktop/src/features/chat/composer/ComposerToolbar.tsx:168` 中 `.composer-left`
  的第一个子元素，位于附件按钮之前。架构热点文件 `Composer.tsx` 不需要修改。
- 形态：`TooltipButton`，`className="icon-btn icon-btn-square"`（28×28，`--ds-control-size`），
  图标是在 `components/icons.tsx` 中新增的 `IconActivity`（lucide `Activity`，15px）。
  ADR 0031 只禁止输入行里的品牌标识，工具栏本来就有图标按钮。不用 `ListChecks`，因为它
  看起来像 TodoDock 清单。
- 渲染规则：`progressAvailableFor(session)` 为真时显示；否则（尚无会话、远程会话、Pi 原生
  会话）不渲染，与听写和实时语音按钮的隐藏方式一致。回合运行期间以及 `controlsBlocked`
  为真时都保持可用，因为它从不配置会话（ADR 0073）。

| 状态 | 视觉 | 提示 |
| --- | --- | --- |
| 默认 | `--ds-text-secondary` 图标 | 进度汇报 |
| 悬停 | `--ds-bg-hover` 填充 | 进度汇报 · 上次 3 分钟前 |
| 打开 | `.active` 填充，`aria-expanded="true"` | 打开时不显示 |
| 采集中 | 11px `.tool-spinner` 替换图标，`aria-busy="true"` | 正在采集进度… |
| 自动开启 | 右上角 5px `--ds-success` 圆点 | 自动采集：每 5 分钟 |
| 有未读汇报 | 右上角 6px `--ds-accent` 圆点，优先于自动圆点 | 有新的进度汇报 |

ARIA：`aria-haspopup="dialog"`、`aria-expanded`、`aria-controls`；有未读汇报时，
`aria-label` 追加“有新汇报”。

### 6.2 弹层

- 基础组件：`AnchoredMenu`，`role="dialog"`、`side="top"`（默认是 `bottom`）、`align="start"`，
  `initialFocus` 保持默认的 `"selected"`——由于没有元素带 `aria-selected`，焦点落在第一个可用
  按钮上，`menuClassName="progress-popover"`。不新增第四种弹层机制。
- 外观：`width: min(376px, calc(100vw - 24px))`，`max-height: min(560px, calc(100vh - 92px))`，
  `--radius-md-plus`（14px），`--ds-bg-elevated-opaque`，`1px --ds-border-default`，
  `--ds-shadow-dialog`，z-index 60（设计系统 § 9 中挂到 body 的浮层层级）。左对齐保证面板
  留在主面板内：主面板宽度处于下限 450px 时，按钮左边缘加 376px 仍在面板内。
- 动效：opacity 加 `translateY(4px)`，时长 `--motion-duration-fast`，缓动
  `--motion-ease-out`；减少动效时只保留 opacity。
- 只有一个滚动容器：头部和底部固定，主体滚动。

```text
┌ 进度汇报 ····················· ● 自动 · 每 5 分钟
│ [Bot gpt-4.1-mini ⌄]  [立即采集]
│ 自动采集 ··························· [ ● ]
│ [1分] [3分] [5分] [10分] [15分] [30分]
│ 下次检查约 14:32 · 会话没有新进展时自动跳过
├──────────────────────────────────────
│ 汇报卡片、状态视图或历史时间线（唯一滚动区）
├──────────────────────────────────────
└ 历史记录 12 ························ ⌄
```

控件使用 `apps/desktop/src/AGENTS.md` 要求的共享基础组件：“立即采集”用 primary 小号
`Button`，另有 `SettingsToggle`、带 radio 角色的 `SegmentedControl`，底部用 ghost `Button`。
间隔行和提示只在自动采集开启时显示。

### 6.3 汇报卡片

| 部分 | 内容 | 样式 |
| --- | --- | --- |
| 元信息行 | 绝对时间（`Intl`，应用语言）、相对时间、触发方式（手动、自动、回合结束）、“基于最近 40 / 86 条消息”；会话已有新进展时显示过期标记 | `--text-2xs`，`--ds-text-muted`，等宽数字，`·` 分隔 |
| 已完成 | 0 到 8 条 | 6px `--ds-success` 圆点，`--ds-text-secondary` |
| 进行中 | 0 到 3 条 | 6px `--ds-warning` 圆点，`--ds-text-primary` |
| 下一步 | 0 到 5 条 | 6px `--ds-text-faint` 圆点 |
| 预计剩余 | ≈ N 步 · ≈ M 分钟、置信度徽标（低、中、高），以及“模型估算，仅供参考” | `--ds-tile` 底块，`--text-lg` 半粗体数字 |

列表为空时显示“暂无”，估算为空时显示“未知”。估算从不显示为百分比或进度条（ADR 0175）。
汇报文本按纯文本渲染，不按 Markdown 渲染。相对时间直接引用 `formatRelativeMoment`
（`apps/desktop/src/features/scheduled/scheduled-format.ts:45`），不再新增第五个相对时间工具函数。

### 6.4 模型视图

点击模型 chip 后，弹层主体原地替换为返回行、搜索框和列表，与输入框“模型 × 推理强度”菜单
的模式一致（`docs/spec/04-ux/08-component-spec.md` § 11.3）。不再打开第二个浮层：输入框模型
菜单的 z-index 是 40，会被这个弹层盖住。

- 第一行：“跟随会话模型”，副文本显示会话当前的模型。
- 之后是已配置的模型，按“最近使用”和服务商分组，用 `ComposerModelList` 基于目录 store
  （`providers`、`providerModels`、`recentModels`）渲染，即
  `docs/spec/03-runtime/13-model-catalog-and-selection.md` § 9.2 所说的已配置模型选择器。
- 没有推理强度滑块：汇报请求固定使用 thinking `off`（§ 7.5）。
- 底部说明：“汇报会把会话摘要发送到所选模型的服务商。”

### 6.5 历史时间线

- 底部按钮显示“历史记录 N”，在当前视图和时间线之间切换；N 为 0 时禁用。
- 顺序：最新在上，第一条就是最新汇报。
- 折叠条目：状态圆点（解析成功为实心，未解析为空心）、时间、相对时间与触发方式、“进行中”
  的第一条（或“输出不符合格式”），以及预计剩余行。条目是带 `aria-expanded` 的按钮。
- 展开条目会原地显示完整分段，以及模型、覆盖范围和 token 用量。
- 分页：`progress.reports.list` 每页返回 20 条并附带游标；“加载更早的记录”获取下一页。
  host 为每个会话保留最新的 100 份汇报（§ 8.4）。
- 被跳过的检查、取消的运行和失败的运行都不产生记录。

### 6.6 状态

| 状态 | 主体 | 头部 |
| --- | --- | --- |
| 从未采集 | “还没有进度汇报”及一行说明 | “立即采集”可用 |
| 首次采集中 | 转圈、“正在生成进度汇报…”、“会话不受影响”、取消按钮 | “立即采集”显示转圈并禁用 |
| 最新汇报 | 汇报卡片 | “立即采集”可用 |
| 后台更新中 | 继续显示上一份汇报 | “立即采集”显示转圈 |
| 已过期 | 汇报卡片带过期标记 | 不变 |
| 已跳过 | 不变；提示行显示“14:32 已检查 · 没有新进展” | 不变 |
| 失败 | 在上一份汇报上方显示内联告警：原因、时间、“会话未受影响”和重试 | 不变 |
| 未解析 | 警告行，以及等宽字体显示的模型原文 | 不变 |
| 自动已暂停 | 提示“已暂停：连续 3 次采集失败”、最近错误和恢复按钮 | 状态显示“自动已暂停” |
| 模型不可用 | 警告行和模型设置链接 | “立即采集”禁用 |

### 6.7 交互与无障碍

- 点击、Enter 或 Space 切换弹层；悬停从不打开（ADR 0047）。
- 外部点击和 Esc 关闭弹层，并把焦点还给按钮（`docs/spec/04-ux/09-interaction-patterns.md`
  的 Floating dropdown surfaces）。
- 打开时焦点移到第一个可用控件。挂到 body 上的浮层不在文档的 Tab 顺序里，所以 Tab 和
  Shift+Tab 通过 `onMenuKeyDown` 在弹层内循环。
- `role="dialog"` 并带 `aria-label`。只在弹层打开时，用 polite 级别的 live region 播报
  “已采集新的进度汇报”。错误使用 `role="alert"`。
- 切换当前会话会关闭弹层。原会话的采集继续进行，结果写入它自己的历史。
- 后台结果从不移动焦点、不打开弹层、不弹 toast，只点亮按钮上的未读圆点。

### 6.8 文案与 i18n

键名、英文和中文文案见英文原文 § 6.8。该表本身已包含中文文案，这里不再重复，以免两份副本
不一致。

## 7. 逻辑设计

### 7.1 采集流水线（Main）

`pi-harbor/progress/collect` 是一次 invoke，在运行结束时返回结果。没有事件通道：没有需要
流式推送的内容，而且发起调用的渲染进程是唯一的消费者。

1. 校验请求（`parseProgressCollectRequest`），拒绝非本地桌面会话。
2. 登记运行：每个会话最多一个（否则返回 `PROGRESS_BUSY`），全应用最多三个。监听调用方的
   导航、崩溃和关闭。
3. 解析模型（§ 7.5）。服务商、模型或凭据缺失时，在发出任何请求之前以
   `PROGRESS_MODEL_UNAVAILABLE` 失败。
4. 用 `messageLimit` 读取 `session.get`（最新窗口，200 条消息）以及 `todos.get`。
5. 计算指纹（§ 7.4）。触发方式为 `auto` 或 `turnEnd` 且指纹与最新一份已存汇报相同时，
   直接返回 `skipped`，不调用模型。
6. 构建摘要和提示词（§ 7.2 和 § 7.3），两者都是纯函数。
7. 调用 `completeOneShot`：不带工具，thinking `off`，`maxOutputTokens` 1,200，60 秒超时
   与运行自身的中止信号合并。
8. 解析文本（§ 7.3），结果为带正文的 `ok`，或带原文（最多 4,000 字符）的 `unparsed`。
9. 通过 `progress.reports.append` 持久化，并返回存储后的记录。

渲染进程的调度器把自动采集限制在同时两个以内，因此在 Main 的三个上限之下，手动采集总能
拿到空位。

### 7.2 快照摘要（纯函数）

`buildProgressDigest(input)` 把对话记录窗口转换成有预算上限的纯文本摘要。它只读，绝不修改
传入的消息。

| 项目 | 规则 |
| --- | --- |
| 窗口 | 从最新消息向前，最多 200 条，始终在回合边界处截断，保证工具调用和它的结果成对保留 |
| 预算 | 约 6,000 token（复用运行时已有的 `estimateTokens`）。先丢弃较旧的消息；会话的第一条用户消息始终保留作为锚点 |
| 用户消息 | 全文，每条最多 600 字符 |
| 助手文本 | 每条最多 800 字符 |
| 助手思考 | 省略 |
| 工具调用 | 每条一行：名称、参数键，以及参数值前 160 字符 |
| 工具结果 | 前 240 字符，加上 `ok`/`error`；二进制和图片内容替换为 `<image>` |
| 清单 | 由 `todos.get` 渲染成带状态标记的紧凑列表 |
| 会话事实 | 模式、权限模式、模型 ID、窗口内的回合数、首尾消息时间戳 |

模型看到的就是这份摘要。它不在 UI 中显示，也不存储，因此汇报之后不会通过弹层泄露文件内容。

### 7.3 提示词与解析器（纯函数）

`buildProgressPrompt(digest, now)` 返回一条 system 消息和一条 user 消息：

- system：“你为正在进行的编程会话向用户总结进度。只依据摘要回答，不要编造文件、命令或结果。
  只回复一个 JSON 对象，不要有其他内容。”
- user：摘要，然后是要求的格式：

```json
{
  "completed": ["..."],
  "inProgress": ["..."],
  "next": ["..."],
  "remainingSteps": 4,
  "remainingMinutes": 18,
  "confidence": "low | medium | high"
}
```

并附上 § 6.3 的数量上限：`remainingSteps` 是 0–99 的整数或 `null`，`remainingMinutes` 是
0–600 的整数或 `null`，另加一条说明：“只根据摘要中可见的节奏估算；摘要不足以支撑估算时用
null。”

`parseProgressReport(text)` 采用宽容策略：

1. 去除首尾空白，去掉首尾的 Markdown 代码围栏。
2. 取出最外层的 `{...}` 片段并 `JSON.parse`。
3. 缺失的数组按空处理，数字字符串转数字，列表和数字按上限裁剪，丢弃非字符串元素。
4. `inProgress` 和 `completed` 同时缺失时判定整段未解析，因为模型回答的不是这个格式。
5. 任何失败都返回 `unparsed` 并附带最多 4,000 字符的原文。运行仍然持久化，弹层显示原文视图。

### 7.4 指纹、过期与去重

- `progressFingerprint({ lastMessageId, messageCount, todosRevision })` 是对最新持久消息 ID、
  消息数量和清单版本号计算的短哈希。
- 触发方式为 `auto` 或 `turnEnd` 且指纹与最新一份已存汇报相同时，返回 `skipped` 且不存储。
- 手动采集总是执行。
- 过期判断在渲染进程，与 BTW 相同（ADR 0346）：会话最新消息 ID 与汇报记录中的不一致时，
  汇报即过期。这个判断只是一次 store 比较，不走 IPC。

### 7.5 模型解析

`ProgressModelRef = { followSession: true } | { providerId: string; modelId: string }`。

- `followSession` 解析为会话当前的 provider 和 model，也就是输入框显示的那一对，从
  `session.get` 读取。
- 显式指定的配对通过模型目录和凭据库解析。发请求前先检查：provider 存在、model 在该
  provider 的模型列表中、凭据或可用的认证方式存在。失败时抛出 `PROGRESS_MODEL_UNAVAILABLE`，
  原因放在 `details` 中。
- 无论会话的推理强度如何，汇报一律请求 thinking `off` 和 `maxOutputTokens` 1,200，因此
  汇报既便宜又快。
- 修改汇报模型从不调用 `session.configure`，也从不改变会话下一回合发送的内容（ADR 0073）。

### 7.6 自动采集调度器（渲染进程）

一个服务独占管理所有自动采集：`createProgressScheduler()`，注入时钟、定时器和 API 端口，
写法参照 BTW 服务。

- 范围：只处理开启了自动采集、且至少采集过一次的会话，因为去重基准是最新汇报的指纹。
- 心跳：所有已启用的会话共用一个自我重排的 `setTimeout`，而不是每个会话一个定时器。下一次
  心跳在本次完成后才安排，因此慢采集不会堆积。
- 决策函数，纯函数并有单元测试：

| 条件 | 动作 |
| --- | --- |
| 没有已启用的会话 | 等待 |
| 自动采集已关闭，或会话已删除 | 停止跟踪 |
| 该会话已有运行在进行 | 跳过本次 |
| 已有两个自动运行在进行 | 跳过本次 |
| 当前时间 − 上次采集 < 间隔 | 等待 |
| 自上一份汇报以来没有新消息，清单也没有变化 | 记录 `skipped`，等待 |
| 其他情况 | 启动一次 `auto` 运行 |

- 会话结束：开启自动采集时，回合结束后为该会话排队一次 `turnEnd` 运行，前提是间隔已过；
  间隔仍然生效，因此话多的会话不会每个回合都采集。
- 失败处理：同一会话连续失败三次则暂停其自动采集，并显示暂停提示（§ 6.6）。手动采集成功后
  恢复。
- 清理：渲染进程卸载、最后一个会话关闭自动采集、应用退出时停止调度器。渲染进程导航、崩溃
  或关闭时由 Main 中止进行中的运行（与 BTW 相同的登记表模式），且不重试。
- 成本保护：窗口不可见时不启动自动运行；下一个可见心跳在数据有变化时才采集。

### 7.7 生命周期

| 事件 | 行为 |
| --- | --- |
| 回合进行中 | 采集照常进行；摘要只读取已持久化的消息，不观察也不等待回合 |
| 回合结束 | 开启自动采集时触发 `turnEnd` 采集（§ 7.6） |
| 运行中关闭弹层 | 运行继续；结果写入历史并点亮未读圆点 |
| 切换当前会话 | 弹层关闭；其他会话的运行继续 |
| 删除会话 | Main 感知删除并中止运行，host 级联删除记录 |
| 归档会话 | 记录保留；触发按钮随会话一起消失 |
| 渲染进程重载或崩溃 | Main 中止该发送方的运行；不写入任何内容 |
| 应用退出 | 进行中的运行被中止；已完成的结果已经持久化 |
| 模型被移除或凭据被清除 | 下次运行以 `PROGRESS_MODEL_UNAVAILABLE` 失败；弹层提供模型视图 |

### 7.8 持久化行为

- 汇报持久保存，重启后仍保留历史。
- host 在与插入相同的事务里把每个会话裁剪到最新 100 份汇报。
- `progress.reports.append` 按 `runId` 幂等，重试插入不会产生重复记录。
- 删除会话时通过 `ON DELETE CASCADE` 删除其汇报，与 `session_todo` 使用的是同一条路径。
- 自动采集设置存在同一组按会话划分的记录里（`progress_settings`），重启后保留，随会话删除
  而消失。

### 7.9 隔离保证

下表每一行都是失败即关闭的：即使模型回复是恶意的，相关机制也无法写入会话。

| 层面 | 保证 | 实现方式 |
| --- | --- | --- |
| 工具面 | 不向 `completeOneShot` 传任何工具 | `Context` 以 `tools: []` 构建，没有工具循环 |
| 对话记录 | 不向 `messages` 或 `turns` 写入任何内容 | 该路径唯一的写方法是 `progress.reports.append` |
| 回合槽位 | 不调用 `agent/prompt`，不调用 `session.prompt` | 该路径从不调用 agent 或 sidecar 方法 |
| 会话配置 | 不调用 `session.configure` | 模型选择保存在 `progress_settings` |
| 运行状态 | 不写 `compactionInProgress`、`isRunning` 或运行状态 | host 方法只写一组数据表 |
| 提醒 | 不产生未读标记、toast 或系统通知 | Main 只把结果返回给发起调用的渲染进程 |
| 锁 | 从不进入 prompt、compact、BTW 共用的按会话串行器 | Main 通过 `session.get` 读取，不获取 agent 锁 |
| 并发 | Main 限制每会话一个运行、全应用三个 | 派发前检查登记表（不影响 ADR 0041 的准入预算） |

提示词里“只依据摘要回答”那句只是建议，和 BTW 的只读框架一样。真正让保证成立的是上表。

## 8. 关键代码设计

以下名称都是提案。每个签名都对照基线中相邻的代码拟定，实现者可以保留这些边界并自由改名。

### 8.1 共享契约（`packages/shared/src/progress.ts`）

```ts
export type ProgressTrigger = "manual" | "auto" | "turnEnd";
export type ProgressModelRef =
  | { followSession: true }
  | { providerId: string; modelId: string };

export type ProgressReport = {
  id: string;
  sessionId: string;
  runId: string;
  createdAt: number;
  trigger: ProgressTrigger;
  providerId: string;
  modelId: string;
  status: "ok" | "unparsed";
  body: ProgressReportBody | null;
  raw: string | null;
  fingerprint: string;
  lastMessageId: string | null;
  messageCount: number;
  includedMessages: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  durationMs: number;
};

export const PROGRESS_INTERVALS = [1, 3, 5, 10, 15, 30] as const;

export function progressAvailableFor(session: { source?: string } | null): boolean;
```

完整类型（`ProgressReportBody`、`ProgressSettings`、`ProgressCollectResult`）见英文原文 § 8.1。

`progressAvailableFor` 仅对 `source` 为 `desktop` 的会话返回 true，与
`packages/shared/src/btw.ts:23-29` 一致。其他来源的请求会在登记运行之前被 Main 拒绝。

### 8.2 IPC 接口

`packages/shared/src/protocol.ts` 新增四个 invoke 通道，没有事件通道（§ 7.1）。

```ts
progressCollect: "pi-harbor/progress/collect",
progressCancel: "pi-harbor/progress/cancel",
progressReportsList: "pi-harbor/progress/reports/list",
progressSettingsSet: "pi-harbor/progress/settings/set",
```

`IPC_WHITELIST` 由同一文件中的 `IPC.invoke` 和 `IPC.event` 自动派生，因此 preload 桥不需要修改。
`apps/desktop/src/lib/api.ts` 在 `btwAsk`/`btwAbort`（`apps/desktop/src/lib/api.ts:1265`）
旁边新增四个薄封装。

### 8.3 Main：运行登记表与采集（`apps/desktop/electron/main/ipc/progress-ipc.ts`）

```ts
export function createProgressRuns(): {
  /** 该会话或全应用达到上限时以 PROGRESS_BUSY 拒绝。 */
  register(run: ProgressRun): void;
  settle(runId: string): void;
  abortSender(senderId: number): void;
  abortSession(sessionId: string): void;
  abortAll(): void;
  size(): number;
};
```

处理器沿用 BTW 的结构（`apps/desktop/electron/main/ipc/btw-ipc.ts`）：校验、登记、监听调用方
的 `did-start-navigation`、`render-process-gone` 和 `destroyed`，然后执行。采集主体很短，
因为逻辑都在纯模块里（§ 8.4）：

```ts
const window = await host.call("session.get", { id: sessionId, messageLimit: 200 });
const todos = await host.call("todos.get", { sessionId });
const latest = await host.call("progress.reports.latest", { sessionId });
const snapshot = buildProgressSnapshot({ session: window.session, messages: window.messages, todos });
if (request.trigger !== "manual" && latest?.fingerprint === progressFingerprint(snapshot)) {
  return { kind: "skipped", report: latest, skipped: true };
}
const launch = await resolveLaunch(sessionId, window.session, await host.call("settings.get"), {
  mode: "agent",
  ...resolveProgressModelRef(request.model, window.session),
  thinkingLevel: "off",
});
const result = await complete(runtimeProviderOf(launch), buildProgressPrompt(buildProgressDigest(snapshot), now()), "off", {
  signal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(PROGRESS_TIMEOUT_MS)]),
  maxOutputTokens: 1200,
  sessionId: `progress:${runId}`,
  emptyErrorCode: "PROGRESS_EMPTY_OUTPUT",
});
const report = await host.call("progress.reports.append", { ...row(parseProgressReport(result.text), snapshot) });
```

完整版本见英文原文 § 8.3。`resolveAgentRuntimeLaunch` 与 `completeOneShot` 正是插件
`agent.complete` 服务已在使用的组合（`apps/desktop/electron/main/services/plugin-services.ts:432-470`），
因此凭据处理、OAuth 和服务商请求头都不需要新增代码。

### 8.4 纯模块（`packages/agent-runtime/src/progress/`）

| 文件 | 导出 | 职责 |
| --- | --- | --- |
| `progress-snapshot.ts` | `buildProgressSnapshot`、`progressFingerprint` | 规范化窗口与清单，不做 I/O |
| `progress-digest.ts` | `buildProgressDigest` | 有预算上限的纯文本摘要（§ 7.2） |
| `progress-prompt.ts` | `buildProgressPrompt` | system 与 user 消息（§ 7.3） |
| `progress-parse.ts` | `parseProgressReport` | 宽容解析与原文回退（§ 7.3） |
| `progress-model.ts` | `resolveProgressModelRef` | 把 `ProgressModelRef` 解析成 provider/model 配对 |
| `index.ts` | 重新导出 | Main 与测试使用的公共接口 |

每个文件都远低于 500 行的建议值，且都不引入 Electron 或数据库，因此整个模块无需 host 即可
单元测试。

### 8.5 Host-core（`crates/host-core/src/progress/`）

参照 `session_team`（`crates/host-core/src/session_team/`）：一个模块，自带 `schema.sql`、
`repository.rs` 和带命名空间的 RPC 分支。两张表 `session_progress_reports` 与
`session_progress_settings` 的 DDL 见英文原文 § 8.5；两者都用
`REFERENCES sessions(id) ON DELETE CASCADE`。

RPC 方法，按 `session.team.*` 相同的 match 分支风格派发（`crates/host-core/src/rpc/mod.rs:2062`）：

| 方法 | 入参 | 出参 |
| --- | --- | --- |
| `progress.reports.append` | 汇报记录 | 存储后的 `ProgressReport` |
| `progress.reports.list` | `sessionId`、`limit`（默认 20）、`before` | `{ reports, nextCursor }` |
| `progress.reports.latest` | `sessionId` | `ProgressReport \| null` |
| `progress.settings.get` | `sessionId` | `ProgressSettings`（缺失时返回默认值） |
| `progress.settings.set` | `sessionId`、补丁 | `ProgressSettings` |

`append` 在同一事务内裁剪到最新 100 份；`set` 用 `PROGRESS_INTERVALS` 校验 `intervalMinutes`，
其他值以 `INVALID_PARAMS` 拒绝，因此存储的间隔永远可以渲染。

schema 30 → 31：新增一个迁移文件 `crates/host-core/src/db/session_progress_migration.rs`，
参照 `session_fast_mode_migration.rs:22-37`（备份、事务、`PRAGMA user_version = 31`），并把
`crates/host-core/src/db.rs:10` 的 `SCHEMA_VERSION` 改为 31，把 DDL 追加到全新安装的 schema。
已有会话没有记录，因此默认值路径必须在有数据的库上可用。

### 8.6 渲染进程（`apps/desktop/src/features/chat/progress/`）

```text
progress-types.ts      state shape, report view model
progress-store.ts      以会话 id 为键的 vanilla Zustand store（参照 BTW）
progress-scheduler.ts  createProgressScheduler({ now, setTimeout, api })
progress-service.ts    手动采集、取消、历史分页、设置写入
progress-controller.ts 单例装配 + 会话变化订阅
useProgressSession.ts  供按钮和弹层使用的按会话选择器 hook
```

这个 store **不是** `app-store.ts` 的一个 slice，遵循
`docs/superpowers/specs/2026-11-06-btw-read-only-side-questions-design.md:335` 的 BTW 规则，
因为 `apps/desktop/src/stores/app-store.ts` 是架构热点。

组件：`ProgressTrigger.tsx`（按钮与 `TooltipButton` 各状态）、`ProgressPopover.tsx`（头部、
控件、主体切换）、`ProgressReportCard.tsx`（固定四段）、`ProgressHistory.tsx`（时间线与分页）、
`ProgressModelView.tsx`（原地模型列表）。`ComposerToolbar.tsx` 增加一个元素；`Composer.tsx`
不修改。

样式放在新文件 `apps/desktop/src/styles/progress-report.css`，由
`apps/desktop/src/styles/globals.css` 引入；引入顺序就是层叠顺序，因此放在
`composer-menus.css` 之后、`responsive.css` 之前。只使用 `--ds-*`、`--radius-*`、`--text-*`、
`--leading-*`、`--motion-*` 等 token，因为 `scripts/check-style-tokens.mjs` 会拒绝原始字号与
圆角数值。

## 9. 错误码

在 `packages/shared/src/errors.ts` 的 `BTW_*` 区块（`packages/shared/src/errors.ts:299-305`）
旁新增稳定错误码：

| 错误码 | 触发条件 | 用户可见 |
| --- | --- | --- |
| `PROGRESS_UNAVAILABLE` | 会话不是本地桌面会话，或功能被关闭 | 不渲染按钮；直接调用会失败 |
| `PROGRESS_NO_SESSION` | 会话 ID 无法解析 | 错误行 |
| `PROGRESS_BUSY` | 该会话已有运行 | 提示“已有采集在进行”的错误行 |
| `PROGRESS_MODEL_UNAVAILABLE` | 服务商、模型或凭据缺失 | 带设置链接的模型不可用行 |
| `PROGRESS_TIMEOUT` | 60 秒预算耗尽 | 带重试的错误行 |
| `PROGRESS_PROVIDER_ERROR` | 服务商在其自身有限重试后仍返回错误 | 带重试的错误行；连续三次暂停自动采集 |
| `PROGRESS_EMPTY_OUTPUT` | 模型没有返回任何文本 | 错误行 |
| `PROGRESS_CANCELLED` | 用户取消，或渲染进程已销毁 | 静默处理，不产生记录 |

`PROGRESS_UNPARSED` **不是**错误码：未解析的结果是一条 `status: "unparsed"` 的记录，因为原文
本身仍有参考价值。

## 10. 安全与隐私

- **出口明确。** 弹层的模型视图会说明汇报会把会话摘要发送给所选服务商，模型列表底部再重复
  一次。用户不点采集就不发送，自动采集默认关闭。
- **数据最少化。** 只有摘要离开本机：工具输出最多 240 字符，图片和二进制从不发送，思考块
  从不发送，系统提示词和指令链也从不发送。
- **不新增权限。** 该路径使用用户已为所选服务商配置的凭据，与插件 `agent.complete` API 的
  解析方式相同。不新增权限、不放开沙箱例外、不绕过网络代理。
- **日志和存储里没有秘密。** `raw_text` 只保存模型输出。服务商请求头、请求体和凭据从不随
  汇报持久化，Rust 审计路径不受影响。
- **模型输出视为不可信。** 汇报文本按纯文本渲染，长度受限，且从不被解释为命令、文件引用或
  链接目标。
- **仅本地。** 汇报只存放在本地 SQLite 中，不参与配置同步、不上传，对插件和 MCP 服务不可见。
- **删除可信。** 删除会话时通过现有级联删除其汇报和设置；除 100 条裁剪外没有其他保留策略。

需要在 `docs/spec/05-security/01-security.md` 补充隐私条款（§ 13）：目前没有任何规则覆盖
“桌面端自身把会话上下文发给第二个模型”这一内建功能。

## 11. 持久化与兼容性

- schema v30 → v31 是纯增量：两张新表，不修改任何已有表或列。
- 已有数据库按标准的“先备份再事务”步骤迁移。升级前创建的会话没有进度设置；`settings.get`
  直接返回默认值而不写入，因此读取不会产生变更。
- 旧版本应用会忽略新表；`PRAGMA user_version` 会阻止降级，而不是静默误读数据。
- IPC 是纯增量。不认识这些通道的渲染进程不会调用它们；Main 对未知的 `progress.*` 载荷以
  `INVALID_PARAMS` 拒绝。
- 会话、对话记录、回合、计划和待办行为都不改变，因此未使用该功能时已有会话行为完全一致。
- `progress.reports.append` 按 `run_id` 幂等，这对 host 重启后重试写入很重要。

## 12. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 估算不准或前后漂移 | 用户不再信任“预计剩余” | 置信度徽标、“模型估算”说明、不显示百分比（ADR 0175）、摘要不足时返回空估算 |
| 每隔一段时间的第二次模型调用产生费用 | 意外开销 | 默认关闭、默认 5 分钟、预设从 1 分钟起、两侧都强制间隔下限、可见的暂停状态、100 条上限 |
| 450px 宽度下限时按钮挤占左下角那一行 | 工具栏被裁切 | 宽度正好 28px，不替换任何已有控件，且排在最前面，已有控件位置不变；模式和权限 chip 本来就会省略号截断 |
| 出现重复或竞争的第二份清单 | 两个事实来源（ADR 0312） | 汇报是散文，不可编辑、不回写，清单项只作为摘要上下文出现 |
| 自动采集在不可见时持续运行 | 后台开销与耗电 | 窗口不可见保护、渲染进程自持定时器、连续三次失败后暂停 |
| 静默失败掩盖了采集中断 | 过期的汇报看起来像最新的 | 暂停提示、过期标记、按钮提示里的上次运行时间 |
| 弹层被裁切容器截断 | 首页上面板无法使用 | `AnchoredMenu` 挂到 `document.body`，输入框的溢出无法裁切它（ADR 0066） |
| 模型视图嵌套菜单的层级问题 | 模型列表被弹层盖住 | 模型视图原地替换弹层主体，不存在第二层 |
| 摘要泄露用户未预期的工具输出 | 隐私意外 | 工具输出截断到 240 字符、图片替换、不含思考块，并明确说明出口 |

## 13. 实现影响

### 13.1 新增文件

| 路径 | 用途 |
| --- | --- |
| `packages/shared/src/progress.ts` | 类型、常量、`progressAvailableFor`、请求解析 |
| `packages/agent-runtime/src/progress/*.ts` | 快照、摘要、提示词、解析器、模型解析（§ 8.4） |
| `apps/desktop/electron/main/ipc/progress-ipc.ts` | 运行登记表与处理器装配（§ 8.3） |
| `apps/desktop/src/features/chat/progress/*.ts(x)` | store、调度器、服务、控制器、组件（§ 8.6） |
| `apps/desktop/src/styles/progress-report.css` | 样式，仅使用 token |
| `crates/host-core/src/progress/{mod.rs,schema.sql,repository.rs}` | host 模块 |
| `crates/host-core/src/db/session_progress_migration.rs` | v30 → v31 |
| `docs/adr/0350-session-progress-report.md` | 实现时编写的 ADR |

### 13.2 修改文件

| 路径 | 变更 |
| --- | --- |
| `packages/shared/src/protocol.ts` | 四个 invoke 通道 |
| `packages/shared/src/errors.ts` | 八个 `PROGRESS_*` 错误码 |
| `apps/desktop/src/lib/api.ts` | `btwAsk`/`btwAbort` 旁的四个 invoke |
| `apps/desktop/src/features/chat/composer/ComposerToolbar.tsx` | `.composer-left` 中增加一个元素 |
| `apps/desktop/src/components/icons.tsx` | `IconActivity` |
| `apps/desktop/src/styles/globals.css` | 引入新样式文件 |
| Electron Main 的 IPC 注册处 | 注册处理器，入口文件保持轻量 |
| `packages/i18n/src/locales/*/index.ts` | 九种语言词条 |
| `crates/host-core/src/{main.rs,db.rs,db/repositories.rs,rpc/mod.rs,db/schema.rs}` | 模块注册、`SCHEMA_VERSION = 31`、迁移分支、RPC 分支、全新安装 DDL |
| `docs/spec` 下的 IPC、host RPC、数据存储、运行时、模型选择、错误码、状态机、组件、交互、设计系统、IA 规范 | 见英文原文 § 13.2 的完整清单 |
| `docs/spec/05-security/01-security.md` | 摘要出口的隐私条款（§ 10） |
| `docs/spec/06-delivery/04-e2e-test-plan.md` | `E2E-1180` 与追溯矩阵 |
| `docs/spec/08-meta/decisions-log.md`（含中文镜像） | D681 |
| `docs/zh-CN/spec/**` 镜像 | 同一次变更内更新的中文规范（ADR 0079） |
| `CHANGES.md` | 落地时的功能条目（仅设计文档不需要） |
| `docs/project/unreleased.md` | 一条面向用户的说明 |

## 14. 测试

| 层级 | 内容 |
| --- | --- |
| 单元（agent-runtime） | 摘要预算与截断、工具结果裁剪、图片替换、提示词结构、解析器宽容度（代码围栏、JSON 前后的散文、数字字符串、缺失数组、越界值）、指纹稳定性、模型解析失败 |
| 单元（渲染进程，纯函数） | § 7.6 决策表每一行、过期比较、未读圆点优先级、间隔格式化 |
| 契约（shared + Main） | `parseProgressCollectRequest` 拒绝远程与原生会话；第二次运行返回 `PROGRESS_BUSY`；用记录式假 host 断言只会调用 `session.get`、`todos.get`、`progress.*` 和一次服务商补全 |
| Host（Rust） | 追加并裁剪到 100 条、`run_id` 幂等、删除会话级联、设置默认值不写入、`intervalMinutes` 校验、在有数据的 v30 库上迁移 |
| 渲染进程组件 | 按钮状态与 aria、弹层分段与空状态、历史切换与分页、模型视图切换、错误与未解析视图（SSR 渲染并打桩 `window.piDesktop`，参照 `apps/desktop/test/composer-mode-menu.test.mjs`） |
| E2E | 假服务商上手动采集新增一条历史且对话记录不变；无新进展的自动检查不存储；回合运行期间的采集让该回合的事件和最终消息保持逐字节一致 |

最重要的一条是隔离测试：必须断言主回合发往服务商的请求与其持久化消息不因并发采集而改变，
做法与 BTW 的差分测试相同。

### 14.1 编码前需要确认的事实

以下内容仅通过阅读代码得出，未运行验证：

1. `session.get` 的窗口语义，以及它是否返回消息总数（用于“N 条中的 M 条”）。
2. `todos.get` 是否返回可参与指纹的版本号。
3. 没有已加载运行时时，`resolveAgentRuntimeLaunch` 需要的入参结构。
4. `completeOneShot` 的选项是否已支持 `sessionId` 和 `emptyErrorCode`。
5. Electron 运行时版本中 `AbortSignal.any` 的确切行为。
6. 在最前面加入 28px 控件后，450px 下限的测量是否变化（需前后各测一次）。

## 15. 交付阶段

| 阶段 | 内容 |
| --- | --- |
| P1 | 共享类型、纯模块、单元测试，无 UI、无存储 |
| P2 | host 模块、schema v31、RPC、Rust 测试 |
| P3 | Main 处理器、运行登记表、契约测试 |
| P4 | 按钮、弹层、汇报卡片、历史、模型视图、样式、i18n |
| P5 | 调度器与自动采集设置、过期标记与未读圆点 |
| P6 | E2E、规范更新、新增 ADR（编号 0350）、决策日志、`CHANGES.md`、`unreleased.md` |

每个阶段都可以独立评审，且都保持应用可构建。P1–P3 没有可见产出，因此评审者也可以停在 P5，
不会留下半成品 UI。

## 16. 决策

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| D1 | 作为核心功能，不做插件 | 只有核心输入框元素能占据左下角最前面的位置（§ 4.1） |
| D2 | 在 Main 中调用一次 `completeOneShot`，不使用 sidecar 旁路运行 | 已加载和未加载的会话都能工作，并避开执行主回合的进程（§ 4.2） |
| D3 | 只用 invoke 的 IPC，不设事件通道 | 没有任何流式内容，发起调用的渲染进程是唯一消费者 |
| D4 | 历史持久化在 host-core，schema v31 | 重载不能丢弃已经花过 token 的汇报（§ 4.4） |
| D5 | 按会话的设置存在 host，模型作为不可拆分的配对 | 遵循 ADR 0305 的配对规则；`session/configure` 仍只在空闲时可用（ADR 0073） |
| D6 | 自动采集默认关闭，默认 5 分钟，预设 1/3/5/10/15/30 | 用户要求可配置间隔；1 分钟是有意义的下限 |
| D7 | 渲染进程自持调度器，配合纯决策函数 | 不给 Main 或 sidecar 增加长期资源（§ 4.3） |
| D8 | 用已持久化的对话记录窗口做快照，而不是活的 `Agent` | 保证主回合从不被观察或加锁 |
| D9 | 宽容 JSON 加原文回退 | 固定格式必须在任何服务商上都能渲染 |
| D10 | 模型视图原地替换弹层主体 | 避免嵌套浮层被弹层盖住 |
| D11 | 估算由模型撰写，配置信度徽标 | 尊重 ADR 0175 对百分比和进度卡片的否决 |
| D12 | 永不写入清单 | ADR 0312 规定 TodoDock 是唯一的会话清单 |

## 17. 产品决策（2026-11-19 已确认）

产品负责人在 2026-11-19 接受了全部推荐默认值。这些决策对实现有约束力；改动其中任何一条都属于
新决策，不是实现细节。

| 编号 | 问题 | 决策 |
| --- | --- | --- |
| Q1 | 默认采集间隔 | **5 分钟**，预设 1/3/5/10/15/30。自动采集在用户开启之前保持关闭。5 分钟在成本与“汇报过期”之间取得平衡，需要更快时仍可选 1 分钟 |
| Q2 | 汇报模型的作用范围 | **按会话保存。** 默认 `followSession`；显式选择的模型只写入该会话的 `progress_settings`。长时间的调试会话可以选一个便宜快速的模型，而不影响其他会话 |
| Q3 | 历史保留量 | **每会话最新 100 条。** 按 5 分钟节奏约覆盖 8 小时的多小时会话，同时把表控制在很小规模 |
| Q4 | 回合结束采集 | **保留。** 每个间隔最多触发一次，且只在自动采集开启时生效，因此能在不每回合采集的前提下提高新鲜度 |
| Q5 | 未解析记录 | **保留并在历史中可见**，用空心状态点和原文展示。隐藏它们等于隐藏“某个模型一直不符合格式”这个事实 |
| Q6 | 按服务商微调提示词 | **暂不做。** 宽容解析器加原文回退已能覆盖服务商差异；按服务商调整提示词需要单独决策，并以一个具体的失败样例为依据 |

设计中被固定的后果：

- `PROGRESS_DEFAULT_INTERVAL = 5`，`autoEnabled` 默认 `false`（§ 8.1、§ 8.5）。
- `intervalMinutes` 在写入时按 `PROGRESS_INTERVALS` 校验，调度器在每次心跳前重新读取（§ 7.6）。
- 裁剪到 100 条发生在追加事务内（§ 8.5）。
- `turnEnd` 触发保留在 `ProgressTrigger` 与调度器决策表中（§ 6.4、§ 7.6）。
- `status: "unparsed"` 的记录以空心圆点显示在时间线里（§ 6.5）。
