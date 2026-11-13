/**
 * `PlanDebate`: one validated roster starts one plan debate.
 *
 * A debate is expensive — one delegate per role, then objections, then one
 * integrator — so the roster is validated before anything starts. A role must
 * resolve to a definition this session can actually launch, because a fabricated
 * name would either fail after the user waited or, worse, quietly drop a seat
 * from a debate the user believes is complete.
 *
 * This module owns the roster and the round request as data; the runtime owns
 * the delegates. A valid roster is a *proposal*: it creates the round in
 * `proposing` and starts nothing. The user confirms the roster in the panel,
 * and only then does the pipeline start — so an expensive round of delegates
 * never runs on the model's word alone, and `plan-debate-driver` decides what
 * runs next once the round is open.
 */
import { Type } from "typebox";
import { normalizeSubagentName, type SubagentDefinition } from "@pi-harbor/shared";

export const PLAN_DEBATE_TOOL_NAME = "PlanDebate";

/**
 * A role that passed validation: the catalog handle, the head its brief makes
 * for, and which seat of that handle it is.
 *
 * A debate may seat the same specialty twice — two frontend engineers argue
 * better than one frontend engineer and one generalist — so `name` alone no
 * longer identifies a seat. `seat` is the 1-based occurrence of that handle in
 * the roster, and every label, key and transcript row carries it.
 */
export type PlanDebateRoleProposal = {
  name: string;
  brief: string;
  seat: number;
};

export const PLAN_DEBATE_MIN_ROLES = 3;
export const PLAN_DEBATE_MAX_ROLES = 5;

/**
 * A seat's display handle: the plain catalog name for the first seat, and
 * `name #2`, `name #3` for the peers that debate beside it.
 *
 * The driver writes this into briefs and topology labels; the panel reads the
 * same text out of the transcript. Keep the shape in step with
 * `debateSeatHandle` in the renderer's `plan-debate-machine`.
 */
export function debateSeatHandle(name: string, seat: number): string {
  return seat > 1 ? `${name} #${seat}` : name;
}
export type PlanDebateValidation =
  | { ok: true; roles: PlanDebateRoleProposal[]; rationale?: string }
  | { ok: false; message: string };

export const planDebateDescription = [
  "Run a plan debate over one requirement: every role drafts a plan, every role objects to all the drafts, then one integrator merges them into a single plan with per-item verdicts.",
  "Only the user opens a round. You may call this tool with `intent: \"start\"` only when the user's own message is the plan-mode debate request (the composer's debate button, or the panel's 重新辩论 prompt): that call proposes the roster and the round waits in `proposing` until the user starts it, so nothing drafts on your word alone and you must not tell the user the debate is running until they start it. A call without `intent: \"start\"` opens nothing: it answers with the round that already exists, or tells the user which control opens the first one.",
  "Every `name` must be a handle from the subagent catalog in this tool's description. Do not invent a role: a name that does not resolve is rejected.",
  "`brief` is the role's job for this debate — what it should draft and what it should object to. It is the only instruction that delegate gets beyond the requirement.",
  "The same specialty may be seated more than once — two `frontend-architect` seats argue better than one specialist and one generalist — but every seat needs its own `brief`, because two identical briefs would run the same argument twice. Seats are labelled `name #2`, `name #3` in the panel.",
  "`requirement` is what the merged plan must satisfy, in your own words. On a re-debate, pass the user's objection as `objection` and the next round number as `round`; the previous round stays as history.",
  "A round that produces no usable draft, or drafts but no merged plan, ends with a typed failure you can read and correct by calling PlanDebate again.",
].join("\n\n");

export const planDebateParameters = {
  intent: Type.Optional(
    Type.Literal("start", {
      description:
        "Pass \"start\" only when the user's own message asked for this debate (the composer's debate button, the panel's re-debate prompt). Without it this tool opens no round: it answers with the round that already exists, because only the user opens a debate.",
    }),
  ),
  roles: Type.Array(
    Type.Object({
      name: Type.String({
        minLength: 1,
        description: "Subagent handle from the catalog, e.g. 'code-reviewer'.",
      }),
      brief: Type.String({
        minLength: 1,
        description: "What this role drafts and what it must object to.",
      }),
    }),
    {
      minItems: PLAN_DEBATE_MIN_ROLES,
      maxItems: PLAN_DEBATE_MAX_ROLES,
      description:
        "The debate roster, in speaking order. A handle may appear more than once; each occurrence is a seat with its own brief.",
    },
  ),
  requirement: Type.Optional(
    Type.String({
      description:
        "What the merged plan must satisfy. State it fully: the drafting delegates cannot see this conversation.",
    }),
  ),
  objection: Type.Optional(
    Type.String({
      description:
        "The user's objection to the previous round, when this call re-debates the plan. It becomes an extra constraint every role drafts against.",
    }),
  ),
  round: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Round number for this debate. Omit for the first round; a re-debate passes the previous round plus one so the panel keeps the older round as history.",
    }),
  ),
  integrator: Type.Optional(
    Type.String({
      description:
        "Role that merges the drafts into one plan. Defaults to the first role in the roster.",
    }),
  ),
  rationale: Type.Optional(
    Type.String({
      description: "Why these roles, in one or two sentences. Shown to the user.",
    }),
  ),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Handles a session may debate with, normalized the way rosters key them. */
function catalogHandles(catalog: readonly SubagentDefinition[]): Map<string, string> {
  const handles = new Map<string, string>();
  for (const definition of catalog) {
    const handle = normalizeSubagentName(definition.name);
    if (handle && !handles.has(handle)) handles.set(handle, definition.name);
  }
  return handles;
}

/**
 * Check a proposed roster against the session's catalog.
 *
 * Normalizing before comparing means `Code Reviewer`, `code-reviewer` and
 * `code_reviewer.md` are one role, so a roster cannot list one definition under
 * two spellings by accident. The same handle *may* be seated more than once: a
 * debate between peers of one specialty is the point of a debate, so the second
 * seat is `name #2` and needs its own brief. What a roster may not do is repeat
 * a seat without telling the two apart — two identical briefs would run the same
 * argument twice and charge the user for it.
 */
export function validatePlanDebateRoles(
  args: unknown,
  catalog: readonly SubagentDefinition[],
): PlanDebateValidation {
  if (!isRecord(args)) return { ok: false, message: "PlanDebate expects an object argument." };
  const raw = args.roles;
  if (!Array.isArray(raw)) {
    return { ok: false, message: "PlanDebate needs a `roles` array." };
  }
  if (raw.length < PLAN_DEBATE_MIN_ROLES) {
    return {
      ok: false,
      message: `A debate needs at least ${PLAN_DEBATE_MIN_ROLES} roles; got ${raw.length}.`,
    };
  }
  if (raw.length > PLAN_DEBATE_MAX_ROLES) {
    return {
      ok: false,
      message: `A debate runs at most ${PLAN_DEBATE_MAX_ROLES} roles; got ${raw.length}.`,
    };
  }
  const handles = catalogHandles(catalog);
  const available = [...handles.keys()].sort();
  const roles: PlanDebateRoleProposal[] = [];
  // Seats per handled: `frontend` twice is two peers, not a mistake.
  const seats = new Map<string, number>();
  const briefsByHandle = new Map<string, Set<string>>();
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      return { ok: false, message: `Role ${index + 1} needs a string \`name\`.` };
    }
    const handle = normalizeSubagentName(entry.name);
    if (!handle) {
      return { ok: false, message: `Role ${index + 1} has an empty name.` };
    }
    if (!handles.has(handle)) {
      return {
        ok: false,
        message: `Role ${index + 1} is "${entry.name}", which is not a subagent here. Use one of: ${available.join(", ")}.`,
      };
    }
    const brief = typeof entry.brief === "string" ? entry.brief.trim() : "";
    if (!brief) {
      return {
        ok: false,
        message: `Role ${handle} needs a \`brief\` so its delegate knows its job.`,
      };
    }
    const seat = (seats.get(handle) ?? 0) + 1;
    const briefs = briefsByHandle.get(handle) ?? new Set<string>();
    const signature = brief.replace(/\s+/g, " ").toLowerCase();
    if (briefs.has(signature)) {
      return {
        ok: false,
        message: `Seat ${debateSeatHandle(handle, seat)} repeats another ${handle} brief; each seat of the same role needs its own angle so the debate has two arguments in it.`,
      };
    }
    briefs.add(signature);
    briefsByHandle.set(handle, briefs);
    seats.set(handle, seat);
    roles.push({ name: handle, brief, seat });
  }
  const rationale =
    typeof args.rationale === "string" && args.rationale.trim()
      ? args.rationale.trim()
      : undefined;
  return { ok: true, roles, ...(rationale ? { rationale } : {}) };
}

/** What the renderer draws as the proposal, and what it hands on to start. */
export type PlanDebateProposal = {
  roles: PlanDebateRoleProposal[];
  rationale?: string;
};

/**
 * The tool result. A rejected roster is a text result the model reads and
 * corrects, not a thrown error, so one bad proposal does not end the turn.
 */
export function planDebateToolResult(validation: PlanDebateValidation): {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
} {
  if (!validation.ok) {
    return {
      content: [{ type: "text", text: `PlanDebate rejected: ${validation.message}` }],
      details: { error: validation.message, planDebate: null },
    };
  }
  const roster = validation.roles
    .map((role) => `- ${debateSeatHandle(role.name, role.seat)}: ${role.brief}`)
    .join("\n");
  return {
    content: [
      {
        type: "text",
        text: [
          `${validation.roles.length} roles accepted for the plan debate:`,
          roster,
          "Nothing has started. The user reviews this roster, may change how many roles run or swap roles, then starts the debate.",
        ].join("\n"),
      },
    ],
    details: {
      planDebate: {
        roles: validation.roles,
        ...(validation.rationale ? { rationale: validation.rationale } : {}),
      } satisfies PlanDebateProposal,
    },
  };
}

/**
 * The round the model asked for: what the plan must satisfy, the objection a
 * re-debate answers, whether the *user* asked for this round, and how the round
 * is numbered.
 *
 * These fields are optional so that a roster alone still validates (the roster
 * is the part a bad proposal cannot recover from); the tool schema is what asks
 * the model for the requirement.
 *
 * `intent` is the discriminator that keeps a debate a user action: the
 * renderer's own debate request carries `"start"`, and a call without it
 * opens nothing.
 */
export type PlanDebateRoundRequest = {
  intent: PlanDebateIntent;
  requirement: string;
  objection: string;
  round: number | null;
  integrator: string;
};

/**
 * Who asked for the round. `start` is the renderer's own request — the plan-mode
 * composer's debate button, the panel's re-debate prompt — relayed by the model
 * with the user's words. `null` is a call the model decided to make by itself,
 * which opens no round: only the user starts a debate.
 */
export type PlanDebateIntent = "start" | null;

export function planDebateIntentOf(args: unknown): PlanDebateIntent {
  const record = isRecord(args) ? args : {};
  return record.intent === "start" ? "start" : null;
}

export function planDebateRoundRequest(args: unknown): PlanDebateRoundRequest {
  const record = isRecord(args) ? args : {};
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const round = typeof record.round === "number" && Number.isInteger(record.round) && record.round > 0
    ? record.round
    : null;
  return {
    intent: planDebateIntentOf(args),
    requirement: text(record.requirement),
    objection: text(record.objection),
    round,
    integrator: text(record.integrator),
  };
}

/**
 * The result of a roster that was proposed.
 *
 * The round exists and waits for the user's start; no delegate has started, so
 * there is no delegation id to name. The panel's start control carries the
 * round number, and the model must not start the debate itself.
 */
export function planDebateProposedResult(input: {
  roles: readonly PlanDebateRoleProposal[];
  rationale?: string;
  round: number;
  requirement: string;
  integratorRole: string;
}): {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
} {
  const roster = input.roles
    .map((role) => `- ${debateSeatHandle(role.name, role.seat)}: ${role.brief}`)
    .join("\n");
  return {
    content: [
      {
        type: "text",
        text: [
          `Plan debate round ${input.round} proposed with ${input.roles.length} roles:`,
          roster,
          `Waiting for the user's start: nothing has drafted. The user reviews this roster in the debate panel and starts the debate, and only then do the drafting delegates run; ${input.integratorRole} merges the drafts when the objections are in.`,
          "Do not start any debate delegate yourself with Task, and do not call TaskWait for them. The runtime chains the critique and integration phases itself. The round ends with a merged plan on the debate rows, or with a typed failure you can correct by calling PlanDebate again.",
        ].join("\n"),
      },
    ],
    details: {
      planDebate: {
        round: input.round,
        requirement: input.requirement,
        integratorRole: input.integratorRole,
        roles: input.roles,
        ...(input.rationale ? { rationale: input.rationale } : {}),
        phase: "proposing",
      },
    },
  };
}

/**
 * The result of a `PlanDebate` call a live round refused.
 *
 * The refusal stays a text result the model can act on, but it now names the
 * round that already exists — its number, its requirement, its roster and its
 * stage — instead of describing a proposal that was thrown away. The panel
 * groups the transcript by round, so a refusal that carries the live round
 * keeps every drawing of the debate pointing at the round the delegates
 * actually belong to; a refusal without it left the model free to number
 * round N+1 and the panel with an empty scaffold nobody was running in.
 */
export function planDebateLiveRoundResult(input: {
  round: number;
  requirement: string;
  roles: readonly PlanDebateRoleProposal[];
  stage: string;
  /** `round 1 (draft)`, the phrase the refusal quotes back. */
  summary: string;
}): {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
} {
  const roster = input.roles
    .map((role) => `- ${debateSeatHandle(role.name, role.seat)}: ${role.brief}`)
    .join("\n");
  const waiting = input.stage === "proposing";
  return {
    content: [
      {
        type: "text",
        text: [
          `PlanDebate rejected: this session is already debating ${input.summary}.`,
          waiting
            ? `Round ${input.round} is proposed and waiting for the user: they start it from the debate panel. Nothing has drafted. Do not call PlanDebate again until that round settles.`
            : `Round ${input.round} is still producing (${input.stage}). Do not call PlanDebate again, and do not number a new round: while a round is unfinished, the panel's re-debate is the only thing that starts the next one.`,
          `The round that already exists answers:`,
          roster,
          `Treat this call as answered by round ${input.round}: tell the user the debate is still running in it and point them at the debate panel rather than proposing a new roster.`,
        ].join("\n"),
      },
    ],
    details: {
      error: `debate running: ${input.summary}`,
      planDebate: {
        round: input.round,
        requirement: input.requirement,
        stage: input.stage,
        alreadyRunning: true,
        roles: input.roles,
      },
    },
  };
}

/**
 * The result of a `PlanDebate` call the model made on its own turn.
 *
 * Opening a round is the user's decision, so a call without `intent: "start"`
 * has no side effect at all: it creates nothing, starts nothing, and answers
 * with the round that already exists — or, when the session has no round yet,
 * with the two controls that open the first one. Naming the round is what keeps
 * the panel honest: the answer carries the round number the delegates belong
 * to, so the model cannot number a phantom round and the panel cannot group a
 * second, empty scaffold beside the real one.
 */
export function planDebateUserOnlyResult(input: {
  /** The newest round in this session, live or finished; `null` before one exists. */
  round: {
    round: number;
    requirement: string;
    roles: readonly PlanDebateRoleProposal[];
    stage: string;
  } | null;
}): {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
} {
  const existing = input.round;
  if (existing === null) {
    return {
      content: [
        {
          type: "text",
          text: [
            "PlanDebate opened nothing: this session has no debate round yet, and only the user starts one.",
            "Tell the user how: in plan mode the composer's 发起辩论 button sends the debate request, and the debate panel's 开始辩论 opens the round it proposes. Do not call PlanDebate again on your own turn and do not describe a round as running.",
          ].join("\n"),
        },
      ],
      details: { error: "debate not started by the model", planDebate: null, intentRequired: true },
    };
  }
  const live = existing.stage !== "done" && existing.stage !== "failed";
  const roster = existing.roles
    .map((role) => `- ${debateSeatHandle(role.name, role.seat)}: ${role.brief}`)
    .join("\n");
  const head = live
    ? `PlanDebate opened nothing new: this session is already debating round ${existing.round} (${existing.stage}).`
    : `PlanDebate opened nothing new: round ${existing.round} already finished (${existing.stage}).`;
  const next = live
    ? `Round ${existing.round} is the live round: the user starts or advances it from the debate panel. Do not call PlanDebate again and do not number a new round.`
    : `A further round is the user's decision: the debate panel's 重新辩论 starts it with their objection.`;
  return {
    content: [
      {
        type: "text",
        text: [
          head,
          next,
          `The round that already exists answers:`,
          roster,
          `Treat this call as answered by round ${existing.round}: report that round to the user instead of proposing a new roster from your own turn.`,
        ].join("\n"),
      },
    ],
    details: {
      error: `debate opened only by the user: round ${existing.round} (${existing.stage})`,
      planDebate: {
        round: existing.round,
        requirement: existing.requirement,
        stage: existing.stage,
        alreadyRunning: live,
        roles: existing.roles,
      },
      intentRequired: true,
    },
  };
}
