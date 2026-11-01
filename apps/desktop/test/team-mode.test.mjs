import assert from "node:assert/strict";
import test from "node:test";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * The Team switch shared by the composer's mode menu and the `toggleTeamMode`
 * shortcut: who is offered it, what it asks of the composer dock, and what a
 * draft does with it. The modules load through one Vite SSR graph, so the
 * `team-mode` and dock-reveal instances read here are the ones the production
 * code shares.
 */

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const config = (enabled) => ({ enabled, revision: 1, members: [] });
const draft = (overrides = {}) => ({
  activeSessionId: null,
  session: undefined,
  remoteProject: false,
  workspacePath: null,
  listedSessionIds: new Set(),
  ...overrides,
});
const collect = () => {
  const errors = [];
  return { errors, onError: (error) => errors.push(error) };
};

test("the Team switch", async (t) => {
  const ssr = await slotSsr(t);
  const mode = await ssr.load("/src/features/team/team-mode.ts");
  const { createTeamStore, EMPTY_TEAM_SESSION_STATE } = await ssr.load(
    "/src/features/team/team-store.ts",
  );
  const reveal = await ssr.load("/src/features/chat/background-tasks/dock-reveal.ts");
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");

  await t.test("Team is offered for local conversations and local drafts only", () => {
    const { teamAvailability } = mode;
    assert.equal(teamAvailability(draft()), "available", "a local draft");
    assert.equal(teamAvailability(draft({ remoteProject: true })), "hidden", "a draft in a remote project");
    const listed = (session) =>
      teamAvailability(draft({ activeSessionId: session.id, session }));
    assert.equal(listed({ id: "s1" }), "available", "a local session");
    assert.equal(listed({ id: "r1", source: "remote" }), "hidden", "a remote session");
    assert.equal(listed({ id: "n1", source: "pi-native" }), "hidden", "a Native Pi session");
    // A session the list does not have yet can only be judged by its id.
    assert.equal(teamAvailability(draft({ activeSessionId: "s2" })), "available");
    assert.equal(teamAvailability(draft({ activeSessionId: "remote:s3" })), "hidden");
    assert.equal(teamAvailability(draft({ activeSessionId: "native-pi:s4" })), "hidden");
  });

  await t.test("the snapshot reads the conversation on screen", () => {
    const state = useAppStore.getState();
    const before = {
      activeSessionId: state.activeSessionId,
      sessions: state.sessions,
      workspace: state.workspace,
    };
    try {
      useAppStore.setState({ activeSessionId: null, sessions: [], workspace: null });
      assert.deepEqual(mode.readTeamModeSnapshot(), draft());
      useAppStore.setState({
        workspace: { path: "/srv/remote-project", remote: { hostKey: "host-1" } },
      });
      assert.equal(mode.readTeamModeSnapshot().remoteProject, true, "a remote project");
      assert.equal(mode.readTeamModeSnapshot().workspacePath, "/srv/remote-project", "the project path");
      useAppStore.setState({
        activeSessionId: "s-live",
        sessions: [{ id: "s-live" }],
        workspace: null,
      });
      assert.deepEqual(mode.readTeamModeSnapshot(), {
        activeSessionId: "s-live",
        session: { id: "s-live" },
        remoteProject: false,
        workspacePath: null,
        listedSessionIds: new Set(["s-live"]),
      });
    } finally {
      useAppStore.setState(before);
    }
  });

  await t.test("switching Team on asks the dock to open before the host answers", async () => {
    const requests = [];
    const stop = reveal.subscribeDockReveal(() => requests.push("request"));
    try {
      const answer = deferred();
      const { errors, onError } = collect();
      const pending = mode.toggleTeamSessionMode({ id: "s-on" }, onError, {
        service: { toggle: () => answer.promise },
        configStore: createTeamStore(),
      });
      assert.equal(requests.length, 1, "asked while the host is still answering");
      answer.resolve(config(true));
      assert.equal((await pending).enabled, true);
      assert.equal(reveal.takeDockReveal("s-on"), true, "a successful switch leaves the request for the dock");
      assert.deepEqual(errors, []);
    } finally {
      stop();
    }
  });

  await t.test("switching Team off withdraws a pending request at once", async () => {
    const id = "s-off";
    const configStore = createTeamStore();
    configStore.setState({
      sessions: { [id]: { ...EMPTY_TEAM_SESSION_STATE, config: config(true) } },
    });
    reveal.requestDockReveal(id);
    const answer = deferred();
    const { errors, onError } = collect();
    const pending = mode.toggleTeamSessionMode({ id }, onError, {
      service: { toggle: () => answer.promise },
      configStore,
    });
    assert.equal(reveal.takeDockReveal(id), false, "nothing is left for the dock to take");
    answer.resolve(config(false));
    assert.equal((await pending).enabled, false);
    assert.equal(reveal.takeDockReveal(id), false);
    assert.deepEqual(errors, []);
  });

  await t.test("a host that answers Team off withdraws the request", async () => {
    const { errors, onError } = collect();
    const result = await mode.toggleTeamSessionMode({ id: "s-refused" }, onError, {
      service: { toggle: async () => config(false) },
      configStore: createTeamStore(),
    });
    assert.equal(result.enabled, false);
    assert.equal(reveal.takeDockReveal("s-refused"), false);
    assert.deepEqual(errors, []);
  });

  await t.test("a failed switch reports the error and withdraws the request", async () => {
    const failure = new Error("host down");
    const { errors, onError } = collect();
    const result = await mode.toggleTeamSessionMode({ id: "s-failed" }, onError, {
      service: {
        toggle: async () => {
          throw failure;
        },
      },
      configStore: createTeamStore(),
    });
    assert.equal(result, null);
    assert.deepEqual(errors, [failure]);
    assert.equal(reveal.takeDockReveal("s-failed"), false);
  });

  await t.test("a remote or missing session is a no-op", async () => {
    const service = {
      toggle: async () => {
        throw new Error("an ineligible session must not reach the host");
      },
    };
    const { errors, onError } = collect();
    const dependencies = { service, configStore: createTeamStore() };
    assert.equal(
      await mode.toggleTeamSessionMode({ id: "remote:x", source: "remote" }, onError, dependencies),
      null,
    );
    assert.equal(await mode.toggleTeamSessionMode(undefined, onError, dependencies), null);
    assert.equal(reveal.takeDockReveal("remote:x"), false);
    assert.deepEqual(errors, []);
  });

  await t.test("with a session on screen the shortcut switches that session", async () => {
    const toggled = [];
    const service = {
      toggle: async (session) => {
        toggled.push(session.id);
        return config(true);
      },
      setEnabled: async () => {
        throw new Error("only a draft is switched on explicitly");
      },
    };
    const materializeDraft = async () => {
      throw new Error("a session exists, nothing is created");
    };
    const { errors, onError } = collect();
    const run = (snapshot) =>
      mode.toggleActiveTeamMode(onError, {
        service,
        configStore: createTeamStore(),
        snapshot: () => snapshot,
        materializeDraft,
      });
    await run(draft({ activeSessionId: "s-live", session: { id: "s-live" } }));
    await run(draft({ activeSessionId: "s-unlisted" }));
    assert.deepEqual(toggled, ["s-live", "s-unlisted"]);
    assert.equal(
      await run(draft({
        activeSessionId: "remote:s",
        session: { id: "remote:s", source: "remote" },
      })),
      null,
      "a remote session is not switched",
    );
    assert.deepEqual(toggled, ["s-live", "s-unlisted"]);
    assert.deepEqual(errors, []);
  });

  await t.test("choosing Team in a draft creates the session once, then switches Team on", async () => {
    const created = deferred();
    const writes = [];
    let materialized = 0;
    const requests = [];
    const stop = reveal.subscribeDockReveal(() => requests.push("request"));
    try {
      const { errors, onError } = collect();
      const dependencies = {
        service: {
          toggle: async () => {
            throw new Error("a draft is never toggled");
          },
          setEnabled: async (session, enabled) => {
            writes.push([session.id, enabled]);
            return config(enabled);
          },
        },
        configStore: createTeamStore(),
        snapshot: () => draft(),
        materializeDraft: () => {
          materialized += 1;
          return created.promise;
        },
        findSession: () => undefined,
      };
      const first = mode.toggleActiveTeamMode(onError, dependencies);
      const second = mode.toggleActiveTeamMode(onError, dependencies);
      assert.equal(second, first, "a second choice joins the creation in flight");
      assert.equal(materialized, 1);
      assert.equal(requests.length, 0, "no dock request before the session exists");
      created.resolve("s-new");
      assert.equal((await first).enabled, true);
      assert.deepEqual(writes, [["s-new", true]]);
      assert.equal(reveal.takeDockReveal("s-new"), true, "the dock is asked to open on the new session");
      assert.deepEqual(errors, []);

      // A finished creation does not swallow the next choice.
      created.promise.then(() => undefined);
      await mode.toggleActiveTeamMode(onError, {
        ...dependencies,
        materializeDraft: async () => {
          materialized += 1;
          return "s-next";
        },
      });
      assert.equal(materialized, 2);
      assert.deepEqual(writes, [["s-new", true], ["s-next", true]]);
    } finally {
      stop();
      reveal.clearDockReveal("s-next");
    }
  });

  await t.test("a creation that ends on a conversation the list already held leaves Team alone", async () => {
    // A creation already under way ends on whichever session is on screen. When the
    // user moved to an existing conversation meanwhile, that is not the draft's session.
    const writes = [];
    const { errors, onError } = collect();
    const result = await mode.toggleActiveTeamMode(onError, {
      service: {
        setEnabled: async (session) => {
          writes.push(session.id);
          return config(true);
        },
      },
      configStore: createTeamStore(),
      snapshot: () => draft({ listedSessionIds: new Set(["s-existing"]) }),
      materializeDraft: async () => "s-existing",
    });
    assert.equal(result, null);
    assert.deepEqual(writes, []);
    assert.equal(reveal.takeDockReveal("s-existing"), false);
    assert.deepEqual(errors, []);
  });

  await t.test("the drafts of two projects each create their own session", async () => {
    const writes = [];
    const { errors, onError } = collect();
    const dependenciesFor = (workspacePath, created) => ({
      service: {
        setEnabled: async (session, enabled) => {
          writes.push([session.id, enabled]);
          return config(enabled);
        },
      },
      configStore: createTeamStore(),
      snapshot: () => draft({ workspacePath }),
      materializeDraft: () => created.promise,
      findSession: () => undefined,
    });
    const createdA = deferred();
    const createdB = deferred();
    const a = mode.toggleActiveTeamMode(onError, dependenciesFor("/work/a", createdA));
    const b = mode.toggleActiveTeamMode(onError, dependenciesFor("/work/b", createdB));
    assert.notEqual(b, a, "the draft of another project does not join the creation of the first");
    // A repeated choice in the first project still joins its own creation.
    assert.equal(mode.toggleActiveTeamMode(onError, dependenciesFor("/work/a", createdA)), a);
    createdA.resolve("s-a");
    createdB.resolve("s-b");
    assert.equal((await a).enabled, true);
    assert.equal((await b).enabled, true);
    assert.deepEqual(
      writes.sort((left, right) => left[0].localeCompare(right[0])),
      [["s-a", true], ["s-b", true]],
    );
    assert.deepEqual(errors, []);
    reveal.clearDockReveal("s-a");
    reveal.clearDockReveal("s-b");
  });

  await t.test("a draft in a remote project is not turned into a session", async () => {
    const { errors, onError } = collect();
    const result = await mode.toggleActiveTeamMode(onError, {
      service: {
        setEnabled: async () => {
          throw new Error("nothing to switch");
        },
      },
      configStore: createTeamStore(),
      snapshot: () => draft({ remoteProject: true }),
      materializeDraft: async () => {
        throw new Error("a remote draft must not create a local session");
      },
    });
    assert.equal(result, null);
    assert.deepEqual(errors, []);
  });

  await t.test("leaving the draft while the session is created leaves Team untouched", async () => {
    const writes = [];
    const { errors, onError } = collect();
    const result = await mode.toggleActiveTeamMode(onError, {
      service: {
        setEnabled: async (session) => {
          writes.push(session.id);
          return config(true);
        },
      },
      configStore: createTeamStore(),
      snapshot: () => draft(),
      materializeDraft: async () => null,
    });
    assert.equal(result, null);
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
  });

  await t.test("a session that cannot run Team is left alone", async () => {
    const writes = [];
    const { errors, onError } = collect();
    const result = await mode.toggleActiveTeamMode(onError, {
      service: {
        setEnabled: async (session) => {
          writes.push(session.id);
          return config(true);
        },
      },
      configStore: createTeamStore(),
      snapshot: () => draft(),
      materializeDraft: async () => "native-pi:created",
      findSession: (id) => ({ id, source: "pi-native" }),
    });
    assert.equal(result, null);
    assert.deepEqual(writes, []);
    assert.equal(reveal.takeDockReveal("native-pi:created"), false);
    assert.deepEqual(errors, []);
  });

  await t.test("a failed creation reports the error and writes nothing", async () => {
    const failure = new Error("could not create the session");
    const writes = [];
    const { errors, onError } = collect();
    const result = await mode.toggleActiveTeamMode(onError, {
      service: {
        setEnabled: async (session) => {
          writes.push(session.id);
          return config(true);
        },
      },
      configStore: createTeamStore(),
      snapshot: () => draft(),
      materializeDraft: async () => {
        throw failure;
      },
    });
    assert.equal(result, null);
    assert.deepEqual(errors, [failure]);
    assert.deepEqual(writes, []);
  });

  await t.test("a failed Team write keeps the new session and withdraws the dock request", async () => {
    const failure = new Error("could not store Team");
    const { errors, onError } = collect();
    const result = await mode.toggleActiveTeamMode(onError, {
      service: {
        setEnabled: async () => {
          throw failure;
        },
      },
      configStore: createTeamStore(),
      snapshot: () => draft(),
      materializeDraft: async () => "s-kept",
    });
    assert.equal(result, null);
    assert.deepEqual(errors, [failure]);
    assert.equal(reveal.takeDockReveal("s-kept"), false);
  });
});
