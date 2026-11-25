import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";

/**
 * Reproduction harness for plan-debate session isolation.
 *
 * The panel's wiring is exercised through the same public modules the
 * PlanDebateTab component uses: view derivation, the project-scoped artifact
 * cache, the per-session renderer selection store, and the per-session
 * localStorage store. No production code is modified; only the external
 * browser storage boundary is replaced by an in-memory Map so the test can run
 * in Node.
 */

function load(relative, imports = {}) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    if (Object.hasOwn(imports, id)) return imports[id];
    throw new Error(`unexpected dependency: ${id} (from ${relative})`);
  }, module.exports, module);
  return module.exports;
}

class MapStorage {
  #data = new Map();
  get length() { return this.#data.size; }
  key(index) { return [...this.#data.keys()][index] ?? null; }
  getItem(key) { return this.#data.has(key) ? this.#data.get(key) : null; }
  setItem(key, value) { this.#data.set(key, String(value)); }
  removeItem(key) { this.#data.delete(key); }
  clear() { this.#data.clear(); }
}

// Replace the browser storage boundary before the store module touches it.
globalThis.localStorage = new MapStorage();

const machine = load("../src/features/plan-debate/plan-debate-machine.ts", {});
const view = load("../src/features/plan-debate/plan-debate-view.ts", {
  "./plan-debate-machine": machine,
});
const artifactCacheMod = load("../src/features/plan-debate/plan-debate-artifact-cache.ts", {});
const store = load("../src/features/plan-debate/plan-debate-store.ts", {
  "./plan-debate-machine": machine,
});
const selectionMod = load("../src/features/plan-debate/plan-debate-selection.ts", {
  "./plan-debate-machine": machine,
});
const handoffMod = load("../src/features/plan-debate/plan-debate-handoff.ts", {
  "./plan-debate-machine": machine,
  "./plan-debate-view": view,
  "../../lib/api.js": { api: {} },
});

const {
  planDebateViewWithArtifacts,
  planDebatePanelRound,
} = view;
const {
  planDebateArtifactCacheForProject,
  planDebateArtifactsForProject,
  planDebateArtifactCacheAfterRefresh,
} = artifactCacheMod;
const {
  readPlanDebateState,
  writePlanDebateState,
  readPlanDebateHandoff,
  writePlanDebateHandoff,
  readDeletedRounds,
  markRoundDeleted,
} = store;
const {
  planDebateSelectionOf,
  setPlanDebateSelection,
  subscribePlanDebateSelection,
} = selectionMod;
const { planDebateHandoffPlan } = handoffMod;

const SESSION_A = "session-a";
const SESSION_B = "session-b";
const PROJECT = "/tmp/shared-project";

const ROLES = [
  { name: "explorer", brief: "map the code", seat: 1 },
  { name: "reviewer", brief: "find the risks", seat: 1 },
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

function proposalRow(round, requirement, overrides = {}) {
  return toolRow(
    "PlanDebate",
    {
      planDebate: {
        round,
        requirement,
        roles: ROLES,
        phase: "proposing",
        ...overrides,
      },
    },
    `plan-debate-${round}`,
  );
}

function delegateRow({ delegationId, round, role, phase, status, report, startedAt = 1000, completedAt }) {
  return toolRow(
    "Task",
    {
      delegationId,
      agent: role,
      status,
      startedAt,
      ...(completedAt === undefined ? {} : { completedAt }),
      phase,
      debateRound: round,
      debateRole: role,
      ...(report === undefined ? {} : { debateReport: report }),
    },
    `task-${delegationId}`,
  );
}

function artifactSeat({ delegationId, role, phase, status, report, startedAt, completedAt }) {
  return {
    phase,
    role,
    seat: 1,
    status,
    delegationId,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(report !== undefined ? { report } : {}),
  };
}
function artifactRound(round, requirement, seats, overrides = {}) {
  return {
    version: 1,
    round,
    requirement,
    seats,
    roles: ROLES,
    ...overrides,
  };
}

function renderForSession(messages, cache, projectPath = PROJECT, sessionId = SESSION_A) {
  const artifacts = planDebateArtifactsForProject(cache, sessionId, projectPath);
  return planDebateViewWithArtifacts(messages, artifacts, null, new Map(), sessionId);
}

function reset() {
  globalThis.localStorage.clear();
  setPlanDebateSelection(SESSION_A, null);
  setPlanDebateSelection(SESSION_B, null);
}

function roundNumbers(view) {
  return view.rounds.map((r) => r.round);
}

/* -------------------------------------------------------------------------- */
/* Baseline isolation: renderer memory and storage already key by session.    */
/* -------------------------------------------------------------------------- */

test("selection store is keyed by session", () => {
  reset();
  const selA = { kind: "merged", round: 1 };
  const selB = { kind: "suggestion", round: 2, text: "do B" };
  setPlanDebateSelection(SESSION_A, selA);
  setPlanDebateSelection(SESSION_B, selB);
  assert.deepEqual(planDebateSelectionOf(SESSION_A), selA);
  assert.deepEqual(planDebateSelectionOf(SESSION_B), selB);
});

test("localStorage state, handoff and deleted rounds are keyed by session", () => {
  reset();
  const stateA = machine.startPlanDebateRound(machine.idlePlanDebateState(), {
    roles: ROLES,
    constraint: "A",
    now: 1000,
  });
  writePlanDebateState(SESSION_A, stateA);
  writePlanDebateHandoff(SESSION_B, { round: 2, at: 2000 });
  markRoundDeleted(SESSION_A, 1);

  const restoredA = readPlanDebateState(SESSION_A);
  assert.ok(restoredA, "session A state was restored");
  assert.equal(restoredA.rounds[0].constraint, "A");
  assert.equal(readPlanDebateState(SESSION_B), null);
  assert.equal(readPlanDebateHandoff(SESSION_A), null);
  assert.deepEqual(readPlanDebateHandoff(SESSION_B), { round: 2, at: 2000 });
  assert.deepEqual(readDeletedRounds(SESSION_A), [1]);
  assert.deepEqual(readDeletedRounds(SESSION_B), []);
});

/* -------------------------------------------------------------------------- */
/* View isolation when no disk artifacts are involved.                        */
/* -------------------------------------------------------------------------- */

test("distinct transcripts in the same project stay isolated when disk is empty", () => {
  reset();
  const messagesA = [
    proposalRow(1, "Requirement A"),
    delegateRow({
      delegationId: "a-draft",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "complete",
      report: "A draft",
      completedAt: 2000,
    }),
  ];
  const messagesB = [
    proposalRow(2, "Requirement B"),
    delegateRow({
      delegationId: "b-draft",
      round: 2,
      role: "explorer",
      phase: "draft",
      status: "complete",
      report: "B draft",
      completedAt: 2000,
    }),
  ];
  const cache = planDebateArtifactCacheForProject(PROJECT);
  const viewA = renderForSession(messagesA, cache);
  const viewB = renderForSession(messagesB, cache);
  assert.deepEqual(roundNumbers(viewA), [1]);
  assert.deepEqual(roundNumbers(viewB), [2]);
  assert.equal(viewA.latest.requirement, "Requirement A");
  assert.equal(viewB.latest.requirement, "Requirement B");
});

/* -------------------------------------------------------------------------- */
/* The conflict point: project-wide disk artifacts leak across sessions.      */
/* -------------------------------------------------------------------------- */

test("project-wide disk artifacts make session A show session B's round", () => {
  reset();
  const messagesA = [
    proposalRow(1, "Requirement A"),
    delegateRow({
      delegationId: "a-draft",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "complete",
      report: "A draft",
      completedAt: 2000,
    }),
  ];
  const messagesB = [
    proposalRow(2, "Requirement B"),
    delegateRow({
      delegationId: "b-draft",
      round: 2,
      role: "explorer",
      phase: "draft",
      status: "complete",
      report: "B draft",
      completedAt: 2000,
    }),
  ];

  const diskArtifactsA = [
    artifactRound(1, "Requirement A", [
      artifactSeat({
        delegationId: "a-disk",
        role: "explorer",
        phase: "draft",
        status: "complete",
        report: "A draft from disk",
        startedAt: 1000,
        completedAt: 2000,
      }),
    ], { sessionId: SESSION_A }),
  ];
  const diskArtifactsB = [
    artifactRound(2, "Requirement B", [
      artifactSeat({
        delegationId: "b-disk",
        role: "explorer",
        phase: "draft",
        status: "complete",
        report: "B draft from disk",
        startedAt: 1000,
        completedAt: 2000,
      }),
    ], { sessionId: SESSION_B }),
  ];

  const cacheA = planDebateArtifactCacheForProject(PROJECT, SESSION_A, diskArtifactsA);
  const cacheB = planDebateArtifactCacheForProject(PROJECT, SESSION_B, diskArtifactsB);
  const viewA = renderForSession(messagesA, cacheA);
  const viewB = renderForSession(messagesB, cacheB);

  assert.deepEqual(
    roundNumbers(viewA),
    [1],
    "session A should only see its own round",
  );
  assert.deepEqual(
    roundNumbers(viewB),
    [2],
    "session B should only see its own round",
  );
});

test("switching session within the same project reuses the project cache and leaks the previous round", () => {
  reset();
  const messagesA = [
    proposalRow(1, "Requirement A"),
    delegateRow({
      delegationId: "a-draft",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "complete",
      report: "A draft",
      completedAt: 2000,
    }),
  ];
  const messagesB = [
    proposalRow(2, "Requirement B"),
    delegateRow({
      delegationId: "b-draft",
      round: 2,
      role: "explorer",
      phase: "draft",
      status: "complete",
      report: "B draft",
      completedAt: 2000,
    }),
  ];

  // Simulate the cache left behind after session A was active.
  let cache = planDebateArtifactCacheAfterRefresh(
    planDebateArtifactCacheForProject(PROJECT, SESSION_A),
    SESSION_A,
    PROJECT,
    {
      ok: true,
      rounds: [
        artifactRound(1, "Requirement A", [
          artifactSeat({
            delegationId: "a-disk",
            role: "explorer",
            phase: "draft",
            status: "complete",
            report: "A draft from disk",
            startedAt: 1000,
            completedAt: 2000,
          }),
        ], { sessionId: SESSION_A }),
      ],
    },
  );

  // The cache is keyed by session; even without a refresh B does not see A's rounds.
  const viewBBeforeRefresh = renderForSession(messagesB, cache, PROJECT, SESSION_B);
  assert.deepEqual(
    roundNumbers(viewBBeforeRefresh),
    [2],
    "session B should not see session A's round in the reused cache",
  );
});

test("reload reads every round in the project directory, leaking across sessions", () => {
  reset();
  const messagesA = [
    proposalRow(1, "Requirement A"),
    delegateRow({
      delegationId: "a-draft",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "complete",
      report: "A draft",
      completedAt: 2000,
    }),
  ];

  const diskArtifacts = [
    artifactRound(1, "Requirement A", [
      artifactSeat({
        delegationId: "a-disk",
        role: "explorer",
        phase: "draft",
        status: "complete",
        report: "A draft from disk",
        startedAt: 1000,
        completedAt: 2000,
      }),
    ], { sessionId: SESSION_A }),
    artifactRound(2, "Requirement B", [
      artifactSeat({
        delegationId: "b-disk",
        role: "explorer",
        phase: "draft",
        status: "complete",
        report: "B draft from disk",
        startedAt: 1000,
        completedAt: 2000,
      }),
    ], { sessionId: SESSION_B }),
  ];

  // Fresh cache after a reload: only the current session's rounds are cached.
  const cache = planDebateArtifactCacheAfterRefresh(
    planDebateArtifactCacheForProject(PROJECT, SESSION_A),
    SESSION_A,
    PROJECT,
    { ok: true, rounds: diskArtifacts },
  );
  const viewA = renderForSession(messagesA, cache);
  assert.deepEqual(
    roundNumbers(viewA),
    [1],
    "after reload session A should still see only its own round",
  );
});

test("parallel rounds in the same project collide on round number", () => {
  reset();
  const messagesA = [
    proposalRow(1, "Requirement A"),
    delegateRow({
      delegationId: "a-draft",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "complete",
      report: "A draft",
      completedAt: 2000,
    }),
  ];

  // Session B also wrote to round-1 in the same project directory.
  const diskArtifactFromB = artifactRound(1, "Requirement B", [
    artifactSeat({
      delegationId: "b-draft",
      role: "explorer",
      phase: "draft",
      status: "complete",
      report: "B draft overwrote the shared directory",
      startedAt: 1000,
      completedAt: 2000,
    }),
  ], { sessionId: SESSION_B });

  const cache = planDebateArtifactCacheForProject(PROJECT, SESSION_B, [diskArtifactFromB]);
  const viewA = renderForSession(messagesA, cache);
  const panelA = planDebatePanelRound(viewA);
  assert.equal(panelA.round, 1);
  assert.equal(panelA.requirement, "Requirement A");
  assert.equal(
    panelA.drafts[0].text,
    "A draft",
    "session A's own transcript draft should not be replaced by another session's disk file",
  );
});

/* -------------------------------------------------------------------------- */
/* Handoff isolation: each session's handoff record gates its own button.     */
/* -------------------------------------------------------------------------- */

test("handoff plan is isolated by session view, selection and stored handoff", () => {
  reset();
  const messagesA = [
    proposalRow(1, "Requirement A"),
    delegateRow({
      delegationId: "a-draft",
      round: 1,
      role: "explorer",
      phase: "draft",
      status: "complete",
      report: "A draft",
      completedAt: 2000,
    }),
    delegateRow({
      delegationId: "a-integrator",
      round: 1,
      role: "explorer",
      phase: "integrate",
      status: "complete",
      report: "VERDICTS\n- adopted | item | explorer\nPLAN\nDo it.",
      completedAt: 3000,
    }),
  ];
  const viewA = planDebateViewWithArtifacts(messagesA, [], null, new Map());
  const selectionA = { kind: "merged", round: 1 };
  writePlanDebateHandoff(SESSION_A, { round: 1, at: 4000 });
  const handoffA = readPlanDebateHandoff(SESSION_A);

  const planA = planDebateHandoffPlan(viewA, selectionA, handoffA);
  assert.equal(planA.ok, false);
  assert.equal(planA.reason, "already-handed-off");

  // Session B has no handoff record and a separate selection.
  const selectionB = { kind: "draft", round: 1, role: "explorer" };
  const planB = planDebateHandoffPlan(viewA, selectionB, readPlanDebateHandoff(SESSION_B));
  assert.equal(planB.ok, true);
});

