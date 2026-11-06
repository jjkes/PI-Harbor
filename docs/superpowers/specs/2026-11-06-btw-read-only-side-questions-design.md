# BTW: Read-Only Side Questions in the Work Panel

## Status and scope

- Status: Implemented on 2026-11-06 (ADR 0344, D680). Sections 12's questions were
  answered with the recommended defaults — a fresh snapshot per question with live
  status in the tab (Q1), T1 read-only tools (Q2), renderer-memory threads (Q3),
  external paths always denied (Q4), usage per answer only (Q5), the main session's
  provider/model/thinking level (Q6), and completed messages only (Q7).
- Branch: `feature/btw功能` in worktree `.pi/worktree/btw功能`.
- Inspected baseline: `9f693dfad` (2026-11-02). `origin/main` is an ancestor of `HEAD`.
- Deliverable: this design document plus the implementation it describes.
- Validation: every code reference below was checked against the baseline when the document was written.
- Scope: local desktop sessions (`source: "desktop"`). Remote and Pi-native sessions are out of scope for the first version.
- Implementation deviations, authoritative over the prose below: `started` carries
  `providerId`/`modelId`/`mainTurnRunning` and `BtwContextRevision` was dropped
  (§6.2/§6.8/§6.11 — staleness is a renderer-side baseline); the snapshot is
  `nextRequestDeclarations(agent.state.messages)` and the transcript already holds
  the composed system prompt from construction, so there is no first-request
  fallback, and extension `transformContext` handlers and Fast mode are not
  applied (§6.3/§6.5); the BTW block is merged only when the last message's role is
  literally `user` (§6.4); the audit payload records `accessProfile` and the run id
  travels inside `btw:<runId>:<toolCallId>`, `permissionScope` is also
  `INVALID_PARAMS`, and `tools.workspaceExecute` is not profile-aware (§6.7);
  `btw.ask` rejects a bad payload with `INVALID_ARGUMENT`; there is no automatic
  provider retry (§6.12); session archive does not abort a run because Main has no
  archive event, while session deletion does (§6.11).

## 1. Request

Typing `/btw` in the chat composer opens a new conversation in the collapsible right-side panel. That conversation follows the main session's context in real time. It is a read-only agent: it cannot perform write operations and only answers questions grounded in the main context.

How each part of the request maps to the design:

| Request | Design |
| --- | --- |
| `/btw` in the composer | A seventh builtin command, `builtin.session.btw`, with the slash alias `btw` (§6.1). |
| Collapsible right-side panel | A new `btw` tab kind in the existing work panel, one per session (§6.10). The work panel is the right-side dock of ADR 0151. |
| A new conversation | A multi-turn BTW thread held in renderer memory. It is not a durable host session and does not appear in the sidebar (Q3). |
| Follows the main context in real time | The tab shows the main session's live state. Every question is answered against a fresh snapshot of the main session's model-visible context, taken at send time, and each answer records which point it is based on (§6.2, Q1). |
| Read-only agent, no writes | Enforced in code at two independent layers, a runtime tool gate and a host-core access profile, not by prompt text (§6.6). Recommended tools: `Read`, `Glob`, `Grep` inside the workspace (Q2). |
| Only questions about the main context | The side request is the main context plus a framing message. BTW never acts on the main session and never speaks unprompted. |

## 2. Current behavior

### 2.1 Commands and composer

| Area | Behavior | Evidence |
| --- | --- | --- |
| Builtin registry | Exactly six first-party commands: `new`, `compact`, `agent-mode`, `plan-mode`, `goal-mode`, `fast`. ADR 0106 froze the registry at five; ADR 0334 added `/fast`. There is no `btw`. | `apps/desktop/electron/main/builtin-commands.ts:12`, [spec 04](../../spec/04-ux/04-builtin-commands.md) |
| Renderer dispatch | Builtin ids run in one `switch`. | `apps/desktop/src/lib/commands.ts:12` |
| Slash parsing | `parseSlashSubmission` splits `/name body`; `resolveSlashDispatch` returns `dispatch`, `prompt`, or `blocked`. | `apps/desktop/src/features/chat/composer/slash-dispatch.ts:24`, `:51` |
| Command body | Among builtins, only the three mode commands use a body. Any other builtin with a body falls through and is sent to the main session as prompt text. Extension commands receive their body separately. | `apps/desktop/src/features/chat/composer/hooks/useComposerSubmit.ts:134`, `:165`, `:177`, `:201` |
| Send gate | `sendBlocked` covers a pending approval, a paste in progress, and blocked native input. It ends the submission before slash dispatch, as does a steer that is not allowed. A running main turn does not block the composer. | `apps/desktop/src/components/Composer.tsx:258`, `apps/desktop/src/features/chat/composer/hooks/useComposerSubmit.ts:94` |
| Steering | Slash dispatch runs only when the submission is not a steer and local commands are allowed. | `apps/desktop/src/features/chat/composer/hooks/useComposerSubmit.ts:119` |
| Remote and Pi-native sessions | `localCommandsAllowed` is `sessionAllows(session, "canUseLocalTools")`. It is always false for a remote session, so `/btw` is sent there as plain text. Pi-native summaries omit the flag, a missing flag counts as allowed, and slash dispatch runs. | `apps/desktop/src/components/Composer.tsx:112`, `:453`, `apps/desktop/src/lib/remote-session-safety.ts:13`, `:16`, `packages/agent-runtime/src/native-pi-session.ts:703` |

### 2.2 Work panel

| Area | Behavior | Evidence |
| --- | --- | --- |
| Placement | A fixed-width, right-side, in-flow column. | [ADR 0151](../../adr/0151-internal-work-panel-dock.md) |
| Tab kinds | A closed union: `new`, `review`, `file`, `diff`, `plugin`, `subagent`. | `apps/desktop/src/lib/work-panel-tabs.ts:1` |
| Unknown kinds | Dropped when tab state is sanitized. | `apps/desktop/src/lib/work-panel-tabs.ts:258`, `:269` |
| Scope | Each session has its own panel context, swapped on session switch ([ADR 0028](../../adr/0028-session-scoped-work-panel-contexts.md)). | `apps/desktop/src/lib/work-panel-tabs.ts:61` |
| Persistence | Only the panel width is stored. Tabs live in memory. | `apps/desktop/src/stores/slices/work-panel-slice.ts:35`, `:51` |
| Session removal | Removing a session drops its panel context. | `apps/desktop/src/stores/slices/project-slice.ts:172` |
| Precedent | A delegate transcript already renders in a `subagent` tab. | `apps/desktop/src/components/workpanel/SubagentTranscriptTab.tsx`, `apps/desktop/src/components/workpanel/WorkPanel.tsx:1093` |

### 2.3 Agent runtime

| Area | Behavior | Evidence |
| --- | --- | --- |
| Model-visible context | `liveSessionContext()` builds the messages from the entries plus the active compaction checkpoint. | `packages/agent-runtime/src/runtime.ts:7642` |
| Running turn | Messages completed during a turn are appended to the live entries. | `packages/agent-runtime/src/runtime.ts:3231`, `:8660`, `:8987` |
| System prompt | The composed system prompt travels as a system transcript inside `agent.state.messages`. | `packages/agent-runtime/src/runtime.ts:2378` |
| Request hooks with side effects | `convertToLlm` persists system-journal messages through `session.appendMessage` before it converts. `prepareToolDeclarations` pushes tool-state messages into `agent.state.messages`. `extensionContext` runs extension `context` handlers. | `packages/agent-runtime/src/runtime.ts:2248`, `:2394`, `:2529` |
| Provider request | The provider-bound context is passed to `streamSimple`. | `packages/agent-runtime/src/runtime.ts:2216` |
| Read-only core set | `READ_ONLY_CORE_TOOLS` is `Read`, `Glob`, `Grep`. | `packages/agent-runtime/src/runtime.ts:1259` |
| Mode gate | `beforeToolCall` denies tools the current mode does not allow, and `withModeExecutionGuard` checks again at execution because "declarations are not grants". | `packages/agent-runtime/src/runtime.ts:2576`, `packages/agent-runtime/src/mode-tool-access.ts:20` |
| Tool execution | Every working tool calls `host.call("tools.execute")` with `sessionId`, `turnId`, `toolCallId`, and `mode`. | `packages/agent-runtime/src/runtime.ts:3567` |
| Runtime reuse | `runtimeFor` disposes and rebuilds a session's runtime when its launch configuration no longer matches. `agent.compact` already gets a runtime this way without a prompt. Between reading the registry and registering a new runtime, `runtimeFor` awaits host calls; the baseline shows no per-session creation guard. | `packages/agent-runtime/src/sidecar.ts:231`, `:260`, `:266`, `:350`, `:553` |
| Existing side runs | `completeOneShot` makes a host-owned call with no session history and no tools. A delegate compacts only its own in-memory context and writes nothing to host-core. | `packages/agent-runtime/src/one-shot-complete.ts:83`, `packages/agent-runtime/src/subagent-context.ts:1` |
| Events | Sidecar `agent.event` envelopes are keyed by `sessionId`. Electron Main tracks active tool calls from them and forwards them on `pi-harbor/agent/event/message`. | `apps/desktop/electron/main/runtime/sidecar.ts:197`, `packages/shared/src/protocol.ts:494` |

### 2.4 Host-core

| Area | Behavior | Evidence |
| --- | --- | --- |
| Tool parameters | `ToolsExecuteParams` carries `session_id`, an optional `turn_id`, `tool_call_id`, `mode`, an optional `permission_scope` (a permission mode for a delegate's call, ADR 0089), and an optional `delegation_id`. | `crates/host-core/src/tools/mod.rs:646` |
| Contract modes | In Plan and Goal the host denies tools outside `plan_mode_allows`, checked against the durable session mode. That list includes `Bash` and `BrowserPreview`, so Plan mode is not a read-only guarantee. | `crates/host-core/src/permissions.rs:144`, `crates/host-core/src/rpc/mod.rs:4603` |
| Permission scope | `permission_scope` accepts only valid permission modes. It changes how calls are approved, not which tools exist. | `crates/host-core/src/rpc/mod.rs:4384` |
| External paths | Outside `auto` and without a session grant, an external path raises a permission request owned by the session. | `crates/host-core/src/permissions.rs:232` |
| Audit | Audit rows are `(ts, kind, session_id, payload_json)`. | `crates/host-core/src/audit.rs:33` |

## 3. Why existing routes do not fit

| Route | Problem |
| --- | --- |
| Send or queue a prompt | The question enters the main context. It waits for the running turn or interrupts it, and it stays in the history. |
| Steer | The text is injected into the running turn and changes what the main agent does. |
| Fork (`session.fork`) | A durable child session with full tool rights, frozen at the fork point. It does not follow the main session afterwards. |
| `Task` delegate | Agent mode only, and the main agent starts it, not the user ([tools and permissions](../../spec/03-runtime/03-tools-and-permissions.md)). A delegate starts from its task, or on resume from its own earlier chain, never from the main context (`packages/agent-runtime/src/subagent.ts:202`, `packages/agent-runtime/src/runtime.ts:4982`). Its result goes into the parent transcript. |

### 3.1 Prior art in this repository

ADR message-quotes-and-side-chats added renderer-owned side chats: Open side chat forked the anchored message with `session.fork`, docked the child in a `sidechat:<childSessionId>` tab, and streamed it. [ADR 0268](../../adr/0268-remove-quotes-annotations-and-side-chats.md) removed them on 2026-09-16 because a side chat was "a second session lifecycle whose only durable artifact — the forked child — `session.fork` already produces". The retired decision and E2E ids must not be reused.

BTW avoids the reason for that removal. It creates no child session and no second session lifecycle. It reads the main context again for every question instead of freezing it at a fork anchor. It cannot write, and it uses a new `btw` tab kind instead of the retired `sidechat:` kind. BTW does add surface, which ADR 0268 also counted against side chats, so the new ADR has to justify it by what fork cannot provide: a live, read-only view of the main session that leaves nothing behind.

### 3.2 External prior art

Claude Code ships a `/btw` command. Third-party write-ups describe it as a side question answered while the main task keeps running, with the conversation as context, no tool use, and nothing added to the history ([wmedia.es](https://wmedia.es/en/tips/claude-code-btw-side-question), [claudefa.st](https://claudefa.st/blog/guide/mechanics/interactive-mode)). A reverse-engineered note reports that tool calls are blocked in the client while the full tool schema is still sent ([gist](https://gist.github.com/ZhangHanDong/a123f194fc0e68c9d408355bd10746c6)). These sources are unofficial and were not checked against Anthropic documentation. This design keeps that request shape (§5.2) and adds what the request asks for beyond it: a multi-turn thread in a docked panel and, optionally, read-only tools.

## 4. Goals and non-goals

Goals:

1. `/btw` and `/btw <question>` in the main composer, and a palette entry, open the session's BTW tab in the work panel.
2. Answers are grounded in the main session's current model-visible context, including the completed parts of a running turn.
3. Asking never blocks, queues, steers, or interrupts the main turn.
4. Read-only by construction: no file writes, no shell, no network, no delegation, and no host call that changes a session, a plan, or settings. This holds even if the model ignores its instructions.
5. Nothing from BTW reaches the main transcript, the main model context, compaction, plan state, the prompt queue, or session configuration.
6. Each answer shows which point of the main conversation it is based on, and whether the main session has moved on since.

Non-goals for the first version:

- BTW speaking unprompted, or answering again automatically when the main session changes.
- BTW threads that survive an app restart (Q3).
- Moving a BTW answer into the main chat. ADR 0268 removed the quote and prefill paths; Copy covers the need.
- Any tool outside the read-only set, including `Bash` (a shell command cannot be proven read-only), `BrowserPreview`, web access, MCP and plugin tools, `Task`, `SubmitPlan`, and `SubmitGoal`.
- A different model for BTW than the main session's (Q6).
- Remote and Pi-native sessions, the plugin API, and remote control.
- Image attachments in BTW questions.

## 5. Options

### 5.1 Architecture

| Option | Summary | Outcome |
| --- | --- | --- |
| A. Ephemeral side run (chosen) | For each question the sidecar starts a separate agent run, seeded from a read-only snapshot of the main runtime's context. The thread lives in renderer memory. | Follows the live context, read-only can be enforced, and there is no second session lifecycle. |
| B. Forked child session | The removed side chat. | Rejected: frozen at the fork point, full tool rights, a durable child, retired by ADR 0268. |
| C. Read-only `Task` delegate | Reuse the delegation registry with a read-only definition. | Rejected: delegations report into the parent transcript by design, run only in Agent mode, and start from their task instead of the main context. Hiding that would need special cases in the registry. Option A reuses only the low-level pieces: provider binding, the retry stream, and the context-budget formula. |
| D. Steer into the main agent | Ask through steering. | Rejected: it changes the main context. |
| E. Plugin over `agent.complete` | A plugin calls the one-shot completion API. | Rejected: a plugin cannot see the main session's post-compaction context, and the read-only guarantee would sit outside the host. |

### 5.2 Request shape

| Option | Summary | Outcome |
| --- | --- | --- |
| P1. Prefix parity (chosen) | Repeat the main session's system transcript, tool declarations, and model-visible messages unchanged, then append the BTW block. Execution is restricted, not declaration. | A provider's prefix cache can serve the shared prefix, and the tool-call history matches the declared tools. |
| P2. Dedicated prompt | A BTW system prompt with only the allowed tools declared. | Rejected as the default. The prefix differs from the first byte, so every question pays for the whole main context again, and the history contains calls to tools the request does not declare, which providers handle differently. |

P1 follows the existing rule that declarations are not grants (`packages/agent-runtime/src/mode-tool-access.ts:16`). Its cost is that the model can still try a declared tool, which is then denied; §6.4 bounds this. A cache hit depends on the provider and on routing, so the side request reuses the parent session's affinity identity (`packages/agent-runtime/src/session-affinity.ts:1`). Cache hits only affect cost. A test pins the prefix equality instead (§10).

### 5.3 Tool access

| Tier | Tools | Notes |
| --- | --- | --- |
| T0 | None; every tool call is denied. | Matches Claude Code. No host-core change, and no tool ever executes. Cannot check a file that the context does not contain or that changed since. |
| T1 (recommended) | `Read`, `Glob`, `Grep` on paths that need no permission request today (the workspace and the session's contained roots, such as scratch). | Matches "read-only agent" in the request. Needs the host-core access profile (§6.7) and a tool-round budget. |

Both tiers share the architecture. T0 is T1 with an empty allowlist and without §6.7. Q2 picks one.

## 6. Design

### 6.1 User flow

- `/btw` in the main composer opens or focuses the session's BTW tab, expands the panel if it is collapsed, and focuses the BTW input.
- `/btw <question>` does the same and then asks the question. The main draft is cleared only after the question is accepted.
- The palette entry `builtin.session.btw` opens the tab without a question.
- The steer shortcut does not turn `/btw ...` into steering text. The BTW branch sits after the send gate and before the slash-dispatch block, which skips steers (§2.1), so it also catches a steer. This is the one place where `/btw` behaves differently from the other builtins, because a side question must never enter the main turn.
- The main composer keeps its `sendBlocked` gate. While it is blocked, for example by a pending approval, the palette entry still opens the tab, and the BTW input itself is not blocked, so the user can ask what a pending command does before approving it.
- Without an active session the command shows a toast ("Start a conversation first"). An empty session is allowed, and the tab says that the main conversation is empty.
- In a remote session slash dispatch does not run, so `/btw` is sent as prompt text, like every builtin there. In a Pi-native session slash dispatch runs, so `/btw` shows `BTW_UNAVAILABLE` and keeps the draft. In both, the palette entry reports that BTW is unavailable.

Registry entry: `{ id: "builtin.session.btw", title: "Ask a side question", category: "Session", keywords: ["btw", "side", "question", "aside", "ask"], slash: "btw" }`. Risk: low. It is read-only, but each question spends tokens like a prompt.

### 6.2 What "real time" means

| Part | Behavior |
| --- | --- |
| Tab status | Derived from existing renderer state: main running or idle, compaction in progress, message count. No new subscription. |
| Model input | A snapshot of the main session's model-visible context, taken when a question is sent. A follow-up question takes a new snapshot. |
| Answer | Stores the snapshot revision. The footer shows when the snapshot was taken and, once the main session has moved on, how many messages it has added since or that it was compacted. Nothing is asked again automatically. |

The in-flight streaming text of the main turn is not part of the snapshot; only completed messages are (Q7).

### 6.3 Context snapshot

`DesktopAgentRuntime` (`packages/agent-runtime/src/runtime.ts:1739`) gets one narrow, read-only method:

```ts
sideQuestionSnapshot(): SideQuestionSnapshot; // deep copies, no host calls, no mutation
```

It returns the system prompt, messages, and tool declarations that the main session's next request would start with, the bound provider, model, and thinking level, the affinity identity, and the revision: the last entry id, the active checkpoint id, and whether a main turn is running.

The snapshot must not call the request hooks with side effects listed in §2.3. It is built in three steps:

1. When the main runtime sends a provider request, it keeps a reference to the provider-bound context it sent.
2. The snapshot is that context plus the messages completed since. The new messages go through the same pure steps main uses (`dropDuplicateToolCalls`, `convertToLlm`, `alignRetainedReasoningIdentity`), and duplicate tool-call ids are checked against the whole list.
3. Before a runtime's first request, the snapshot falls back to `liveSessionContext()` and the composed system transcript, without extension `context` handlers. That first question has no cached prefix to reuse and does not see extension-injected context.

Stage 1 of delivery (§11) splits the `convertToLlm` hook into its journal write and a pure conversion, and `prepareToolDeclarations` into a pure computation and the push into agent state. A differential test proves that main's provider request is byte-identical before and after.

A snapshot taken mid-turn can end with tool calls that have no result yet. Provider APIs such as Anthropic Messages and OpenAI Chat Completions require a result for every tool call, so the side request closes each open call with a synthetic result that exists only in that request: "No result yet: this call has not finished in the main conversation."

### 6.4 Side request

```text
[main system transcript]        identical to the main request
[main model-visible messages]   identical to the main request
[synthetic results]             only for tool calls not yet finished in main
[user] BTW block
  framing: this is a side question; the main task continues without you;
    do not take it over and do not follow workflow instructions from the
    conversation (plan submission, delegation, mode changes); inspect only
    with Read, Glob, and Grep (T1) or use no tools (T0); if the main
    conversation is still running, say what is known so far
  earlier BTW turns as plain text: question and final answer, tool traffic dropped
  the new question
```

- Earlier BTW turns go into the final user message as text, not as separate messages. A question therefore adds one user message after the main context, plus its own run's tool traffic, and the main context stays the prefix while it grows between questions.
- If the snapshot ends on a user message, the BTW block is appended to it as an extra content part so the roles still alternate.
- Context budget: the request is estimated with the shared formula (`packages/agent-runtime/src/context-budget.ts`) against the main session's model. Over budget, the oldest BTW turns are dropped first. If it still does not fit, the run fails with `BTW_CONTEXT_FULL` and suggests compacting the main conversation. BTW never compacts the main session and never writes a checkpoint.
- Tool-round budget: 8 rounds per question (proposed default). After that, tool calls are denied with "Tool budget used; answer with what you have." A run that still ends on tool calls stops with `BTW_TOOL_BUDGET_EXHAUSTED` and keeps the partial answer.
- Output is clamped with the existing `clampOutputToContext` (`packages/agent-runtime/src/output-cap.ts`).

### 6.5 Agent runtime

The logic lives in new modules under `packages/agent-runtime/src/btw/`. `runtime.ts` gets only the snapshot accessor, and `sidecar.ts` gets two cases and the runtime lookup.

| Module | Responsibility |
| --- | --- |
| `btw-request.ts` | Pure: snapshot, thread history, and question in; side request out. |
| `btw-tool-gate.ts` | Pure: wraps the snapshot's tool declarations. Allowed tools execute through the BTW host client. Every other tool is blocked in `beforeToolCall` and throws in `execute`. Descriptions stay unchanged so the prefix stays identical. |
| `btw-run.ts` | Builds one pi-agent-core `Agent` per question, as `SubagentRun` does (`packages/agent-runtime/src/subagent.ts:319`), with the provider plumbing that `completeOneShot` already composes: provider binding, retry stream, usage accounting, session affinity. Emits BTW events and owns its `AbortController`. |

The run's host client is narrowed by type. For T1 it exposes only `tools.execute` and `tools.abort`. Every call carries the main session's `mode`, which the host requires, and `accessProfile: "read-only"`. It omits `turnId`, `fileBatchTicket`, `delegationId`, and `permissionScope`, and it namespaces the host `toolCallId` as `btw:<runId>:<id>`, so host bookkeeping for active calls, cancellation, and permissions never collides with main's. For T0 the client exposes nothing. In both tiers the run has no way to call `session.appendMessage`, `session.appendCompaction`, `plans.*`, `session.rename`, `session.fork`, `session.create`, or `worktree.delegate.create`.

Sidecar methods, next to `agent.prompt` (`packages/agent-runtime/src/sidecar.ts:455`):

- `btw.ask { runId, sessionId, launchIfAbsent, history, question }` returns `{ accepted: true }` and streams `btw.event` notifications.
- `btw.abort { runId }`.

Runtime lookup must not go through `runtimeFor` as it is. On a launch mismatch it disposes the runtime (`packages/agent-runtime/src/sidecar.ts:266`), which would end a running main turn. `btw.ask` uses a registered runtime as it is, whatever its launch. When none exists, it creates one from `launchIfAbsent`, which Electron Main resolves the same way it would for the next prompt (`apps/desktop/electron/main/runtime/session-launch.ts:322`). Creation awaits host calls before it registers the runtime (§2.3), so Stage 3 must confirm whether a concurrent `agent.prompt` can interleave there. If it can, both paths share one per-session creation guard, so the session ends up with a single runtime. If creating a runtime has session side effects, or the guard cannot be added safely, `btw.ask` fails closed with `BTW_CONTEXT_UNAVAILABLE` for sessions without a live runtime (risk R4).

One run per session may be active. A second `btw.ask` for the same session fails with `BTW_BUSY`. Disposing or rebuilding the main runtime does not affect an active run, which holds its own snapshot and agent.

### 6.6 Read-only enforcement

| Layer | Mechanism | Fails closed |
| --- | --- | --- |
| Renderer | The BTW tab has no write, apply, or send-to-main action. | Not a boundary |
| Electron Main | Forwards only `btw.ask` and `btw.abort` and checks availability again. | Yes |
| Agent runtime, tool gate | Only allowlisted tools execute; every other tool is blocked before and during execution. | Yes |
| Agent runtime, host client | Typed to `tools.execute` and `tools.abort` with the read-only profile (T1), or to nothing (T0). | Yes |
| Host-core | `accessProfile: "read-only"` admits only `Read`, `Glob`, and `Grep` on paths that need no permission request, whatever the runtime sends. | Yes, authoritative |
| Prompt framing | Tells the model it is read-only. | No, advisory only |

### 6.7 Host-core access profile (T1 only)

`ToolsExecuteParams` (`crates/host-core/src/tools/mod.rs:646`) gets an optional `access_profile` (`accessProfile` on the wire). When it is absent, behavior is unchanged. With `"read-only"`:

- Only `Read`, `Glob`, and `Grep` run. Any other tool is denied with `TOOL_DISABLED_IN_READ_ONLY` and audited.
- Paths resolve against the session's persisted tool root, as today. A path that needs no permission request today stays allowed: the workspace and the session's contained roots, such as scratch (`crates/host-core/src/workspace.rs:312`, `crates/host-core/src/permissions.rs:188`). A path that requires external-path permission (`crates/host-core/src/permissions.rs:232`) is denied with `EXTERNAL_PATH_DISABLED_IN_READ_ONLY` instead, in every permission mode, including `auto`, and despite existing session grants (Q4). Any other evaluation that would raise a permission request is denied as well, so a BTW read never creates a permission request in the main session.
- Combining the profile with `file_batch_ticket`, `delegation_id`, or `run_in_background`, or sending an unknown profile value, fails with `INVALID_PARAMS`.
- Audit rows record `origin: "btw"` and the run id in `payload_json`. The schema does not change.

The profile is a separate field because `permission_scope` is a permission mode, validated as one (`crates/host-core/src/rpc/mod.rs:4384`), and decides how calls are approved. The read-only profile decides which tools and paths may run at all, under any mode. Adding `read-only` to the permission-mode vocabulary would leak it into session settings. Plan mode cannot be reused either: it is durable session state, and it allows `Bash`.

### 6.8 Shared contract and IPC

```ts
// packages/shared/src/types/btw.ts
export type BtwHistoryTurn = { question: string; answer: string };

export type BtwAskRequest = {
  sessionId: string;          // the main session
  runId: string;              // UUID generated by the renderer
  question: string;           // 1 to 8000 characters (proposed)
  history: BtwHistoryTurn[];  // at most 20 turns and 64000 characters (proposed)
};

export type BtwContextRevision = {
  throughEntryId: string | null;
  checkpointId: string | null;
  mainTurnRunning: boolean;
};

export type BtwEvent =
  | { type: "started"; revision: BtwContextRevision; providerId: string; modelId: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; ok: boolean; errorCode?: string }
  | { type: "usage"; usage: MessageUsage }
  | { type: "done"; stopReason: "stop" | "aborted" }
  | { type: "error"; error: AppError };

export type BtwEventEnvelope = { runId: string; sessionId: string; seq: number; event: BtwEvent };
```

New entries in the `IPC` table (`packages/shared/src/protocol.ts`), which feeds the preload whitelist (`packages/shared/src/protocol.ts:551`):

- invoke: `btwAsk: "pi-harbor/btw/ask"`, `btwAbort: "pi-harbor/btw/abort"`
- event: `btwMessage: "pi-harbor/btw/event/message"`

BTW events never use `pi-harbor/agent/event/message`, so main's active-tool tracking (`apps/desktop/electron/main/runtime/sidecar.ts:197`), the outbox, and the main transcript reducers never see them.

The `history` sent by the renderer is untrusted text. Electron Main validates its type and size, and the runtime treats it as quoted conversation, never as instructions or grants.

Availability is one shared, fail-closed helper, `btwAvailableFor(session)`. It is true only when the normalized `source` is `"desktop"` and the id has neither the `remote:` nor the `native-pi:` prefix; like `isRemoteSession` (`apps/desktop/src/lib/remote-session-safety.ts:3`), it checks both signals. Electron Main is authoritative; the renderer uses the same helper to hide or disable entry points. It is not a new optional capability flag: for a non-remote session a missing flag counts as allowed (`apps/desktop/src/lib/remote-session-safety.ts:16`). That is why Pi-native sessions already pass `canUseLocalTools`, and a future session source would get BTW by default.

### 6.9 Electron Main

A new `apps/desktop/electron/main/ipc/btw-ipc.ts`, registered in `apps/desktop/electron/main/ipc/register.ts`:

- `btwAsk` validates the payload, checks that the session exists and that `btwAvailableFor` it, resolves `launchIfAbsent`, and forwards `btw.ask`.
- `btwAbort` forwards `btw.abort`.
- A `btw.event` branch next to the `agent.event` branch in `apps/desktop/electron/main/runtime/sidecar.ts` forwards envelopes on `btwMessage` and does nothing else.
- A registry of active runs (`runId` to session and `webContents`). Main aborts the runs on renderer reload or crash, window close, session deletion or archive, and app quit. When the sidecar exits, Main emits `BTW_RUNTIME_EXITED` for each active run.

Main validates, routes, and cleans up. The run itself lives in the sidecar.

### 6.10 Renderer

- `builtin.session.btw` in `apps/desktop/electron/main/builtin-commands.ts` and a case in `apps/desktop/src/lib/commands.ts`.
- A branch in `apps/desktop/src/features/chat/composer/hooks/useComposerSubmit.ts`, after the send gate and before the slash-dispatch block, that handles `/btw` with or without a question through a helper in the feature folder. It requires `localCommandsAllowed` but not a non-steer submission (§6.1).
- Tab kind `btw` in `apps/desktop/src/lib/work-panel-tabs.ts` (`isKnownWorkPanelTab` and a `btwWorkPanelTab()` factory with the id `btw`), and one routing case in `apps/desktop/src/components/workpanel/WorkPanel.tsx`.
- `apps/desktop/src/features/chat/btw/`: a standalone store keyed by main session id that holds the thread (turns with question, streamed answer, status, tool rows, usage, and revision) and the active `runId`; a pure reducer that folds `BtwEventEnvelope`s and ignores unknown runs, superseded runs, and out-of-order `seq`; and the event subscription, next to `onAgentEvent` in the renderer API (`apps/desktop/src/lib/api.ts:1994`).

The store is not a slice of `app-store.ts`, which is an architecture hotspot (AGENTS.md §7).

`BtwTab.tsx` in `apps/desktop/src/components/workpanel/`:

- Header: the title "BTW", a "Read-only" badge, a status line such as "Following the main conversation · running", and Clear.
- Body: the questions and answers. Answers render with the existing `Markdown` component and tool calls as compact rows. Each answer's footer shows the model, usage, staleness (§6.2), and Copy.
- Input: the shared input and button primitives from `apps/desktop/src/components/ui.tsx`. Enter sends, Shift+Enter starts a new line, and Stop replaces Send while a run is active.
- Every string goes through i18n in `packages/i18n/src/locales/<locale>/index.ts`, including `title` and `aria-*`. The status line and answer completion are announced with `aria-live="polite"`.
- No default keyboard shortcut in the first version. A later shortcut would go through the keybinding registry.

### 6.11 Lifecycle

| Event | Effect |
| --- | --- |
| Session switch | The thread and an active run continue; the tab follows the session's panel context (ADR 0028). |
| Panel collapsed | No change; `/btw` expands it again. |
| Tab closed | Aborts an active run. The thread stays until Clear, so reopening the tab shows it. |
| Main turn starts, ends, or is stopped during a run | No effect on the run; the answer may show as stale. |
| Main compaction during a run | The run finishes on its snapshot; the answer shows that the main conversation was compacted since. |
| Main runtime disposed or rebuilt | No effect on an active run. |
| Second question while running | Disabled in the UI; `BTW_BUSY` if it still reaches the sidecar. |
| Session deleted or archived | Main aborts the run; the renderer drops the thread together with the panel context (`apps/desktop/src/stores/slices/project-slice.ts:172`). |
| Renderer reload or window close | Main aborts the runs owned by that `webContents`; the threads are gone. |
| Sidecar exit | Active runs end with `BTW_RUNTIME_EXITED`; threads stay, and the user can ask again. |
| App restart | Threads are gone (Q3). |

An answer is stale when the session's transcript has messages after `throughEntryId`, or when its active checkpoint differs from `checkpointId`. The implementation must confirm that runtime entry ids match the renderer's transcript message ids; if they do not, staleness compares message counts instead.

### 6.12 Errors

| Code | When | Shown as |
| --- | --- | --- |
| `BTW_UNAVAILABLE` | A Pi-native session from the composer, or a remote or Pi-native session from the palette | Toast |
| `BTW_NO_SESSION` | No active session | Toast "Start a conversation first" |
| `BTW_BUSY` | A run is already active for the session | Input disabled; toast if raced |
| `BTW_CONTEXT_UNAVAILABLE` | No snapshot can be built without side effects | Error row with Retry |
| `BTW_CONTEXT_FULL` | The request does not fit after trimming BTW history | Error row that suggests compaction |
| `BTW_TOOL_BUDGET_EXHAUSTED` | Still calling tools after the round budget | Partial answer with a note |
| `BTW_RUNTIME_EXITED` | The sidecar exited during a run | Error row with Retry |
| `TOOL_DISABLED_IN_READ_ONLY`, `EXTERNAL_PATH_DISABLED_IN_READ_ONLY` | Host-core denied a tool call | Failed tool row; the run continues |

Provider and model errors use the existing classification (`packages/agent-runtime/src/agent-errors.ts`). `MODEL_NOT_CONFIGURED` applies as it does for a prompt.

### 6.13 Model and usage

BTW uses the main session's bound provider, model, and thinking level from the snapshot, so the context fits and the prefix stays shared (Q6). Usage is shown per answer and is not added to persisted session or project totals in the first version (Q5).

## 7. Persistence and compatibility

- No database, schema, or persisted-state change. BTW threads are not stored.
- Host RPC: one optional parameter, `access_profile`. Callers that omit it keep today's behavior.
- IPC: two invoke channels and one event channel, all additive.
- Sidecar RPC: `btw.ask`, `btw.abort`, and the `btw.event` notification, all additive.
- The builtin registry grows from six to seven entries. The new command id is not one that ADR 0106 removed, and the new tab kind, decision ids, and E2E ids are not ones that ADR 0268 retired.
- Plugin SDK: unchanged.

## 8. Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | The snapshot path calls a request hook with side effects: the journal write, the agent-state push, or an extension handler. | Stage 1 extracts pure steps. A contract test with a recording fake host fails on any host call other than `tools.execute` with the read-only profile. |
| R2 | The prefix differs from main's (dynamic system sections, deferred tool activation, reasoning replay), so every question pays for the whole context. | A test compares the BTW prefix with main's last request. Only cost depends on this. |
| R3 | The model keeps calling denied tools and wastes rounds. | Framing, denial text, and the round budget. |
| R4 | Creating a runtime for an idle session has side effects (instruction preflight, MCP connections, extension activation) or races with a concurrent `agent.prompt` (§6.5). | Verify in Stage 3, and add the shared creation guard if requests can interleave. If any write to session state remains, fail closed with `BTW_CONTEXT_UNAVAILABLE` for sessions without a live runtime. |
| R5 | A BTW read sees a file while the main agent is writing it. | Accepted: BTW takes no path locks, and an answer about a file being edited is marked stale anyway. |
| R6 | A host notification for a BTW call, such as `tools.output` (`crates/host-core/src/tools/mod.rs:2657`), reaches the main transcript. | Namespaced `toolCallId`. Stage 2 lists the notifications that `Read`, `Glob`, and `Grep` emit and confirms that their consumers ignore unknown ids; the E2E checks the main transcript. |
| R7 | On a cache miss, a large main context is sent again with every question. | Usage per answer and prefix parity. |
| R8 | Prompt injection in the main context or in workspace files steers BTW. | The worst case is a misleading answer: BTW cannot write, run commands, or reach the network. |
| R9 | Reviewers read BTW as the removed side chat. | The new ADR compares the two point by point (§3.1). |

## 9. Implementation impact

| Area | Files |
| --- | --- |
| Shared | New `packages/shared/src/types/btw.ts` and the `btwAvailableFor` helper; `packages/shared/src/protocol.ts` (three channels). |
| Electron Main | New `apps/desktop/electron/main/ipc/btw-ipc.ts`; `apps/desktop/electron/main/ipc/register.ts`; `apps/desktop/electron/main/runtime/sidecar.ts` (`btw.event` branch and run registry); `apps/desktop/electron/main/builtin-commands.ts`. |
| Agent runtime | New `packages/agent-runtime/src/btw/`; `packages/agent-runtime/src/runtime.ts` (snapshot accessor, retained last request, pure-step extraction); `packages/agent-runtime/src/sidecar.ts` (`btw.ask`, `btw.abort`, lookup-or-create, and the creation guard if needed). |
| Host-core (T1) | `crates/host-core/src/tools/mod.rs` (`access_profile`); `crates/host-core/src/rpc/mod.rs` (admission, path denial, audit origin). |
| Renderer | New `apps/desktop/src/features/chat/btw/` and `apps/desktop/src/components/workpanel/BtwTab.tsx`; `apps/desktop/src/lib/work-panel-tabs.ts`; `apps/desktop/src/components/workpanel/WorkPanel.tsx`; `apps/desktop/src/lib/commands.ts`; `apps/desktop/src/features/chat/composer/hooks/useComposerSubmit.ts`; `apps/desktop/src/lib/api.ts`; locale files. |

Hotspots (AGENTS.md §7): `apps/desktop/src/components/Composer.tsx`, `apps/desktop/src/stores/app-store.ts`, and `apps/desktop/electron/main/index.ts` are not touched. `runtime.ts` gets only the accessor, the retained reference, and the extraction.

Documents at landing:

- A new ADR, "Read-only BTW side questions", with the next free number (the highest at the baseline is 0343). It amends ADR 0106 and ADR 0334 (a registry of seven), compares BTW with ADR 0268, and relates to ADR 0028, 0048, 0057, 0062, 0151, and 0299.
- [04-builtin-commands.md](../../spec/04-ux/04-builtin-commands.md): the seventh command; "six" becomes "seven" in §1, §3, §4, and the §6 acceptance list.
- [02-agent-runtime.md](../../spec/03-runtime/02-agent-runtime.md): BTW run, snapshot, and request shape.
- [03-tools-and-permissions.md](../../spec/03-runtime/03-tools-and-permissions.md): the read-only access profile.
- [06-host-rpc-protocol.md](../../spec/03-runtime/06-host-rpc-protocol.md): `access_profile`.
- [01-ipc-protocol.md](../../spec/03-runtime/01-ipc-protocol.md): channels and sidecar methods.
- [08-error-codes.md](../../spec/03-runtime/08-error-codes.md): the new codes.
- [08-component-spec.md](../../spec/04-ux/08-component-spec.md) and [09-interaction-patterns.md](../../spec/04-ux/09-interaction-patterns.md): the BTW tab.
- [04-e2e-test-plan.md](../../spec/06-delivery/04-e2e-test-plan.md): scenarios (the highest id at the baseline is E2E-1178).
- [decisions-log.md](../../spec/08-meta/decisions-log.md) and its [zh-CN mirror](../../zh-CN/spec/08-meta/decisions-log.md) (the highest decision at the baseline is D678).
- `CHANGES.md`.

Ids are assigned when the work lands, because other branches may take the next numbers first.

## 10. Tests

Unit tests (agent-runtime):

- `btw-request`: the prefix equals the snapshot; dangling tool calls are closed; a trailing user message is merged; the oldest BTW turns are dropped over budget; `BTW_CONTEXT_FULL` when nothing fits.
- `btw-tool-gate`: tools outside the allowlist are blocked before and during execution; allowed tools reach the host with `accessProfile: "read-only"`, no `turnId`, and a namespaced id; T0 denies everything; the round budget holds.
- Stage 1 differential test: main's provider request is byte-identical before and after the extraction.

Contract and integration tests (agent-runtime, fake provider, recording fake host):

- A BTW question during a running main turn calls only `tools.execute` with the read-only profile.
- The main transcript and main's next provider request equal those of a control run without BTW.
- The BTW request prefix equals main's last request.
- `btw.ask` with a live runtime whose launch differs from `launchIfAbsent` does not dispose it; concurrent `btw.ask` and `agent.prompt` on a session without a runtime create one runtime.
- `btw.abort` stops the run; a second `btw.ask` returns `BTW_BUSY`.

Host-core tests (Rust), using the existing tests around `delegate_permission_scope_overrides_session_mode_without_opening_external_paths` (`crates/host-core/src/rpc/mod.rs:10483`) as the template:

- The read-only profile denies `Write`, `Edit`, `Bash`, and `plugin_*` with `TOOL_DISABLED_IN_READ_ONLY`.
- An external `Read` is denied in `ask` and `auto`, with and without a session grant, and creates no pending permission request.
- A `Read` inside the workspace still works.
- `INVALID_PARAMS` for the profile combined with `file_batch_ticket` or `delegation_id`, and for an unknown value.
- Calls without the profile behave as before.

Renderer tests:

- Submit: `/btw` opens the tab; `/btw q` opens it, asks, and clears the draft only on acceptance; the steer shortcut does not steer `/btw`; without a session the toast appears; a remote session keeps the fallthrough; a Pi-native session shows `BTW_UNAVAILABLE` and keeps the draft.
- Reducer: deltas, tool rows, done, error, abort, superseded runs, out-of-order `seq`.
- `BtwTab`: empty, running, answered, stale, and error states; i18n and accessible names.
- Work panel: the `btw` kind survives sanitization; a session switch keeps the thread; session deletion drops it.

E2E (Electron, scripted fake provider):

- Representative user path: the main turn runs a slow tool; `/btw what are you doing?` opens the tab and streams an answer grounded in the main context; the main turn finishes unchanged and its transcript contains no BTW text.
- A scripted BTW `Write` call and an external `Read` are denied, and no approval card appears in the main session.
- A session switch keeps the thread; deleting the session clears it; a renderer reload clears it and aborts the run.

## 11. Delivery stages

Each stage builds and passes its tests on its own.

1. Behavior-preserving refactor in `runtime.ts`: extract the pure conversion and declaration steps, and keep a reference to the last provider-bound context. Differential test.
2. Host-core read-only access profile with Rust tests (T1 only).
3. Agent runtime: snapshot accessor, `btw/` modules, sidecar methods, and the runtime lookup, with a per-session creation guard if concurrent requests can interleave (§6.5). Contract tests.
4. Shared types, IPC channels, Electron Main handlers, and the run registry.
5. Renderer: command, composer branch, store, tab, i18n. Component and interaction tests.
6. ADR, specs, decision log, E2E scenarios, and `CHANGES.md`; task-candidate E2E.

## 12. Questions to decide

| # | Question | Options | Recommendation |
| --- | --- | --- | --- |
| Q1 | What "follows the main context in real time" means | (a) a fresh snapshot per question plus live status in the tab; (b) BTW also comments on its own when the main session changes | (a). Option (b) runs the model on every main event and spends tokens when nobody asked; it is a different feature. |
| Q2 | Tool access | T0: no tools; T1: `Read`, `Glob`, `Grep` in the workspace | T1, because the request asks for a read-only agent. T0 is simpler (no host-core change, and no tool ever executes) and matches Claude Code. |
| Q3 | Thread lifetime | (a) renderer memory until Clear, session deletion, or restart; (b) stored in host-core | (a). Option (b) needs a schema migration and moves back toward the durable side chat that ADR 0268 removed. |
| Q4 | External paths in BTW | (a) always denied; (b) follow the main session's mode and grants | (a). Option (b) would put BTW permission prompts into the main session. |
| Q5 | Usage accounting | (a) shown per answer only; (b) also added to session totals | (a) for the first version. Option (b) needs a decision on how side usage is labeled. |
| Q6 | Model | (a) always the main session's; (b) configurable | (a). Another model loses the shared prefix and may not fit the context. |
| Q7 | The main turn's in-flight streaming text | (a) completed messages only; (b) include the partial text | (a). Option (b) ties BTW to stream internals, and the user already sees that text in the main transcript. |

## 13. Documentation drift found during intake

- The scope table in the root `AGENTS.md` routes to `apps/desktop/electron/AGENTS.md`, `apps/desktop/electron/ipc/AGENTS.md`, `crates/host-core/AGENTS.md`, `packages/agent-runtime/AGENTS.md`, `packages/plugin-sdk/AGENTS.md`, and `packages/shared/AGENTS.md`. None of them exists at the baseline; the tracked files are the root `AGENTS.md`, `apps/desktop/src/AGENTS.md`, and `docs/plugin-plan/AGENTS.md`. The IPC handlers live in `apps/desktop/electron/main/ipc/`.
- ADR 0106 is titled "Keep only five core builtin commands", while spec 04 has listed six since ADR 0334.

Both are outside this request and are not changed here.
