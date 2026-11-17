/**
 * Session token usage is no longer a second toolbar control: its ledger lives
 * inside the context inspector, which is the one token surface beside the
 * composer, and it stays a session aggregate rather than a turn one.
 */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const LOCALES = ["en", "zh-CN", "zh-TW", "tr", "de", "es", "fr", "ko", "pt-BR"];

const [toolbar, composer, inspector, messagesCss, globals, spec, ...catalogs] =
  await Promise.all([
    read("../src/features/chat/composer/ComposerToolbar.tsx"),
    read("../src/components/Composer.tsx"),
    read("../src/components/ContextUsageInspector.tsx"),
    read("../src/styles/messages.css"),
    read("../src/styles/globals.css"),
    read("../../../docs/spec/04-ux/08-component-spec.md"),
    ...LOCALES.map((locale) =>
      read(`../../../packages/i18n/src/locales/${locale}/index.ts`),
    ),
  ]);

test("the composer toolbar no longer hosts a separate token entry", () => {
  assert.match(
    composer,
    /const sessionTokenUsage = useSessionTokenUsage\(\s*activeSessionId,\s*liveMessages,/,
  );
  assert.match(composer, /sessionUsage=\{sessionTokenUsage \?\? null\}/);
  // The pill, its stylesheet, and its trigger are gone from the toolbar.
  assert.doesNotMatch(toolbar, /SessionTokenUsagePanel/);
  // The inspector is the one token surface in the right-hand cluster.
  const rightCluster = toolbar.indexOf('<div className="composer-right">');
  const inspectorEntry = toolbar.indexOf("<ContextUsageInspector");
  assert.ok(rightCluster > -1, "the right-hand cluster still exists");
  assert.ok(inspectorEntry > rightCluster, "the inspector renders in composer-right");
  assert.ok(
    inspectorEntry < toolbar.indexOf("<ComposerModelPicker"),
    "the inspector precedes the model picker",
  );
  // The pill's own markup and classes are gone, not just its component.
  assert.doesNotMatch(toolbar, /session-token-usage-(trigger|panel)/);
  assert.match(toolbar, /sessionUsage=\{sessionTokenUsage \?\? undefined\}/);
});

test("the token ledger moved into the context inspector, split into scopes", () => {
  for (const key of [
    "sessionTokenUsage",
    "sessionTokenUsageMain",
    "sessionTokenUsageSubagents",
    "sessionTokenUsageTotal",
    "sessionTokenUsageInput",
    "sessionTokenUsageOutput",
    "sessionTokenUsageCacheRead",
    "sessionTokenUsageCacheWrite",
    "sessionTokenUsageReasoning",
    "sessionTokenUsageDelegations",
    "sessionTokenUsageCalls",
    "sessionTokenUsageSessionTotal",
  ]) {
    assert.ok(
      inspector.includes(`chat.${key}`),
      `the inspector reads chat.${key} from the catalog`,
    );
  }
  assert.match(inspector, /<UsageScopeBlock/);
  assert.match(inspector, /className="context-inspector-usage"/);
  // A session that never delegated shows no empty team block.
  assert.match(inspector, /sessionUsage\.subagents\.totalTokens > 0 \?/);
  // The viewer action is still the panel's only control.
  assert.match(inspector, /chat\.sessionContextOpen/);
  // Every visible string comes from the catalog.
  assert.doesNotMatch(inspector, />[A-Za-z][A-Za-z ]{3,}</);
});

test("the inspector no longer renders a generation-speed KPI", () => {
  assert.doesNotMatch(inspector, /usageThroughput/);
  // What the inspector still owns: occupancy, timing, and provider usage.
  for (const key of [
    "usageContextWindow",
    "usageSessionTime",
    "usageProviderUsage",
    "usageCacheRate",
  ]) {
    assert.ok(
      inspector.includes(`chat.${key}`),
      `the inspector keeps chat.${key}`,
    );
  }
});

test("the deleted token panel and its stylesheet are gone", async () => {
  await assert.rejects(
    () =>
      access(
        new URL("../src/components/SessionTokenUsagePanel.tsx", import.meta.url),
        constants.F_OK,
      ),
    { code: "ENOENT" },
  );
  await assert.rejects(
    () =>
      access(
        new URL(
          "../src/styles/components/session-token-usage.css",
          import.meta.url,
        ),
        constants.F_OK,
      ),
    { code: "ENOENT" },
  );
  assert.doesNotMatch(globals, /session-token-usage\.css/);
  assert.match(messagesCss, /\.context-inspector-usage \{/);
});

test("every locale carries the session usage ledger and drops the pill label", () => {
  const keysOf = (catalog) =>
    new Set(
      [...catalog.matchAll(/(?:^|\s)"?(sessionTokenUsage[A-Za-z]*)"?\s*:/g)].map(
        (match) => match[1],
      ),
    );
  const reference = keysOf(catalogs[0]);
  assert.equal(reference.size, 12, "the English catalog defines 12 keys");

  LOCALES.forEach((locale, index) => {
    assert.deepEqual(
      [...keysOf(catalogs[index])].sort(),
      [...reference].sort(),
      `${locale} is missing session token usage keys`,
    );
    // The pill's own label and the removed speed KPI are not left behind.
    assert.doesNotMatch(
      catalogs[index],
      /sessionTokenUsageLabel/,
      `${locale} kept the deleted pill label`,
    );
    assert.doesNotMatch(
      catalogs[index],
      /usageThroughputLabel/,
      `${locale} kept the removed speed label`,
    );
  });
});

test("the component spec documents the ledger instead of the old pill", () => {
  assert.match(spec, /- Session token usage lives inside the context inspector/);
  assert.match(spec, /a whole-session total adds the two/);
  assert.doesNotMatch(spec, /keeps a compact pill ahead of/);
  assert.doesNotMatch(spec, /Generation speed is a completed-turn value/);
});
