/**
 * The Composer model menu follows the app surface.
 *
 * Image mode is a generation surface: it offers only the models bound for image
 * generation, so a text model can never be mistaken for the image model that
 * will run the prompt. Agent mode is unchanged. The one exception is a menu
 * that would end up empty — an empty picker strands the Composer with nothing
 * to choose — so that case keeps the full list and reports the fallback.
 */
import { readComposerModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { composerModelGroupsForMode } from "../src/lib/composer-models.ts";

const model = (modelId, providerId = "openai") => ({
  modelId,
  displayName: modelId,
  providerId,
  capabilities: ["text"],
  source: "discovered",
});

const group = (providerId, modelIds) => ({
  provider: { id: providerId },
  providerDisplayName: providerId,
  providerSearchText: providerId,
  models: modelIds.map((modelId) => model(modelId, providerId)),
});

const shape = (groups) =>
  groups.map((entry) => [entry.provider.id, entry.models.map((entry) => entry.modelId)]);

const menu = [group("openai", ["gpt-6", "gpt-image-1"]), group("google", ["gemini-4", "imagen-5"])];

test("agent mode lists every configured conversation model", () => {
  const result = composerModelGroupsForMode(menu, {
    imagesMode: false,
    imageGeneration: [{ providerId: "openai", modelId: "gpt-image-1" }],
  });

  assert.deepEqual(shape(result.groups), [
    ["openai", ["gpt-6", "gpt-image-1"]],
    ["google", ["gemini-4", "imagen-5"]],
  ]);
  assert.equal(result.imageFallback, false);
  // The groups themselves are the caller's objects; only the list is rebuilt.
  assert.equal(result.groups[0], menu[0]);
  assert.equal(result.groups[1].providerDisplayName, "google");
});

test("image mode keeps only the bound image-generation models", () => {
  const result = composerModelGroupsForMode(menu, {
    imagesMode: true,
    imageGeneration: [
      { providerId: "google", modelId: "imagen-5" },
      { providerId: "openai", modelId: "gpt-image-1" },
    ],
  });

  assert.deepEqual(shape(result.groups), [
    ["openai", ["gpt-image-1"]],
    ["google", ["imagen-5"]],
  ]);
  assert.equal(result.imageFallback, false);
  // Group order follows the providers, not the binding order; the rest of the
  // group's fields survive the filter.
  assert.equal(result.groups[0].providerDisplayName, "openai");
});

test("a single legacy binding is enough to select the image model", () => {
  const result = composerModelGroupsForMode(menu, {
    imagesMode: true,
    imageGeneration: { providerId: "openai", modelId: "gpt-image-1" },
  });

  assert.deepEqual(shape(result.groups), [["openai", ["gpt-image-1"]]]);
  assert.equal(result.imageFallback, false);
});

test("image mode drops a provider that keeps no model", () => {
  const result = composerModelGroupsForMode(menu, {
    imagesMode: true,
    imageGeneration: [{ providerId: "openai", modelId: "gpt-image-1" }],
  });

  assert.deepEqual(shape(result.groups), [["openai", ["gpt-image-1"]]]);
});

test("a provider holding both a text and an image model keeps only the image one", () => {
  const both = [group("openai", ["gpt-6", "gpt-image-1", "gpt-7"])];
  const result = composerModelGroupsForMode(both, {
    imagesMode: true,
    imageGeneration: [{ providerId: "openai", modelId: "gpt-image-1" }],
  });

  assert.deepEqual(shape(result.groups), [["openai", ["gpt-image-1"]]]);
});

test("image mode without a matching binding falls back to the full list", () => {
  for (const imageGeneration of [
    undefined,
    null,
    [],
    [{ providerId: "openai", modelId: "gpt-image-9" }],
    [{ providerId: "removed-provider", modelId: "gpt-image-1" }],
  ]) {
    const result = composerModelGroupsForMode(menu, { imagesMode: true, imageGeneration });
    assert.deepEqual(shape(result.groups), shape(menu), `binding ${JSON.stringify(imageGeneration)}`);
    // The fallback is reported, so a menu that is not surface-filtered is
    // distinguishable from one that is.
    assert.equal(result.imageFallback, true);
  }
  assert.deepEqual(composerModelGroupsForMode([], { imagesMode: true }).groups, []);
  assert.equal(composerModelGroupsForMode([], { imagesMode: true }).imageFallback, true);
  assert.equal(composerModelGroupsForMode([], { imagesMode: false }).imageFallback, false);
});

test("the menu hook takes its groups from the app-surface selector", async () => {
  const source = await readComposerModule("hooks/useComposerModelMenu.ts");

  assert.match(source, /import \{ appModeOf \} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/app-mode";/);
  assert.match(source, /const appMode = useAppStore\(\(s\) => s\.settings\?\.appMode\);/);
  assert.match(source, /const imagesMode = appModeOf\(\{ appMode \}\) === "images";/);
  // Image rows only exist in the candidate list when the conversation list's
  // own image exclusion is lifted for that surface.
  assert.match(source, /imagesMode \? undefined : imageGenerationCandidates,/);
  assert.match(
    source,
    /return composerModelGroupsForMode\(groups, \{\n\s+imagesMode,\n\s+imageGeneration: imageGenerationCandidates,\n\s+\}\)\.groups;/,
  );
  assert.match(source, /\}, \[providers, providerModels, imageGenerationCandidates, imagesMode\]\);/);
});
