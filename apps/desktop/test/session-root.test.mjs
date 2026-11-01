import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { assertSingleSessionBinding, resolveBoundSessionRoot, resolveSessionFileRoot } = await import(
  "../electron/main/session-root.ts"
);

/** A host double that answers only the methods a case expects. */
function fakeHost(replies) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (!(method in replies)) throw new Error(`unexpected host call ${method}`);
      const reply = replies[method];
      if (reply instanceof Error) throw reply;
      return typeof reply === "function" ? reply(params) : reply;
    },
  };
}

function codedError(message, errorCode) {
  return Object.assign(new Error(message), { errorCode });
}

test("an unbound session has no bound root and asks the host nothing", async () => {
  const host = fakeHost({});
  assert.equal(await resolveBoundSessionRoot(host, "s1", { workspaceId: "  " }), undefined);
  assert.equal(await resolveBoundSessionRoot(host, "s1", null), undefined);
  assert.deepEqual(host.calls, []);
});

test("an isolated session resolves through worktree.location", async () => {
  const host = fakeHost({ "worktree.location": { path: "/data/worktrees/p/abc" } });
  const root = await resolveBoundSessionRoot(host, "s1", { worktree: { branch: "pi-harbor/abc" } });
  assert.equal(root, "/data/worktrees/p/abc");
  assert.deepEqual(host.calls, [{ method: "worktree.location", params: { sessionId: "s1" } }]);
});

test("a workspace session resolves through projectWorkspace.location by session id", async () => {
  const host = fakeHost({ "projectWorkspace.location": { path: "/repo/.pi/worktree/feat" } });
  const root = await resolveBoundSessionRoot(host, "s2", { workspaceId: "w1" });
  assert.equal(root, "/repo/.pi/worktree/feat");
  // Main names the session; host-core derives the path from its own binding.
  assert.deepEqual(host.calls, [{ method: "projectWorkspace.location", params: { sessionId: "s2" } }]);
});

test("a workspace session never falls back to the project root", async () => {
  const empty = fakeHost({ "projectWorkspace.location": { path: "  " } });
  await assert.rejects(
    resolveBoundSessionRoot(empty, "s2", { workspaceId: "w1" }),
    (error) => error.errorCode === "WORKSPACE_MISSING",
  );

  const missing = fakeHost({
    "session.get": { session: { projectPath: "/repo", workspaceId: "w1" } },
    "projectWorkspace.location": codedError("the folder is gone", "WORKSPACE_MISSING"),
  });
  await assert.rejects(
    resolveSessionFileRoot(missing, "s2"),
    (error) => error.errorCode === "WORKSPACE_MISSING",
  );
});

test("a record bound to both a worktree and a workspace is refused before any lookup", async () => {
  const host = fakeHost({});
  await assert.rejects(
    resolveBoundSessionRoot(host, "s3", { worktree: { branch: "b" }, workspaceId: "w1" }),
    (error) => error.errorCode === "WORKSPACE_ISOLATED_CONFLICT",
  );
  assert.throws(
    () => assertSingleSessionBinding("s3", { worktree: {}, workspaceId: "w1" }),
    (error) => error.errorCode === "WORKSPACE_ISOLATED_CONFLICT",
  );
  assert.deepEqual(host.calls, []);
});

test("resolveSessionFileRoot uses the project path only for an unbound session", async () => {
  const unbound = fakeHost({ "session.get": { session: { projectPath: " /repo " } } });
  assert.equal(await resolveSessionFileRoot(unbound, "s4"), "/repo");

  const bound = fakeHost({
    "session.get": { session: { projectPath: "/repo", workspaceId: "w1" } },
    "projectWorkspace.location": { path: "/repo/.pi/worktree/feat" },
  });
  assert.equal(await resolveSessionFileRoot(bound, "s5"), "/repo/.pi/worktree/feat");

  const gone = fakeHost({ "session.get": { session: null } });
  assert.equal(await resolveSessionFileRoot(gone, "s6"), null);
});
