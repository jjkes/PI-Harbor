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
const rosterModel = load("../src/features/team/team-roster-model.ts", {
  "@pi-harbor/shared": shared,
  "../chat/transcript/model": { delegateAgentName: (message) => message.toolArgs?.agent ?? "" },
  "../../lib/subagent-topology": { subagentOutcome: () => "completed" },
  "../../lib/tool-presentation": { toolResultPayload: () => undefined },
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
  "./team-roster-model": rosterModel,
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

test("member switches append in catalog order, keep session settings while off, and drop bare off entries", async () => {
  const harness = createHarness({
    initial: teamConfig({
      enabled: true,
      members: [{ agent: "explorer" }, { agent: "reviewer", model }],
      revision: 2,
    }),
  });
  await harness.service.load(local);
  await harness.service.updateMember(local, "Review Agent", { enabled: true });
  await harness.service.updateMember(local, "REVIEWER", { enabled: false });
  await harness.service.updateMember(local, "explorer", { enabled: false });

  assert.deepEqual(harness.calls.updates, [
    {
      sessionId: local.id,
      expectedRevision: 2,
      members: [{ agent: "explorer" }, { agent: "reviewer", model }, { agent: "review-agent" }],
    },
    {
      sessionId: local.id,
      expectedRevision: 3,
      members: [
        { agent: "explorer" },
        { agent: "reviewer", enabled: false, model },
        { agent: "review-agent" },
      ],
    },
    {
      sessionId: local.id,
      expectedRevision: 4,
      members: [{ agent: "reviewer", enabled: false, model }, { agent: "review-agent" }],
    },
  ]);
  // Member edits never touch the session's Team switch.
  assert.equal(harness.state().config.enabled, true);
});

test("session settings change only the named member, are stored canonically, and null clears them", async () => {
  const harness = createHarness({
    initial: teamConfig({
      enabled: true,
      members: [{ agent: "explorer" }, { agent: "review-agent" }],
      revision: 5,
    }),
  });
  await harness.service.load(local);
  await harness.service.updateMember(local, "review-agent", {
    model,
    tools: ["Write", "inherit", "Read"],
    thinkingLevel: "high",
  });
  assert.deepEqual(harness.calls.updates[0].members, [
    { agent: "explorer" },
    { agent: "review-agent", model, tools: ["inherit", "Read", "Write"], thinkingLevel: "high" },
  ]);

  await harness.service.updateMember(local, "review-agent", { tools: null });
  assert.deepEqual(harness.state().config.members[1], {
    agent: "review-agent",
    model,
    thinkingLevel: "high",
  });
  await harness.service.updateMember(local, "review-agent", { model: null, thinkingLevel: null });
  assert.deepEqual(harness.state().config.members, [
    { agent: "explorer" },
    { agent: "review-agent" },
  ]);
  assert.deepEqual(
    harness.calls.updates.map((update) => update.expectedRevision),
    [5, 6, 7],
  );
});

test("an edit that changes nothing writes nothing", async () => {
  const harness = createHarness({
    initial: teamConfig({ enabled: true, members: [{ agent: "explorer", model }], revision: 4 }),
  });
  await harness.service.load(local);
  await harness.service.updateMember(local, "Explorer", { enabled: true, model: { ...model } });
  await harness.service.updateMember(local, "fixer", { enabled: false });
  await harness.service.updateMember(local, "explorer", { tools: null, thinkingLevel: null });
  assert.equal(harness.calls.updates.length, 0);
  assert.equal(harness.state().saving, false);
  assert.equal(harness.state().error, null);
});

test("a full roster rejects a new member without writing", async () => {
  const members = Array.from({ length: shared.MAX_TEAM_MEMBERS }, (_, index) => ({
    agent: `role-${index}`,
  }));
  const harness = createHarness({
    initial: teamConfig({ enabled: true, members, revision: 9 }),
  });
  await harness.service.load(local);
  await assert.rejects(harness.service.updateMember(local, "newcomer", { enabled: true }), {
    code: "TEAM_ROSTER_FULL",
  });
  assert.equal(harness.calls.updates.length, 0);
  assert.deepEqual(harness.state().config.members, members);
  assert.equal(harness.state().saving, false);
  assert.equal(harness.state().errorCode, "TEAM_ROSTER_FULL");
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

  await assert.rejects(harness.service.updateMember(local, "fixer", { enabled: true }), {
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
    await assert.rejects(harness.service.updateMember(remote, "explorer", { enabled: true }), {
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
    harness.service.updateMember(local, "fixer", { enabled: true }),
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

test("setMembersEnabled applies many handles in one canonical host write", async () => {
  const harness = createHarness({
    initial: teamConfig({
      enabled: true,
      members: [{ agent: "explorer" }, { agent: "reviewer", enabled: false, model }],
      revision: 4,
    }),
  });
  await harness.service.load(local);
  await harness.service.setMembersEnabled(local, ["Fixer", "REVIEWER"], true);

  assert.equal(harness.calls.updates.length, 1);
  assert.deepEqual(harness.calls.updates[0], {
    sessionId: local.id,
    expectedRevision: 4,
    members: [{ agent: "explorer" }, { agent: "reviewer", model }, { agent: "fixer" }],
  });
  assert.equal(harness.state().saving, false);
});

test("setMembersEnabled is optimistic and rolls every handle back on failure", async () => {
  const initial = teamConfig({ enabled: true, members: [{ agent: "explorer" }], revision: 2 });
  const failure = Object.assign(new Error("write failed"), { code: "WRITE_FAILED" });
  let rejectWrite;
  let harness;
  harness = createHarness({
    initial,
    update: () => new Promise((_, reject) => { rejectWrite = reject; }),
  });
  await harness.service.load(local);
  const pending = harness.service.setMembersEnabled(local, ["fixer", "reviewer"], true);
  const rejection = assert.rejects(pending, { code: "WRITE_FAILED" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.calls.updates.length, 1);
  assert.deepEqual(harness.state().config.members, [
    { agent: "explorer" },
    { agent: "fixer" },
    { agent: "reviewer" },
  ]);
  rejectWrite(failure);
  await rejection;
  assert.deepEqual(harness.state().config, initial);
  assert.equal(harness.state().saving, false);
  assert.equal(harness.state().errorCode, "WRITE_FAILED");
});

test("setMembersEnabled rolls back and reloads the fresh roster after a revision conflict", async () => {
  const initial = teamConfig({ enabled: true, members: [{ agent: "explorer" }], revision: 3 });
  const fresh = teamConfig({ enabled: true, members: [{ agent: "fresh" }], revision: 5 });
  const conflict = Object.assign(new Error("stale team revision"), {
    code: "SESSION_TEAM_REVISION_CONFLICT",
  });
  let conflicted = false;
  let harness;
  harness = createHarness({
    initial,
    read: async () => {
      if (!conflicted) return initial;
      assert.deepEqual(harness.state().config, initial, "bulk rollback precedes the reload");
      return fresh;
    },
    update: async () => {
      assert.deepEqual(harness.state().config.members, [
        { agent: "explorer" },
        { agent: "fixer" },
        { agent: "reviewer" },
      ]);
      conflicted = true;
      throw conflict;
    },
  });
  await harness.service.load(local);
  await assert.rejects(harness.service.setMembersEnabled(local, ["fixer", "reviewer"], true), {
    code: conflict.code,
  });
  assert.equal(harness.calls.updates.length, 1);
  assert.equal(harness.calls.reads, 2);
  assert.deepEqual(harness.state().config, fresh);
  assert.equal(harness.state().errorCode, conflict.code);
});

test("setMembersEnabled shares the serial revision queue with updateMember", async () => {
  const harness = createHarness({
    initial: teamConfig({ enabled: true, members: [{ agent: "explorer" }], revision: 7 }),
  });
  await harness.service.load(local);
  await Promise.all([
    harness.service.setMembersEnabled(local, ["fixer", "reviewer"], true),
    harness.service.updateMember(local, "explorer", { enabled: false }),
  ]);
  assert.deepEqual(harness.calls.updates.map((update) => update.expectedRevision), [7, 8]);
  assert.deepEqual(harness.state().config.members, [{ agent: "fixer" }, { agent: "reviewer" }]);
});
