/**
 * Fixtures for the plan-debate web harness (`pnpm --filter @pi-harbor/desktop web`).
 *
 * This module is debug tooling, never packaged: nothing under `src/` imports
 * `web/`. Each shape below mirrors one production reader, named beside it, so a
 * change in the reader shows up here as a shape that no longer matches:
 *
 *  - `proposalRow` mirrors `proposalFromPayload`
 *    (`src/features/plan-debate/plan-debate-view.ts:236`): the `PlanDebate` tool
 *    row that carries the round's roster — `payload.planDebate.{round,
 *    requirement, roles[{name,brief,seat}], rationale }`.
 *  - `seatRow` mirrors `nodeFromPayload` (same module, `:322`): the delegate
 *    `Task` row the runtime replaces in place as the seat settles —
 *    `payload.{delegationId, agent, debateRole, debateSeat, debateRound, phase,
 *    status, startedAt, completedAt, debateReport, error }`.
 *  - `diskRound` mirrors `readRound`
 *    (`electron/main/ipc/plan-debate-artifacts-ipc.ts:162`), i.e. exactly what
 *    the `pi-harbor/plan-debate/artifacts` channel returns: the
 *    `.pi-harbor/debate/round-<N>/round-<N>.json` index — the roster it
 *    started with (`roles[{name,brief,seat}]`) and each settled seat's
 *    `startedAt`/`completedAt` — with each seat's `reportFile` already read
 *    back into `report`, plus `merged.md` read into `merged`. Statuses there
 *    are the on-disk three words (`complete` / `failed` / `stopped`): a seat
 *    that settled is the only seat the runtime writes a file for.
 */
import type { PlanDebateRoundArtifacts, UiMessage } from "@pi-harbor/shared";

/** One session id, so the panel's remount key and the fixtures cannot drift. */
export const HARNESS_SESSION_ID = "harness-plan-debate-web";

export const HARNESS_SCENARIOS = [
  "transcript-only",
  "disk-only",
  "merged",
  "empty-round",
  "round-2-pending",
] as const;

export type HarnessScenario = (typeof HARNESS_SCENARIOS)[number];

/** What each scenario proves, drawn beside its button on the debug page. */
export const SCENARIO_LABEL: Record<HarnessScenario, string> = {
  "transcript-only": "transcript only — the live rows, no files on disk",
  "disk-only": "disk only — everything recovered from round-1 files",
  merged: "merged — window dropped the drafts, disk brings them back",
  "empty-round": "empty round — roster proposed, nothing started",
  "round-2-pending": "round 2 pending — header line above round 1's body",
};

const MINUTE = 60_000;

type SeatPhase = "draft" | "critique" | "integrate";

/** The status words the runtime publishes on a delegate `Task` row. */
type SeatStatus = "running" | "completed" | "failed" | "stopped";

/** The three words a disk index may carry; a settled seat is written as `complete`. */
const DISK_STATUS: Record<SeatStatus, "complete" | "failed" | "stopped"> = {
  completed: "complete",
  running: "complete",
  failed: "failed",
  stopped: "stopped",
};

type SeatSpec = {
  delegationId: string;
  role: string;
  seat: number;
  phase: SeatPhase;
  status: SeatStatus;
  /** Milliseconds after the round's first delegate started. */
  startedAfter: number;
  completedAfter?: number;
  report?: string;
  error?: string;
};

type RoleSpec = { name: string; brief: string };

const ROUND_ONE_ROLES: RoleSpec[] = [
  {
    name: "plan-architect",
    brief: "Own the shape of the change: modules, boundaries, and what moves.",
  },
  {
    name: "data-migration",
    brief: "Own the stored data: schema, migration order, and rollback.",
  },
  {
    name: "security-review",
    brief: "Own the trust boundary: permissions, untrusted input, and secrets.",
  },
  {
    // A handle with no ASCII in it at all: the on-disk report file is named
    // `draft-seat1.md`, and the round index — not the file name — is what keeps
    // the role the user recognises.
    name: "发布工程",
    brief: "Own the delivery: feature flags, rollout order, and the rollback path.",
  },
];

const ROUND_ONE_REQUIREMENT =
  "Move the session store to a WAL-backed SQLite file so a renderer reload keeps the " +
  "transcript it was reading, and ship it to existing users without a manual reset.";

const ROUND_ONE_RATIONALE =
  "Four seats: the shape, the stored data, the trust boundary, and the delivery each " +
  "have a failure mode the others do not look for.";

const ARCHITECT_DRAFT = `## Proposal — one store, one owner

1. Keep SQLite ownership in host-core. The renderer never opens the file.
2. Add a \`store_version\` table beside the existing schema; the WAL flip is a
   version bump, not a second database.
3. Read path first: the session summary and the transcript page both come from
   the same connection, so a reload cannot read two shapes.

**Risk:** a WAL file beside a stale \`-shm\` on a network volume. Guard with a
synchronous open-and-check.`;

const MIGRATION_DRAFT = `## Proposal — migrate forward only

1. \`PRAGMA journal_mode=WAL\` is per-file and persistent; run it once inside the
   migration transaction, after \`store_version\` bumps.
2. Copy the existing database to \`sessions.sqlite.bak-<version>\` before the
   flip, then delete the backup only after a successful read of the first page.
3. Rollback = restore the backup; the post-WAL file is never read by an older
   build, so an old app sees its own file untouched.

**Rejected alternative:** a second database for WAL mode — two files drift.`;

const SECURITY_CRITIQUE = `## Objections

- **data-migration's copy step** writes to a path derived from user data. Cap
  the backup name to digits and a version, never the session title.
- **plan-architect's read path** inherits whatever the project directory allows:
  a symlinked \`.pi-harbor\` must be refused, not followed.
- No objection to the version bump itself.

The migration must run with the same permission check the existing reader has,
not a looser one because it happens once.`;

const MIGRATION_CRITIQUE = `## Objections

- The backup name is fine; it is generated, not derived.
- The architect's synchronous open-and-check duplicates a check host-core
  already does at boot — one of the two should go, and it should not be the
  one that runs for every process.`;

const SECURITY_DRAFT = `## Proposal — the trust boundary is the path

1. The store path is user data: refuse a symlinked \`.pi-harbor\` and open with
   \`O_NOFOLLOW\`, rather than resolving it and trusting where it landed.
2. The migration is one-shot, so it must run under the same permission check the
   existing reader already has — a looser check "because it runs once" is how a
   trust boundary moves.

**Risk:** a project on a network volume where WAL locking is not reliable.`;

const RELEASE_DRAFT = `## Proposal — ship behind the version bump

1. No new flag: \`store_version\` is the flag. An older build sees the old file
   and never the WAL one.
2. Rollout: internal, then 5% for two days, then the rest. Watch first-turn
   failures, which is where a broken store shows up first.

**Risk:** a user who downgrades after the flip. Their old build reads the
pre-migration backup only if we keep it; the delete step removes that option.`;

/**
 * The reports the disk copy still holds for the two drafts the transcript shows
 * running: the file exists because the delegate answered, which is exactly the
 * gap between a stale row and the durable copy.
 */
const DISK_ONLY_DRAFT_REPORT: Record<string, string> = {
  "dlg-r1-draft-security": SECURITY_DRAFT,
  "dlg-r1-draft-release": RELEASE_DRAFT,
};

const INTEGRATOR_REPORT = `## VERDICTS
- adopted | WAL flip inside the store_version migration | data-migration
- adopted | one owner for the connection, renderer never opens the file | plan-architect
- adopted | refuse a symlinked .pi-harbor instead of following it | security-review
- rejected | a second database for WAL mode | data-migration
- rejected | the duplicate boot-time synchronous check | security-review

## PLAN
1. Bump \`store_version\`; run \`PRAGMA journal_mode=WAL\` inside that migration.
2. Copy \`sessions.sqlite\` to \`sessions.sqlite.bak-<version>\` first; the backup
   name is generated from the version only.
3. Refuse to open the store through a symlinked \`.pi-harbor\`; keep the boot-time
   check as the single check and drop the second one.
4. Read back one transcript page before the round is declared done, then delete
   the backup.
5. Roll back by restoring the backup; the WAL file is left for the next run to
   discard.`;

/** Round 1's seats: 4 drafts (2 settled, 2 running), 4 critiques, 1 integrate. */
const ROUND_ONE_SEATS: SeatSpec[] = [
  {
    delegationId: "dlg-r1-draft-architect",
    role: "plan-architect",
    seat: 1,
    phase: "draft",
    status: "completed",
    startedAfter: 0,
    completedAfter: 92_000,
    report: ARCHITECT_DRAFT,
  },
  {
    delegationId: "dlg-r1-draft-migration",
    role: "data-migration",
    seat: 1,
    phase: "draft",
    status: "completed",
    startedAfter: 1_000,
    completedAfter: 104_000,
    report: MIGRATION_DRAFT,
  },
  {
    delegationId: "dlg-r1-draft-security",
    role: "security-review",
    seat: 1,
    phase: "draft",
    status: "running",
    startedAfter: 2_000,
  },
  {
    delegationId: "dlg-r1-draft-release",
    role: "发布工程",
    seat: 1,
    phase: "draft",
    status: "running",
    startedAfter: 3_000,
  },
  {
    delegationId: "dlg-r1-critique-architect",
    role: "plan-architect",
    seat: 1,
    phase: "critique",
    status: "completed",
    startedAfter: 130_000,
    completedAfter: 186_000,
    report:
      "## Objections\n\n- The migration order is right; the backup delete is the risky step.\n" +
      "- No objection to keeping one connection.",
  },
  {
    delegationId: "dlg-r1-critique-migration",
    role: "data-migration",
    seat: 1,
    phase: "critique",
    status: "failed",
    startedAfter: 131_000,
    completedAfter: 151_000,
    error: "delegate exited without a report (exit code 1)",
  },
  {
    delegationId: "dlg-r1-critique-security",
    role: "security-review",
    seat: 1,
    phase: "critique",
    status: "completed",
    startedAfter: 132_000,
    completedAfter: 199_000,
    report: SECURITY_CRITIQUE,
  },
  {
    delegationId: "dlg-r1-critique-release",
    role: "发布工程",
    seat: 1,
    phase: "critique",
    status: "completed",
    startedAfter: 133_000,
    completedAfter: 210_000,
    report: MIGRATION_CRITIQUE,
  },
  {
    delegationId: "dlg-r1-integrate-architect",
    role: "plan-architect",
    seat: 1,
    phase: "integrate",
    status: "completed",
    startedAfter: 240_000,
    completedAfter: 318_000,
    report: INTEGRATOR_REPORT,
  },
];

/** Round 2's roster only: a re-debate the user has proposed and not started. */
const ROUND_TWO_ROLES: RoleSpec[] = ROUND_ONE_ROLES.slice(0, 3);

const ROUND_TWO_REQUIREMENT =
  "Same migration, but the objection is that the backup delete can strand a user: " +
  "keep the previous file until the next successful start.";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The `PlanDebate` tool row; see `proposalFromPayload`. */
function proposalRow(args: {
  id: string;
  round: number;
  requirement: string;
  roles: RoleSpec[];
  rationale?: string;
  at: number;
}): UiMessage {
  return {
    id: args.id,
    role: "tool",
    content: "",
    createdAt: iso(args.at),
    toolName: "PlanDebate",
    toolCallId: args.id,
    toolStatus: "success",
    toolResult: {
      content: `Plan debate round ${args.round} proposed.`,
      details: {
        planDebate: {
          round: args.round,
          requirement: args.requirement,
          // A proposal row without seats is one seat of each role; the fixture
          // states `seat: 1` explicitly, as the runtime now does.
          roles: args.roles.map((role) => ({ name: role.name, brief: role.brief, seat: 1 })),
          ...(args.rationale !== undefined ? { rationale: args.rationale } : {}),
        },
      },
    },
  };
}

/** One delegate `Task` row; see `nodeFromPayload`. */
function seatRow(spec: SeatSpec, round: number, roundStart: number): UiMessage {
  const startedAt = roundStart + spec.startedAfter;
  const completedAt = spec.completedAfter !== undefined ? roundStart + spec.completedAfter : undefined;
  return {
    id: spec.delegationId,
    role: "tool",
    content: "",
    createdAt: iso(startedAt),
    toolName: "Task",
    toolCallId: spec.delegationId,
    toolStatus:
      spec.status === "running" ? "running" : spec.status === "failed" ? "error" : "success",
    toolCompletedAt: completedAt !== undefined ? iso(completedAt) : undefined,
    toolResult: {
      content: spec.report ?? spec.error ?? "",
      details: {
        delegationId: spec.delegationId,
        agent: spec.role,
        debateRole: spec.role,
        debateSeat: spec.seat,
        debateRound: round,
        phase: spec.phase,
        // The runtime's own words: a settled seat says `completed`.
        status: spec.status,
        startedAt,
        ...(completedAt !== undefined ? { completedAt } : {}),
        ...(spec.report !== undefined ? { debateReport: spec.report } : {}),
        ...(spec.error !== undefined ? { error: spec.error } : {}),
      },
    },
  };
}

/**
 * The round as the transcript holds it. `includeSeats` narrows it to the rows
 * still in the live window: `"drafts-dropped"` is the case the panel's disk
 * read exists for — a debate is about fifteen rows, so its drafts fall out of
 * the window while its critiques are still in it.
 */
function roundOneRows(opts: {
  at: number;
  includeProposal?: boolean;
  seats?: "all" | "drafts-dropped" | "none";
}): UiMessage[] {
  const rows: UiMessage[] = [];
  if (opts.includeProposal !== false) {
    rows.push(
      proposalRow({
        id: "msg-r1-proposal",
        round: 1,
        requirement: ROUND_ONE_REQUIREMENT,
        roles: ROUND_ONE_ROLES,
        rationale: ROUND_ONE_RATIONALE,
        at: opts.at,
      }),
    );
  }
  const seats =
    opts.seats === "none"
      ? []
      : ROUND_ONE_SEATS.filter(
          (seat) => opts.seats !== "drafts-dropped" || seat.phase !== "draft",
        );
  for (const seat of seats) rows.push(seatRow(seat, 1, opts.at + MINUTE));
  return rows;
}

/** The user + assistant rows a real transcript would carry around the debate. */
function turnRows(at: number, assistant?: string): UiMessage[] {
  const rows: UiMessage[] = [
    {
      id: "msg-user-requirement",
      role: "user",
      content: ROUND_ONE_REQUIREMENT,
      createdAt: iso(at - MINUTE),
    },
  ];
  if (assistant !== undefined) {
    rows.push({
      id: "msg-assistant-open",
      role: "assistant",
      content: assistant,
      createdAt: iso(at - 30_000),
      status: "complete",
    });
  }
  return rows;
}

/** The transcript a scenario draws, as the store's live `messages`. */
export function transcriptFor(scenario: HarnessScenario, now = Date.now()): UiMessage[] {
  const start = now - 6 * MINUTE;
  switch (scenario) {
    case "transcript-only":
      return [
        ...turnRows(start, "Opening a plan debate with four seats."),
        ...roundOneRows({ at: start }),
      ];
    case "disk-only":
      // Nothing survived the reload: the panel has only the files to draw from.
      return turnRows(start);
    case "merged":
      return [
        ...turnRows(start, "Opening a plan debate with four seats."),
        ...roundOneRows({ at: start, seats: "drafts-dropped" }),
      ];
    case "empty-round":
      return [
        ...turnRows(start, "Proposing a roster; nothing starts until you say so."),
        ...roundOneRows({ at: start, seats: "none" }),
      ];
    case "round-2-pending":
      return [
        ...turnRows(start, "Opening a plan debate with four seats."),
        ...roundOneRows({ at: start }),
        proposalRow({
          id: "msg-r2-proposal",
          round: 2,
          requirement: ROUND_TWO_REQUIREMENT,
          roles: ROUND_TWO_ROLES,
          at: now - MINUTE,
        }),
      ];
  }
}

/** One disk round, in the shape the artifacts channel returns. */
function diskRound(args: {
  round: number;
  requirement: string;
  at: number;
  /** The roster `round-<N>.json` records when the round starts. */
  roles?: RoleSpec[];
  seats: Array<{ spec: SeatSpec; report?: string; error?: string }>;
  merged?: string;
}): PlanDebateRoundArtifacts {
  const startedAt = args.at;
  const completedAt = args.at + 6 * MINUTE;
  return {
    version: 1,
    round: args.round,
    requirement: args.requirement,
    startedAt,
    completedAt,
    ...(args.roles !== undefined && args.roles.length > 0
      ? { roles: args.roles.map((role) => ({ name: role.name, brief: role.brief, seat: 1 })) }
      : {}),
    seats: args.seats.map(({ spec, report, error }) => {
      // Every seat wrote its own start, because a recovered seat's duration is
      // the span the file recorded — not a number the panel guesses.
      const seatStartedAt = startedAt + spec.startedAfter;
      const seatCompletedAt =
        spec.completedAfter !== undefined ? startedAt + spec.completedAfter : completedAt;
      return {
        phase: spec.phase,
        role: spec.role,
        seat: spec.seat,
        // On disk a seat is terminal by construction: the file exists because
        // the delegate answered.
        status: DISK_STATUS[spec.status],
        delegationId: spec.delegationId,
        startedAt: seatStartedAt,
        completedAt: seatCompletedAt,
        ...(report !== undefined ? { report } : {}),
        ...(error !== undefined ? { error } : {}),
      };
    }),
    ...(args.merged !== undefined ? { merged: args.merged } : {}),
  };
}

/** What the `pi-harbor/plan-debate/artifacts` channel answers for a scenario. */
export function artifactsFor(
  scenario: HarnessScenario,
  now = Date.now(),
): PlanDebateRoundArtifacts[] {
  const start = now - 8 * MINUTE;
  switch (scenario) {
    case "transcript-only":
      // No project, no debate directory: the transcript is the only source.
      return [];
    case "disk-only":
    case "merged":
      return [
        diskRound({
          round: 1,
          requirement: ROUND_ONE_REQUIREMENT,
          at: start,
          // Every seat the runtime settled wrote a report file, with the span it
          // ran for; the two the fixture leaves running settle here, which is
          // the point of the merged scenario: disk outranks a stale running row.
          // The roster it started with rides along, briefs included, so a
          // recovered round reads its proposal exactly as the live one did.
          roles: ROUND_ONE_ROLES,
          seats: ROUND_ONE_SEATS.map((spec) => ({
            spec,
            report: spec.report ?? DISK_ONLY_DRAFT_REPORT[spec.delegationId],
            ...(spec.error !== undefined ? { error: spec.error } : {}),
          })),
          merged: INTEGRATOR_REPORT,
        }),
      ];
    case "empty-round":
      // A round whose roster nobody started writes no directory at all.
      return [];
    case "round-2-pending":
      return [diskRound({ round: 2, requirement: ROUND_TWO_REQUIREMENT, at: start, seats: [] })];
  }
}

/** The single session the harness seeds into the app store. */
export function sessionFixture(now = Date.now()) {
  return {
    id: HARNESS_SESSION_ID,
    title: "Plan debate web harness",
    messageCount: 0,
    mode: "agent" as const,
    thinkingLevel: "medium" as const,
    permissionMode: "ask" as const,
    createdAt: iso(now - 30 * MINUTE),
    updatedAt: iso(now),
  };
}
