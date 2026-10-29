import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const topbarProps = {
  sidebarCollapsed: false,
  workPanelOpen: false,
  onToggleSidebar() {},
  onNewTask() {},
  onOpenSearch() {},
};

function sessionState(config) {
  return {
    config,
    loading: false,
    saving: false,
    error: null,
    errorCode: null,
  };
}

test("Team shell wires eligibility, toggle, layout thresholds, overlay and width preference", async (t) => {
  const ssr = await slotSsr(t);
  const [
    layoutStoreModule,
    { createTeamStore, teamStore },
    layoutModel,
    { ConversationTopbar },
    { useAppStore },
    { teamLayoutStore },
  ] = await Promise.all([
    ssr.load("/src/features/team/team-layout-store.ts"),
    ssr.load("/src/features/team/team-store.ts"),
    ssr.load("/src/features/team/team-layout-model.ts"),
    ssr.load("/src/components/ConversationTopbar.tsx"),
    ssr.load("/src/stores/app-store.ts"),
    ssr.load("/src/features/team/team-layout-store.ts"),
  ]);
  const {
    TEAM_PANEL_WIDTH_STORAGE_KEY,
    createTeamLayoutStore,
    toggleTeamSessionMode,
  } = layoutStoreModule;
  const { resolveTeamLayout } = layoutModel;

  const writes = [];
  const storage = {
    getItem(key) {
      assert.equal(key, TEAM_PANEL_WIDTH_STORAGE_KEY);
      return null;
    },
    setItem(key, value) {
      writes.push([key, value]);
    },
  };
  const presentationStore = createTeamLayoutStore({ storage });
  assert.equal(presentationStore.getState().preferredWidth, 320);

  // Only an explicit user resize writes the app-wide preference. Resolving a
  // collapsed/clamped presentation cannot consume it.
  presentationStore.getState().setPreferredWidth(420);
  assert.equal(presentationStore.getState().preferredWidth, 420);
  assert.deepEqual(writes, [[TEAM_PANEL_WIDTH_STORAGE_KEY, "420"]]);
  assert.equal(resolveTeamLayout(716, 420).presentation, "inline");
  assert.equal(resolveTeamLayout(716, 420).conversationWidth, 450);
  for (const width of [715, 500]) {
    const layout = resolveTeamLayout(width, 420);
    assert.equal(layout.presentation, "rail");
    assert.equal(layout.panelWidth, 44);
    assert.ok(layout.conversationWidth >= 450);
  }
  assert.equal(resolveTeamLayout(499, 420).presentation, "hidden");
  assert.equal(resolveTeamLayout(499, 420).overlay, true);
  assert.equal(presentationStore.getState().preferredWidth, 420);
  assert.equal(writes.length, 1);

  presentationStore.getState().openOverlay("local");
  presentationStore.getState().setPresentation("local", "rail");
  assert.equal(presentationStore.getState().overlaySessionId, "local");
  presentationStore.getState().setPresentation("local", "inline");
  assert.equal(presentationStore.getState().overlaySessionId, null);

  presentationStore.getState().openOverlay("local");
  presentationStore.getState().setPresentation("other", "hidden");
  assert.equal(
    presentationStore.getState().overlaySessionId,
    null,
    "a session switch closes the old drawer",
  );
  presentationStore.getState().openOverlay("local");
  presentationStore.getState().closeOverlay("other");
  assert.equal(presentationStore.getState().overlaySessionId, "local");
  presentationStore.getState().closeOverlay("local");
  assert.equal(presentationStore.getState().overlaySessionId, null);

  const local = { id: "local", source: "desktop" };
  const enabled = {
    sessionId: local.id,
    enabled: true,
    members: [],
    revision: 3,
  };
  const configStore = createTeamStore();
  configStore.setState({ sessions: { local: sessionState(enabled) } });
  presentationStore.getState().openOverlay(local.id);
  const toggleCalls = [];
  const service = {
    async toggle(session) {
      toggleCalls.push(session.id);
      return { ...enabled, enabled: false, revision: 4 };
    },
  };
  const errors = [];
  const toggled = await toggleTeamSessionMode(
    local,
    (error) => errors.push(error),
    { service, configStore, layoutStore: presentationStore },
  );
  assert.equal(toggled.enabled, false);
  assert.deepEqual(toggleCalls, [local.id]);
  assert.equal(
    presentationStore.getState().overlaySessionId,
    null,
    "disabling Team mode closes its drawer independently of reveal",
  );
  assert.deepEqual(errors, []);

  for (const ineligible of [
    { id: "remote:one", source: "desktop" },
    { id: "ordinary-remote", source: "remote" },
    { id: "native-pi:one", source: "desktop" },
    { id: "ordinary-native", source: "pi-native" },
  ]) {
    assert.equal(
      await toggleTeamSessionMode(
        ineligible,
        (error) => errors.push(error),
        { service, configStore, layoutStore: presentationStore },
      ),
      null,
    );
  }
  assert.deepEqual(toggleCalls, [local.id], "ineligible sessions never reach the service");

  const failure = new Error("host unavailable");
  assert.equal(
    await toggleTeamSessionMode(
      local,
      (error) => errors.push(error),
      {
        service: { async toggle() { throw failure; } },
        configStore,
        layoutStore: presentationStore,
      },
    ),
    null,
  );
  assert.deepEqual(errors, [failure], "the shared action reports the real service failure");

  teamStore.setState({ sessions: { local: sessionState(enabled) } });
  teamLayoutStore.setState({
    presentation: { sessionId: local.id, presentation: "rail" },
    overlaySessionId: null,
  });
  const renderTopbar = (session) => {
    Object.assign(useAppStore.getInitialState(), {
      activeSessionId: session?.id ?? null,
      sessions: session ? [session] : [],
      workspace: { path: "/workspace", name: "Workspace" },
      projectMeta: {},
      settings: { keybindings: {} },
    });
    return ssr.render(createElement(ConversationTopbar, topbarProps), {
      sessionId: null,
    });
  };

  const localHtml = renderTopbar({ ...local, title: "Local task" });
  // SSR reads the store's initial snapshot, so this proves the eligible control
  // and its accessible name; enabled/reveal behavior is covered by the store
  // assertions above.
  assert.match(localHtml, /aria-pressed="false"[^>]*class="ct-icon-btn ct-team-mode"[^>]*aria-label="Toggle Team mode"/);

  teamLayoutStore.setState({
    presentation: { sessionId: local.id, presentation: "inline" },
    overlaySessionId: null,
  });
  const inlineHtml = renderTopbar({ ...local, title: "Local task" });
  assert.match(inlineHtml, /ct-team-mode/);
  assert.doesNotMatch(inlineHtml, /ct-team-reveal/);

  for (const ineligible of [
    { id: "remote:one", source: "remote", title: "Remote task" },
    { id: "native-pi:one", source: "pi-native", title: "Native task" },
  ]) {
    const html = renderTopbar(ineligible);
    assert.doesNotMatch(html, /ct-team-mode|ct-team-reveal/);
  }
});
