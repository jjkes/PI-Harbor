/**
 * Composer token metrics: one always-present row under the input carrying the
 * four readings the toolbar no longer duplicates. Speed is a live estimate while
 * a reply streams and the provider average once it settles; the three cache
 * readings never mix their scopes.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const LOCALES = ["en", "zh-CN", "zh-TW", "tr", "de", "es", "fr", "ko", "pt-BR"];

const [bar, composer, hook, composerCss, ...catalogs] = await Promise.all([
  read("../src/features/chat/composer/ComposerMetricsBar.tsx"),
  read("../src/components/Composer.tsx"),
  read("../src/features/chat/context-usage/useInstantTokenRate.ts"),
  read("../src/styles/composer.css"),
  ...LOCALES.map((locale) =>
    read(`../../../packages/i18n/src/locales/${locale}/index.ts`),
  ),
]);

test("the metrics row is a sibling of the input shell, not a toolbar control", () => {
  const shell = composer.indexOf('className={`composer-shell');
  const toolbar = composer.indexOf("<ComposerToolbar");
  const metrics = composer.indexOf("<ComposerMetricsBar");
  assert.ok(shell > -1, "the composer shell still exists");
  assert.ok(toolbar > shell, "the toolbar renders inside the shell");
  assert.ok(metrics > toolbar, "the metrics row follows the shell");
  // It closes the stack: directly after the shell's own closing tag.
  assert.match(
    composer,
    /<\/div>\s*\{\/\* Token metrics sit under the input[\s\S]{0,240}?<ComposerMetricsBar/,
  );
  assert.equal(composer.split("<ComposerMetricsBar").length - 1, 1);
  assert.match(composer, /contextUsage=\{composerContextUsage \?\? null\}/);
  assert.match(composer, /sessionUsage=\{sessionTokenUsage \?\? null\}/);
});

test("the row carries the four readings and hides an idle team", () => {
  for (const key of [
    "metricsLabel",
    "metricsSpeedLabel",
    "metricsSpeedHelp",
    "metricsCacheLatestLabel",
    "metricsCacheLatestHelp",
    "metricsCacheSessionLabel",
    "metricsCacheSessionHelp",
    "metricsCacheTeamLabel",
    "metricsCacheTeamHelp",
    "metricsUnavailable",
  ]) {
    assert.ok(bar.includes(`chat.${key}`), `the row reads chat.${key}`);
  }
  assert.match(bar, /role="group"/);
  assert.match(bar, /aria-label=\{t\("chat\.metricsLabel"\)\}/);
  // No team yet means no team reading at all, not a zero; the gate is decided by
  // `lib/composer-metrics` and only rendered here.
  assert.match(bar, /const \{[\s\S]{0,160}?showTeam \}/);
  assert.match(bar, /\{showTeam \? \(/);
  // Every reading falls back to the catalog's dash.
  assert.match(bar, /percentText\(/);
  // Visible copy comes from the catalog only.
  assert.doesNotMatch(bar, />[A-Za-z][A-Za-z ]{3,}</);
});

test("speed is the stream estimate while streaming and the average once settled", () => {
  assert.match(bar, /useInstantTokenRate\(streamingTokens \?\? 0, streaming\)/);
  assert.match(bar, /resolveSpeedReading\(streaming, instantRate, averageRate\)/);
  // The estimate keeps the capsule's own wording.
  assert.match(bar, /"chat\.usageThroughputEstimated"/);
  assert.match(bar, /"chat\.usageThroughput"/);
  // The settled average comes from the shared readings, so the row and the
  // inspector cannot disagree about which figure is authoritative.
  assert.match(bar, /composerMetricReadings\(contextUsage, sessionUsage\)/);
});

test("the row consumes one pure readings helper instead of re-deriving scopes", () => {
  for (const field of [
    "averageRate",
    "latestCacheRate",
    "sessionCacheRate",
    "teamCacheRate",
    "showTeam",
  ]) {
    assert.ok(bar.includes(field), `the row prints ${field}`);
  }
  // Scope arithmetic lives in lib/composer-metrics, covered by its own unit test.
  assert.doesNotMatch(bar, /calculateCacheRate|calculateTokenRate/);
});

test("the live figure only follows the main session's own stream", () => {
  // Delegate rows stream on the same session stream but belong to a node.
  assert.match(bar, /if \(message\.role !== "assistant" \|\| message\.parentToolCallId\) continue;/);
  assert.match(bar, /if \(message\.status !== "streaming"\) return undefined;/);
  assert.match(bar, /useAppStore\(selectStreamingOutputTokens\)/);
});

test("the reading is republished once a second, not once per chunk", () => {
  // A delta only records a sample; the ticker publishes, so the number stays
  // readable and the transcript is not re-rendered per token.
  assert.match(hook, /export const INSTANT_RATE_SAMPLE_MS = 1_000;/);
  assert.match(hook, /window\.setInterval\(/);
  assert.match(hook, /INSTANT_RATE_SAMPLE_MS\);/);
  assert.match(hook, /samplesRef\.current = appendTokenSample\(/);
  assert.match(hook, /return active \? rate : undefined;/);
});

test("the row paints no surface of its own and keeps the token scales", () => {
  const block = composerCss.slice(
    composerCss.indexOf(".composer-metrics {"),
    composerCss.indexOf(".composer-metrics-value {"),
  );
  assert.ok(block.length > 0, "the metrics styles exist");
  // Colours and type come from the shared scales, never from literals.
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}/);
  assert.doesNotMatch(block, /\brgb(a)?\(/);
  assert.match(block, /font-size: var\(--text-2xs\)/);
  assert.match(block, /color: var\(--ds-text-muted\)/);
});

test("every locale carries the metrics catalog", () => {
  const keysOf = (catalog) =>
    new Set(
      [...catalog.matchAll(/(?:^|\s)"?(metrics[A-Za-z]*)"?\s*:/g)].map(
        (match) => match[1],
      ),
    );
  const reference = keysOf(catalogs[0]);
  assert.equal(reference.size, 10, "the English catalog defines 10 metrics keys");
  LOCALES.forEach((locale, index) => {
    assert.deepEqual(
      [...keysOf(catalogs[index])].sort(),
      [...reference].sort(),
      `${locale} is missing metrics keys`,
    );
  });
});
