import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const LOCALES = ["en", "zh-CN", "zh-TW", "tr", "de", "es", "fr", "ko", "pt-BR"];

const [toolbar, composer, panel, css, globals, spec, ...catalogs] =
  await Promise.all([
    read("../src/features/chat/composer/ComposerToolbar.tsx"),
    read("../src/components/Composer.tsx"),
    read("../src/components/SessionTokenUsagePanel.tsx"),
    read("../src/styles/components/session-token-usage.css"),
    read("../src/styles/globals.css"),
    read("../../../docs/spec/04-ux/08-component-spec.md"),
    ...LOCALES.map((locale) =>
      read(`../../../packages/i18n/src/locales/${locale}/index.ts`),
    ),
  ]);

test("the composer toolbar hosts the session token entry beside context usage", () => {
  assert.match(
    composer,
    /const sessionTokenUsage = useSessionTokenUsage\(\s*activeSessionId,\s*liveMessages,/,
  );
  assert.match(composer, /sessionTokenUsage=\{sessionTokenUsage \?\? null\}/);
  // The entry belongs to the right-hand cluster, ahead of the model picker and
  // the send control, so a long conversation does not push it beside Stop.
  const rightCluster = toolbar.indexOf('<div className="composer-right">');
  const tokenPanel = toolbar.indexOf("<SessionTokenUsagePanel");
  assert.ok(rightCluster > -1, "the right-hand cluster still exists");
  assert.ok(tokenPanel > rightCluster, "the token panel renders in composer-right");
  assert.ok(
    tokenPanel < toolbar.indexOf("<ComposerModelPicker"),
    "the token panel precedes the model picker",
  );
  assert.match(toolbar, /\{sessionTokenUsage \? <SessionTokenUsagePanel/);
});

test("the panel keeps an accessible disclosure and no hardcoded visible copy", () => {
  assert.match(panel, /aria-expanded=\{open\}/);
  assert.match(panel, /aria-controls=\{open \? panelId : undefined\}/);
  assert.match(panel, /role="dialog"/);
  assert.match(panel, /event\.key !== "Escape"/);
  assert.match(panel, /addEventListener\("mousedown", onPointerDown\)/);
  // Every visible string comes from the catalog.
  assert.doesNotMatch(panel, />[A-Za-z][A-Za-z ]{3,}</);
  for (const key of [
    "sessionTokenUsage",
    "sessionTokenUsageLabel",
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
      panel.includes(`chat.${key}`),
      `the panel reads chat.${key} from the catalog`,
    );
  }
});

test("the usage styles load from the stylesheet entry point", () => {
  assert.match(globals, /@import "\.\/components\/session-token-usage\.css";/);
  // The stylesheet must not paint over the shared light theme.
  assert.doesNotMatch(css, /!important/);
  assert.match(css, /\.session-token-usage-trigger/);
  assert.match(css, /\.session-token-usage-panel/);
});

test("every locale carries the full session token usage catalog", async () => {
  const keys = catalogs.map((catalog) => {
    const found = [...catalog.matchAll(/(?:^|\s)"?(sessionTokenUsage[A-Za-z]*)"?\s*:/g)].map(
      (match) => match[1],
    );
    return new Set(found);
  });
  const reference = keys[0];
  assert.equal(reference.size, 13, "the English catalog defines 13 keys");

  LOCALES.forEach((locale, index) => {
    assert.deepEqual(
      [...keys[index]].sort(),
      [...reference].sort(),
      `${locale} is missing session token usage keys`,
    );
  });
});

test("the component spec documents the session aggregate boundary", () => {
  assert.match(spec, /- Session token usage: the composer right toolbar/);
  // The spec must state that this is a session aggregate, not a turn one.
  assert.match(
    spec,
    /This\s+is a session aggregate and stays deliberately distinct from the\s+capsule's\s+turn aggregate/,
  );
});
