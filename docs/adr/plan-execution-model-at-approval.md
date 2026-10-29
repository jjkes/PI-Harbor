# ADR plan-execution-model-at-approval: Execution model chosen at plan approval

- Status: Accepted (D675)
- Date: 2026-10-29
- Amends: [ADR 0053](0053-plan-checkpoint-artifact-and-execution-epoch.md) § 3 and § 4
- Related: D198; design: [Plan execution model selection](../superpowers/specs/2026-10-28-plan-execution-model-selection-design.md)

## Context

Approving a Plan or Goal proposal commits the session to Agent with the
selected permission mode and queues the execution turn (ADR 0053 § 4). The
session configuration lock (§ 5) holds from submission until the execution
ends, and both dispatchers launch the execution turn from the session row. The
execution therefore always ran on the model that wrote the plan. A user who
planned with a strong model and wanted a cheaper model to implement had to
reject the plan or stop the execution.

The runtime already handles a model change between turns: the launch resolver
accepts provider and model overrides, and the sidecar rebuilds a session
runtime whose model changed and restores the transcript. Only the approval
decision could not name a model.

## Decision

1. Approve gains an optional execution model, `targetModel: { providerId,
   modelId, thinkingLevel? }`, beside the required permission mode. The card
   still has only Approve and Reject. Reject never carries a target.
2. Host-core validates the target before any write. Both ids are non-empty,
   the thinking level is a known level, and the provider is an enabled
   provider row; trusted extension agents are not valid targets. The model id
   is not checked against a catalog, as in `session.configure`. A failure
   returns `PLAN_TARGET_MODEL_INVALID` and leaves the approval pending.
3. Approval writes the target provider, model, and thinking level to the
   session row in the transaction that writes `mode` and `permission_mode`.
   The session keeps that model after the execution. The dispatchers are
   unchanged: they launch from the committed row.
4. `plan_approvals` stores the target in three nullable columns (schema v26);
   `NULL` means no override. A replay without a target returns the stored
   resolution, and a replay that names a different target fails with
   `PLAN_APPROVAL_CONFLICT`. Proposals, execution descriptors, planning-state
   events, resolution results, and the audit record carry `targetModel`.
5. The approval bar defaults to the last approved execution model while its
   provider and model are still available, and otherwise to the session's
   current model. It sends `targetModel` only when the choice differs from the
   session, and it hides the picker wherever the Composer's own model picker
   is capability-blocked.
6. Main refuses `targetModel` for a session whose model the user cannot
   configure. The remote-control backend refuses it, because RACP
   `approval/respond` has no model field. The control gateway that MCP and
   first-party plugins share refuses it on every `plans/resolve` call, because
   that operation does not carry the field in this phase. The headless host
   does not send it.

ADR 0053 § 5 is unchanged: the Composer stays locked while an approval is
pending, and the approval bar is the only place to choose the execution model.

## Consequences

- Clients that never send `targetModel` behave as before, and existing rows
  read back with no target.
- After the execution the session stays on the execution model. Returning to
  the planning model is an ordinary Composer change.
- The first request after a model change replays the planning transcript
  without the planning provider's prompt cache. Executing from the plan
  artifact alone would avoid that cost, but it changes the rule that the same
  Agent continues into execution and needs its own decision.
- Exposing `targetModel` over RACP, MCP control, or plugin control is a
  separate, later contract change.

## Alternatives

The design compares the rejected options: unlocking the Composer model picker
while approval is pending (contradicts § 5 and races the settling submission
turn), delegating implementation to a cheap subagent (the execution turn still
runs on the planning model), a mode-bound model pair (a second model axis, and
a possible later default), and switching models by hand around the approval
(misrecords the decision or bills a wasted request).
