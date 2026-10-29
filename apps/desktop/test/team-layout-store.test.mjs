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
    assert.ok(Object.hasOwn(imports, id), `unexpected Team layout dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

const shared = await import("@pi-harbor/shared");
const zustand = {
  zustand: require("zustand"),
  "zustand/vanilla": require("zustand/vanilla"),
};
const teamStoreModule = load("../src/features/team/team-store.ts", zustand);
const teamService = load("../src/features/team/team-service.ts", {
  "@pi-harbor/shared": shared,
  "../../components/settings/subagent-settings": {
    fetchSubagentPageData: async () => ({ owned: [], builtins: [] }),
  },
  "../../lib/api": { api: {} },
  "../../lib/remote-session-safety": load("../src/lib/remote-session-safety.ts", {}),
  "./team-store": teamStoreModule,
  "./team-roster-model": load("../src/features/team/team-roster-model.ts", {
    "@pi-harbor/shared": shared,
  }),
});
const {
  TEAM_PANEL_WIDTH_STORAGE_KEY,
  TEAM_ROSTER_COLLAPSED_STORAGE_KEY,
  createTeamLayoutStore,
  toggleTeamSessionMode,
} = load("../src/features/team/team-layout-store.ts", {
  ...zustand,
  "./team-layout-model": load("../src/features/team/team-layout-model.ts", {}),
  "./team-service": teamService,
  "./team-store": teamStoreModule,
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

test("the roster's collapsed state is an app-wide preference next to the panel width", () => {
  const storage = memoryStorage();
  const store = createTeamLayoutStore({ storage });
  assert.equal(store.getState().rosterCollapsed, false, "the roster starts expanded");
  store.getState().setRosterCollapsed(true);
  assert.equal(store.getState().rosterCollapsed, true);
  assert.equal(storage.values.get(TEAM_ROSTER_COLLAPSED_STORAGE_KEY), "true");
  assert.equal(storage.values.has(TEAM_PANEL_WIDTH_STORAGE_KEY), false, "collapsing never writes the width");
  assert.equal(createTeamLayoutStore({ storage }).getState().rosterCollapsed, true);

  const broken = memoryStorage({ [TEAM_ROSTER_COLLAPSED_STORAGE_KEY]: "{not json" });
  assert.equal(createTeamLayoutStore({ storage: broken }).getState().rosterCollapsed, false);
  assert.equal(createTeamLayoutStore({ storage: null }).getState().rosterCollapsed, false);
});

test("a reveal is consumed once by its own session: inline needs no drawer, a narrow layout opens it", () => {
  const store = createTeamLayoutStore({ storage: null });
  const state = () => store.getState();

  state().requestReveal("a");
  state().consumeReveal("b", "rail");
  assert.equal(state().revealSessionId, "a", "another session cannot consume the reveal");
  assert.equal(state().overlaySessionId, null);

  state().consumeReveal("a", "inline");
  assert.equal(state().revealSessionId, null);
  assert.equal(state().overlaySessionId, null, "the inline view is already visible");

  state().requestReveal("a");
  state().consumeReveal("a", "rail");
  assert.equal(state().revealSessionId, null);
  assert.equal(state().overlaySessionId, "a", "a narrow window opens the drawer");
  state().closeOverlay("a");
  state().consumeReveal("a", "rail");
  assert.equal(state().overlaySessionId, null, "a consumed reveal does not reopen the drawer");

  state().requestReveal("a");
  state().clearReveal("b");
  assert.equal(state().revealSessionId, "a", "clearing another session keeps the request");
  state().clearReveal("a");
  assert.equal(state().revealSessionId, null);

  state().requestReveal("a");
  state().consumeReveal("a", "hidden");
  assert.equal(state().overlaySessionId, "a", "a hidden layout opens the drawer as well");
});

test("switching Team on asks for a reveal before the host answers; switching off or failing clears it", async () => {
  const local = { id: "local", source: "local" };
  const configStore = teamStoreModule.createTeamStore();
  const layoutStore = createTeamLayoutStore({ storage: null });
  const errors = [];
  const onError = (error) => errors.push(error);
  let answer;
  const service = {
    toggle: () =>
      new Promise((resolve, reject) => {
        answer = { resolve, reject };
      }),
  };
  const dependencies = { service, configStore, layoutStore };
  const config = (enabled) => ({ sessionId: local.id, enabled, members: [], revision: 1 });

  const enabling = toggleTeamSessionMode(local, onError, dependencies);
  assert.equal(layoutStore.getState().revealSessionId, local.id, "armed before the host answers");
  answer.resolve(config(true));
  assert.deepEqual(await enabling, config(true));
  assert.equal(layoutStore.getState().revealSessionId, local.id, "TeamLayout consumes it once measured");
  layoutStore.getState().consumeReveal(local.id, "rail");
  assert.equal(layoutStore.getState().overlaySessionId, local.id);

  configStore.setState({
    sessions: {
      [local.id]: { config: config(true), loading: false, saving: false, error: null, errorCode: null },
    },
  });
  layoutStore.getState().requestReveal(local.id);
  const disabling = toggleTeamSessionMode(local, onError, dependencies);
  assert.equal(layoutStore.getState().overlaySessionId, null, "switching off closes the drawer at once");
  assert.equal(layoutStore.getState().revealSessionId, null);
  answer.resolve(config(false));
  assert.deepEqual(await disabling, config(false));

  configStore.setState({ sessions: {} });
  const failure = Object.assign(new Error("host unavailable"), { code: "HOST_UNAVAILABLE" });
  const failing = toggleTeamSessionMode(local, onError, dependencies);
  assert.equal(layoutStore.getState().revealSessionId, local.id);
  answer.reject(failure);
  assert.equal(await failing, null);
  assert.equal(layoutStore.getState().revealSessionId, null, "a failed switch leaves no reveal behind");
  assert.deepEqual(errors, [failure]);

  const remote = { id: "remote:one", source: "remote" };
  assert.equal(await toggleTeamSessionMode(remote, onError, dependencies), null);
  assert.equal(layoutStore.getState().revealSessionId, null, "ineligible sessions are a no-op");
});

test("TeamLayout consumes a reveal only after measuring MainChat", () => {
  const layout = fs.readFileSync(
    new URL("../src/features/team/TeamLayout.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    layout,
    /if \(!revealPending \|\| mainChatWidth <= 0\) return;\s*\n\s*consumeReveal\(session\.id, layout\.presentation\);/,
  );
});
