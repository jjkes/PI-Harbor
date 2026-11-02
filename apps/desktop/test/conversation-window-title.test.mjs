import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const UNTITLED = "Untitled task";

/**
 * The crumb derivation and the window-title write are plain modules, so this
 * suite loads them directly instead of rendering the topbar: an SSR render
 * never runs the effect that names the window.
 */
async function withTitleModules(work) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const title = await server.ssrLoadModule("/src/lib/conversation-title.ts");
    const windowTitle = await server.ssrLoadModule("/src/hooks/use-window-title.ts");
    return await work({ ...title, ...windowTitle });
  } finally {
    await server.close();
  }
}

test("the conversation crumb names the project, its workspace, and the task", async () => {
  await withTitleModules(({ conversationTitleParts }) => {
    const parts = (input) =>
      conversationTitleParts({
        projectMeta: {},
        workspaceName: null,
        untitledTask: UNTITLED,
        ...input,
      });

    /* A workspace session names both the project and the workspace it runs in. */
    assert.deepEqual(
      parts({
        session: {
          id: "s1",
          title: "Fix the parser",
          projectPath: "/dev/project",
          workspaceId: "ws-1",
        },
        projectMeta: { "/dev/project": { name: "Project" } },
        workspaceName: "Workspace",
      }),
      {
        project: "Project",
        workspaceName: "Workspace",
        taskTitle: "Fix the parser",
        crumb: "Project / Workspace",
        breadcrumbTitle: "Project / Workspace · Fix the parser",
      },
    );

    /* A project session has no workspace segment. */
    assert.equal(
      parts({
        session: { id: "s2", title: "Fix the parser", projectPath: "/dev/project" },
        projectMeta: { "/dev/project": { name: "Project" } },
      }).breadcrumbTitle,
      "Project · Fix the parser",
    );

    /* No display name: the project directory's own last segment names it. */
    assert.equal(
      parts({
        session: { id: "s3", title: "Fix the parser", projectPath: "/dev/parser-work" },
      }).breadcrumbTitle,
      "parser-work · Fix the parser",
    );

    /* A session with no project at all is just its task. */
    assert.deepEqual(
      parts({ session: { id: "s4", title: "Scratch pad" } }),
      {
        project: null,
        workspaceName: null,
        taskTitle: "Scratch pad",
        crumb: null,
        breadcrumbTitle: "Scratch pad",
      },
    );

    /* A remote session carries its display-only label, never a local path. */
    assert.equal(
      parts({
        session: {
          id: "remote:host/1",
          title: "Remote build",
          source: "remote",
          remoteHostKey: "host",
          remoteWorkspaceLabel: "Remote project",
          projectPath: "/should/not/be/read",
        },
        projectMeta: { "/should/not/be/read": { name: "Leaked" } },
      }).breadcrumbTitle,
      "Remote project · Remote build",
    );

    /* A host-generated placeholder title is replaced by the localized one. */
    for (const title of ["New task", "New chat", "新建任务", "新对话", "   ", ""]) {
      assert.equal(
        parts({ session: { id: "s5", title, projectPath: "/dev/project" } }).breadcrumbTitle,
        `project · ${UNTITLED}`,
        `"${title}" is a default title, not a real one`,
      );
    }

    /* Before the first prompt there is no session: the active workspace names
       an unscoped draft, which has no workspace segment. */
    assert.deepEqual(
      parts({
        session: null,
        workspace: { path: "/dev/project", name: "Project" },
      }),
      {
        project: "Project",
        workspaceName: null,
        taskTitle: UNTITLED,
        crumb: "Project",
        breadcrumbTitle: `Project · ${UNTITLED}`,
      },
    );

    /* A draft scoped to a workspace shows the same crumb before it has a
       session, so the destination is visible before the first prompt. */
    assert.equal(
      parts({
        session: null,
        workspace: { path: "/dev/project", name: "Project" },
        workspaceName: "Workspace",
      }).crumb,
      "Project / Workspace",
    );

    /* A workspace segment has nothing to qualify without a project, so it is
       dropped rather than shown on its own. */
    assert.deepEqual(
      parts({
        session: { id: "s6", title: "Scratch pad" },
        workspaceName: "Workspace",
      }),
      {
        project: null,
        workspaceName: null,
        taskTitle: "Scratch pad",
        crumb: null,
        breadcrumbTitle: "Scratch pad",
      },
    );
  });
});

test("the window title appends the app name and is restored without a conversation", async () => {
  await withTitleModules(({ conversationWindowTitle, applyWindowTitle }) => {
    const appName = "PI-Harbor Desktop";

    assert.equal(
      conversationWindowTitle("Project / Workspace · Fix the parser", appName),
      "Project / Workspace · Fix the parser — PI-Harbor Desktop",
    );
    /* No conversation: the window keeps the app's own default title. */
    assert.equal(conversationWindowTitle(null, appName), appName);
    assert.equal(conversationWindowTitle("", appName), appName);

    /* The default title is captured from the document, never hard-coded. */
    const doc = { title: appName };
    const restore = applyWindowTitle(doc, "Project · Fix the parser", doc.title);
    assert.equal(doc.title, "Project · Fix the parser — PI-Harbor Desktop");
    restore();
    assert.equal(doc.title, appName, "unmounting restores the previous title");

    /* A document whose default differs is restored to its own default. */
    const other = { title: "Another Name" };
    applyWindowTitle(other, "Project · Fix the parser", other.title)();
    assert.equal(other.title, "Another Name");
  });
});
