# Plan Execution Model Selection

## Status and scope

- Status: Accepted on 2026-10-28; the user chose Option A and settled every question in section 10. Implemented on 2026-10-29 and recorded in [ADR plan-execution-model-at-approval](../../adr/plan-execution-model-at-approval.md) and D675.
- Date: 2026-10-28.
- Branch: `feat/plan-execution-model` in worktree `worktrees/docs-plan-execution-model`, renamed from `docs/plan-execution-model-design` when implementation started.
- Inspected baseline: `480abe845`. `origin/main` and local `main` were identical at intake.
- Deliverable: problem analysis, alternatives, the chosen design, and acceptance tests. The implementation and the accepted specification updates are on the same branch.
- Validation: code references were checked against the `480abe845` baseline when the design was written. Implementation checks and the E2E-1176 scenarios are recorded in D675 and `docs/spec/06-delivery/04-e2e-test-plan.md`.
- Scope: both proposal kinds, `plan` and `goal`. Goal reuses the Plan approval pipeline end to end (D198), so one design covers both.

## 1. Problem

Users often want to plan with a strong, expensive model and implement the approved plan with a cheaper one. PI-Desktop cannot do that. After approval, the execution turn always runs on the provider and model that wrote the plan, and the only way to change the model is to reject the plan.

## 2. Current behavior

| Layer | Behavior | Evidence |
| --- | --- | --- |
| Shared contract | `PlanResolveRequest` carries the proposal identity, `action`, `version`, and `targetPermissionMode`. It has no model field. | `packages/shared/src/types/plans.ts:147` |
| Electron IPC | The `plansResolve` handler rebuilds the host payload from an explicit field list, so an extra field is dropped. | `apps/desktop/electron/main/ipc/agent-ipc.ts:831` |
| Host commit | Approve sets `sessions.mode = 'agent'` and `sessions.permission_mode` in one transaction, queues the execution, and writes the audit event. Provider, model, and thinking level are not touched. | `crates/host-core/src/plans/approval.rs:434` |
| Configuration lock | `gate_session_configure` rejects mode, provider, model, thinking, and permission changes with `PLAN_CONFIGURATION_BLOCKED` while the session has a pending approval, a queued or running execution, or a running turn. | `crates/host-core/src/plans/approval.rs:54` |
| Renderer lock | The Composer blocks its model, mode, and permission controls while an approval is pending. | `apps/desktop/src/components/Composer.tsx:248` |
| Dispatch | Both dispatchers claim the execution, re-read the session, and call the launch resolver with only `{ mode: "agent" }`. The execution turn uses the session's stored model. | `apps/desktop/electron/main/runtime/plans.ts:442`, `packages/host-runtime/src/plan-dispatch.ts:136` |

The lock is deliberate. ADR 0053 § 3 says Approve "requires an explicit execution permission mode", § 4 says approval "atomically changes the session to Agent with the selected permission mode", and § 5 says "approval actions are the only controls enabled for a pending Plan request". The model is therefore fixed from plan submission until the execution ends, and the approval decision cannot name another one.

The rest of the pipeline already handles a model change:

- `resolveAgentRuntimeLaunch` accepts `providerId`, `modelId`, and `thinkingLevel` overrides and falls back to the session values (`apps/desktop/electron/main/runtime/session-launch.ts:323`).
- The sidecar reuses a session runtime only while its launch configuration still matches, and the provider comparison includes the model id (`packages/agent-runtime/src/runtime.ts:2721`). Otherwise it disposes the runtime, builds a new one, and restores the transcript from host storage (`packages/agent-runtime/src/sidecar.ts:234`). A manual Composer model switch takes the same path.
- The execution turn appends the approved plan as an internal instruction to the same conversation (`packages/agent-runtime/src/runtime.ts:8922`), then runs a compaction preflight that fails with `CONTEXT_COMPACTION_FAILED` or `CONTEXT_TOO_LARGE` instead of truncating (`runtime.ts:8957`).
- Each turn row records its own `provider_id` and `model_id` (`crates/host-core/src/db/schema.rs:132`).

The gap is in the approval decision, not in the runtime.

### 2.1 Why Task delegation does not solve it

During an approved execution, `Task` can already send work to another model, through a subagent definition pin or through `Task.model` for a model marked **Available for AI delegation**. This does not answer the request:

- The execution turn still runs on the planning model. That model reads the plan, writes briefs, waits for reports, and checks the result.
- Delegation is the model's decision, guided by the prompt. Nothing enforces it.
- On-demand model grants expire at every approved plan or goal execution (`docs/adr/subagent-model-opt-in.md:35`; the runtime clears them at `runtime.ts:8903`), so a grant obtained while planning does not carry over.

### 2.2 The only direct route today

Reject resolves only the `plan_approvals` row. The session update runs only on approve (`approval.rs:420`), and the plan artifact stays on disk. Once the submitting turn settles, the session is idle in Plan, so the user can switch the Composer to Agent and a cheaper model and ask the agent to implement the artifact. History then shows the plan as rejected, and the work runs as an ordinary Agent turn without the approved-execution epoch.

## 3. Goals and non-goals

Goals:

1. The user chooses the execution model and thinking level on the approval bar, as part of the approval decision.
2. The choice commits atomically with the Plan → Agent transition and the permission mode. No state exists in which the plan is approved but the session still points at the old model, and the configuration lock stays intact.
3. Approving without a choice behaves exactly as today. Remote control, local MCP control, the headless host, and older clients keep working unchanged.
4. The model that ran the execution stays visible, in the Composer and in plan history.

Non-goals:

- Automatic model routing or cost estimation.
- Changes to subagent model authorization.
- Scheduled or unattended Plan execution, which stays rejected with `PLAN_REQUIRES_INTERACTIVE_SESSION` (ADR 0053 § 6).
- Executing in a fresh context (see R1).
- Native agent-host sessions and trusted extension agents as execution targets.

## 4. Options

| | A. Model in the approval decision | B. Unlock the model picker while pending | C. Delegate to a cheap subagent | D. Mode-bound model pair | E. Manual switch around approval |
| --- | --- | --- | --- | --- | --- |
| Code change | Contract, host, migration, UI | Host gate, renderer lock, ADR change | None (C1) or small (C2) | New setting, mode-transition logic | None |
| User steps | Pick a model on the approval bar, approve | Change the Composer model, approve | Ask for a delegating plan | Configure once | Reject or stop, switch, re-prompt |
| Execution turn runs on | Chosen model | Composer model | Planning model; implementation on the subagent | Configured execution model | Chosen model |
| Enforced by the host | Yes, one transaction | Yes, two separate writes | No, prompt-level | Yes | Yes, but outside the approval record |
| Fit with ADR 0053 | Extends § 3 and § 4 | Contradicts § 5 | Unchanged | Extends § 4, couples mode and model | Unchanged; E1 misrecords the decision |

Prior art: Claude Code's `opusplan` alias uses Opus in plan mode and switches to Sonnet for execution ([model configuration](https://docs.anthropic.com/en/docs/claude-code/model-config)). Aider's architect mode has an architect model propose the change and a separate editor model turn it into file edits ([chat modes](https://aider.chat/docs/usage/modes.html)). In both, the user picks the pair; the agent does not.

### Option A: the execution model is part of the approval decision (chosen)

The approve request carries an optional execution model. Host-core validates it and writes it to the session row in the same transaction that already writes `mode` and `permission_mode`. The dispatchers need no change, because they read the session after the commit. Section 5 specifies it.

### Option B: unlock the model picker while approval is pending

Relax `gate_session_configure` to allow provider, model, and thinking changes while the only blocker is a pending approval, and stop blocking the Composer model picker. Dispatch then uses whatever the Composer shows.

Not chosen, because:

- It contradicts ADR 0053 § 5.
- The decision is split across two surfaces and two host writes. The approval bar does not show which model will run.
- The submitting turn can still be running while the approval bar is visible (`dispatchApprovedPlan` waits for it at `plans.ts:404`), and the gate also blocks configuration during a running turn. B would have to relax that condition as well, or fail intermittently.

### Option C: delegate implementation to a cheap subagent

- C1, available now: define an implementer subagent with a pinned cheap model, or mark the cheap model **Available for AI delegation**, and ask for a plan whose implementation steps go to that subagent through `Task`.
- C2, a small product addition: an approval choice such as "execute through subagent X" that makes the execution instruction delegate.

Both keep the execution turn on the planning model, and the subagent works from a brief instead of the transcript. This is a workaround, not a fix.

### Option D: mode-bound model pair

A setting binds one model to Plan and another to execution, and mode transitions switch between them, as `opusplan` does. It removes the per-approval step, but it adds a second model axis to every session. It also cannot switch on `EnterPlanMode` in the middle of a turn: the current launch path only rebuilds an idle runtime (`sidecar.ts:228` refuses a busy one with `AGENT_BUSY`). Its useful part fits on top of Option A as a default for the approval picker (Phase 3).

### Option E: manual switch around the approval

- E1, reject and re-prompt: the route in § 2.2. History records a rejection.
- E2, approve and stop: approve, stop the execution turn at once, switch the Composer model, and ask the agent to implement the plan artifact. Stopping does not undo the approval. Finishing an execution writes only the execution fields of the approval row (`crates/host-core/src/plans/execution.rs:136`), and an interrupted execution leaves the session in Agent (ADR 0053 § 4). The planning model may already have sent its first request with the full context, which is billed.

Both are documented as workarounds only.

## 5. Chosen design (Option A)

### 5.1 Flow

```text
PlanApprovalBar
  plansResolve { approve, targetPermissionMode, targetModel? }
Electron Main: validate at the trust boundary
  plans.resolve
host-core, one transaction:
  sessions:       mode = agent, permission_mode, provider_id, model_id, thinking_level
  plan_approvals: approved, target_* columns, execution queued
Electron Main: dispatchApprovedPlan (unchanged)
  session.get -> resolveAgentRuntimeLaunch -> sidecar rebuilds runtime -> execution turn
```

### 5.2 Shared contract

```ts
// packages/shared/src/types/plans.ts
export type PlanExecutionModel = {
  providerId: string;
  modelId: string;
  /** Omitted: keep the session's current thinking level. */
  thinkingLevel?: SessionThinkingLevel;
};

export type PlanResolveRequest =
  | (PlanResolveIdentity & {
      action: "approve";
      targetPermissionMode: GlobalPermissionMode;
      /** Omitted: execute with the session's current model, as today. */
      targetModel?: PlanExecutionModel;
    })
  | (PlanResolveIdentity & {
      action: "reject";
      targetPermissionMode?: never;
      targetModel?: never;
    });
```

Every type in that file that carries `targetPermissionMode` for an approved proposal also gains `targetModel`. The approve request uses `targetModel?: PlanExecutionModel`; the response types `PlanProposal`, `PlanExecution`, `PlanningStateEvent`, and `PlanResolutionResult` use `targetModel?: PlanExecutionModel | null`, because the host can serialize an absent target as `null`. `SessionThinkingLevel` already exists in `packages/shared/src/types/models.ts`.

### 5.3 Electron Main

The `plansResolve` handler (`agent-ipc.ts:831`) validates `targetModel` the way it validates `targetPermissionMode`:

- It must be an object with non-empty trimmed `providerId` and `modelId`; `thinkingLevel` must be absent or a known level.
- It is refused on `reject`.
- It is forwarded only when present.
- It is refused for sessions whose model the user cannot configure. The renderer applies the same rule through `canConfigureModel` (`Composer.tsx:248`); Main must use its own authoritative source for that capability instead of trusting the renderer.

### 5.4 Host-core

`PlanResolveParams` gains optional target provider, model, and thinking level fields, parsed by the `plans.resolve` handler (`crates/host-core/src/rpc/mod.rs:3720`).

Validation, on approve and before any write:

- Provider and model are both present or both absent.
- The thinking level passes `validate_thinking_level`, as in `session.configure` (`crates/host-core/src/sessions.rs:1906`).
- The provider exists and is enabled. Trusted extension agent provider ids are not valid targets in this phase.
- A failure returns a new stable code, `PLAN_TARGET_MODEL_INVALID`, and the approval stays pending.

This is stricter than `session.configure`, which stores provider and model ids unchecked (`crates/host-core/src/rpc/mod.rs:2861`). A bad provider id here would consume the approval and fail only when the execution launches, so the extra check is worth it. The host does not check the model id, which matches `session.configure`. The picker offers only listed models, and R4 covers a model that stops being served before launch.

Commit: the approve branch extends its `UPDATE sessions` (`approval.rs:434`) with `provider_id`, `model_id`, and `thinking_level`, using the same `COALESCE` semantics as `configure_session_with_thinking`. Like the existing mode write, this is the approval transition itself, so it does not pass through `gate_session_configure`.

Persistence: schema v26 (`SCHEMA_VERSION` is 25 at `crates/host-core/src/db.rs:10`) adds nullable `target_provider_id`, `target_model_id`, and `target_thinking_level` to `plan_approvals`. Existing rows stay `NULL`, meaning no override. The approval row is the only durable place for this choice: turn rows record their own model, but nothing durable links an execution id to its turn. Main keeps that link only in memory (`plans.ts:459`).

Idempotency: `same_resolution` (`approval.rs:393`) currently compares the action and the permission mode. It adds the target model:

- A repeated approve without `targetModel` matches, because it states no preference.
- A repeated approve with `targetModel` must equal the stored target, including a stored `NULL`. Otherwise it returns `PLAN_APPROVAL_CONFLICT`, so two windows that chose different models cannot both report success.

Audit: the `plan_approval_resolved` payload (`approval.rs:471`) gains `targetModel`.

### 5.5 Dispatch and runtime

No change. Both dispatchers read the session after `plans.claimExecution`, so the execution launches on the committed model, and the sidecar rebuilds the runtime with restored history. Dispatchers must not pass `execution.targetModel` as a launch override. The session row stays the single source of truth for the execution turn, the Composer, and later turns.

Restart needs no change either. If the app stops after approval, the startup fence marks the execution interrupted (ADR 0053 § 4), and the session is already in Agent on the chosen model.

### 5.6 Renderer

- `PlanApprovalBar` gains an "Execute with" model picker next to the permission picker. It reuses the Composer model menu the way `ScheduledModelPicker` does, with no active session and a local callback (`apps/desktop/src/features/scheduled/ScheduledModelPicker.tsx:16`), so it never writes to the session before approval. The thinking level follows the Composer's model-switch rule (`thinkingLevelForProvider`).
- Default: the remembered execution model if its provider is enabled and the model is still listed; otherwise the session's current model.
- `targetModel` is sent only when the selection differs from the session's provider, model, or thinking level, so an untouched approval sends today's request. When sent, it always includes `thinkingLevel`, so the host never guesses a level for the new model.
- The last choice is remembered under a new key next to `pi.desktop.planApprovalMode` (`apps/desktop/src/lib/plan-approval-preferences.ts:3`). A storage failure must not block approval.
- The picker is hidden wherever the Composer model picker is blocked by capability, and for remotely controlled sessions until the remote protocol carries the field (§ 5.7).
- `resolvePlan` (`apps/desktop/src/stores/slices/interaction-slice.ts:199`) applies `targetModel` from the result, so the Composer shows the execution model at once. Switching back for the next planning round is an ordinary Composer action.
- `PlanHistoryCard` shows the execution model when the approval recorded one.
- New strings, including `title` and `aria-*`, go through i18n in every locale under `packages/i18n/src/locales/`.

### 5.7 Other `plans.resolve` callers

Each caller builds its payload from explicit fields, so none forwards `targetModel` today. Phase 1 leaves them as they are, with one guard:

| Caller | Phase 1 |
| --- | --- |
| Remote control, `apps/desktop/electron/main/remote/remote-backend.ts:351` | Maps to RACP `approval/respond` with `decision` and `permissionMode` only. It refuses a request that carries `targetModel` instead of dropping it. |
| Local MCP control and first-party plugins, `apps/desktop/electron/main/mcp-control.ts:421` | Tool schema unchanged. The control gateway they share refuses any `plans/resolve` call that carries `targetModel` with `PLAN_TARGET_MODEL_INVALID`, whether it arrives through `pi_plans_resolve`, `pi_desktop_invoke`, or a plugin invocation, because the operation has no model field in this phase. |
| Headless host, `apps/pi-host/src/app.ts:74` | Forwards `permissionMode` only. |
| Native agent-host bridge, `agentHostBridge.settleApproval` | Unchanged; native sessions cannot select a target (§ 5.3). |

Exposing `targetModel` through RACP and the MCP control schema is a separate decision (Q5).

### 5.8 Persistence and compatibility

| Case | Result |
| --- | --- |
| Existing database, new app | Migration to v26 adds three nullable columns; old rows read `NULL` and render as today. |
| New app, new approval | Session model, permission, mode, and approval target commit in one transaction. |
| Client that never sends `targetModel` | Same request and result as today. |
| Restart with a queued or running execution | Interrupted by the existing startup fence; the session keeps the committed model; nothing is replayed. |
| Older app opening a v26 database | Governed by the existing schema-version policy; the change only adds nullable columns. |

## 6. Risks

| ID | Risk | Mitigation |
| --- | --- | --- |
| R1 | Prompt-cache loss. Execution continues the planning conversation, so the first request on the new model resends the whole transcript without the planning provider's cache. A long planning session followed by a short execution can save little. | State the trade-off in the picker's help text. Executing from the plan artifact alone would remove the cost, but it changes the rule that the same Agent continues into execution (ADR 0053 § 4) and needs its own decision. |
| R2 | The target model has a smaller context window. | The preflight compacts first and fails with `CONTEXT_TOO_LARGE` or `CONTEXT_COMPACTION_FAILED` instead of truncating (`runtime.ts:8957`). The picker can warn when current usage exceeds the target window. |
| R3 | Cross-provider history replay becomes routine; today it happens only on a manual Composer switch. | E2E with two fixture providers (§ 8). |
| R4 | The provider is disabled, or the model stops being served, between approval and dispatch. | A failed launch marks the execution interrupted (`plans.ts:480`), and a model the provider rejects fails the first request as it would in any turn. Approval-time validation keeps the provider window small. The session stays in Agent, so the user can pick another model and continue. |
| R5 | Two clients approve concurrently with different models. | `version` check plus the extended `same_resolution` rule. |
| R6 | A remote or native path silently drops the choice. | The picker is hidden there, and Main and the remote backend refuse the field instead of dropping it. |
| R7 | The cheaper model does weaker work. | The user's trade-off. Goal executions already verify each acceptance criterion (`runtime.ts:8933`). |

## 7. Implementation impact

Host changes landed in `crates/host-core/src/plans/approval.rs` (validation, provider check, commit, and replay), `plans/model.rs`, `plans/repository.rs`, and `plans/execution.rs` (fields and projections), `rpc/mod.rs` (parameter parsing and the echoed `targetModel`), and a new `db/plan_execution_model_migration.rs` (v25 → v26) dispatched from `db/repositories.rs`. Of the ratchet hotspots, `db.rs` gains only the schema version and the module wiring, `plans.rs` only re-exports the new type, and `providers.rs` is unchanged: the provider check is a direct enabled-row predicate that matches `providers.list` with `includeDisabled: false`. Main validates the target in `ipc/agent-ipc.ts`; `remote/remote-backend.ts` and the MCP and plugin control gateway in `mcp-control.ts` refuse it. The picker is a new `PlanExecutionModelPicker` component with its logic in `lib/plan-execution-model.ts`, and the Composer refresh lives in `interaction-slice.ts` and `events-slice.ts`. `Composer.tsx` and `app-store.ts` are unchanged.

Documents updated with the implementation:

- A new ADR amending ADR 0053 § 3 and § 4: Approve gains an optional execution model beside the permission mode, the card still has only Approve and Reject, and approval also commits the selected model. § 5 is unchanged. AGENTS.md § 4 orders this as proposal, then implementation, then ADR.
- A new entry in `docs/spec/08-meta/decisions-log.md`.
- `docs/spec/03-runtime/06-host-rpc-protocol.md` and `01-ipc-protocol.md`: the resolve payload.
- `docs/spec/03-runtime/04-data-storage.md`: the v26 columns.
- `docs/spec/03-runtime/08-error-codes.md` and `packages/shared/src/errors.ts`: `PLAN_TARGET_MODEL_INVALID`.
- `docs/spec/03-runtime/10-session-state-machine.md`, where it describes the approval transition.
- `docs/spec/04-ux/09-interaction-patterns.md` and `08-component-spec.md`: the approval bar.
- `docs/spec/06-delivery/04-e2e-test-plan.md`: the new scenario.
- The matching `docs/zh-CN/spec/` mirrors and `docs/project/unreleased.md`.

## 8. Tests

Host-core (`cargo test -p host-core --locked`):

- Approve with `targetModel` commits mode, permission, provider, model, and thinking level together and stores the target columns.
- Approve without `targetModel` leaves provider, model, and thinking level unchanged.
- Unknown or disabled provider, half-specified target, or invalid thinking level returns `PLAN_TARGET_MODEL_INVALID` and leaves the approval pending.
- `targetModel` on reject is refused.
- Retries: same target is idempotent, omitted target matches, a different target returns `PLAN_APPROVAL_CONFLICT`.
- Migration from v25 on a populated database keeps every approval readable, with `NULL` targets.

Shared and Main:

- Contract tests for both `PlanResolveRequest` branches.
- `plansResolve` validates, forwards only when present, and refuses the field on reject and for sessions that cannot configure a model. The remote backend refuses it.

Renderer:

- The picker defaults to the session model. An untouched approval sends no `targetModel`; a changed one sends it with `thinkingLevel`. A remembered model that is no longer available falls back. The picker is hidden for blocked and remote sessions.
- The Composer shows the execution model after approval.

Runtime:

- `executeApprovedPlan` after a provider change restores history into the rebuilt runtime.

E2E, run as task-candidate validation in the request worktree, extending `scripts/e2e-plan.mjs` and `scripts/e2e-plan-ui.mjs`:

- Plan on fixture provider P1, approve with P2. The execution turn row records P2, the Composer and plan history show P2, and the next turn runs on P2.

## 9. Delivery phases

1. Contract, host-core validation and commit, migration, and Main validation. Behavior-neutral, because no client sends `targetModel` yet.
2. Approval bar picker, preference, Composer refresh, history display, i18n, and E2E.
3. Optional: a default execution model setting that pre-fills the picker (the useful part of Option D), and `targetModel` over RACP and MCP control.

## 10. Decisions

| ID | Question | Decision (2026-10-28) |
| --- | --- | --- |
| Q1 | Does the chosen model stay on the session after execution, or apply only to the execution turn? | Stay on the session. Approval already commits the permission mode this way, and the Composer then always shows the running model. An execution-only override needs a second source of truth for the running model, and later turns would quietly return to the expensive planning model. If switching back by hand becomes tedious, Phase 3's setting can automate it. |
| Q2 | Store the target on `plan_approvals` (migration) or only in the audit log? | Store it. Conflict detection and history need it, and nothing else durable links an execution to its turn. |
| Q3 | Show the thinking level in the approval picker? | Yes, defaulted by the Composer's model-switch rule. |
| Q4 | Remember the last execution model? | Yes, like the permission mode. The picker shows the value before every approval. |
| Q5 | Expose `targetModel` over RACP and MCP control in Phase 1? | No. Both are external contracts and need their own compatibility review (Phase 3). |

## 11. What works today without code

1. Option C1: pin a cheap model on an implementer subagent, or mark the model **Available for AI delegation** under the model's advanced settings in Settings → Models, and ask in the planning request for a plan that delegates implementation to it. The execution turn still runs on the planning model.
2. Option E1: reject the plan, switch the Composer to Agent and the cheap model, and ask the agent to implement the artifact under `.pi/plan/`. History records a rejection.
3. Option E2: approve, stop the execution turn at once, switch the model, and ask the agent to implement the artifact. The approval stays recorded; the planning model's first request may already be billed.
