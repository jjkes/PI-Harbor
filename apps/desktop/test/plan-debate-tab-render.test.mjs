import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-harbor/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/*
 * The plan-debate panel, rendered through the real component and the English
 * catalog. The view is covered by plan-debate-view.test.mjs; this pins what the
 * user actually reads: which round the panel draws, what its phase rows say,
 * and that each seat's artifact is the delegate's report rather than a count.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const ROLES = [
  { name: "ui-架构", brief: "own the layout", seat: 1 },
  { name: "code-reviewer", brief: "own the risks", seat: 1 },
];

function toolRow(toolName, details, id) {
  return {
    id,
    role: "tool",
    content: "",
    toolName,
    toolResult: { details },
    toolCallId: id,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function proposal(round, overrides = {}) {
  return toolRow(
    "PlanDebate",
    {
      planDebate: {
        round,
        requirement: `Requirement ${round}`,
        roles: ROLES,
        phase: "proposing",
        ...overrides,
      },
    },
    `plan-debate-${round}`,
  );
}

function delegate({ delegationId, round, role, phase, status, report, completedAt = 4000 }) {
  return toolRow(
    "Task",
    {
      delegationId,
      agent: role,
      status,
      startedAt: 1000,
      completedAt,
      phase,
      debateRound: round,
      debateRole: role,
      ...(report === undefined ? {} : { debateReport: report }),
    },
    `task-${delegationId}`,
  );
}

/** Round 1 drafted everything; round 2 was proposed over it and started nothing. */
const MESSAGES = [
  proposal(1),
  delegate({
    delegationId: "r1-d1",
    round: 1,
    role: "ui-架构",
    phase: "draft",
    status: "complete",
    report: "Layout first, then the data layer.",
  }),
  delegate({
    delegationId: "r1-d2",
    round: 1,
    role: "code-reviewer",
    phase: "draft",
    status: "complete",
  }),
  proposal(2),
];

/**
 * Render the panel against a fixture. `render` receives the vite server as its
 * second argument, so a test can read the same store the panel reads through a
 * renderer module and compare the two surfaces' answers.
 */
async function withPanel(render, messages = MESSAGES) {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { PlanDebateTab } = await server.ssrLoadModule(
      "/src/components/workpanel/PlanDebateTab.tsx",
    );
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    /*
     * A renderer store is read through React's server snapshot, which zustand
     * answers from the *initial* state (the components' first paint), so the
     * fixture seeds that state object instead of calling `setState`.
     */
    Object.assign(useAppStore.getInitialState(), {
      activeSessionId: "s1",
      sessions: [{ id: "s1", source: "local", title: "Debate session" }],
      messages,
    });
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    await render(
      () =>
        renderToStaticMarkup(
          createElement(
            I18nextProvider,
            { i18n },
            createElement(PlanDebateTab, { sessionId: "s1" }),
          ),
        ),
      server,
    );
  } finally {
    await server.close();
  }
}

test("the panel draws the round that owns the delegates, not the empty newest one", async () => {
  await withPanel((render) => {
    const html = render();
    // Round 2 exists as a proposal only; round 1 is the round that ran.
    assert.match(html, /data-plan-debate-timeline="1"/);
    assert.match(html, /data-plan-debate-round="1" data-plan-debate-latest="false"/);
    // Settled drafts are complete, untouched phases wait: the status comes from
    // the nodes, which is what the dock's delegate rows said all along.
    assert.match(html, /data-plan-debate-phase="proposing" data-status="complete"/);
    assert.match(html, /data-plan-debate-phase="drafting" data-status="complete"/);
    assert.match(html, /data-plan-debate-phase="critiquing" data-status="pending"/);
    assert.match(html, /data-plan-debate-phase="integrating" data-status="pending"/);
    // The elapsed span of a settled phase is drawn, not left blank.
    assert.match(html, /data-plan-debate-phase="drafting"[\s\S]{0,600}?3s/);
  });
});

test("a phase lists its seats and each seat's report is the artifact", async () => {
  await withPanel((render) => {
    const html = render();
    // One seat per delegate, with role, status and its own report disclosure.
    assert.match(html, /data-plan-debate-node="r1-d1"[\s\S]*?data-plan-debate-seat="ui-架构#1"/);
    assert.match(html, /data-plan-debate-seat-status="complete"/);
    assert.match(html, /<summary>Read the report<\/summary>/);
    assert.match(html, /Layout first, then the data layer\./);
    // A settled seat with no document says so instead of showing nothing.
    assert.match(html, /data-plan-debate-missing-report="r1-d2"/);
    assert.match(html, /This seat settled without a report\./);
    // The count is no longer the headline of a phase row.
    assert.doesNotMatch(html, /Artifacts:/);
    assert.doesNotMatch(html, /class="work-panel-plan-debate-phase-count"/);
  });
});

test("the round switcher lists every round newest first with its status", async () => {
  await withPanel((render) => {
    const html = render();
    const newest = html.indexOf('data-plan-debate-round-switch="2"');
    const oldest = html.indexOf('data-plan-debate-round-switch="1"');
    assert.ok(newest >= 0 && oldest >= 0, "both rounds are listed");
    assert.ok(newest < oldest, "the newest round is listed first");
    // The round on screen is the pressed one, and it is not the newest round.
    assert.match(html, /data-plan-debate-round-switch="1"[^>]*aria-pressed="true"/);
    assert.match(html, /data-plan-debate-round-switch="2"[^>]*aria-pressed="false"/);
    // Its status is the badge's, so history is readable without opening it.
    assert.match(html, /data-plan-debate-round-switch="1"[^>]*data-status="running"/);
  });
});

/** Round 1 ran to its merged plan; round 2 was proposed over it and started nothing. */
const FINISHED_WITH_PENDING = [
  proposal(1),
  delegate({
    delegationId: "r1-d1",
    round: 1,
    role: "ui-架构",
    phase: "draft",
    status: "complete",
    report: "Layout first, then the data layer.",
  }),
  delegate({
    delegationId: "r1-d2",
    round: 1,
    role: "code-reviewer",
    phase: "draft",
    status: "complete",
    report: "Add the rollback path.",
  }),
  delegate({
    delegationId: "r1-c1",
    round: 1,
    role: "ui-架构",
    phase: "critique",
    status: "complete",
    report: "No objection.",
  }),
  delegate({
    delegationId: "r1-c2",
    round: 1,
    role: "code-reviewer",
    phase: "critique",
    status: "complete",
    report: "The rollback path is missing.",
  }),
  delegate({
    delegationId: "r1-i1",
    round: 1,
    role: "ui-架构",
    phase: "integrate",
    status: "complete",
    report: "VERDICTS\n- adopted | layout first | ui-架构\nPLAN\n# merged plan\n1. Build the panel.",
  }),
  proposal(2),
];

test("an empty newer round is one header line, and the artifacts stay the body", async () => {
  await withPanel((render) => {
    const html = render();
    // The body is the round with the plan, even though round 2 is newer and the
    // round 1 plan already finished.
    assert.match(html, /data-plan-debate-round="1" data-plan-debate-latest="false"/);
    assert.match(html, /data-plan-debate-current="true"/);
    assert.match(html, /data-plan-debate-timeline="1"/);
    // The round nobody started is announced above it, with the control that opens it.
    assert.match(html, /data-plan-debate-pending-round="2"/);
    assert.match(html, /Round 2 has not started/);
    assert.match(html, /data-plan-debate-start="2"/);
    // The older round's seats and their documents are still on screen.
    assert.match(html, /data-plan-debate-node="r1-d1"/);
    assert.match(html, /data-plan-debate-node="r1-i1"/);
    // The merged document itself, not only its phase row.
    assert.match(html, /Build the panel\./);
  }, FINISHED_WITH_PENDING);
});

test("the current round keeps its choose and dual handoff controls beside an empty newer round", async () => {
  await withPanel((render) => {
    const html = render();
    // The choice controls belong to the round the panel decides on, not to the
    // newest round: they must survive a newer round that owns nothing, or the
    // handoff can never be armed.
    assert.match(html, /data-plan-debate-choice="draft:ui-架构"/);
    assert.match(html, /data-plan-debate-choice="merged"/);
    // The addition box is not a choice: whatever the user types there is
    // submitted with the plan they chose, never instead of it.
    assert.doesNotMatch(html, /data-plan-debate-choice="suggestion"/);
    // Two handoff actions: team mode and single-agent execution.
    assert.match(html, /data-plan-debate-handoff="team"/);
    assert.match(html, /data-plan-debate-handoff="single-agent"/);
    assert.match(html, />Hand off to team mode</);
    assert.match(html, />Hand to current Agent</);
    // Neither is armed until a plan is chosen; the honest reason is exposed.
    assert.match(html, /data-plan-debate-handoff-disabled="team"/);
    assert.match(html, /data-plan-debate-handoff-disabled="single-agent"/);
  }, FINISHED_WITH_PENDING);
});

test("the merged plan is read before it is chosen, so it is not behind a disclosure", async () => {
  await withPanel((render) => {
    const html = render();
    // The plan the round produced is drawn open: choosing it must not require
    // opening a collapsed block first.
    assert.match(html, /<h4 class="work-panel-plan-debate-merged-summary">Merged plan<\/h4>/);
    assert.doesNotMatch(html, /work-panel-plan-debate-merged-details"><summary/);
    // A seat's brief stays scannable at two lines; the full text is the title.
    assert.match(html, /class="work-panel-plan-debate-role-brief" title="[^"]+"/);
  }, FINISHED_WITH_PENDING);
});

/**
 * Four seats drafting while the coordinator's turn has already closed: the
 * shape the user reported, where the dock said `Stopped` (已停止) and the panel
 * counted the same seats as `进行中 … s`.
 */
const TURN_CLOSED_WITH_RUNNING_SEATS = [
  proposal(1),
  delegate({
    delegationId: "r1-d1",
    round: 1,
    role: "ui-架构",
    phase: "draft",
    status: "running",
  }),
  delegate({
    delegationId: "r1-d2",
    round: 1,
    role: "code-reviewer",
    phase: "draft",
    status: "running",
  }),
];

test("a seat still running after the turn closed reads running on both surfaces", async () => {
  let studio = null;
  await withPanel(async (render, server) => {
    // The dock's own derivation, read from the same store and the same modules
    // the panel uses: the two must return one answer for one delegation.
    const { sessionDelegations } = await server.ssrLoadModule("/src/lib/session-delegations.ts");
    const { collectDelegationStatuses, subagentOutcome } = await server.ssrLoadModule(
      "/src/lib/subagent-topology.ts",
    );
    const { getTranscriptProjection } = await server.ssrLoadModule("/src/lib/transcript-projection.ts");
    const { collectLiveDelegationEntries } = await server.ssrLoadModule(
      "/src/lib/live-delegation-entries.ts",
    );
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const state = useAppStore.getInitialState();
    const projection = getTranscriptProjection(state.messages, undefined);
    // The session is not running: every turn is closed, which is what rewrote
    // a `running` seat to `aborted` in the dock.
    const liveEntries = collectLiveDelegationEntries(
      projection.history,
      projection.entries.at(-1),
      false,
    );
    const delegations = sessionDelegations(projection.entries, liveEntries, projection.runs);
    const seatRows = state.messages.filter((message) => message.role === "tool");
    const dockOutcome = subagentOutcome(
      seatRows.find((message) => message.id === "task-r1-d1"),
      delegations.statuses,
    );
    // The dock-facing rule is what the panel draws.
    assert.equal(dockOutcome, "running");
    assert.equal(
      subagentOutcome(
        seatRows.find((message) => message.id === "task-r1-d1"),
        collectDelegationStatuses(
          seatRows.map((message) => ({ kind: "tool", message })),
          { turnLive: false },
        ),
      ),
      "running",
    );
    studio = render();
  }, TURN_CLOSED_WITH_RUNNING_SEATS);
  assert.ok(studio !== null, "the panel rendered");
  assert.match(studio, /data-plan-debate-seat-status="running"/);
  assert.match(studio, /data-plan-debate-phase="drafting" data-status="running"/);
  // The complaint itself: a live seat is never drawn as stopped.
  assert.doesNotMatch(studio, /data-plan-debate-seat-status="stopped"/);
  assert.doesNotMatch(studio, /已停止/);
});

/** Four seats through the whole pipeline, the shape the live panel showed. */
const FOUR_SEAT_ROLES = ["ui-架构", "code-reviewer", "rust-开发", "typescript-开发"];

const FOUR_SETTLED = [
  proposal(1),
  ...FOUR_SEAT_ROLES.map((role, index) =>
    delegate({
      delegationId: `r1-d${index + 1}`,
      round: 1,
      role,
      phase: "draft",
      status: "complete",
      report: `Draft from ${role}`,
    }),
  ),
  ...FOUR_SEAT_ROLES.map((role, index) =>
    delegate({
      delegationId: `r1-c${index + 1}`,
      round: 1,
      role,
      phase: "critique",
      status: "complete",
      report: `Objection from ${role}`,
    }),
  ),
  delegate({
    delegationId: "r1-i1",
    round: 1,
    role: "ui-架构",
    phase: "integrate",
    status: "complete",
    report: "VERDICTS\n- adopted | layout first | ui-架构\nPLAN\n# merged plan\nBuild the four-seat plan.",
  }),
];

test("a settled round lists every seat's document and closes every phase with seats", async () => {
  await withPanel((render) => {
    const html = render();
    // Four drafts, each with the document the delegate returned.
    assert.equal((html.match(/data-plan-debate-draft=/g) ?? []).length, 4);
    assert.match(html, /Draft from rust-开发/);
    assert.equal((html.match(/data-plan-debate-objection=/g) ?? []).length, 4);
    assert.match(html, /Objection from code-reviewer/);
    // A phase with seats never reads as an empty section.
    assert.doesNotMatch(html, /Nothing in this phase yet\./);
    // Every phase whose seats all settled is closed: drafting, critiquing and
    // integrating can never still read 进行中 after their seats finished.
    assert.match(html, /data-plan-debate-phase="drafting" data-status="complete"/);
    assert.match(html, /data-plan-debate-phase="critiquing" data-status="complete"/);
    assert.match(html, /data-plan-debate-phase="integrating" data-status="complete"/);
    // And the merged plan is the integrator's document.
    assert.match(html, /Build the four-seat plan\./);
  }, FOUR_SETTLED);
});

test("the merged block speaks for the integrator's own seat, not for the clock", async () => {
  // The integrator is still working: nothing to merge, and the block must not
  // claim the round produced no integrator.
  await withPanel((render) => {
    const html = render();
    assert.match(html, /data-plan-debate-phase="integrating" data-status="running"/);
    assert.doesNotMatch(html, /The integrator has not produced a plan yet\./);
    assert.doesNotMatch(html, /Build the four-seat plan\./);
  }, [...FOUR_SETTLED.slice(0, -1), { ...FOUR_SETTLED.at(-1), toolResult: { details: { ...FOUR_SETTLED.at(-1).toolResult.details, status: "running", debateReport: undefined } } }]);

  // The integrator settled without a document: the seat says so, the block does
  // not pretend no integrator ran.
  await withPanel((render) => {
    const html = render();
    assert.match(html, /data-plan-debate-phase="integrating" data-status="failed"/);
    assert.doesNotMatch(html, /The integrator has not produced a plan yet\./);
    assert.match(html, /data-plan-debate-missing-report="r1-i1"/);
  }, [...FOUR_SETTLED.slice(0, -1), { ...FOUR_SETTLED.at(-1), toolResult: { details: { ...FOUR_SETTLED.at(-1).toolResult.details, debateReport: "   " } } }]);
});

/** The chip markup of one round, so a test reads the badge and not the page. */
function chipOf(html, round) {
  const start = html.indexOf(`data-plan-debate-round-switch="${round}"`);
  assert.ok(start >= 0, `round ${round} has a chip`);
  const open = html.lastIndexOf("<button", start);
  return html.slice(open, html.indexOf("</button>", start));
}

test("a round whose spending phases are all terminal reads complete, not running", async () => {
  await withPanel((render) => {
    const html = render();
    const chip = chipOf(html, 1);
    // Every delegate settled and the plan is merged: the round is over, however
    // long the user takes to choose.
    assert.match(chip, /data-status="complete"/);
    assert.doesNotMatch(chip, /Running/);
    // `reviewing` is still open — the panel is asking the user to choose — and it
    // keeps its own running styling without colouring the round.
    assert.match(html, /data-plan-debate-phase="reviewing" data-status="running"/);
    assert.match(html, /data-plan-debate-phase="drafting" data-status="complete"/);
  }, FOUR_SETTLED);
});

test("a round whose plan was handed to team mode says so on its chip", async () => {
  // The handoff is the one stored fact the transcript cannot state; the panel
  // reads it on its first paint, so the chip never flashes Running over it.
  globalThis.localStorage = {
    getItem: (key) =>
      key === "pi.desktop.planDebateHandoff.s1"
        ? JSON.stringify({ version: 1, round: 1, at: 1_700_000_000_000 })
        : null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  try {
    await withPanel((render) => {
      const html = render();
      const chip = chipOf(html, 1);
      assert.match(chip, /data-status="complete"/);
      assert.match(chip, /data-plan-debate-round-handoff="done"/);
      assert.match(chip, /Handed to team mode/);
      assert.doesNotMatch(chip, /Running/);
    }, FOUR_SETTLED);
  } finally {
    delete globalThis.localStorage;
  }
});

/** One settled draft whose row carries no start, because its file had none. */
const NO_CLOCK = [
  proposal(1),
  toolRow(
    "Task",
    {
      delegationId: "r1-d1",
      agent: "ui-架构",
      debateRole: "ui-架构",
      debateSeat: 1,
      debateRound: 1,
      phase: "draft",
      status: "complete",
      debateReport: "Layout first, then the data layer.",
    },
    "task-r1-d1",
  ),
];

test("a seat with no recorded span draws no duration instead of 0s", async () => {
  await withPanel((render) => {
    const html = render();
    const start = html.indexOf('data-plan-debate-node="r1-d1"');
    assert.ok(start >= 0, "the seat is drawn");
    const row = html.slice(start, html.indexOf("</li>", start));
    assert.match(row, /Layout first, then the data layer\./);
    // An unknown clock is drawn as nothing: no seat, and no phase, says `0s`.
    assert.doesNotMatch(row, /0s/);
    assert.doesNotMatch(html, /data-plan-debate-phase="drafting"[\s\S]{0,400}?0s/);
  }, NO_CLOCK);
});

test("a user-stopped round and a reportless stopped seat draw stopped", async () => {
  const stopped = [
    proposal(1, { stoppedAt: 5000 }),
    delegate({
      delegationId: "r1-stopped",
      round: 1,
      role: "ui-架构",
      phase: "draft",
      status: "stopped",
    }),
  ];
  await withPanel((render) => {
    const html = render();
    const chip = chipOf(html, 1);
    assert.match(chip, /data-status="stopped"/);
    assert.match(chip, /Stopped/);
    assert.doesNotMatch(chip, /Running|Failed/);
    assert.match(html, /data-plan-debate-seat-status="stopped"/);
    assert.match(html, /data-plan-debate-phase="drafting" data-status="stopped"/);
    assert.match(html, /data-plan-debate-phase="integrating" data-status="stopped"/);
  }, stopped);
});


/** Round 1 failed before producing any readable draft. */
const FAILED_ROUND = [
  proposal(1),
  delegate({
    delegationId: "r1-d1",
    round: 1,
    role: "ui-架构",
    phase: "draft",
    status: "failed",
    report: "",
  }),
  delegate({
    delegationId: "r1-d2",
    round: 1,
    role: "code-reviewer",
    phase: "draft",
    status: "failed",
    report: "",
  }),
];

test("a failed round offers a retry control", async () => {
  await withPanel((render) => {
    const html = render();
    const chip = chipOf(html, 1);
    assert.match(chip, /data-status="failed"/);
    assert.match(html, /data-plan-debate-retry="1"/);
    assert.doesNotMatch(html, /data-plan-debate-cancel="1"/);
  }, FAILED_ROUND);
});

/** Round 1 finished; round 2 is a running retry round. */
const RUNNING_RETRY = [
  proposal(1),
  delegate({
    delegationId: "r1-d1",
    round: 1,
    role: "ui-架构",
    phase: "draft",
    status: "complete",
    report: "First plan.",
  }),
  proposal(2),
  delegate({
    delegationId: "r2-d1",
    round: 2,
    role: "ui-架构",
    phase: "draft",
    status: "running",
  }),
];

test("a running retry round offers a cancel control", async () => {
  await withPanel((render) => {
    const html = render();
    const chip = chipOf(html, 2);
    assert.match(chip, /data-status="running"/);
    assert.match(html, /data-plan-debate-cancel="2"/);
    // The retry button belongs to failed/stopped rounds, not a running one.
    assert.doesNotMatch(html, /data-plan-debate-retry="2"/);
  }, RUNNING_RETRY);
});

/** Round 1 is a normal (non-retry) running round. */
const RUNNING_NORMAL = [
  proposal(1),
  delegate({
    delegationId: "r1-d1",
    round: 1,
    role: "ui-架构",
    phase: "draft",
    status: "running",
  }),
  delegate({
    delegationId: "r1-d2",
    round: 1,
    role: "code-reviewer",
    phase: "draft",
    status: "running",
  }),
];

test("a normal running round offers a cancel control", async () => {
  await withPanel((render) => {
    const html = render();
    const chip = chipOf(html, 1);
    assert.match(chip, /data-status="running"/);
    assert.match(html, /data-plan-debate-cancel="1"/);
    // It is not a retry/re-debate, so no retry badge or retry button.
    assert.doesNotMatch(html, /data-plan-debate-retry="1"/);
  }, RUNNING_NORMAL);
});
