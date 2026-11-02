import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { createSessionCoordination } = await import("../src/stores/runtime/session-coordination.ts");
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { api } = await import("../src/lib/api.ts");
const { resolveNewSessionScope } = await import("../src/lib/session-create.ts");

const projectPath = "/repo";

function session(id, workspaceId = null, messageCount = 1, path = projectPath) {
  return {
    id,
    title: id,
    projectPath: path,
    workspaceId,
    messageCount,
    mode: "agent",
    providerId: "provider",
    modelId: "model",
    thinkingLevel: "off",
    updatedAt: "2026-11-02T12:00:00.000Z",
    createdAt: "2026-11-02T12:00:00.000Z",
  };
}

/** Real renderer creation/selection wiring; only host IPC is mocked. */
function harness(t, { scope = null, sessions = [], activeSessionId } = {}) {
  let state = {
    activeSessionId,
    sessions,
    sessionMeta: {},
    workspace: { path: projectPath },
    activeProjectPath: projectPath,
    newSessionScope: scope,
    messages: [],
    retainedSessionIds: [],
    retainedTranscripts: {},
    sessionHistory: {},
    runningSessions: {},
    sessionOutcomes: {},
    planningStates: {},
    pendingPlans: {},
    sessionCompactions: {},
    workPanelContexts: {},
    workPanelTabs: [],
    workPanelOpen: false,
    activeWorkPanelTabId: null,
    navStack: [{ page: "chat" }],
    navIndex: 0,
    page: "chat",
    settings: { defaultMode: "agent" },
    providers: [],
    providerModels: {},
    recentModels: [],
    draftConfiguration: null,
    isRunning: false,
    acknowledgeSessionOutcome: async () => {},
    restorePendingPlan: async () => {},
    restorePendingInteractive: async () => {},
    showToast: () => {},
  };
  let runtime;
  const access = {
    get: () => state,
    set: (update) => {
      const previous = state;
      state = { ...state, ...(typeof update === "function" ? update(state) : update) };
      runtime?.syncTranscriptProjection(state, previous);
    },
  };
  runtime = createSessionRuntime(access);
  const decorateSessions = (rows) => rows;
  const withoutRecordKey = (record, key) =>
    Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));
  const coordination = createSessionCoordination({
    ...access,
    runtime,
    decorateSessions,
    withoutRecordKey,
    untitledTaskTitle: () => "New task",
  });
  const slice = createSessionSlice({
    ...access,
    runtime,
    decorateSessions,
    withoutRecordKey,
    sessionModeForPlanningState: () => "agent",
    openPlanArtifact: () => {},
    rememberSessionCompactions: () => {},
    commitForkedSession: () => {},
    persistSessionAndSelect: coordination.persistSessionAndSelect,
  });
  const creates = [];
  t.mock.method(api, "createSession", async (input) => {
    creates.push(input);
    return {
      session: session(
        `created-${creates.length}`,
        input.workspaceId ?? null,
        0,
        input.projectPath ?? null,
      ),
    };
  });
  t.mock.method(api, "getSession", async (id) => {
    const summary = state.sessions.find((row) => row.id === id);
    return {
      session: {
        ...summary,
        messages: [{ id: `${id}-message`, role: "user", content: "hello" }],
        messageCount: 1,
        messageStart: 0,
        hasMoreBefore: false,
      },
    };
  });
  return { slice, coordination, runtime, creates, get: access.get };
}

test("New Task uses the workspace scope instead of reusing a project-root empty slot", async (t) => {
  const h = harness(t, {
    scope: { projectPath, workspaceId: "workspace-1" },
    sessions: [session("project-empty", null, 0)],
    activeSessionId: "project-empty",
  });
  await h.slice.newSession();
  assert.equal(h.creates.length, 1);
  assert.equal(h.creates[0].projectPath, projectPath);
  assert.equal(h.creates[0].workspaceId, "workspace-1");
  assert.equal(h.get().newSessionScope.workspaceId, "workspace-1");
});

test("the first draft prompt materializes in the same workspace scope", async (t) => {
  const h = harness(t, { scope: { projectPath, workspaceId: "workspace-1" } });
  await h.coordination.materializeDraftSession();
  assert.equal(h.creates[0].workspaceId, "workspace-1");
  assert.notEqual(
    h.runtime.newSessionScopeKey({ projectPath }),
    h.runtime.newSessionScopeKey({ projectPath, workspaceId: "workspace-1" }),
  );
});

test("an explicit project-root New Task clears the workspace scope", async (t) => {
  const h = harness(t, { scope: { projectPath, workspaceId: "workspace-1" } });
  await h.slice.newSession({ projectPath });
  assert.equal(h.creates[0].workspaceId, undefined);
  assert.equal(h.get().newSessionScope, null);
});

test("selecting sessions synchronizes the next-session scope", async (t) => {
  const h = harness(t, {
    sessions: [session("root"), session("workspace", "workspace-1")],
    activeSessionId: "root",
  });
  await h.slice.selectSession("workspace");
  assert.deepEqual(h.get().newSessionScope, {
    projectPath,
    workspaceId: "workspace-1",
  });
  await h.slice.selectSession("root");
  assert.equal(h.get().newSessionScope, null);
});

test("scope resolution keeps archive/delete fallback bindings and rejects stale scopes", () => {
  const scope = { projectPath, workspaceId: "workspace-1" };
  assert.deepEqual(
    resolveNewSessionScope(
      { workspace: { path: projectPath }, newSessionScope: scope },
      { projectPath, workspaceId: "workspace-1" },
    ),
    scope,
  );
  assert.deepEqual(
    resolveNewSessionScope({
      workspace: { path: projectPath },
      newSessionScope: { projectPath: "/other", workspaceId: "other-workspace" },
    }),
    { projectPath, workspaceId: null },
  );
  assert.deepEqual(
    resolveNewSessionScope(
      { workspace: { path: projectPath }, newSessionScope: scope },
      { projectPath: null },
    ),
    { projectPath: null, workspaceId: null },
  );
});

test("creating a workspace makes it the next New Task destination", async (t) => {
  const { createProjectWorkspace } = await import(
    "../src/features/project-workspace/project-workspace-actions.ts"
  );
  const { useAppStore } = await import("../src/stores/app-store.ts");
  const { useProjectWorkspaceStore } = await import(
    "../src/features/project-workspace/project-workspace-store.ts"
  );
  const workspace = {
    id: "workspace-created",
    projectPath,
    name: "Feature",
    relativePath: ".pi/worktree/Feature",
    branch: "feature",
    sourceRemote: "origin",
    sourceBranch: "main",
    createdBranch: true,
    status: "active",
    createdAt: "2026-11-02T12:00:00.000Z",
    updatedAt: "2026-11-02T12:00:00.000Z",
  };
  useAppStore.setState({ newSessionScope: null });
  useProjectWorkspaceStore.setState({ byProject: {}, loading: {} });
  t.after(() => {
    useAppStore.setState({ newSessionScope: null });
    useProjectWorkspaceStore.setState({ byProject: {}, loading: {} });
  });
  t.mock.method(api, "createProjectWorkspace", async () => ({
    workspace,
    included: { copied: [] },
  }));
  t.mock.method(api, "listProjectWorkspaces", async () => [workspace]);
  await createProjectWorkspace(
    { projectPath, name: "Feature", remote: "origin", sourceBranch: "main" },
    (key) => key,
  );
  assert.deepEqual(useAppStore.getState().newSessionScope, {
    projectPath,
    workspaceId: "workspace-created",
  });
});

test("the active session binding remains the fallback when no draft scope exists", () => {
  assert.deepEqual(
    resolveNewSessionScope({
      workspace: { path: projectPath },
      activeSessionId: "workspace",
      sessions: [session("workspace", "workspace-1")],
    }),
    { projectPath, workspaceId: "workspace-1" },
  );
});
