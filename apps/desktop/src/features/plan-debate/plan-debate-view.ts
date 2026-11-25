/**
 * The debate a session ran, read back from its own transcript.
 *
 * The runtime publishes a round as data: one `PlanDebate` row carrying the
 * roster and requirement, then one `Task` row per delegate that is replaced in
 * place as it settles. That is the whole durable record — the plan artifact and
 * the delegate transcripts hold the documents — so the panel derives its
 * timeline from those rows instead of keeping a second copy of the round that
 * could drift.
 *
 * Everything here is pure: no React, no storage, no clock. The caller passes
 * the messages and the handoff record it read from storage, and gets the same
 * view back, so a reload repaints the timeline the transcript describes.
 */
import type {
  PlanDebateArtifactSeat,
  PlanDebateRoundArtifacts,
  UiMessage,
} from "@pi-harbor/shared";
import type { SubagentOutcome } from "../../lib/subagent-topology";
import {
  debateSeatHandle,
  planDebatePhase,
  type PlanDebateContribution,
  type PlanDebateHandoff,
  type PlanDebateMergedPlan,
  type PlanDebatePhase,
  type PlanDebatePhaseName,
  type PlanDebatePhaseStatus,
  type PlanDebateRole,
  type PlanDebateRound,
  type PlanDebateSelection,
  type PlanDebateState,
  type PlanDebateVerdict,
} from "./plan-debate-machine";

/**
 * A phase status reads as a badge tone, so both drawings of a round — the
 * panel's timeline and the conversation card — colour the same status the same
 * way instead of each keeping its own map.
 */
export const PLAN_DEBATE_STATUS_TONE: Record<
  PlanDebatePhaseStatus,
  "neutral" | "success" | "error" | "warning"
> = {
  pending: "neutral",
  running: "neutral",
  complete: "success",
  failed: "error",
  stopped: "warning",
};

/** How one delegate finished, as its `Task` row reports it. */
export type PlanDebateNodeStatus = "running" | "complete" | "failed" | "stopped";

/** Which phase of the round a delegate works in. */
export type PlanDebateNodePhase = "draft" | "critique" | "integrate";

/**
 * A delegation's status, as the panel's four badges read it.
 *
 * The panel does not judge a seat's status itself: it is handed the same map
 * the docks read (`collectDelegationStatuses`), so one seat can never be 进行中
 * on this surface and 已停止 on the dock's. The dock's finer outcomes collapse
 * onto the four states a phase row can draw: a timeout and a stop both end a
 * seat, and a refusal is a failure.
 */
const PLAN_DEBATE_NODE_STATUS: Record<SubagentOutcome, PlanDebateNodeStatus> = {
  queued: "running",
  running: "running",
  completed: "complete",
  timed_out: "stopped",
  aborted: "stopped",
  failed: "failed",
  stopped: "stopped",
  denied: "failed",
};

const NODE_STATUSES: ReadonlySet<PlanDebateNodeStatus> = new Set<PlanDebateNodeStatus>([
  "running",
  "complete",
  "failed",
  "stopped",
]);

/**
 * The status a delegate row declares itself: the docks' outcome vocabulary
 * (`completed`, `timed_out`, …) as the runtime publishes it, or the panel's own
 * four words. A settled row that says `completed` is a finished seat, never a
 * row to drop.
 */
function declaredNodeStatus(value: unknown): PlanDebateNodeStatus | null {
  if (typeof value !== "string") return null;
  const outcome = (
    PLAN_DEBATE_NODE_STATUS as Record<string, PlanDebateNodeStatus | undefined>
  )[value];
  if (outcome !== undefined) return outcome;
  return NODE_STATUSES.has(value as PlanDebateNodeStatus)
    ? (value as PlanDebateNodeStatus)
    : null;
}

/** One delegate's contribution to one round, as the transcript currently states it. */
export type PlanDebateNode = {
  delegationId: string;
  /** The catalog handle of the seat that ran; `seat` numbers its peers. */
  role: string;
  seat: number;
  phase: PlanDebateNodePhase;
  status: PlanDebateNodeStatus;
  startedAt?: number;
  completedAt?: number;
  text: string;
  error?: string;
};

/** A node's display handle: the role, or `role #2` for a peer seat. */
export function planDebateNodeLabel(node: Pick<PlanDebateNode, "role" | "seat">): string {
  return debateSeatHandle(node.role, node.seat);
}

export type PlanDebateRoundView = {
  round: number;
  requirement: string;
  roles: PlanDebateRole[];
  rationale?: string;
  stoppedAt?: number;
  drafts: PlanDebateNode[];
  critiques: PlanDebateNode[];
  integrator: PlanDebateNode | null;
  merged: PlanDebateMergedPlan | null;
  /**
   * The round as the machine sees it, rebuilt from the derived contributions
   * so `readableDrafts` / `draftingSettled` / `choosePlan` / `canHandoff` and
   * the panel's tests judge the same facts the transcript states.
   */
  state: PlanDebateRound;
  /**
   * True when this round's artifacts came back from disk because the transcript
   * no longer held them. The panel says so once per round instead of silently
   * drawing a round the conversation cannot explain.
   */
  fromDisk?: boolean;
};

export type PlanDebateView = {
  /** Every round the transcript describes, oldest first. */
  rounds: PlanDebateRoundView[];
  /** The round on screen: the newest one, or null before a debate starts. */
  latest: PlanDebateRoundView | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * A failure's reason. The runtime publishes `error` as a string on its own rows
 * and as `{ code, message }` on the lifecycle summary that settles a row; both
 * say why a seat did not produce a document.
 */
function failureText(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (text !== null) return text;
  if (!isRecord(value)) return null;
  return nonEmptyString(value.message) ?? nonEmptyString(value.code);
}

/**
 * The structured payload of one tool row.
 *
 * The runtime returns `{ content, details }`, and `details` is the structured
 * result; a row that was restored from storage may carry the payload directly.
 * Both shapes are accepted, and a payload serialized as a JSON string is read
 * back rather than dropped, because an imported session is still evidence.
 */
function payloadOf(message: UiMessage): unknown {
  const raw: unknown = message.toolResult;
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
  if (isRecord(raw) && raw.details !== undefined && raw.details !== null) return raw.details;
  return raw;
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

type RoundProposal = {
  round: number;
  requirement: string;
  roles: PlanDebateRole[];
  rationale?: string;
  stoppedAt?: number;
};

/** The `PlanDebate` row: the round's roster and the requirement it answers. */
function proposalFromPayload(payload: unknown): RoundProposal | null {
  if (!isRecord(payload)) return null;
  const debate = payload.planDebate;
  if (!isRecord(debate)) return null;
  const round = finiteNumber(debate.round);
  if (round === undefined) return null;
  const requirement = typeof debate.requirement === "string" ? debate.requirement : null;
  if (requirement === null) return null;
  if (!Array.isArray(debate.roles)) return null;
  const roles: PlanDebateRole[] = [];
  for (const role of debate.roles) {
    if (!isRecord(role)) return null;
    const name = nonEmptyString(role.name);
    const brief = nonEmptyString(role.brief);
    if (name === null || brief === null) return null;
    // A proposal row written before seats existed is one seat of each role.
    const storedSeat = finiteNumber(role.seat);
    roles.push({ name, brief, seat: storedSeat !== undefined && storedSeat >= 1 ? storedSeat : 1 });
  }
  const rationale = nonEmptyString(debate.rationale);
  const stoppedAt = finiteNumber(debate.stoppedAt);
  return {
    round,
    requirement,
    roles,
    ...(rationale !== null ? { rationale } : {}),
    ...(stoppedAt !== undefined ? { stoppedAt } : {}),
  };
}

/**
 * One delegate row. Rows are replaced in place when the delegate settles, so
 * this always reads the payload the transcript currently holds; a row missing
 * a field the panel draws is ignored rather than drawn half-empty.
 *
 * The status is the delegation's own, read from the same map the docks read
 * (`statuses`). Without it the row's declared status is used, which is the same
 * fact when nothing else knows better.
 */
function nodeFromPayload(
  payload: unknown,
  statuses?: ReadonlyMap<string, SubagentOutcome>,
): { round: number; node: PlanDebateNode } | null {
  if (!isRecord(payload)) return null;
  const delegationId = nonEmptyString(payload.delegationId);
  // The seat's handle rides beside its round; a row that only names the agent
  // it ran as is the same seat, so the agent name is the fallback.
  const role = nonEmptyString(payload.debateRole) ?? nonEmptyString(payload.agent);
  const round = finiteNumber(payload.debateRound);
  const phase = payload.phase;
  if (delegationId === null || role === null || round === undefined) return null;
  if (phase !== "draft" && phase !== "critique" && phase !== "integrate") return null;
  const settled = statuses?.get(delegationId);
  const status = settled
    ? PLAN_DEBATE_NODE_STATUS[settled]
    : declaredNodeStatus(payload.status);
  if (status === null) return null;
  const startedAt = finiteNumber(payload.startedAt);
  const completedAt = finiteNumber(payload.completedAt);
  const error = failureText(payload.error);
  // The runtime publishes the seat beside the handle: a peer seat is `role #2`.
  const storedSeat = finiteNumber(payload.debateSeat);
  return {
    round,
    node: {
      delegationId,
      role,
      seat: storedSeat !== undefined && storedSeat >= 1 ? storedSeat : 1,
      phase,
      status,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      text: typeof payload.debateReport === "string" ? payload.debateReport : "",
      ...(error !== null ? { error } : {}),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Merged plan                                                                */
/* -------------------------------------------------------------------------- */

const ADOPTED_TOKENS = new Set(["adopted", "采纳"]);
const REJECTED_TOKENS = new Set(["rejected", "驳回"]);

/** `VERDICTS` / `## VERDICTS` — a heading is tolerated, the word is not. */
const VERDICTS_HEADING = /^[#*\s]*VERDICTS\b/i;
/** `PLAN` / `## PLAN:` — `PLANNING` must not match, hence the word boundary. */
const PLAN_HEADING = /^[#*\s]*PLAN\b/i;
/** A list marker: `-`, `*`, `+`, `•`, or `1.` / `1)`. */
const LIST_MARKER = /^\s*(?:[-*+•]|\d+[.)])\s*/;

function verdictOf(raw: string): "adopted" | "rejected" | null {
  // Markdown emphasis and a trailing colon are decoration on the word.
  const token = raw.replace(/[*_`]/g, "").replace(/[：:]+$/, "").trim().toLowerCase();
  if (ADOPTED_TOKENS.has(token)) return "adopted";
  if (REJECTED_TOKENS.has(token)) return "rejected";
  return null;
}

/**
 * One verdict line: `adopted | item | source`, and the same with `:` as the
 * separator or 采纳 / 驳回 as the words. An unrecognizable line is dropped
 * instead of failing the block, because a model's formatting is not a contract.
 */
function verdictFromLine(line: string): PlanDebateVerdict | null {
  const body = line.replace(LIST_MARKER, "").trim();
  if (body === "") return null;
  const separator = body.includes("|") ? "|" : body.includes("：") ? "：" : body.includes(":") ? ":" : null;
  if (separator === null) return null;
  const parts = body.split(separator).map((part) => part.trim());
  const verdict = verdictOf(parts[0] ?? "");
  if (verdict === null) return null;
  const item = parts[1] ?? "";
  if (item === "") return null;
  const source = parts.slice(2).join(separator === "|" ? " | " : separator).trim();
  return { item, verdict, source };
}

/**
 * The integrator's report, split into the plan a reader chooses and the
 * verdicts that explain it. A report with no block still is a plan, so it is
 * returned whole with no verdicts rather than rejected.
 */
export function parseMergedPlan(report: string): PlanDebateMergedPlan | null {
  if (typeof report !== "string" || report.trim() === "") return null;
  const lines = report.split(/\r?\n/);
  const verdictsStart = lines.findIndex((line) => VERDICTS_HEADING.test(line.trim()));
  if (verdictsStart < 0) return { text: report, verdicts: [] };
  const planStart = lines.findIndex(
    (line, index) => index > verdictsStart && PLAN_HEADING.test(line.trim()),
  );
  const verdictLines =
    planStart < 0
      ? lines.slice(verdictsStart + 1)
      : lines.slice(verdictsStart + 1, planStart);
  const verdicts: PlanDebateVerdict[] = [];
  for (const line of verdictLines) {
    const verdict = verdictFromLine(line);
    if (verdict !== null) verdicts.push(verdict);
  }
  if (planStart < 0) return { text: report, verdicts };
  const body = lines.slice(planStart + 1).join("\n").trim();
  return { text: body === "" ? report : body, verdicts };
}

/* -------------------------------------------------------------------------- */
/* Phases                                                                     */
/* -------------------------------------------------------------------------- */

type Timed = {
  startedAt?: number;
  completedAt?: number;
};

type PhaseInput = {
  round: number;
  requirement: string;
  roles: number;
  drafts: PlanDebateContribution[];
  objections: PlanDebateContribution[];
  integrator: PlanDebateNode | null;
  merged: PlanDebateMergedPlan | null;
  handoffRound: number | null;
  stoppedAt?: number;
};

function minDefined(values: readonly (number | undefined)[]): number | undefined {
  let result: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (result === undefined || value < result) result = value;
  }
  return result;
}

function maxDefined(values: readonly (number | undefined)[]): number | undefined {
  let result: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (result === undefined || value > result) result = value;
  }
  return result;
}

/** A phase row: status, plus the span its own nodes ran through. */
function phaseOf(
  name: PlanDebatePhaseName,
  status: PlanDebatePhaseStatus,
  nodes: readonly Timed[],
): PlanDebatePhase {
  const phase: PlanDebatePhase = { name, status };
  const startedAt = minDefined(nodes.map((node) => node.startedAt));
  if (startedAt !== undefined) phase.startedAt = startedAt;
  if (status === "complete" || status === "failed" || status === "stopped") {
    const completedAt = maxDefined(nodes.map((node) => node.completedAt));
    if (completedAt !== undefined) phase.completedAt = completedAt;
  }
  return phase;
}

function contributionOf(node: PlanDebateNode): PlanDebateContribution {
  return {
    // The machine keys contributions by role, so a peer seat contributes under
    // its own display handle; two seats of one specialty never collide.
    role: planDebateNodeLabel(node),
    status: node.status,
    text: node.text,
    ...(node.startedAt !== undefined ? { startedAt: node.startedAt } : {}),
    ...(node.completedAt !== undefined ? { completedAt: node.completedAt } : {}),
    ...(node.error !== undefined ? { error: node.error } : {}),
  };
}

function contributionsOf(nodes: readonly PlanDebateNode[]): PlanDebateContribution[] {
  return nodes.map(contributionOf);
}

/**
 * One phase's status, from the seats it holds.
 *
 * A phase is a projection of its seats and nothing else — no clock, no single
 * seat's word:
 *
 * - `pending` while no seat of the phase has started;
 * - `running` while any of its seats is still open;
 * - `complete` once every seat has settled and at least one left a report;
 * - `stopped` when reportless seats were user-stopped and none really failed;
 * - `failed` when settled seats failed or completed without any report.
 *
 * A phase whose seats are all terminal can therefore never read `running`
 * again — the old critique row fell back to `running` whenever a settled
 * objection had no text, which is what left a finished round ticking 进行中
 * forever.
 *
 * The seats a phase expects are the seats the round dispatched for it: a seat
 * exists only once the runtime started it, and the driver slices a roster to the
 * free delegate slots, so a roster count is not a seat count and must not keep a
 * finished phase open.
 */
function phaseStatusOf(
  seats: readonly Pick<PlanDebateNode, "status" | "text">[],
): PlanDebatePhaseStatus {
  if (seats.length === 0) return "pending";
  if (seats.some((seat) => seat.status === "running")) return "running";
  if (seats.some((seat) => seat.text.trim() !== "")) return "complete";
  // A reportless user stop is not a delegate failure. A real failure still
  // wins when both outcomes are present, while an all-stopped phase reads stopped.
  if (seats.some((seat) => seat.status === "failed")) return "failed";
  if (seats.some((seat) => seat.status === "stopped")) return "stopped";
  return "failed";
}

/**
 * The six phases with derived status and timestamps.
 *
 * A round is a timeline, not a state machine: the transcript says which
 * delegates ran and how they finished, and the phase rows are what that means.
 * Nothing here is stored, so a row that arrives late repaints the phase it
 * belongs to instead of leaving a stale label behind.
 */
function derivePhases(input: PhaseInput): PlanDebatePhase[] {
  const nodeCount =
    input.drafts.length + input.objections.length + (input.integrator ? 1 : 0);
  const draftContributions = input.drafts;
  const drafting = phaseOf("drafting", phaseStatusOf(draftContributions), draftContributions);

  // Proposing stays *running* while the round has a roster but none of its
  // delegates: the model proposed, and the round waits for the user's start
  // control. It is over as soon as a delegate exists; its span then runs from
  // the round's first delegate to the start of drafting.
  const creation = minDefined([
    ...draftContributions.map((draft) => draft.startedAt),
    ...input.objections.map((objection) => objection.startedAt),
    ...(input.integrator ? [input.integrator.startedAt] : []),
  ]);
  const proposing: PlanDebatePhase =
    nodeCount === 0 && input.requirement.trim() === "" && input.roles === 0
      ? { name: "proposing", status: "pending" }
      : nodeCount === 0
        ? { name: "proposing", status: "running" }
        : {
            name: "proposing",
            status: "complete",
            ...(creation !== undefined ? { startedAt: creation } : {}),
            ...(drafting.startedAt !== undefined
              ? { completedAt: drafting.startedAt }
              : {}),
          };

  const critiquing = phaseOf("critiquing", phaseStatusOf(input.objections), input.objections);

  const integratorSeats = input.integrator ? [input.integrator] : [];
  const integrating = phaseOf("integrating", phaseStatusOf(integratorSeats), integratorSeats);

  // Review starts when there is something to choose. Choosing is what completes
  // it, and the panel owns that selection rather than the transcript.
  const artifact =
    hasReadable(draftContributions) ||
    (input.merged !== null && input.merged.text.trim() !== "");
  const reviewing: PlanDebatePhase = {
    name: "reviewing",
    status: artifact ? "running" : "pending",
  };

  const handedOff = input.handoffRound !== null && input.handoffRound === input.round;
  const handingoff: PlanDebatePhase = {
    name: "handingoff",
    status: handedOff ? "complete" : "pending",
  };

  const phases = [proposing, drafting, critiquing, integrating, reviewing, handingoff];
  if (input.stoppedAt === undefined) return phases;
  // End is a round-level terminal fact: pending phases never started and a
  // stale running phase must not keep drawing a user-stopped round as active.
  return phases.map((phase) =>
    phase.status === "pending" || phase.status === "running"
      ? {
          ...phase,
          status: "stopped" as const,
          ...(phase.startedAt !== undefined && phase.completedAt === undefined
            ? { completedAt: input.stoppedAt }
            : {}),
        }
      : phase,
  );
}

/**
 * The machine's readability rule, for contributions the machine has no helper
 * for: a settled contribution with text a reader can open.
 */
function hasReadable(list: readonly PlanDebateContribution[]): boolean {
  return list.some((item) => item.status === "complete" && item.text.trim() !== "");
}

/**
 * The round's phases as the panel draws them.
 *
 * The handoff record is not part of the transcript, so it was merged into the
 * round's machine phases when the view was built; reading it back here keeps
 * one derivation for both the stored state and the drawn timeline.
 */
export function planDebatePhaseStatuses(round: PlanDebateRoundView): PlanDebatePhase[] {
  const handedOff = planDebatePhase(round.state, "handingoff").status === "complete";
  return derivePhases({
    round: round.round,
    requirement: round.requirement,
    roles: round.roles.length,
    drafts: contributionsOf(round.drafts),
    objections: contributionsOf(round.critiques),
    integrator: round.integrator,
    merged: round.merged,
    handoffRound: handedOff ? round.round : null,
    stoppedAt: round.stoppedAt,
  });
}

/* -------------------------------------------------------------------------- */
/* View                                                                       */
/* -------------------------------------------------------------------------- */

type RoundBucket = {
  round: number;
  requirement: string;
  roles: PlanDebateRole[];
  rationale?: string;
  drafts: PlanDebateNode[];
  critiques: PlanDebateNode[];
  integrator: PlanDebateNode | null;
  stoppedAt?: number;
};

/** Replace one delegate's node where it already stands: order is evidence. */
function upsertNode(list: PlanDebateNode[], node: PlanDebateNode): void {
  const index = list.findIndex((item) => item.delegationId === node.delegationId);
  if (index < 0) list.push(node);
  else list[index] = node;
}

function buildRoundView(
  bucket: RoundBucket,
  handoff: PlanDebateHandoff | null,
): PlanDebateRoundView {
  const drafts = contributionsOf(bucket.drafts);
  const objections = contributionsOf(bucket.critiques);
  const merged = bucket.integrator ? parseMergedPlan(bucket.integrator.text) : null;
  const phases = derivePhases({
    round: bucket.round,
    requirement: bucket.requirement,
    roles: bucket.roles.length,
    drafts,
    objections,
    integrator: bucket.integrator,
    merged,
    handoffRound: handoff?.round ?? null,
    stoppedAt: bucket.stoppedAt,
  });
  const state: PlanDebateRound = {
    round: bucket.round,
    constraint: bucket.requirement,
    // A round after the first answers the user's objection about the last one.
    redebate: bucket.round > 1,
    roles: bucket.roles,
    phases,
    drafts,
    objections,
    merged,
    createdAt:
      minDefined([
        ...bucket.drafts.map((node) => node.startedAt),
        ...bucket.critiques.map((node) => node.startedAt),
        ...(bucket.integrator ? [bucket.integrator.startedAt] : []),
      ]) ?? 0,
  };
  return {
    round: bucket.round,
    requirement: bucket.requirement,
    roles: bucket.roles,
    ...(bucket.rationale !== undefined ? { rationale: bucket.rationale } : {}),
    ...(bucket.stoppedAt !== undefined ? { stoppedAt: bucket.stoppedAt } : {}),
    drafts: bucket.drafts,
    critiques: bucket.critiques,
    integrator: bucket.integrator,
    merged,
    state,
  };
}

/**
 * Group the debate rows by round.
 *
 * A round exists from its `PlanDebate` row or from any delegate row that names
 * it, because a delegate can publish before the proposal row lands. Rounds are
 * ascending and nodes keep transcript order, so the panel can render the
 * timeline the session actually ran.
 *
 * `statuses` is the session's delegation statuses — the same map the subagent
 * docks read (`useSessionDelegations`). A seat's status is taken from there
 * rather than judged again here, so the panel and the dock report one truth for
 * the same delegation; a caller that has no map reads the row's own status.
 */
export function planDebateView(
  messages: readonly UiMessage[],
  handoff: PlanDebateHandoff | null = null,
  statuses?: ReadonlyMap<string, SubagentOutcome>,
): PlanDebateView {
  const buckets = new Map<number, RoundBucket>();
  const bucketFor = (round: number): RoundBucket => {
    const existing = buckets.get(round);
    if (existing) return existing;
    const created: RoundBucket = {
      round,
      requirement: "",
      roles: [],
      drafts: [],
      critiques: [],
      integrator: null,
    };
    buckets.set(round, created);
    return created;
  };

  for (const message of messages) {
    if (!message || message.role !== "tool") continue;
    if (message.toolName === "PlanDebate") {
      const proposal = proposalFromPayload(payloadOf(message));
      if (proposal === null) continue;
      const bucket = bucketFor(proposal.round);
      bucket.requirement = proposal.requirement;
      bucket.roles = proposal.roles;
      if (proposal.rationale !== undefined) bucket.rationale = proposal.rationale;
      else delete bucket.rationale;
      if (proposal.stoppedAt !== undefined) bucket.stoppedAt = proposal.stoppedAt;
      continue;
    }
    if (message.toolName !== "Task") continue;
    const delegate = nodeFromPayload(payloadOf(message), statuses);
    if (delegate === null) continue;
    const bucket = bucketFor(delegate.round);
    if (delegate.node.phase === "draft") upsertNode(bucket.drafts, delegate.node);
    else if (delegate.node.phase === "critique") upsertNode(bucket.critiques, delegate.node);
    else bucket.integrator = delegate.node;
  }

  const rounds = [...buckets.values()]
    .sort((left, right) => left.round - right.round)
    .map((bucket) => buildRoundView(bucket, handoff));
  return { rounds, latest: rounds.length > 0 ? rounds[rounds.length - 1] : null };
}

/* -------------------------------------------------------------------------- */
/* Disk artifacts                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The seat a set of artifacts describes, as a panel node.
 *
 * A seat on disk has settled, so its status is terminal and its text is the
 * report itself. A reportless stopped seat stays stopped; an older index
 * without its own completion clock inherits the round's stop stamp.
 */
function nodeFromArtifact(
  seat: PlanDebateArtifactSeat,
  stoppedAt?: number,
): PlanDebateNode {
  const completedAt =
    seat.completedAt ?? (seat.status === "stopped" ? stoppedAt : undefined);
  return {
    delegationId: seat.delegationId,
    role: seat.role,
    seat: seat.seat,
    phase: seat.phase,
    status: seat.status,
    ...(seat.startedAt !== undefined ? { startedAt: seat.startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    text: seat.report ?? "",
    ...(seat.error !== undefined ? { error: seat.error } : {}),
  };
}

/** Two nodes are the same seat when they are the same delegation or seat. */
function sameSeat(left: Pick<PlanDebateNode, "delegationId" | "role" | "seat">, right: Pick<PlanDebateNode, "delegationId" | "role" | "seat">): boolean {
  if (left.delegationId === right.delegationId) return true;
  return left.role === right.role && left.seat === right.seat;
}

function bucketFromRound(round: PlanDebateRoundView): RoundBucket {
  return {
    round: round.round,
    requirement: round.requirement,
    roles: [...round.roles],
    ...(round.rationale !== undefined ? { rationale: round.rationale } : {}),
    ...(round.stoppedAt !== undefined ? { stoppedAt: round.stoppedAt } : {}),
    drafts: [...round.drafts],
    critiques: [...round.critiques],
    integrator: round.integrator,
  };
}

/**
 * The roster a round had, when the transcript no longer holds its proposal row.
 *
 * The index records the roster it started with — role name, brief and seat — so
 * a recovered round reads exactly as the live one did. An index written before
 * that (`roles` absent) still names the seats it settled, with an empty brief:
 * the panel can say who debated without inventing a brief the user never read.
 */
function rolesFromArtifact(artifact: PlanDebateRoundArtifacts): PlanDebateRole[] {
  const listed = artifact.roles ?? [];
  const roles: PlanDebateRole[] = [];
  for (const role of listed) {
    if (roles.some((existing) => existing.name === role.name && existing.seat === role.seat)) continue;
    roles.push({ name: role.name, brief: role.brief, seat: role.seat });
  }
  if (roles.length > 0) return roles;
  for (const seat of artifact.seats) {
    if (roles.some((role) => role.name === seat.role && role.seat === seat.seat)) continue;
    roles.push({ name: seat.role, brief: "", seat: seat.seat });
  }
  return roles;
}

/**
 * Apply one round's artifacts to a bucket, and say whether disk added anything.
 *
 * Disk wins for a seat it names: the seat settled, and a report read back from
 * the file is the delegate's own conclusion rather than a row that may have
 * aged out of the window. The transcript keeps what disk cannot know — a seat
 * still running, its briefs, its rationale — so nothing is dropped here.
 */
function applyArtifact(bucket: RoundBucket, artifact: PlanDebateRoundArtifacts): boolean {
  let contributed = false;
  if (artifact.stoppedAt !== undefined && bucket.stoppedAt !== artifact.stoppedAt) {
    bucket.stoppedAt = artifact.stoppedAt;
    contributed = true;
  }
  if (bucket.requirement.trim() === "" && artifact.requirement.trim() !== "") {
    bucket.requirement = artifact.requirement;
    contributed = true;
  }
  if (bucket.roles.length === 0) {
    const roles = rolesFromArtifact(artifact);
    if (roles.length > 0) {
      bucket.roles = roles;
      // A roster the window no longer holds is itself something disk added.
      contributed = true;
    }
  }
  for (const seat of artifact.seats) {
    const node = nodeFromArtifact(seat, artifact.stoppedAt);
    if (node.delegationId === "") continue;
    if (node.phase === "integrate") {
      // A settled integrator is the round's merged plan, whatever the window
      // still says about it.
      if (bucket.integrator === null || bucket.integrator.text.trim() === "") {
        bucket.integrator = node;
        contributed = true;
      }
      continue;
    }
    const list = node.phase === "draft" ? bucket.drafts : bucket.critiques;
    const index = list.findIndex((item) => sameSeat(item, node));
    if (index < 0) {
      list.push(node);
      contributed = true;
      continue;
    }
    const previous = list[index];
    if (previous === undefined) continue;
    // Keep the transcript's own span where disk has none, but take the settled
    // status and the report: those are the facts the window lost.
    const merged: PlanDebateNode = {
      ...previous,
      ...node,
      ...(previous.startedAt !== undefined && node.startedAt === undefined
        ? { startedAt: previous.startedAt }
        : {}),
      ...(previous.completedAt !== undefined && node.completedAt === undefined
        ? { completedAt: previous.completedAt }
        : {}),
      ...(node.text.trim() === "" && previous.text.trim() !== "" ? { text: previous.text } : {}),
      ...(node.error === undefined && previous.error !== undefined ? { error: previous.error } : {}),
    };
    list[index] = merged;
    if (previous.status !== merged.status || previous.text !== merged.text) contributed = true;
  }
  return contributed;
}

/**
 * The panel's view: the transcript, plus the rounds the runtime wrote to disk.
 *
 * The artifacts are additive and never required. A session that debated before
 * they existed has none, and renders exactly as its transcript describes; a
 * session that debated since gets its drafts back even when fifteen rows of
 * debate pushed them out of the window, and a reload can still read the round.
 */
export function planDebateViewWithArtifacts(
  messages: readonly UiMessage[],
  artifacts: readonly PlanDebateRoundArtifacts[],
  handoff: PlanDebateHandoff | null = null,
  statuses?: ReadonlyMap<string, SubagentOutcome>,
  sessionId?: string,
): PlanDebateView {
  const transcript = planDebateView(messages, handoff, statuses);
  if (artifacts.length === 0) return transcript;
  const buckets = new Map<number, RoundBucket>();
  const recovered = new Set<number>();
  for (const round of transcript.rounds) buckets.set(round.round, bucketFromRound(round));
  for (const artifact of artifacts) {
    if (!Number.isInteger(artifact.round) || artifact.round < 1) continue;
    const isLegacy = artifact.sessionId === undefined;
    const isOwned = !isLegacy && artifact.sessionId === sessionId;
    if (!isLegacy && !isOwned) continue;
    const existing = buckets.get(artifact.round);
    const bucket =
      existing ??
      ({ round: artifact.round, requirement: "", roles: [], drafts: [], critiques: [], integrator: null } satisfies RoundBucket);
    if (applyArtifact(bucket, artifact)) recovered.add(artifact.round);
    buckets.set(artifact.round, bucket);
  }
  const rounds = [...buckets.values()]
    .sort((left, right) => left.round - right.round)
    .map((bucket) => {
      const view = buildRoundView(bucket, handoff);
      return recovered.has(bucket.round) ? { ...view, fromDisk: true } : view;
    });
  return { rounds, latest: rounds.length > 0 ? rounds[rounds.length - 1] : null };
}
/** One delegate that has not settled yet: the round is still producing. */
function nodeIsRunning(node: PlanDebateNode): boolean {
  return node.status === "running";
}

/** Does this round own any delegate row at all? */
export function planDebateRoundHasNodes(round: PlanDebateRoundView | null): boolean {
  if (round === null) return false;
  return round.drafts.length > 0 || round.critiques.length > 0 || round.integrator !== null;
}

/** A document a reader can actually open. */
function nodeHasReport(node: PlanDebateNode): boolean {
  return node.status === "complete" && node.text.trim() !== "";
}

/**
 * Whether the round waits for the user's start: a roster was proposed, but no
 * delegate has ever been started for it. The panel's start control is drawn
 * exactly for this state, and nowhere else.
 */
export function planDebateAwaitingStart(round: PlanDebateRoundView | null): boolean {
  if (round === null || round.stoppedAt !== undefined) return false;
  return (
    round.roles.length > 0 &&
    round.drafts.length === 0 &&
    round.critiques.length === 0 &&
    round.integrator === null
  );
}

/**
 * Is a round still producing?
 *
 * A round is running exactly while one of the delegates it published — a
 * draft, a critique, or the integrator — has not settled. Nothing else
 * counts: `reviewing` stays open while the user chooses a plan, so it says
 * the round is readable, not that it is still moving.
 */
export function planDebateRoundRunning(round: PlanDebateRoundView | null): boolean {
  if (round === null || round.stoppedAt !== undefined) return false;
  return (
    round.drafts.some(nodeIsRunning) ||
    round.critiques.some(nodeIsRunning) ||
    (round.integrator !== null && nodeIsRunning(round.integrator))
  );
}

/**
 * Is this round's pipeline still unfinished?
 *
 * The same rule the runtime's driver applies, read back from the transcript:
 * the round is unfinished while a phase it must still run has no verdict. A
 * roster nobody started yet is unfinished (the user's start is the only thing
 * that opens it); every seat has to publish before the next phase may begin;
 * and the round is over once the integrator settled — or once every draft
 * failed, which is the one failure that ends a round early.
 *
 * The count checks apply only when the round knows its roster: a bucket whose
 * proposal row never landed still gets the running/settled answer.
 */
export function planDebateRoundUnfinished(round: PlanDebateRoundView | null): boolean {
  if (round === null || round.stoppedAt !== undefined) return false;
  if (!planDebateRoundHasNodes(round)) return round.roles.length > 0;
  const seats = round.roles.length;
  const short = (published: number) => seats > 0 && published < seats;
  // Drafting: a running seat, or a seat that has not published at all.
  if (round.drafts.some(nodeIsRunning)) return true;
  if (short(round.drafts.length)) return true;
  // A round whose every draft failed is over: there is nothing to critique.
  if (!round.drafts.some(nodeHasReport)) return false;
  // Critiquing: every seat objects before the integrator may start.
  if (round.critiques.some(nodeIsRunning)) return true;
  if (short(round.critiques.length)) return true;
  // Integrating: the merged plan is the round's last step.
  if (round.integrator === null) return true;
  return nodeIsRunning(round.integrator);
}

/**
 * The round the panel draws.
 *
 * The newest round that owns a delegate, whether it finished or not. A round
 * that owns no delegate says nothing about the debate — its six phase rows are
 * all `pending` — so it is never the body of the tab, however new it is: the
 * panel draws the artifacts that exist and the tab's header line names the
 * round that has not started, with the control that starts it. Falling back to
 * an empty newest round is what once hid the live round behind a scaffold of
 * "nothing in this phase yet".
 *
 * `latest` is returned only when no round owns a delegate at all: a session
 * whose first roster was proposed and not yet started still has one round to
 * draw.
 */
export function planDebatePanelRound(view: PlanDebateView): PlanDebateRoundView | null {
  for (let index = view.rounds.length - 1; index >= 0; index -= 1) {
    const round = view.rounds[index];
    if (round !== undefined && planDebateRoundHasNodes(round)) return round;
  }
  return view.latest;
}

/**
 * The rounds newer than the one on screen that own no delegate yet.
 *
 * The panel draws the newest of them as one header line above the round with
 * the artifacts — `Round 2 has not started · Start debate` — so a round the
 * user must start is never invisible and never replaces the body.
 */
export function planDebatePendingRounds(
  view: PlanDebateView,
  shown: PlanDebateRoundView | null,
): PlanDebateRoundView[] {
  if (shown === null) return [];
  return view.rounds.filter(
    (round) => round.round > shown.round && !planDebateRoundHasNodes(round),
  );
}

/**
 * Does this transcript describe a debate round that is still running? It reads
 * the same view the panel draws, so the composer's debate button and the
 * round's timeline can never disagree about whether the round is live.
 *
 * The handoff record is not read: it only closes the `handingoff` phase, which
 * no delegate's status depends on.
 */
export function planDebateRunning(messages: readonly UiMessage[]): boolean {
  return planDebateRoundRunning(planDebateView(messages).latest);
}

/**
 * The round that keeps the composer from launching another one, or `null` when
 * the debate is between rounds.
 *
 * Two rounds can answer. The one on screen answers first: while the round whose
 * artifacts are drawn is still unfinished, no new round may start beside it.
 * Then the newest round: a round nobody has started yet — a roster proposed and
 * waiting for the user's start — is unfinished too, and it is the one the start
 * control opens. Both answers are the panel's own rounds, so the composer's
 * 发起辩论 and the panel's timeline never point at two different rounds.
 */
export function planDebateUnfinishedRound(messages: readonly UiMessage[]): number | null {
  const view = planDebateView(messages);
  const shown = planDebatePanelRound(view);
  if (shown !== null && planDebateRoundUnfinished(shown)) return shown.round;
  const latest = view.latest;
  if (latest !== null && latest !== shown && planDebateRoundUnfinished(latest)) {
    return latest.round;
  }
  return null;
}

/**
 * The derived rounds as machine state, so the component and the machine's own
 * helpers (`choosePlan`, `canHandoff`, `planDebateChoices`) agree on what the
 * transcript says instead of each judging it differently.
 */
export function planDebateState(
  view: PlanDebateView,
  selection: PlanDebateSelection | null,
  handoff: PlanDebateHandoff | null,
): PlanDebateState {
  return { rounds: view.rounds.map((round) => round.state), selection, handoff };
}
