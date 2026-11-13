/**
 * Plan-debate artifacts are read back from `<projectPath>/.pi-harbor/debate/`.
 * A genuinely absent debate root is empty. Project/host failures, an unreadable
 * directory and any unusable kept round instead reject, so the renderer can
 * preserve its last good cache rather than replacing it with a partial list.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { IPC } = await import("@pi-harbor/shared");
const {
  MAX_ARTIFACT_REPORT_CHARS,
  MAX_ARTIFACT_ROUNDS,
  readPlanDebateArtifacts,
  registerPlanDebateArtifactsIpc,
} = await import("../electron/main/ipc/plan-debate-artifacts-ipc.ts");

/** A throwaway project root; the debate directory is created by each fixture. */
const withProject = async (run) => {
  const root = await mkdtemp(join(tmpdir(), "pi-harbor-debate-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const debateDir = (projectRoot) => join(projectRoot, ".pi-harbor", "debate");

const roundIndex = (overrides = {}) => ({
  version: 1,
  round: 1,
  requirement: "Ship it",
  startedAt: 1750000000000,
  completedAt: 1750000009000,
  seats: [
    {
      phase: "draft",
      role: "code-reviewer",
      seat: 1,
      status: "complete",
      delegationId: "d1",
      startedAt: 1750000000000,
      completedAt: 1750000004000,
      reportFile: "draft-code-reviewer.md",
    },
  ],
  mergedFile: "merged.md",
  ...overrides,
});

const writeRound = async (projectRoot, round, index, files = {}) => {
  const dir = join(debateDir(projectRoot), `round-${round}`);
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(dir, name), text, "utf8");
  }
  await writeFile(join(dir, `round-${round}.json`), JSON.stringify(index), "utf8");
  return dir;
};

test("a settled round parses with its seat report, merged text and index fields", async () => {
  await withProject(async (root) => {
    await writeRound(root, 1, roundIndex(), {
      "draft-code-reviewer.md": "## draft\nlooks fine",
      "merged.md": "## merged plan",
    });
    const result = await readPlanDebateArtifacts(root, { sessionId: "s1" });
    assert.deepEqual(result, {
      rounds: [
        {
          version: 1,
          round: 1,
          requirement: "Ship it",
          startedAt: 1750000000000,
          completedAt: 1750000009000,
          seats: [
            {
              phase: "draft",
              role: "code-reviewer",
              seat: 1,
              status: "complete",
              delegationId: "d1",
              startedAt: 1750000000000,
              completedAt: 1750000004000,
              report: "## draft\nlooks fine",
            },
          ],
          merged: "## merged plan",
        },
      ],
    });
    // The index has no failure, so the round must not grow one.
    assert.equal("failure" in result.rounds[0], false);
  });
});

test("a user-stopped round round-trips stoppedAt through the artifact reader", async () => {
  await withProject(async (root) => {
    await writeRound(
      root,
      1,
      roundIndex({ completedAt: undefined, stoppedAt: 1750000007000 }),
      { "draft-code-reviewer.md": "## draft" },
    );
    const result = await readPlanDebateArtifacts(root, { sessionId: "s1" });
    assert.equal(result.rounds[0].stoppedAt, 1750000007000);
    assert.equal("completedAt" in result.rounds[0], false);
  });
});

test("a round index with a roster and per-seat spans returns both", async () => {
  await withProject(async (root) => {
    await writeRound(
      root,
      1,
      roundIndex({
        roles: [
          { name: "code-reviewer", brief: "own the risk", seat: 1 },
          // A CJK handle: the file it wrote is named after its seat, so the
          // index — and only the index — is what carries the role back.
          { name: "发布工程", brief: "own the delivery", seat: 1 },
          // A role written without a brief or a seat is still a role.
          { name: "half" },
        ],
      }),
      { "draft-code-reviewer.md": "## draft" },
    );
    const result = await readPlanDebateArtifacts(root, { sessionId: "s1" });
    const [round] = result.rounds;
    // The roster the round started with, briefs included.
    assert.deepEqual(round.roles, [
      { name: "code-reviewer", brief: "own the risk", seat: 1 },
      { name: "发布工程", brief: "own the delivery", seat: 1 },
      { name: "half", brief: "", seat: 1 },
    ]);
    // Each seat's own span, which is what the panel draws its duration from.
    assert.equal(round.seats[0].startedAt, 1750000000000);
    assert.equal(round.seats[0].completedAt, 1750000004000);
    assert.equal(round.startedAt, 1750000000000);
    assert.equal(round.completedAt, 1750000009000);
  });
});

test("an index written before rosters were persisted reads without roles and without spans", async () => {
  await withProject(async (root) => {
    // The shape an older writer produced: no `roles`, no per-seat timestamps.
    await writeRound(root, 1, {
      version: 1,
      round: 1,
      requirement: "Ship it",
      seats: [
        {
          phase: "draft",
          role: "发布工程",
          seat: 1,
          status: "complete",
          delegationId: "d1",
          reportFile: "draft-seat1.md",
        },
      ],
    }, { "draft-seat1.md": "## draft" });
    const result = await readPlanDebateArtifacts(root, { sessionId: "s1" });
    const [round] = result.rounds;
    // No roster to return, and the round still reads: the panel falls back to
    // naming the seats with an empty brief.
    assert.equal("roles" in round, false);
    assert.equal(round.seats.length, 1);
    assert.equal(round.seats[0].role, "发布工程");
    assert.equal(round.seats[0].report, "## draft");
    // An unknown clock stays unknown: nothing here invents a zero.
    assert.equal("startedAt" in round.seats[0], false);
    assert.equal("completedAt" in round.seats[0], false);
  });
});

test("a reportFile that escapes the round directory is ignored, not read", async () => {
  await withProject(async (root) => {
    const secret = "TOP-SECRET-OUTSIDE-THE-ROUND";
    // `../../outside.md` from the round directory lands here, so plant the file:
    // containment has to be what drops it, not a missing file.
    await mkdir(join(root, ".pi-harbor"), { recursive: true });
    await writeFile(join(root, ".pi-harbor", "outside.md"), secret, "utf8");
    await writeRound(
      root,
      1,
      roundIndex({
        mergedFile: "../../outside.md",
        seats: [
          {
            phase: "draft",
            role: "explorer",
            seat: 1,
            status: "complete",
            delegationId: "d1",
            reportFile: "../../outside.md",
          },
          {
            phase: "critique",
            role: "critic",
            seat: 1,
            status: "failed",
            delegationId: "d2",
            error: "delegate failed",
            reportFile: "/etc/passwd",
          },
        ],
      }),
    );
    const result = await readPlanDebateArtifacts(root, { sessionId: "s1" });
    assert.equal(result.rounds.length, 1);
    const [round] = result.rounds;
    assert.equal(round.seats.length, 2);
    assert.deepEqual(
      round.seats.map((seat) => [seat.phase, seat.role, "report" in seat]),
      [
        ["draft", "explorer", false],
        ["critique", "critic", false],
      ],
    );
    assert.equal(round.seats[1].error, "delegate failed");
    assert.equal("merged" in round, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  });
});

test("a missing debate root is an authoritative empty result", async () => {
  await withProject(async (root) => {
    assert.deepEqual(await readPlanDebateArtifacts(root, { sessionId: "s1" }), { rounds: [] });
  });
});

test("an unresolved project or bad request rejects instead of looking empty", async () => {
  for (const projectPath of [null, undefined, "", "   "]) {
    await assert.rejects(readPlanDebateArtifacts(projectPath, { sessionId: "s1" }), /project path/);
  }
  const registered = new Map();
  registerPlanDebateArtifactsIpc({
    registrar: { handle: (channel, handler) => registered.set(channel, handler) },
    getProjectPath: async () => null,
  });
  const invoke = registered.get(IPC.invoke.planDebateArtifacts);
  assert.equal(typeof invoke, "function");
  await assert.rejects(invoke({ sessionId: "unknown" }), /project path/);
  for (const raw of [
    { sessionId: 42 },
    { sessionId: "  " },
    { round: 1 },
    {},
    null,
    "s1",
    [1],
  ]) {
    await assert.rejects(invoke(raw), /sessionId/);
  }
});

test("more than the kept round limit keeps only the last rounds, ascending", async () => {
  await withProject(async (root) => {
    const written = MAX_ARTIFACT_ROUNDS + 5;
    for (let round = 1; round <= written; round += 1) {
      await writeRound(root, round, roundIndex({ round }));
    }
    const result = await readPlanDebateArtifacts(root, { sessionId: "s1" });
    assert.equal(result.rounds.length, MAX_ARTIFACT_ROUNDS);
    assert.equal(result.rounds[0].round, written - MAX_ARTIFACT_ROUNDS + 1);
    assert.equal(result.rounds.at(-1).round, written);
    const seen = result.rounds.map((round) => round.round);
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
    // A request naming one round reads just that one.
    const single = await readPlanDebateArtifacts(root, { sessionId: "s1", round: 3 });
    assert.deepEqual(
      single.rounds.map((round) => round.round),
      [3],
    );
  });
});

test("an oversized report is truncated to the character cap", async () => {
  await withProject(async (root) => {
    const report = "x".repeat(MAX_ARTIFACT_REPORT_CHARS + 5_000);
    await writeRound(root, 1, roundIndex(), { "draft-code-reviewer.md": report });
    const result = await readPlanDebateArtifacts(root, { sessionId: "s1" });
    const fetched = result.rounds[0].seats[0].report;
    assert.equal(typeof fetched, "string");
    assert.equal(fetched.length, MAX_ARTIFACT_REPORT_CHARS);
    assert.equal(fetched, report.slice(0, MAX_ARTIFACT_REPORT_CHARS));
    assert.ok(fetched.length <= MAX_ARTIFACT_REPORT_CHARS + 100);
  });
});

test("an unusable kept round fails the whole read instead of returning partial rounds", async () => {
  await withProject(async (root) => {
    await writeRound(root, 1, roundIndex());
    await mkdir(join(debateDir(root), "round-2"), { recursive: true });
    await writeFile(join(debateDir(root), "round-2", "round-2.json"), "{ not json", "utf8");
    await mkdir(join(debateDir(root), "round-3"), { recursive: true });
    await mkdir(join(debateDir(root), "notes"), { recursive: true });
    await writeFile(join(debateDir(root), "notes", "round-9.json"), "{}", "utf8");

    await assert.rejects(readPlanDebateArtifacts(root, { sessionId: "s1" }), /round 2 index/);
    await rm(join(debateDir(root), "round-2"), { recursive: true, force: true });
    await assert.rejects(readPlanDebateArtifacts(root, { sessionId: "s1" }), { code: "ENOENT" });

    // Non-round directories are still irrelevant once every kept round reads.
    await rm(join(debateDir(root), "round-3"), { recursive: true, force: true });
    const result = await readPlanDebateArtifacts(root, { sessionId: "s1" });
    assert.deepEqual(result.rounds.map((round) => round.round), [1]);
  });
});

test("ENOTDIR at the debate root rejects instead of returning no rounds", async () => {
  await withProject(async (root) => {
    await mkdir(join(root, ".pi-harbor"), { recursive: true });
    await writeFile(debateDir(root), "not a directory", "utf8");
    await assert.rejects(readPlanDebateArtifacts(root, { sessionId: "s1" }), { code: "ENOTDIR" });
  });
});

test("EACCES in one kept round rejects instead of returning a partial result", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission bits are not an EACCES fixture for this user/platform");
    return;
  }
  await withProject(async (root) => {
    const directory = await writeRound(root, 1, roundIndex(), {
      "draft-code-reviewer.md": "report",
    });
    const reportPath = join(directory, "draft-code-reviewer.md");
    await chmod(reportPath, 0o000);
    try {
      await assert.rejects(readPlanDebateArtifacts(root, { sessionId: "s1" }), { code: "EACCES" });
    } finally {
      await chmod(reportPath, 0o600);
    }
  });
});

test("host project resolution failures propagate through the IPC handler", async () => {
  const registered = new Map();
  const failure = Object.assign(new Error("host unavailable"), { errorCode: "HOST_UNAVAILABLE" });
  registerPlanDebateArtifactsIpc({
    registrar: { handle: (channel, handler) => registered.set(channel, handler) },
    getProjectPath: async () => {
      throw failure;
    },
  });
  const invoke = registered.get(IPC.invoke.planDebateArtifacts);
  assert.equal(typeof invoke, "function");
  await assert.rejects(invoke({ sessionId: "s1" }), (error) => error === failure);
});

test("the channel is registered and the request is resolved through getProjectPath", async () => {
  await withProject(async (root) => {
    await writeRound(root, 1, roundIndex(), { "merged.md": "## merged plan" });
    const registered = new Map();
    const resolved = [];
    registerPlanDebateArtifactsIpc({
      registrar: { handle: (channel, handler) => registered.set(channel, handler) },
      getProjectPath: async (sessionId) => {
        resolved.push(sessionId);
        return sessionId === "s1" ? root : null;
      },
    });
    assert.equal(IPC.invoke.planDebateArtifacts, "pi-harbor/plan-debate/artifacts");
    const invoke = registered.get(IPC.invoke.planDebateArtifacts);
    assert.equal(typeof invoke, "function");
    const result = await invoke({ sessionId: "s1" });
    assert.deepEqual(resolved, ["s1"]);
    assert.equal(result.rounds.length, 1);
    assert.equal(result.rounds[0].requirement, "Ship it");
    assert.equal(result.rounds[0].merged, "## merged plan");
  });
});
