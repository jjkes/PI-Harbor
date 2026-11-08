/**
 * The work-panel image gallery reads what the session already generated. These
 * tests pin the read: only succeeded outputs become tiles, the prompt travels
 * with them, and nothing is invented for a call that produced no image.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { generatedImagesFromResult, generatedSessionImages, mergeGeneratedImages } =
  await import("../src/lib/generated-session-images.ts");

const call = ({ id = "tool-1", prompt = "a cat", results = [], args } = {}) => ({
  id,
  role: "tool",
  toolName: "GenerateImages",
  toolArgs: args ?? { items: [{ prompt }] },
  toolResult: { details: { kind: "generated-images", results } },
});

test("succeeded outputs become tiles in transcript order, with their prompt", () => {
  const images = generatedSessionImages([
    call({
      results: [
        { index: 0, status: "succeeded", path: "scratch/a.png", mimeType: "image/png" },
        { index: 1, status: "failed", errorCode: "PROVIDER_ERROR" },
      ],
    }),
    call({
      id: "tool-2",
      prompt: "  a dog  ",
      results: [{ index: 0, status: "succeeded", path: "scratch/b.webp" }],
    }),
  ]);

  assert.deepEqual(
    images.map((image) => [image.path, image.prompt, image.key]),
    [
      ["scratch/a.png", "a cat", "tool-1:0"],
      ["scratch/b.webp", "a dog", "tool-2:0"],
    ],
  );
  // A missing mimeType stays absent so the reader can sniff from the path.
  assert.equal(images[1].mimeType, undefined);
  assert.equal(images[0].mimeType, "image/png");
});

test("rows that are not a finished image call contribute nothing", () => {
  assert.deepEqual(generatedSessionImages([]), []);
  // A different tool never contributes, even with a generated-images payload.
  assert.deepEqual(
    generatedSessionImages([
      { ...call(), toolName: "Task" },
    ]),
    [],
  );
  // An error payload has no results to read.
  assert.deepEqual(
    generatedSessionImages([
      {
        ...call(),
        toolResult: { details: { kind: "image-generation-error", errorCode: "IMAGE_NOT_CONFIGURED" } },
      },
    ]),
    [],
  );
  // A succeeded row without a path cannot be drawn.
  assert.deepEqual(
    generatedSessionImages([call({ results: [{ index: 0, status: "succeeded" }] })]),
    [],
  );
  // No prompt in the call leaves the caption empty instead of undefined text.
  assert.deepEqual(
    generatedSessionImages([
      call({ args: {}, results: [{ index: 0, status: "succeeded", path: "scratch/c.png" }] }),
    ]).map((image) => image.prompt),
    [""],
  );
});

const tile = (path, { prompt = "", index = 0, key = `generated:${path}`, mimeType } = {}) => ({
  path,
  index,
  ...(mimeType ? { mimeType } : {}),
  prompt,
  key,
});

test("a panel batch is appended after the transcript, deduplicated by path", () => {
  const transcript = [
    tile("scratch/a.png", { prompt: "a cat", index: 0, key: "tool-1:0" }),
    tile("scratch/b.png", { prompt: "a cat", index: 1, key: "tool-1:1" }),
  ];
  const generated = [
    // The same path the transcript already holds is the same image.
    tile("scratch/a.png", { prompt: "again" }),
    tile("scratch/c.png", { prompt: "panel run" }),
    // Path matching is exact: a different case is a different image.
    tile("scratch/C.png", { prompt: "panel run" }),
  ];

  assert.deepEqual(
    mergeGeneratedImages(transcript, generated).map((image) => image.path),
    ["scratch/a.png", "scratch/b.png", "scratch/c.png", "scratch/C.png"],
  );
  // The transcript's own entry wins, so its prompt and key are not replaced.
  assert.equal(mergeGeneratedImages(transcript, generated)[0].prompt, "a cat");
});

test("merging no panel images is a no-op that preserves transcript order", () => {
  const transcript = [tile("scratch/b.png", { index: 2 }), tile("scratch/a.png")];
  assert.deepEqual(mergeGeneratedImages(transcript, []), transcript);
  assert.deepEqual(mergeGeneratedImages([], []), []);
  // The same panel batch twice still yields one tile per path.
  const panel = [tile("scratch/c.png"), tile("scratch/c.png")];
  assert.deepEqual(
    mergeGeneratedImages([], panel).map((image) => image.path),
    ["scratch/c.png"],
  );
});

test("only succeeded panel results with a real path become tiles", () => {
  const images = generatedImagesFromResult(
    {
      kind: "generated-images",
      results: [
        { index: 0, status: "succeeded", path: "scratch/a.png", mimeType: "image/png" },
        { index: 1, status: "failed", errorCode: "PROVIDER_ERROR" },
        { index: 2, status: "cancelled" },
        { index: 3, status: "succeeded", path: 42 },
      ],
    },
    "a cat",
  );

  assert.deepEqual(
    images.map((image) => [image.path, image.index, image.key, image.prompt]),
    [["scratch/a.png", 0, "generated:scratch/a.png", "a cat"]],
  );
  assert.equal(images[0].mimeType, "image/png");
  // The prompt is carried as given: the caller trims what it sends.
  assert.equal(
    generatedImagesFromResult(
      { kind: "generated-images", results: [{ index: 0, status: "succeeded", path: "p.png" }] },
      "  a cat  ",
    )[0].prompt,
    "  a cat  ",
  );
});

test("content that is not a finished image result contributes nothing", () => {
  const prompt = "a cat";
  assert.deepEqual(generatedImagesFromResult(undefined, prompt), []);
  assert.deepEqual(generatedImagesFromResult(null, prompt), []);
  assert.deepEqual(generatedImagesFromResult("generated-images", prompt), []);
  assert.deepEqual(generatedImagesFromResult([], prompt), []);
  // An error payload has no results to read.
  assert.deepEqual(
    generatedImagesFromResult(
      { kind: "image-generation-error", errorCode: "IMAGE_NOT_CONFIGURED" },
      prompt,
    ),
    [],
  );
  assert.deepEqual(generatedImagesFromResult({ kind: "generated-images" }, prompt), []);
  // A batch where nothing succeeded leaves the gallery unchanged.
  assert.deepEqual(
    generatedImagesFromResult(
      { kind: "generated-images", results: [{ index: 0, status: "failed" }] },
      prompt,
    ),
    [],
  );
});
