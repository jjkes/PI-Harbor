# Session Progress Report: Read-Only Progress Snapshots from the Composer

## Status and scope

- Status: Proposed design, 2026-11-19. Not implemented. Implementation needs a new
  ADR (next free number 0350), a decision-log row (D681), and the spec updates in
  § 13.
- Branch: `feature/进度汇报` in worktree `.pi/worktree/进度汇报`.
- Inspected baseline: `b038dff99` (2026-11-19).
- Deliverables: this document and a static UI prototype at
  `docs/design/session-progress-report.html`. The prototype uses the real token
  values from `apps/desktop/src/styles/tokens.css`; it is a reading aid, not
  product code.
- Validation: code references were checked against the baseline by read-only
  reconnaissance. § 14.2 lists the facts that implementation must confirm first.
- Scope: local desktop sessions (`source: "desktop"`), the same boundary as BTW
  (ADR 0346). Remote and Pi-native sessions do not render the trigger.
- Product decisions: confirmed by the product owner on 2026-11-19 (§ 17). No
  product question is left open; implementation may start at § 15 P1.

## 1. Request

The user asked for:

1. A small progress-report button inside the bottom-left corner of the Composer.
2. Clicking it opens a small popover that offers a model selector (which model
   writes the report), an action to collect and view progress now, and an
   automatic-collection switch with a configurable interval.
3. After a collection, the popover shows the current progress in a fixed format:
   what is done, what is in progress, what comes next, and roughly how many steps
   and how much time remain.
4. Collection is asynchronous. It takes a snapshot of the current session context
   and asks the configured model. The popover shows when the snapshot was taken.
5. History is hidden by default. A button at the bottom reveals a timeline the
   user can scroll through.
6. Collecting never interrupts or affects the session.

## 2. Current behavior

No progress-report feature exists. Three nearby surfaces shape the design:

| Surface | What it is | Why it is not the requested feature |
| --- | --- | --- |
| TodoDock (ADR 0312) | Agent-written checklist in the Composer dock, durable in `session_todo` | The agent writes it; it has no "remaining time", and no other path may write it |
| BTW (ADR 0346) | Read-only side question; an ephemeral run seeded from a snapshot of the main runtime | Free-form Q&A in a work-panel tab; nothing is persisted; it uses the session's model |
| Live activity status (ADR 0175, ADR 0198) | Quiet phase labels while a turn runs | ADR 0175 rejected a permanent multi-step progress card because turns have no reliable step or percentage model |

Reusable pieces at the baseline:

- `completeOneShot(provider, context, thinkingLevel, options)` in
  `packages/agent-runtime/src/one-shot-complete.ts:83` runs one tool-free
  completion. Electron Main already calls it for the plugin `agent.complete` API
  (`apps/desktop/electron/main/services/plugin-services.ts:457`) after resolving
  credentials with `resolveAgentRuntimeLaunch`
  (`apps/desktop/electron/main/runtime/session-launch.ts:323`).
- Host RPC `session.get` reads a transcript window (`messageLimit`,
  `messageBefore`; `crates/host-core/src/rpc/mod.rs:3012`), and `todos.get`
  returns the session checklist (`crates/host-core/src/rpc/mod.rs:3068`).
- BTW's Main registry aborts runs when the owning renderer navigates, crashes,
  or closes (`apps/desktop/electron/main/ipc/btw-ipc.ts:60-74`).
- `AnchoredMenu` (`apps/desktop/src/components/settings/AnchoredMenu.tsx`)
  portals a measured, viewport-fixed surface with outside-press and Escape
  dismissal, focus-in, and focus restore.
- `session_team` (`crates/host-core/src/session_team/`) is a per-session host
  module with its own DDL, repository, and namespaced RPC arm. The schema
  version is 30 (`crates/host-core/src/db.rs:10`).

## 3. Goals and non-goals

Goals:

- One trigger at the leading edge of the Composer's bottom-left toolbar group, in
  home and thread-docked Composers, for local desktop sessions.
- Manual collection at any time, including while a turn runs, and opt-in
  automatic collection per session at a user-chosen interval.
- A fixed four-part report (Completed, In progress, Next, Remaining) with the
  collection time, trigger, model, and how much of the session the snapshot
  covered.
- A history timeline, hidden by default, that survives restart.
- Zero effect on the session: no change to its transcript, context, run state,
  queue, turn slot, configuration, unread state, or notifications, and no wait on
  the main turn.

Non-goals:

- Steering, pausing, or prompting the session from a report.
- A second checklist. The report reads the TodoDock and never writes it
  (ADR 0312).
- A percentage, a progress bar, or a transcript progress card (ADR 0175,
  ADR 0198).
- Remote and Pi-native sessions, collection while the app is closed,
  cross-session dashboards, export, toasts, and native notifications.
- Restoring the background pre-computation that ADR 0064 removed.

## 4. Options

### 4.1 Where the feature lives

| Option | Verdict | Reason |
| --- | --- | --- |
| A. Core feature, like BTW (ADR 0346) | **Chosen** | The trigger must lead the bottom-left group. The plugin outlet `ComposerControlSlots side="left"` renders after the mode and permission chips (`apps/desktop/src/features/chat/composer/ComposerToolbar.tsx:236`), so a plugin cannot own the corner |
| B. Bundled plugin over `agent.complete` | Rejected | Cannot take the corner position. ADR 0323 moved model-written titles out of core because they spent tokens and changed sessions automatically; a report spends tokens only after the user opts in and changes nothing, the reasoning that kept BTW in core |

### 4.2 How a report runs

| Option | Verdict | Reason |
| --- | --- | --- |
| A. One tool-free `completeOneShot` call in Electron Main over a bounded digest of the persisted transcript | **Chosen** | Reuses the `agent.complete` credential path, never touches the sidecar that runs the main turn, and works when the session has no loaded runtime, for example after a restart |
| B. Ephemeral side run in the sidecar seeded from `sideQuestionSnapshot()`, like BTW | Rejected | Needs a loaded runtime, so it either launches one for an idle session or cannot report after a restart; adds sidecar RPC methods; runs in the process that executes the main turn |
| C. Prompt the session itself, or fork a child session | Rejected | Occupies the turn slot (ADR 0053), writes the transcript, and creates unread marks (ADR 0107). ADR 0268 already removed side chats |

Main hosts the request but does not own report logic. The digest, prompt,
fingerprint, and parser are pure functions in `packages/agent-runtime/src/progress/`;
Main only wires them, the way `plugin-services.ts` wires `completeOneShot` today.

### 4.3 Who schedules automatic collection

| Option | Verdict | Reason |
| --- | --- | --- |
| A. A renderer service with a pure decision function and an injected clock | **Chosen** | Stops with the window; adds no long-lived resource to Main or the sidecar; the decision table is unit-testable |
| B. A timer in Electron Main | Rejected | Main stays a thin orchestrator; a timer that outlives the window needs its own lifecycle and becomes a second scheduler |
| C. A timer in the sidecar | Rejected | Reintroduces the background request machinery that ADR 0064 deleted |

### 4.4 Where history and settings live

| Option | Verdict | Reason |
| --- | --- | --- |
| A. Host-core tables, schema v31, cascading on session delete | **Chosen** | Survives restart; deleting a session removes its reports; SQLite stays host-owned (ADR 0041) |
| B. Renderer memory, like BTW threads | Rejected | A reload discards reports that already spent tokens |
| C. Renderer `localStorage` | Rejected | Outside host ownership and config sync; no cascade on session delete |

### 4.5 Report format

| Option | Verdict | Reason |
| --- | --- | --- |
| A. One JSON object, tolerant parser, raw-text fallback | **Chosen** | Renders the fixed layout on every provider |
| B. Free-form Markdown | Rejected | The four sections would not render consistently |
| C. Provider-native structured output | Deferred | Provider support is uneven; it can sit under A later |

## 5. Architecture

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

The agent sidecar and the live `Agent` are not on this path. Main calls no
`agent.*`, `session.configure`, `session.appendMessage`, or notification method.

## 6. UI design

The prototype `docs/design/session-progress-report.html` renders every state in
this section in the dark and light themes.

### 6.1 Trigger

- Placement: the first child of `.composer-left` in
  `apps/desktop/src/features/chat/composer/ComposerToolbar.tsx:168`, before the
  attach button. `Composer.tsx`, an architecture hotspot, does not change.
- Form: a `TooltipButton` with `className="icon-btn icon-btn-square"` (28×28,
  `--ds-control-size`) and a new `IconActivity` (lucide `Activity`, 15px) in
  `components/icons.tsx`. ADR 0031 bans only a brand mark in the prompt row, and
  the toolbar already carries icon buttons. `ListChecks` is avoided because it
  reads as the TodoDock checklist.
- Render rule: shown when `progressAvailableFor(session)` holds; otherwise not
  rendered (no session yet, remote, Pi-native), the way dictation and live voice
  hide. It stays enabled while a turn runs and while `controlsBlocked` is true,
  because it never configures the session (ADR 0073).

| State | Visual | Tooltip |
| --- | --- | --- |
| Idle | `--ds-text-secondary` glyph | Progress report |
| Hover | `--ds-bg-hover` fill | Progress report · last 3 min ago |
| Open | `.active` fill, `aria-expanded="true"` | None while open |
| Collecting | 11px `.tool-spinner` replaces the glyph, `aria-busy="true"` | Collecting progress… |
| Auto on | 5px `--ds-success` corner dot | Auto-collect every 5 min |
| Unseen report | 6px `--ds-accent` corner dot, wins over the auto dot | New progress report |

ARIA: `aria-haspopup="dialog"`, `aria-expanded`, `aria-controls`, and an
`aria-label` that appends "new report available" while a report is unseen.

### 6.2 Popover

- Primitive: `AnchoredMenu` with `role="dialog"`, `side="top"` (its default is
  `bottom`), `align="start"`, the default `initialFocus="selected"` — which lands
  on the first enabled button because no row carries `aria-selected` — and
  `menuClassName="progress-popover"`. No fourth popover mechanism is added.
- Surface: `width: min(376px, calc(100vw - 24px))`,
  `max-height: min(560px, calc(100vh - 92px))`, `--radius-md-plus` (14px),
  `--ds-bg-elevated-opaque`, `1px --ds-border-default`, `--ds-shadow-dialog`, and
  z-index 60, the body-portaled layer of the design system (§ 9). Left alignment
  keeps the panel inside the main pane: at the 450px pane floor the trigger's
  left edge plus 376px still ends inside the pane.
- Motion: opacity plus `translateY(4px)` over `--motion-duration-fast` with
  `--motion-ease-out`; opacity only under reduced motion.
- One scroll container: the header and footer stay fixed, the body scrolls.

```text
┌ Progress report                      ● Auto · every 5 min ┐  header
│ [Bot  gpt-4.1-mini           ⌄]  [Collect now]            │  controls
│ Auto-collect                                      [ ●  ]  │  SettingsToggle
│ [1m] [3m] [5m] [10m] [15m] [30m]                          │  SegmentedControl
│ Next check ≈ 14:32 · skipped when nothing changed         │  hint
├───────────────────────────────────────────────────────────┤
│ report card, state view, or history timeline              │  scroll body
├───────────────────────────────────────────────────────────┤
│ History 12                                             ⌄  │  footer
└───────────────────────────────────────────────────────────┘
```

Controls use the shared primitives required by `apps/desktop/src/AGENTS.md`: a
primary small `Button` for Collect now, `SettingsToggle`, `SegmentedControl` with
radio roles, and a ghost `Button` for the footer. The interval row and the hint
show only while auto is on.

### 6.3 Report card

| Part | Content | Style |
| --- | --- | --- |
| Meta line | Absolute time (`Intl`, app locale), relative time, trigger (Manual, Auto, Turn end), "Based on the latest 40 of 86 messages", and a Stale chip when the session has moved on | `--text-2xs`, `--ds-text-muted`, tabular numbers, `·` separators |
| Completed | 0 to 8 bullets | 6px `--ds-success` dot, `--ds-text-secondary` |
| In progress | 0 to 3 bullets | 6px `--ds-warning` dot, `--ds-text-primary` |
| Next | 0 to 5 bullets | 6px `--ds-text-faint` dot |
| Remaining | ≈ N steps · ≈ M min, a confidence badge (low, medium, high), and "Model estimate, may be off" | `--ds-tile` tile, `--text-lg` semibold numbers |

An empty list renders "Nothing yet" and a null estimate renders "Unknown". The
estimate is never a percentage or a bar (ADR 0175). Report text renders as plain
text, not Markdown. Relative time imports `formatRelativeMoment`
(`apps/desktop/src/features/scheduled/scheduled-format.ts:45`) instead of adding
a fifth relative-time helper.

### 6.4 Model view

Clicking the model chip replaces the popover body in place with a back row, a
search field, and a list, the pattern of the Composer model × reasoning menu
(`docs/spec/04-ux/08-component-spec.md` § 11.3). No second floating menu opens:
the Composer model menu sits at z-index 40 and would paint under this popover.

- First row: "Follow session model", with the session's current model as
  secondary text.
- Then configured models grouped by recent and provider, rendered with
  `ComposerModelList` over the catalog store (`providers`, `providerModels`,
  `recentModels`). This is the configured-model picker of
  `docs/spec/03-runtime/13-model-catalog-and-selection.md` § 9.2.
- No reasoning slider: reports request thinking `off` (§ 7.5).
- A footer line: "Reports send a session digest to this model's provider."

### 6.5 History timeline

- The footer button reads "History N" and toggles the body between the current
  view and the timeline. It is disabled while N is 0.
- Order: newest first, so the first entry is the latest report.
- Collapsed item: a status dot (filled when parsed, hollow when unparsed), the
  time, relative time and trigger, the first In progress bullet (or "Output did
  not match the format"), and the Remaining line. The item is a button with
  `aria-expanded`.
- Expanding an item reveals its full sections in place, plus model, coverage,
  and token usage.
- Paging: `progress.reports.list` returns 20 rows per page with a cursor; "Load
  earlier reports" fetches the next page. The host keeps the newest 100 reports
  per session (§ 8.4).
- Skipped ticks, cancelled runs, and failed runs create no rows.

### 6.6 States

| State | Body | Header |
| --- | --- | --- |
| Never collected | "No progress report yet" with a one-line explanation | Collect now enabled |
| First collection running | Spinner, "Generating a progress report…", "The session is not affected", Cancel | Collect now shows a spinner, disabled |
| Latest report | Report card | Collect now enabled |
| Refreshing | The previous report stays visible | Collect now shows a spinner |
| Stale | Report card with the Stale chip | Unchanged |
| Skipped | Unchanged; the hint reads "Checked 14:32 · no new activity" | Unchanged |
| Error | Inline alert with reason, time, "The session was not affected", and Retry, above the previous report | Unchanged |
| Unparsed | Warning row and the raw model text in a monospace block | Unchanged |
| Auto paused | Notice "Paused after 3 failed collections", the last error, and Resume | Status reads "Auto paused" |
| Model unavailable | Warning row and a link to model settings | Collect now disabled |

### 6.7 Interaction and accessibility

- Click, Enter, or Space toggles the popover; hover never opens it (ADR 0047).
- Outside press and Escape close it and restore focus to the trigger
  (`docs/spec/04-ux/09-interaction-patterns.md`, Floating dropdown surfaces).
- Opening moves focus to the first enabled control. Tab and Shift+Tab cycle
  inside the popover through `onMenuKeyDown`, because the portaled surface sits
  outside the document's tab order.
- `role="dialog"` with `aria-label`. A polite live region announces "New
  progress report collected" only while the popover is open. Errors use
  `role="alert"`.
- Switching the active session closes the popover. That session's run continues
  and lands in its own history.
- A background result never moves focus, opens the popover, or shows a toast; it
  only sets the trigger's unseen dot.

### 6.8 Strings and i18n

Keys live under `chat.progressReport` in `packages/i18n/src/locales/*/index.ts`;
the table omits that prefix.

| Key | en | zh-CN |
| --- | --- | --- |
| `trigger.label` | Progress report | 进度汇报 |
| `trigger.lastCollected` | Progress report · last {{time}} | 进度汇报 · 上次 {{time}} |
| `trigger.collecting` | Collecting progress… | 正在采集进度… |
| `trigger.autoOn` | Auto-collect every {{minutes}} min | 自动采集：每 {{minutes}} 分钟 |
| `trigger.unseen` | New progress report | 有新的进度汇报 |
| `trigger.unseenAria` | Progress report, new report available | 进度汇报，有新汇报 |
| `title` | Progress report | 进度汇报 |
| `status.autoOff` | Auto-collect: off | 自动采集：关 |
| `status.autoEvery` | Auto · every {{minutes}} min | 自动 · 每 {{minutes}} 分钟 |
| `status.autoPaused` | Auto paused | 自动已暂停 |
| `collectNow` | Collect now | 立即采集 |
| `collecting` | Collecting | 采集中 |
| `cancel` | Cancel | 取消 |
| `retry` | Retry | 重试 |
| `resume` | Resume | 恢复 |
| `auto.label` | Auto-collect | 自动采集 |
| `auto.intervalLabel` | Collection interval | 采集间隔 |
| `auto.intervalOption` | {{minutes}} min | {{minutes}} 分 |
| `auto.nextCheck` | Next check ≈ {{time}} · skipped when nothing changed | 下次检查约 {{time}} · 会话没有新进展时自动跳过 |
| `auto.skipped` | Checked {{time}} · no new activity | {{time}} 已检查 · 没有新进展 |
| `auto.pausedTitle` | Paused after {{count}} failed collections | 已暂停：连续 {{count}} 次采集失败 |
| `auto.pausedLastError` | Last error: {{message}} | 最近错误：{{message}} |
| `empty.title` | No progress report yet | 还没有进度汇报 |
| `empty.body` | Collect now builds a report from a snapshot of this session. It runs in the background and never interrupts the session. | 点击“立即采集”，基于当前会话快照生成一份汇报。采集在后台进行，不会打断会话。 |
| `running.title` | Generating a progress report… | 正在生成进度汇报… |
| `running.body` | The session is not affected. Keep working or close this panel. | 会话不受影响，你可以继续对话或关闭此窗口。 |
| `meta.trigger.manual` | Manual | 手动 |
| `meta.trigger.auto` | Auto | 自动 |
| `meta.trigger.turnEnd` | Turn end | 回合结束 |
| `meta.coverage` | Based on the latest {{included}} of {{total}} messages | 基于最近 {{included}} / {{total}} 条消息 |
| `meta.stale` | Session has moved on | 会话已有新进展 |
| `meta.previous` | Previous report | 上一份汇报 |
| `section.completed` | Completed | 已完成 |
| `section.inProgress` | In progress | 进行中 |
| `section.next` | Next | 下一步 |
| `section.remaining` | Remaining | 预计剩余 |
| `section.empty` | Nothing yet | 暂无 |
| `remaining.steps` | ≈ {{count}} steps | ≈ {{count}} 步 |
| `remaining.minutes` | ≈ {{count}} min | ≈ {{count}} 分钟 |
| `remaining.unknown` | Unknown | 未知 |
| `remaining.confidence.{low,medium,high}` | Confidence: low / medium / high | 置信度 低 / 中 / 高 |
| `remaining.note` | Model estimate, may be off | 模型估算，仅供参考 |
| `error.title` | Collection failed: {{reason}} | 采集失败：{{reason}} |
| `error.timeout` | the model did not answer within {{seconds}} s | 模型请求超时（{{seconds}} 秒） |
| `error.busy` | a collection is already running for this session | 该会话已有采集在进行 |
| `error.notAffected` | {{time}} · the session was not affected | {{time}} · 会话未受影响 |
| `unparsed.title` | Output did not match the format | 模型输出不符合固定格式 |
| `unparsed.body` | Showing the raw text. A model that is better at structured output may help. | 已显示原文。可换用更擅长结构化输出的模型后重新采集。 |
| `model.unavailableTitle` | The selected model is unavailable | 所选模型不可用 |
| `model.unavailableBody` | {{model}}'s provider was removed or has no credential. Pick another model or configure the provider in Settings. | {{model}} 的服务商已被移除或缺少凭据。请重新选择模型，或在设置中配置服务商。 |
| `model.openSettings` | Open model settings | 打开模型设置 |
| `model.pick` | Choose a model | 选择模型 |
| `model.viewTitle` | Report model | 汇报模型 |
| `model.search` | Search configured models | 搜索已配置的模型 |
| `model.followSession` | Follow session model | 跟随会话模型 |
| `model.followSessionChip` | Session · {{model}} | 跟随会话 · {{model}} |
| `model.recent` | Recent | 最近使用 |
| `model.egress` | Reports send a session digest to this model's provider. | 汇报会把会话摘要发送到所选模型的服务商。 |
| `history.toggle` | History {{count}} | 历史记录 {{count}} |
| `history.hide` | Hide history | 收起历史 |
| `history.heading` | History · {{count}} reports, newest first | 历史记录 · {{count}} 份，按时间倒序 |
| `history.loadMore` | Load earlier reports | 加载更早的记录 |
| `history.unparsedLine` | Output did not match the format (raw text) | 输出不符合格式（显示原文） |
| `history.inProgressLine` | In progress: {{text}} | 进行中：{{text}} |
| `history.remainingLine` | Remaining ≈ {{steps}} steps · ≈ {{minutes}} min | 剩余 ≈ {{steps}} 步 · ≈ {{minutes}} 分钟 |
| `live.newReport` | New progress report collected | 已采集新的进度汇报 |

Plural forms follow the catalog's existing `count` convention. The seven other
locales are translated at implementation time, and
`packages/i18n/test/renderer-keys.test.mjs` fails until all nine catalogs have
every key.

## 7. Logic design

### 7.1 Collection pipeline (Main)

`pi-harbor/progress/collect` is one invoke that resolves when the run settles.
There is no event channel: nothing streams, and the invoking renderer is the
only consumer.

1. Validate the request (`parseProgressCollectRequest`) and reject sessions that
   are not local desktop sessions.
2. Register the run: at most one per session (`PROGRESS_BUSY` otherwise) and three
   app-wide. Observe the sender for navigation, crash, and close.
3. Resolve the model (§ 7.5). Missing provider, model, or credential fails with
   `PROGRESS_MODEL_UNAVAILABLE` before any request is sent.
4. Read `session.get` with `messageLimit` (newest window, 200 messages) and
   `todos.get`.
5. Compute the fingerprint (§ 7.4). For an `auto` or `turnEnd` trigger whose
   fingerprint equals the latest stored report's, return `skipped` without a
   model call.
6. Build the digest and the prompt (§ 7.2 and § 7.3), both pure.
7. Call `completeOneShot` with no tools, thinking `off`, `maxOutputTokens` 1,200,
   and a 60 s timeout combined with the run's abort signal.
8. Parse the text (§ 7.3) into `ok` with a body, or `unparsed` with the raw text
   capped at 4,000 characters.
9. Persist through `progress.reports.append` and resolve with the stored row.

The renderer scheduler keeps automatic runs to two at a time, so a manual run
always finds a free slot under Main's cap of three.

### 7.2 Snapshot digest (pure)

`buildProgressDigest(input)` turns the transcript window into a budgeted,
plain-text digest. It reads only; it never mutates the messages it receives.

| Item | Rule |
| --- | --- |
| Window | The newest messages first, back to at most 200 messages, always cut at a turn boundary so a tool call and its result stay together |
| Budget | 6,000 estimated tokens (`estimateTokens` from the runtime's existing token helper). Older messages are dropped first; the first user message of the session is always kept as an anchor |
| User | Full text, capped at 600 characters per message |
| Assistant text | Capped at 800 characters per message |
| Assistant thinking | Omitted |
| Tool calls | One line each: name, first argument keys, and the first 160 characters of the value |
| Tool results | First 240 characters, plus `ok`/`error`; binary and image payloads become `<image>` |
| Checklist | Rendered from `todos.get` as a compact list with status markers |
| Session facts | Mode, permission mode, model id, turn count in the window, first and last message timestamps |

The digest is what the model sees. It is never shown in the UI, and it is not
stored, so a report cannot leak file contents later through the popover.

### 7.3 Prompt and parser (pure)

`buildProgressPrompt(digest, now)` returns one system message and one user
message:

- System: "You summarize an in-progress coding session for its user. Answer only
  from the digest. Do not invent files, commands, or results. Reply with a
  single JSON object and nothing else."
- User: the digest, then the required shape:

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

with the limits from § 6.3, `remainingSteps` an integer 0–99 or `null`,
`remainingMinutes` an integer 0–600 or `null`, and one instruction: "estimate
only from the pace visible in the digest; use null when the digest does not
support an estimate."

`parseProgressReport(text)` is tolerant:

1. Trim; strip a leading or trailing Markdown code fence.
2. Take the outermost `{...}` span and `JSON.parse` it.
3. Accept missing arrays as empty, coerce numeric strings, clamp every list and
   number to its limit, and drop non-string items.
4. A missing `inProgress` plus a missing `completed` marks the whole answer
   unparsed, because the model answered something else.
5. On any failure, return `unparsed` with the raw text capped at 4,000
   characters. The run still persists, and the popover shows the raw view.

### 7.4 Fingerprint, staleness, dedupe

- `progressFingerprint({ lastMessageId, messageCount, todosRevision })` is a short
  hash of the newest durable message id, the message count, and the checklist
  revision.
- An `auto` or `turnEnd` run whose fingerprint equals the newest stored report's
  fingerprint returns `skipped` and stores nothing.
- A manual run always runs.
- Staleness is renderer-side, like BTW (ADR 0346): a report is stale when the
  session's newest message id differs from the one recorded with the report.
  That check is a store comparison and costs no IPC.

### 7.5 Model resolution

`ProgressModelRef = { followSession: true } | { providerId: string; modelId: string }`.

- `followSession` resolves to the session's current provider and model, the same
  pair the Composer shows, read from `session.get`.
- An explicit pair resolves through the catalog and the credential store. It is
  checked before the request: provider exists, model is in the provider's model
  list, and a credential or a working auth mode is present. A failure raises
  `PROGRESS_MODEL_UNAVAILABLE` with the reason in `details`.
- Reports always request thinking `off` and `maxOutputTokens` 1,200, whatever the
  session's reasoning level is, so a report is cheap and fast.
- Changing the report model never calls `session.configure` and never changes
  what the session sends on its next turn (ADR 0073).

### 7.6 Automatic collection scheduler (renderer)

One service owns all automatic runs: `createProgressScheduler()` with an
injected clock, timer, and API port, in the style of the BTW service.

- Scope: only sessions that have auto-collect enabled and have been collected at
  least once, because the newest report's fingerprint is the dedupe baseline.
- Tick: one self-rescheduling `setTimeout` for all enabled sessions, not one timer
  per session. The next tick is scheduled after each tick completes, so a slow
  collection cannot pile up.
- Decision function, pure and unit-tested:

| Condition | Action |
| --- | --- |
| No enabled sessions | Wait |
| Auto off, or the session was deleted | Stop tracking it |
| A run is in flight for that session | Skip this tick |
| Two automatic runs already in flight | Skip this tick |
| Now − last collected < interval | Wait |
| The session gained no message and no checklist change since the last report | Record `skipped`, wait |
| Otherwise | Start an `auto` run |

- Session end: when a turn finishes and auto is on, one `turnEnd` run is queued
  for that session if the interval has not expired; the interval still applies,
  so a chatty session does not collect on every turn.
- Failure handling: three consecutive failures for a session pause its auto mode
  and show the paused notice (§ 6.6). A manual success resumes it.
- Cleanup: the scheduler stops on renderer unload, on disabling auto for the last
  session, and on app quit. Main aborts in-flight runs when the renderer
  navigates, crashes, or closes (same registry pattern as BTW), and does not
  retry.
- Cost guard: an automatic run never starts while the app window is hidden; the
  next visible tick collects if the data changed.

### 7.7 Lifecycle

| Event | Behavior |
| --- | --- |
| Turn running | Collection proceeds; the digest reads persisted messages only, and the turn is not observed or waited on |
| Turn ends | `turnEnd` collection if auto is on (§ 7.6) |
| Popover closed mid-run | The run continues; the result lands in history and sets the unseen dot |
| Active session switched | The popover closes; runs for other sessions continue |
| Session deleted | Main sees the delete, aborts the run, and the host cascades the rows |
| Session archived | Rows are kept; the trigger disappears with the session |
| Renderer reload or crash | Main aborts that sender's runs; nothing is written for them |
| App quit | In-flight runs are aborted; a completed run is already persisted |
| Model removed or credentials cleared | Next run fails with `PROGRESS_MODEL_UNAVAILABLE`; the popover offers the model view |

### 7.8 Persistence behavior

- Reports are durable, so a restart keeps the history.
- The host prunes to the newest 100 reports per session inside the same
  transaction as the insert.
- `progress.reports.append` is idempotent per `runId`, so a retried append cannot
  duplicate a row.
- Deleting a session deletes its reports through `ON DELETE CASCADE`, the same
  path `session_todo` uses.
- The auto-collect setting lives in the same per-session row family
  (`progress_settings`), so it survives a restart and dies with the session.

### 7.9 Isolation guarantees

Every row below is fail-closed: the machinery cannot write to the session even if
a model reply is hostile.

| Layer | Guarantee | Enforcement |
| --- | --- | --- |
| Tool surface | No tools are passed to `completeOneShot` | `Context` is built with `tools: []`; there is no tool loop |
| Transcript | Nothing is appended to `messages` or `turns` | The only write method the path calls is `progress.reports.append` |
| Turn slot | No `agent/prompt`, no `session.prompt` | The path never calls an agent or sidecar method |
| Configuration | No `session.configure` | Model choice lives in `progress_settings` |
| Run state | No `compactionInProgress`, `isRunning`, or run-status write | The host method writes one table family |
| Attention | No unread mark, toast, or native notification | Main returns the result only to the invoking renderer |
| Locking | The per-session keyed serializer used by prompt, compact, and BTW is never entered | Main reads through `session.get`, which takes no agent lock |
| Concurrency | Main caps one run per session and three app-wide | Registry check before dispatch (ADR 0041 admission budget untouched) |

The prompt's "answer only from the digest" line is advisory, like BTW's
read-only framing. The table above is what makes the guarantee real.

## 8. Key code design

Names below are proposals. Every signature was shaped against the baseline code
it sits next to, so the implementer can keep the boundaries and rename freely.

### 8.1 Shared contract (`packages/shared/src/progress.ts`)

```ts
export type ProgressTrigger = "manual" | "auto" | "turnEnd";
export type ProgressConfidence = "low" | "medium" | "high";

export type ProgressModelRef =
  | { followSession: true }
  | { providerId: string; modelId: string };

export type ProgressReportBody = {
  completed: string[];
  inProgress: string[];
  next: string[];
  remainingSteps: number | null;
  remainingMinutes: number | null;
  confidence: ProgressConfidence | null;
};

export type ProgressReport = {
  id: string;
  sessionId: string;
  runId: string;
  createdAt: number;
  trigger: ProgressTrigger;
  providerId: string;
  modelId: string;
  /** `unparsed` still carries a row so the history can show what happened. */
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

export type ProgressSettings = {
  sessionId: string;
  model: ProgressModelRef;
  autoEnabled: boolean;
  /** Minutes. One of PROGRESS_INTERVALS; default 5. */
  intervalMinutes: number;
  lastCollectedAt: number | null;
  consecutiveFailures: number;
  updatedAt: number;
};

export const PROGRESS_INTERVALS = [1, 3, 5, 10, 15, 30] as const;
export const PROGRESS_DEFAULT_INTERVAL = 5;

export type ProgressCollectResult =
  | { kind: "ok"; report: ProgressReport; skipped: false }
  | { kind: "skipped"; report: ProgressReport | null; skipped: true }
  | { kind: "error"; code: string; message: string; retriable: boolean };

/** Same fail-closed shape as `btwAvailableFor`. */
export function progressAvailableFor(session: { source?: string } | null): boolean;

export function parseProgressCollectRequest(input: unknown): ProgressCollectRequest;
```

`progressAvailableFor` returns true only for a session whose `source` is
`desktop`, mirroring `packages/shared/src/btw.ts:23-29`. A request for any other
source is rejected in Main before the run is registered.

### 8.2 IPC surface

`packages/shared/src/protocol.ts` gains four invoke channels; there is no event
channel (§ 7.1).

```ts
progressCollect: "pi-harbor/progress/collect",
progressCancel: "pi-harbor/progress/cancel",
progressReportsList: "pi-harbor/progress/reports/list",
progressSettingsSet: "pi-harbor/progress/settings/set",
```

`IPC_WHITELIST` is derived from `IPC.invoke` and `IPC.event` in that same file, so
the preload bridge needs no change. The renderer API in
`apps/desktop/src/lib/api.ts` adds four thin invokes next to `btwAsk`/`btwAbort`
(`apps/desktop/src/lib/api.ts:1265`).

### 8.3 Main: run registry and collection (`apps/desktop/electron/main/ipc/progress-ipc.ts`)

```ts
export type ProgressIpcDependencies = {
  host: HostRpcPort;
  resolveLaunch: typeof resolveAgentRuntimeLaunch;
  complete: typeof completeOneShot;
  now: () => number;
};

type ProgressRun = {
  runId: string;
  sessionId: string;
  senderId: number;
  trigger: ProgressTrigger;
  controller: AbortController;
  startedAt: number;
};

export function createProgressRuns(): {
  /** Rejects with PROGRESS_BUSY when the session or the app cap is reached. */
  register(run: ProgressRun): void;
  settle(runId: string): void;
  abortSender(senderId: number): void;
  abortSession(sessionId: string): void;
  abortAll(): void;
  size(): number;
};
```

The handler keeps the BTW shape (`apps/desktop/electron/main/ipc/btw-ipc.ts`):
validate, register, observe the sender's `did-start-navigation`,
`render-process-gone`, and `destroyed`, then run. The collection body stays small
because the work lives in the pure module (§ 8.4):

```ts
const window = await host.call<SessionWindow>("session.get", {
  id: sessionId,
  messageLimit: PROGRESS_WINDOW_MESSAGES, // 200
});
const todos = await host.call<TodoSnapshot | null>("todos.get", { sessionId });
const latest = await host.call<ProgressReport | null>("progress.reports.latest", { sessionId });

const snapshot = buildProgressSnapshot({ session: window.session, messages: window.messages, todos });
const fingerprint = progressFingerprint(snapshot);
if (request.trigger !== "manual" && latest?.fingerprint === fingerprint) {
  return { kind: "skipped", report: latest, skipped: true };
}

const launch = await resolveLaunch(sessionId, window.session, await host.call("settings.get"), {
  mode: "agent",
  ...resolveProgressModelRef(request.model, window.session),
  thinkingLevel: "off",
});
const digest = buildProgressDigest(snapshot);
const context = buildProgressPrompt(digest, now());
const result = await complete(runtimeProviderOf(launch), context, "off", {
  signal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(PROGRESS_TIMEOUT_MS)]),
  maxOutputTokens: 1200,
  sessionId: `progress:${runId}`,
  emptyErrorCode: "PROGRESS_EMPTY_OUTPUT",
});
const parsed = parseProgressReport(result.text);
const report = await host.call<ProgressReport>("progress.reports.append", { ...row(parsed, snapshot) });
```

`resolveAgentRuntimeLaunch` and `completeOneShot` are the exact pair the plugin
`agent.complete` service already uses
(`apps/desktop/electron/main/services/plugin-services.ts:432-470`), so credential
handling, OAuth, and provider headers need no new code.

### 8.4 Pure module (`packages/agent-runtime/src/progress/`)

| File | Exports | Responsibility |
| --- | --- | --- |
| `progress-snapshot.ts` | `buildProgressSnapshot`, `progressFingerprint` | Normalizes the window plus the checklist; no I/O |
| `progress-digest.ts` | `buildProgressDigest` | Budgeted plain-text digest (§ 7.2) |
| `progress-prompt.ts` | `buildProgressPrompt` | System and user messages (§ 7.3) |
| `progress-parse.ts` | `parseProgressReport` | Tolerant parse with the raw fallback (§ 7.3) |
| `progress-model.ts` | `resolveProgressModelRef` | `ProgressModelRef` to a provider/model pair |
| `index.ts` | re-exports | Public surface for Main and tests |

Each file stays well under the 500 LOC guidance, and none of them imports
Electron or the database, so the whole module is unit-testable without a host.

### 8.5 Host-core (`crates/host-core/src/progress/`)

Mirrors `session_team` (`crates/host-core/src/session_team/`): a module with its
own `schema.sql`, a `repository.rs`, and a namespaced RPC arm.

```sql
CREATE TABLE IF NOT EXISTS session_progress_reports (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  trigger       TEXT NOT NULL CHECK (trigger IN ('manual','auto','turnEnd')),
  provider_id   TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok','unparsed')),
  body_json     TEXT,
  raw_text      TEXT,
  fingerprint   TEXT NOT NULL,
  last_message_id TEXT,
  message_count INTEGER NOT NULL,
  included_messages INTEGER NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  duration_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_progress_reports_session
  ON session_progress_reports(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS session_progress_settings (
  session_id           TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  model_json           TEXT NOT NULL,
  auto_enabled         INTEGER NOT NULL DEFAULT 0,
  interval_minutes     INTEGER NOT NULL DEFAULT 5,
  last_collected_at    INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL
);
```

RPC methods, dispatched from the same match arm style as `session.team.*`
(`crates/host-core/src/rpc/mod.rs:2062`):

| Method | Input | Output |
| --- | --- | --- |
| `progress.reports.append` | report row | stored `ProgressReport` |
| `progress.reports.list` | `sessionId`, `limit` (default 20), `before` | `{ reports, nextCursor }` |
| `progress.reports.latest` | `sessionId` | `ProgressReport \| null` |
| `progress.settings.get` | `sessionId` | `ProgressSettings` (defaults when absent) |
| `progress.settings.set` | `sessionId`, patch | `ProgressSettings` |

`append` prunes inside the same transaction:
`DELETE FROM session_progress_reports WHERE session_id = ?1 AND id NOT IN (SELECT id ... ORDER BY created_at DESC LIMIT 100)`.
`set` validates `intervalMinutes` against `PROGRESS_INTERVALS` and rejects
anything else with `INVALID_PARAMS`, so a stored interval is always renderable.

Schema 30 → 31: one migration file
`crates/host-core/src/db/session_progress_migration.rs` following
`session_fast_mode_migration.rs:22-37` (backup, transaction, `PRAGMA user_version
= 31`), plus `SCHEMA_VERSION = 31` in `crates/host-core/src/db.rs:10` and the DDL
appended to the fresh-install schema. Existing sessions get no rows, so the
defaults path must work on a populated database.

### 8.6 Renderer (`apps/desktop/src/features/chat/progress/`)

```text
progress-types.ts      state shape, report view model
progress-store.ts      vanilla Zustand store keyed by session id (BTW precedent)
progress-scheduler.ts  createProgressScheduler({ now, setTimeout, api })
progress-service.ts    manual collect, cancel, history paging, settings writes
progress-controller.ts singleton wiring + the session-change subscription
useProgressSession.ts  per-session selector hook for the trigger and popover
```

The store is **not** an `app-store.ts` slice, following the BTW rule in
`docs/superpowers/specs/2026-11-06-btw-read-only-side-questions-design.md:335`,
because `apps/desktop/src/stores/app-store.ts` is an architecture hotspot.

```ts
export type ProgressSessionState = {
  settings: ProgressSettings;
  latest: ProgressReport | null;
  history: { reports: ProgressReport[]; cursor: string | null; loading: boolean };
  run: { runId: string; trigger: ProgressTrigger; startedAt: number } | null;
  historyOpen: boolean;
  modelViewOpen: boolean;
  unseen: boolean;
  lastError: { code: string; message: string; at: number } | null;
  lastSkippedAt: number | null;
};
```

Components: `ProgressTrigger.tsx` (button plus `TooltipButton` states),
`ProgressPopover.tsx` (header, controls, body switch), `ProgressReportCard.tsx`
(the fixed four sections), `ProgressHistory.tsx` (timeline plus paging), and
`ProgressModelView.tsx` (in-place model list). `ComposerToolbar.tsx` gains one
element; `Composer.tsx` does not change.

CSS lives in a new partial `apps/desktop/src/styles/progress-report.css` imported
by `apps/desktop/src/styles/globals.css`; import order is the cascade, so it goes
after `composer-menus.css` and before `responsive.css`. Only `--ds-*`,
`--radius-*`, `--text-*`, `--leading-*`, and `--motion-*` tokens are used, because
`scripts/check-style-tokens.mjs` rejects raw typography and radius values.

## 9. Error codes

New stable codes in `packages/shared/src/errors.ts`, next to the `BTW_*` block
(`packages/shared/src/errors.ts:299-305`):

| Code | When | User-visible |
| --- | --- | --- |
| `PROGRESS_UNAVAILABLE` | Session is not a local desktop session, or the feature is disabled | Trigger is not rendered; a direct call fails |
| `PROGRESS_NO_SESSION` | Session id does not resolve | Error row |
| `PROGRESS_BUSY` | A run already exists for that session | Error row with "already running" |
| `PROGRESS_MODEL_UNAVAILABLE` | Provider, model, or credential missing | Model-unavailable row with a settings link |
| `PROGRESS_TIMEOUT` | The 60 s budget expired | Error row with Retry |
| `PROGRESS_PROVIDER_ERROR` | The provider returned an error after its own bounded retries | Error row with Retry; three in a row pause auto |
| `PROGRESS_EMPTY_OUTPUT` | The model returned no text | Error row |
| `PROGRESS_CANCELLED` | The user cancelled, or the renderer went away | Silent; no row |

`PROGRESS_UNPARSED` is **not** an error code: an unparsed answer is a stored
report with `status: "unparsed"`, because the raw text is still useful.

## 10. Security and privacy

- **Egress is explicit.** The popover's model view states that reports send a
  session digest to the chosen provider. The footer of the model list repeats it.
  Nothing is sent until the user collects, and automatic collection is off by
  default.
- **Least data.** Only the digest leaves the machine, never raw tool output beyond
  240 characters, never images or binaries, never thinking blocks, and never the
  system prompt or instructions chain.
- **No new privilege.** The path uses the credentials the user already configured
  for the chosen provider, the same resolution the plugin `agent.complete` API
  uses. It adds no permission, no sandbox exception, and no network proxy bypass.
- **No secrets in logs or storage.** `raw_text` holds model output only. Provider
  headers, request bodies, and credentials are never persisted with a report; the
  Rust audit path is untouched.
- **Untrusted model output.** Report text renders as plain text, is length-capped,
  and is never interpreted as a command, a file reference, or a link target.
- **Local only.** Reports stay in the local SQLite database. They are not part of
  config sync, not uploaded, and not visible to plugins or MCP servers.
- **Deletion is honest.** Deleting a session deletes its reports and settings
  through the existing cascade; there is no separate retention beyond the 100-row
  prune.

A privacy clause must be added to `docs/spec/05-security/01-security.md` (§ 13):
no current rule covers the desktop itself sending session context to a second
model for a built-in feature.

## 11. Persistence and compatibility

- Schema v30 → v31 is additive: two new tables, no change to existing tables or
  columns.
- Existing databases migrate with the standard backup-then-transaction step.
  Sessions created before the upgrade have no progress settings; `settings.get`
  returns defaults without writing, so a read never mutates.
- Older app versions ignore the new tables; `PRAGMA user_version` guards the
  upgrade so a downgrade is refused rather than silently mis-reading data.
- IPC is additive. A renderer that does not know the channels never calls them;
  Main rejects unknown `progress.*` payloads with `INVALID_PARAMS`.
- No session, transcript, turn, plan, or todo behavior changes, so existing
  sessions behave identically when the feature is unused.
- `progress.reports.append` stays idempotent per `run_id`, which matters if Main
  retries a write after a host restart.

## 12. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Estimates are wrong or drift | Users lose trust in the "remaining" line | Confidence badge, "model estimate" note, no percentage (ADR 0175), and a null estimate when the digest is thin |
| A second model call per interval costs money | Surprise spend | Off by default, 5 min default, presets starting at 1 min, interval floor enforced on both sides, visible paused state, and 100-report cap |
| The trigger crowds the bottom-left row at the 450 px floor | Toolbar clipping | It is exactly 28 px wide, replaces no existing control, and is the leading item, so every existing control keeps its position; the mode and permission chips already ellipsize |
| Duplicate or rival checklist | Two sources of truth (ADR 0312) | The report is prose, never editable, never written back, and shows checklist items only as digest context |
| Auto-collect keeps running invisibly | Background cost and battery | Window-hidden guard, renderer-owned timer, pause after three failures |
| A silent failure hides that collection stopped | Stale reports look current | The paused notice, the stale chip, and the trigger's last-run tooltip |
| Popover inside a clipped container | Panel unreachable on home | `AnchoredMenu` portals to `document.body`, so the composer's overflow cannot clip it (ADR 0066) |
| Model view nested menu z-order | Model list hidden under the popover | The model view replaces the popover body in place, so no second layer exists |
| Digest leaks tool output the user did not expect | Privacy surprise | 240-character tool truncation, image replacement, no thinking blocks, and a stated egress line |

## 13. Implementation impact

### 13.1 New files

| Path | Purpose |
| --- | --- |
| `packages/shared/src/progress.ts` | Types, constants, `progressAvailableFor`, request parser |
| `packages/agent-runtime/src/progress/*.ts` | Snapshot, digest, prompt, parser, model resolution (§ 8.4) |
| `apps/desktop/electron/main/ipc/progress-ipc.ts` | Run registry, handler wiring (§ 8.3) |
| `apps/desktop/src/features/chat/progress/*.ts(x)` | Store, scheduler, service, controller, components (§ 8.6) |
| `apps/desktop/src/styles/progress-report.css` | Styles, tokens only |
| `crates/host-core/src/progress/{mod.rs,schema.sql,repository.rs}` | Host module |
| `crates/host-core/src/db/session_progress_migration.rs` | v30 → v31 |
| `docs/adr/0350-session-progress-report.md` | ADR at implementation time |

### 13.2 Modified files

| Path | Change |
| --- | --- |
| `packages/shared/src/protocol.ts` | Four invoke channels |
| `packages/shared/src/errors.ts` | Eight `PROGRESS_*` codes |
| `apps/desktop/src/lib/api.ts` | Four invokes next to `btwAsk`/`btwAbort` |
| `apps/desktop/src/features/chat/composer/ComposerToolbar.tsx` | One element in `.composer-left` |
| `apps/desktop/src/components/icons.tsx` | `IconActivity` |
| `apps/desktop/src/styles/globals.css` | Import the new partial |
| `apps/desktop/electron/main/index.ts` or the IPC registrar | Register the handler; keep the entry thin |
| `packages/i18n/src/locales/*/index.ts` | Nine catalogs |
| `crates/host-core/src/main.rs`, `db.rs`, `db/repositories.rs`, `rpc/mod.rs`, `db/schema.rs` | Module registration, `SCHEMA_VERSION = 31`, migration arm, RPC arms, fresh DDL |
| `docs/spec/03-runtime/01-ipc-protocol.md` | Channel group, error codes |
| `docs/spec/03-runtime/06-host-rpc-protocol.md` | Method catalog |
| `docs/spec/03-runtime/04-data-storage.md` | Two tables, v31 migration, prune rule |
| `docs/spec/03-runtime/02-agent-runtime.md` | Run section beside BTW |
| `docs/spec/03-runtime/13-model-catalog-and-selection.md` | Report-model resolution |
| `docs/spec/03-runtime/08-error-codes.md` | New codes |
| `docs/spec/03-runtime/10-session-state-machine.md` | Collection never enters the turn lifecycle |
| `docs/spec/04-ux/08-component-spec.md` | Composer anatomy, new § 11.3x, states, a11y, acceptance |
| `docs/spec/04-ux/09-interaction-patterns.md` | Popover row, focus flow |
| `docs/spec/04-ux/07-ui-design-system.md` | Second model picker exception, z-index note |
| `docs/spec/04-ux/01-ui-ia.md` | Overlay row |
| `docs/spec/05-security/01-security.md` | Privacy clause for the digest egress (§ 10) |
| `docs/spec/06-delivery/04-e2e-test-plan.md` | `E2E-1180`, traceability matrix |
| `docs/spec/08-meta/decisions-log.md` (+ zh-CN) | D681 |
| `docs/zh-CN/spec/**` mirrors | Same-change locale updates (ADR 0079) |
| `CHANGES.md` | Feature section at landing, not for the design doc alone |
| `docs/project/unreleased.md` | One user-facing bullet |

## 14. Tests

### 14.1 Planned coverage

| Level | Test |
| --- | --- |
| Unit (agent-runtime) | Digest budget and truncation; tool result capping; image replacement; prompt shape; parser tolerance (code fence, prose around JSON, numeric strings, missing arrays, out-of-range values); fingerprint stability; model resolution failures |
| Unit (renderer, pure) | Scheduler decision table for every row in § 7.6; staleness comparison; unseen-dot priority; interval formatting |
| Contract (shared + Main) | `parseProgressCollectRequest` rejects remote and native sessions; `PROGRESS_BUSY` on a second run; the handler issues only `session.get`, `todos.get`, `progress.*`, and one provider completion, asserted with a recording fake host |
| Host (Rust) | Append plus prune to 100; idempotency on `run_id`; cascade on session delete; settings defaults without a write; `intervalMinutes` validation; migration on a populated v30 database |
| Renderer component | Trigger states and aria; popover sections and empty states; history toggle and paging; model view switch; error and unparsed views (SSR-rendered with stubbed `window.piDesktop`, following `apps/desktop/test/composer-mode-menu.test.mjs`) |
| E2E | Manual collect on a fake provider adds one history row with no transcript change; auto tick with no new activity stores nothing; a collection during a running turn leaves the turn's events and final message byte-identical |

The isolation test is the one that matters most: it must assert that the main
turn's provider request and its persisted messages are unchanged by a concurrent
collection, the way BTW's differential test does.

### 14.2 Facts to confirm before coding

These were not verified by running code, only by reading it:

1. `session.get`'s exact window semantics and whether it reports a total message
   count for the "of N messages" line.
2. Whether `todos.get` returns a revision that can feed the fingerprint.
3. The shape `resolveAgentRuntimeLaunch` needs for a session without a loaded
   runtime, and whether it requires a `SessionSummary` for a deleted session.
4. Whether `completeOneShot`'s options already accept `sessionId` and
   `emptyErrorCode` as the plugin path suggests.
5. The exact behavior of `AbortSignal.any` in the Electron runtime version.
6. Whether the 450 px floor measurement changes when a 28 px control is added at
   the leading edge (measure before and after).

## 15. Delivery phases

| Phase | Content |
| --- | --- |
| P1 | Shared types, pure module, unit tests — no UI, no storage |
| P2 | Host module, schema v31, RPC, Rust tests |
| P3 | Main handler, run registry, contract tests |
| P4 | Trigger, popover, report card, history, model view, CSS, i18n |
| P5 | Scheduler plus auto-collect settings, staleness and unseen dot |
| P6 | E2E, spec updates, the new ADR (id 0350), decision log, `CHANGES.md`, `unreleased.md` |

Each phase is independently reviewable and leaves the app buildable. P1–P3 ship
nothing visible, so a reviewer can stop after P5 without a half-built UI.

## 16. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | Core feature, not a plugin | Only a core Composer element can take the leading bottom-left position (§ 4.1) |
| D2 | One `completeOneShot` call in Main, not a sidecar side run | Works for loaded and unloaded sessions, avoids the process that runs the main turn (§ 4.2) |
| D3 | Invoke-only IPC, no event channel | Nothing streams; the invoking renderer is the only consumer |
| D4 | Durable history in host-core, schema v31 | A reload must not discard a report that already cost tokens (§ 4.4) |
| D5 | Per-session settings in the host, model as an all-or-nothing pair | Follows ADR 0305's pair rule; `session/configure` stays idle-only (ADR 0073) |
| D6 | Auto-collect off by default, 5 min default, presets 1/3/5/10/15/30 | The user asked for a configurable interval; a 1 min floor is the useful limit |
| D7 | Renderer-owned scheduler with a pure decision function | No long-lived Main or sidecar resource (§ 4.3) |
| D8 | Persisted transcript window as the snapshot, not the live `Agent` | Guarantees the main turn is never observed or locked |
| D9 | Tolerant JSON with raw-text fallback | The fixed format must render on every provider |
| D10 | Model view replaces the popover body in place | Avoids a nested layer that would paint under the popover |
| D11 | Estimates are model-authored prose with a confidence badge | Respects ADR 0175's rejection of a percentage or progress card |
| D12 | No checklist writes, ever | ADR 0312 makes the TodoDock the only session checklist |

## 17. Product decisions (confirmed 2026-11-19)

The product owner accepted every recommended default on 2026-11-19. These are
binding for the implementation; changing one is a new decision, not an
implementation detail.

| # | Question | Decision |
| --- | --- | --- |
| Q1 | Default collection interval | **5 minutes**, with presets 1/3/5/10/15/30. Auto-collect stays off until the user turns it on. 5 min balances cost against a stale report, and 1 min remains available for a fast-moving session |
| Q2 | Report-model scope | **Per session.** `followSession` is the default; an explicit model is stored in that session's `progress_settings` only. A long debugging session can pick a cheap fast model without changing unrelated sessions |
| Q3 | History retention | **Newest 100 reports per session.** Enough to cover a multi-hour session at a 5 min cadence (about 8 hours), bounded enough that the table stays small |
| Q4 | Turn-end collection | **Kept.** It fires at most once per interval and only while auto is on, so it improves freshness without collecting on every turn |
| Q5 | Unparsed rows | **Kept and visible** in the history with a hollow status dot and the raw text. Hiding them would hide the fact that a model keeps failing the format |
| Q6 | Provider-specific prompt tweaks | **Not now.** The tolerant parser plus the raw-text fallback covers uneven providers; a per-provider prompt adjustment would need its own decision, backed by a failing example |

Consequences now fixed in the design:

- `PROGRESS_DEFAULT_INTERVAL = 5` and `autoEnabled` default `false` (§ 8.1, § 8.5).
- `intervalMinutes` is validated against `PROGRESS_INTERVALS` on write, and the
  scheduler re-reads it before each tick (§ 7.6).
- Prune to 100 happens inside the append transaction (§ 8.5).
- The `turnEnd` trigger stays in `ProgressTrigger` and in the scheduler's
  decision table (§ 6.4, § 7.6).
- `status: "unparsed"` rows render in the timeline with the hollow dot (§ 6.5).
