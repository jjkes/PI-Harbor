import {
  readStoreModuleSync,
  readMainSourceSync,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { catalogs, flattenCatalog } from "@pi-harbor/i18n";
import {
  latestSessionOutcomes,
  SIDEBAR_SESSION_STATUS_LABEL_KEYS,
  sidebarSessionStatus,
} from "../src/lib/sidebar-session-status.ts";
import { loadStylesSync } from "./helpers/styles.mjs";

function notification(overrides) {
  return {
    id: "notification-1",
    kind: "task.completed",
    sessionId: "session-1",
    sessionTitle: "Session",
    turnId: "turn-1",
    createdAt: "2026-07-27T10:00:00.000Z",
    readAt: null,
    ...overrides,
  };
}

test("keeps the newest unread completed or failed outcome for each session", () => {
  const outcomes = latestSessionOutcomes([
    notification({ id: "latest", kind: "task.completed" }),
    notification({ id: "older", kind: "task.failed" }),
    notification({
      id: "other",
      kind: "task.failed",
      sessionId: "session-2",
    }),
  ]);

  assert.deepEqual(outcomes, {
    "session-1": "completed",
    "session-2": "failed",
  });
});

test("read task notifications leave no sidebar indicator", () => {
  const outcomes = latestSessionOutcomes([
    notification({ id: "latest", readAt: "2026-07-27T10:05:00.000Z" }),
    notification({ id: "older", kind: "task.failed" }),
  ]);

  assert.deepEqual(outcomes, {});
});

test("prioritizes in-progress and selected states over terminal outcomes", () => {
  assert.equal(
    sidebarSessionStatus({ running: true, selected: true, outcome: "failed" }),
    "running",
  );
  assert.equal(
    sidebarSessionStatus({ running: false, selected: true, outcome: "failed" }),
    "selected",
  );
  assert.equal(
    sidebarSessionStatus({ running: false, selected: false, outcome: "completed" }),
    "completed",
  );
  assert.equal(sidebarSessionStatus({ running: false, selected: false }), null);
});

test("a session that needs the user outranks work, selection, and outcomes", () => {
  const idle = { running: false, selected: false };
  assert.equal(sidebarSessionStatus({ ...idle, awaitingInput: true }), "input");
  assert.equal(
    sidebarSessionStatus({ running: true, selected: true, outcome: "completed", awaitingInput: true }),
    "input",
  );
  assert.equal(
    sidebarSessionStatus({ ...idle, outcome: "failed", awaitingInput: true }),
    "input",
  );
  assert.equal(
    sidebarSessionStatus({ running: true, selected: true, hasPendingPermission: true, awaitingInput: true }),
    "permission",
  );
});

test("every indicator has a localized accessible label in every catalog", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    for (const [status, key] of Object.entries(SIDEBAR_SESSION_STATUS_LABEL_KEYS)) {
      assert.equal(typeof flat[key], "string", `${locale}: ${status} label ${key}`);
      assert.ok(flat[key].trim(), `${locale}: ${status} label ${key} must not be blank`);
    }
  }
  assert.equal(flattenCatalog(catalogs.en)["nav.sessionInput"], "Waiting for your input");
  assert.equal(flattenCatalog(catalogs.en)["nav.sessionPermission"], "Permission required");
});

test("opening a conversation acknowledges its outcome badge before loading details", () => {
  const sessionSource = readStoreModuleSync("slices/session-slice.ts");
  const catalogSource = readStoreModuleSync("slices/catalog-slice.ts");
  const selectBlock = sessionSource.match(/selectSession: async[\s\S]*?\n    newSession:/)?.[0] ?? "";
  const acknowledgementStart = selectBlock.indexOf(
    "const outcomeAcknowledgement = get().acknowledgeSessionOutcome(id);",
  );
  const detailLoadStart = selectBlock.indexOf(
    "const detailPromise = runtime.loadSessionDetail(id",
  );
  assert.ok(acknowledgementStart >= 0);
  assert.ok(detailLoadStart >= 0);
  assert.ok(
    acknowledgementStart < detailLoadStart,
    "session outcome acknowledgement must start before detail loading",
  );
  assert.match(selectBlock, /await outcomeAcknowledgement/);

  const ackBlock = catalogSource.slice(
    catalogSource.indexOf("acknowledgeSessionOutcome: async"),
  );
  assert.match(ackBlock, /withoutRecordKey\(state\.sessionOutcomes, sessionId\)/);
  assert.match(ackBlock, /markNotificationRead\(item\.id\)/);
});

test("renders semantic, shape-distinct sidebar status indicators", () => {
  const sidebar = fs.readFileSync(
    new URL("../src/components/Sidebar.tsx", import.meta.url),
    "utf8",
  );
  const styles = loadStylesSync();
  // The status fixture lives in the capture rig, which App only loads lazily
  // behind __PI_CAPTURE__.
  const app = fs.readFileSync(
    new URL("../src/capture/capture-rig.ts", import.meta.url),
    "utf8",
  );
  const main = readMainSourceSync();

  // Labels resolve through the status map, whose keys are checked against
  // every catalog above; only the failed state draws a glyph.
  assert.match(sidebar, /t\(SIDEBAR_SESSION_STATUS_LABEL_KEYS\[status\]\)/);
  const renderStatus = sidebar.slice(
    sidebar.indexOf("const renderSessionStatus"),
    sidebar.indexOf("const reportError"),
  );
  assert.match(renderStatus, /status === "failed" \? <IconCircleAlert/);
  assert.doesNotMatch(renderStatus, /IconCheck/, "completed is a dot, not a check mark");
  assert.match(styles, /thread-item-status\.running::before[\s\S]*--ds-warning/);
  assert.match(styles, /thread-item-status\.selected::before[\s\S]*--ds-accent/);
  assert.match(styles, /thread-item-status\.completed::before \{[^}]*background: var\(--ds-success\)/);
  assert.doesNotMatch(styles, /thread-item-status\.completed svg/);
  assert.match(styles, /thread-item-status\.permission::before \{[^}]*background: var\(--ds-purple\)/);
  assert.match(styles, /thread-item-status\.input::before \{[^}]*background: var\(--ds-purple\)/);
  assert.match(styles, /thread-item-status\.failed[\s\S]*--ds-error/);
  assert.match(
    styles,
    /prefers-reduced-motion: reduce[\s\S]*thread-item-status\.running::before[\s\S]*animation: none/,
  );
  assert.match(
    app,
    /seedSidebarStatuses[\s\S]*runningSessions[\s\S]*sessionOutcomes/,
  );
  assert.match(
    main,
    /PI_HARBOR_CAPTURE_STATUS_ONLY[\s\S]*prefers-reduced-motion[\s\S]*SIDEBAR_STATUS_PROBE[\s\S]*pi-sidebar-status-/,
  );
});
