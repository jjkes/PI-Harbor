import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);

// Transpile the renderer modules and replace only their external I/O boundaries.
function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected Team service dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

const shared = await import("@pi-harbor/shared");
const remoteSafety = load("../src/lib/remote-session-safety.ts", {});
const teamStore = load("../src/features/team/team-store.ts", {
  zustand: require("zustand"),
  "zustand/vanilla": require("zustand/vanilla"),
});
const {
  createTeamService,
  isTeamSessionEligible,
  TEAM_SESSION_INELIGIBLE,
} = load("../src/features/team/team-service.ts", {
  "@pi-harbor/shared": shared,
  "../../components/settings/subagent-settings": {
    fetchSubagentPageData: async () => ({ owned: [], builtins: [] }),
  },
  "../../lib/api": { api: {} },
  "../../lib/remote-session-safety": remoteSafety,
  "./team-store": teamStore,
});

const local = { id: "session-1", source: "local" };
const model = { providerId: "anthropic", modelId: "claude-sonnet" };

function teamConfig(overrides = {}) {
  return {
    sessionId: local.id,
    enabled: false,
    members: [],
    revision: 0,
    ...overrides,
  };
}

function createHarness(options = {}) {
  const store = teamStore.createTeamStore();
  let hostConfig = options.initial ?? teamConfig();
  const calls = { reads: 0, updates: [], seeds: 0 };
  const client = {
    async getSessionTeam(sessionId) {
      calls.reads += 1;
      if (options.read) return options.read(sessionId);
      return hostConfig;
    },
    async updateSessionTeam(update) {
      calls.updates.push(update);
      if (options.update) return options.update(update);
      const { sessionId, expectedRevision: _expectedRevision, ...change } = update;
      hostConfig = { ...hostConfig, ...change, sessionId, revision: hostConfig.revision + 1 };
      return hostConfig;
    },
  };
  const service = createTeamService({
    api: client,
    store,
    loadSubagentPage: async () => {
      calls.seeds += 1;
      return options.page ?? { owned: [], builtins: [] };
    },
  });
  return {
    service,
    store,
    calls,
    state: (sessionId = local.id) => store.getState().sessions[sessionId],
  };
}

test("first enable seeds enabled settings definitions in order without card model pins", async () => {
  const harness = createHarness({
    page: {
      owned: [
        { id: "Review Agent", enabled: true, model },
        { id: "disabled-owned", enabled: false },
      ],
      builtins: [
        { name: "explorer", enabled: true, model },
        { name: "review_agent", enabled: true },
        { name: "disabled-builtin", enabled: false },
      ],
    },
  });
  await harness.service.load(local);
  const saved = await harness.service.toggle(local);

  assert.deepEqual(harness.calls.updates, [{
    sessionId: local.id,
    expectedRevision: 0,
    enabled: true,
    members: [{ agent: "review-agent" }, { agent: "explorer" }],
  }]);
  assert.equal(harness.calls.seeds, 1);
  assert.deepEqual(saved.members, [{ agent: "review-agent" }, { agent: "explorer" }]);
  assert.equal(harness.state().saving, false);
  assert.equal(harness.state().error, null);
});

test("disable and re-enable preserve the roster and do not seed again", async () => {
  const members = [{ agent: "explorer", model }, { agent: "fixer" }];
  const harness = createHarness({
    initial: teamConfig({ enabled: true, members, revision: 4 }),
  });
  await harness.service.load(local);
  await harness.service.toggle(local);
  assert.equal(harness.state().config.enabled, false);
  assert.deepEqual(harness.state().config.members, members);
  await harness.service.toggle(local);

  assert.deepEqual(harness.calls.updates, [
    { sessionId: local.id, expectedRevision: 4, enabled: false },
    { sessionId: local.id, expectedRevision: 5, enabled: true },
  ]);
  assert.equal(harness.calls.seeds, 0);
  assert.deepEqual(harness.state().config.members, members);
});

test("an intentionally empty later roster is not re-seeded", async () => {
  const harness = createHarness({ initial: teamConfig({ revision: 8 }) });
  await harness.service.load(local);
  await harness.service.toggle(local);
  assert.deepEqual(harness.calls.updates[0], {
    sessionId: local.id,
    expectedRevision: 8,
    enabled: true,
  });
  assert.equal(harness.calls.seeds, 0);
});

test("add appends a normalized member and model edit changes only that card", async () => {
  const harness = createHarness({
    initial: teamConfig({ enabled: true, members: [{ agent: "explorer" }], revision: 2 }),
  });
  await harness.service.load(local);
  await harness.service.addMember(local, "Review Agent");
  await harness.service.setMemberModel(local, "review-agent", model);

  assert.deepEqual(harness.calls.updates[0], {
    sessionId: local.id,
    expectedRevision: 2,
    members: [{ agent: "explorer" }, { agent: "review-agent" }],
  });
  assert.deepEqual(harness.calls.updates[1], {
    sessionId: local.id,
    expectedRevision: 3,
    members: [{ agent: "explorer" }, { agent: "review-agent", model }],
  });
  assert.equal(harness.state().config.enabled, true);

  await harness.service.setMemberModel(local, "review-agent", undefined);
  assert.deepEqual(harness.state().config.members, [
    { agent: "explorer" },
    { agent: "review-agent" },
  ]);
});

test("remove keeps Team enabled and preserves the remaining member and its pin", async () => {
  const harness = createHarness({
    initial: teamConfig({
      enabled: true,
      members: [{ agent: "explorer" }, { agent: "reviewer", model }],
      revision: 6,
    }),
  });
  await harness.service.load(local);
  await harness.service.removeMember(local, "EXPLORER");

  assert.deepEqual(harness.calls.updates[0], {
    sessionId: local.id,
    expectedRevision: 6,
    members: [{ agent: "reviewer", model }],
  });
  assert.equal(harness.state().config.enabled, true);
  assert.deepEqual(harness.state().config.members, [{ agent: "reviewer", model }]);
});

test("stale revision rolls back the optimistic edit, reloads, and retains the conflict", async () => {
  const initial = teamConfig({ enabled: true, members: [{ agent: "explorer" }], revision: 3 });
  const fresh = teamConfig({ enabled: false, members: [{ agent: "reviewer" }], revision: 5 });
  const conflict = Object.assign(new Error("stale team revision"), {
    code: "SESSION_TEAM_REVISION_CONFLICT",
  });
  let conflicted = false;
  let harness;
  harness = createHarness({
    initial,
    read: async () => {
      if (!conflicted) return initial;
      assert.deepEqual(harness.state().config, initial, "rollback precedes the reload");
      return fresh;
    },
    update: async () => {
      assert.deepEqual(harness.state().config.members, [
        { agent: "explorer" },
        { agent: "fixer" },
      ]);
      conflicted = true;
      throw conflict;
    },
  });
  await harness.service.load(local);

  await assert.rejects(harness.service.addMember(local, "fixer"), {
    code: "SESSION_TEAM_REVISION_CONFLICT",
  });
  assert.equal(harness.calls.updates[0].expectedRevision, 3);
  assert.equal(harness.calls.reads, 2);
  assert.deepEqual(harness.state().config, fresh);
  assert.equal(harness.state().loading, false);
  assert.equal(harness.state().saving, false);
  assert.equal(harness.state().errorCode, conflict.code);
});

test("remote and Native Pi sessions are ineligible without IPC reads, writes, or definition seeding", async () => {
  const harness = createHarness();
  const remotes = [
    { id: "remote:one", source: "local" },
    { id: "ordinary-id", source: "remote" },
    { id: "native-pi:one", source: "local" },
    { id: "ordinary-native", source: "pi-native" },
  ];
  assert.equal(isTeamSessionEligible(local), true);
  for (const remote of remotes) {
    assert.equal(isTeamSessionEligible(remote), false);
    await assert.rejects(harness.service.load(remote), { code: TEAM_SESSION_INELIGIBLE });
    await assert.rejects(harness.service.toggle(remote), { code: TEAM_SESSION_INELIGIBLE });
    await assert.rejects(harness.service.addMember(remote, "explorer"), {
      code: TEAM_SESSION_INELIGIBLE,
    });
  }
  assert.equal(harness.calls.reads, 0);
  assert.equal(harness.calls.updates.length, 0);
  assert.equal(harness.calls.seeds, 0);
});

test("cache is per session and an explicit reload refreshes only its target", async () => {
  const other = { id: "session-2", source: "local" };
  const harness = createHarness({
    read: async (sessionId) => teamConfig({ sessionId, enabled: sessionId === other.id }),
  });
  await harness.service.load(local);
  await harness.service.load(other);
  await harness.service.load(local);
  await harness.service.load(other);
  assert.equal(harness.calls.reads, 2);
  assert.equal(harness.state().config.sessionId, local.id);
  assert.equal(harness.state(other.id).config.sessionId, other.id);

  await harness.service.reload(local);
  assert.equal(harness.calls.reads, 3);
  assert.equal(harness.state(other.id).config.enabled, true);
});

test("initial reads expose loading and retain coded failures", async () => {
  const failure = Object.assign(new Error("host unavailable"), { code: "HOST_UNAVAILABLE" });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const harness = createHarness({
    read: async () => {
      markStarted();
      throw failure;
    },
  });
  const pending = harness.service.load(local);
  await started;
  assert.equal(harness.state().loading, true);
  await assert.rejects(pending, { code: "HOST_UNAVAILABLE" });
  assert.equal(harness.state().loading, false);
  assert.equal(harness.state().config, null);
  assert.equal(harness.state().error, "host unavailable");
  assert.equal(harness.state().errorCode, "HOST_UNAVAILABLE");
});

test("rapid edits on one session serialize their expected revisions", async () => {
  const harness = createHarness({
    initial: teamConfig({ enabled: true, members: [{ agent: "explorer" }], revision: 7 }),
  });
  await harness.service.load(local);

  await Promise.all([
    harness.service.toggle(local),
    harness.service.addMember(local, "fixer"),
  ]);

  assert.deepEqual(
    harness.calls.updates.map((update) => update.expectedRevision),
    [7, 8],
  );
  assert.equal(harness.state().config.enabled, false);
  assert.deepEqual(harness.state().config.members, [
    { agent: "explorer" },
    { agent: "fixer" },
  ]);
});
