/**
 * A renderer-requested image batch (`pi-harbor/images/generate`) is handed to
 * the runtime's own `GenerateImages` handler, so it must validate exactly what
 * the model tool path validates and fail in a shape the renderer can render.
 * These tests pin the request validation, the typed model-unavailable state,
 * and that the handler is reached with the request unchanged.
 */
import assert from "node:assert/strict";
import test from "node:test";

const { IPC, MAX_GENERATED_IMAGES } = await import("@pi-harbor/shared");
const { handleImagesGenerate, registerImagesIpc } = await import(
  "../electron/main/ipc/images-ipc.ts"
);

const request = (overrides = {}) => ({
  sessionId: "s1",
  items: [{ prompt: "a lighthouse at dusk" }],
  ...overrides,
});

const unreachable = () => {
  throw new Error("the image tool must not be reached");
};

const failureShape = (errorCode, message) => ({
  ok: false,
  errorCode,
  content: { kind: "image-generation-error", errorCode, message },
});

test("a missing or empty sessionId is rejected without reaching the tool", async () => {
  for (const sessionId of [undefined, "", "   ", 42]) {
    const result = await handleImagesGenerate(
      request({ sessionId }),
      unreachable,
    );
    assert.deepEqual(result, failureShape("INVALID_ARGUMENT", "sessionId is required"));
  }
  assert.deepEqual(
    await handleImagesGenerate({ items: request().items }, unreachable),
    failureShape("INVALID_ARGUMENT", "sessionId is required"),
  );
});

test("an item list over the batch limit is rejected, with the validator's message", async () => {
  const items = Array.from({ length: MAX_GENERATED_IMAGES + 1 }, (_, index) => ({
    prompt: `variant ${index}`,
  }));
  const result = await handleImagesGenerate(request({ items }), unreachable);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "INVALID_ARGUMENT");
  assert.deepEqual(result.content, {
    kind: "image-generation-error",
    errorCode: "INVALID_ARGUMENT",
    message: "items must contain 1–10 entries",
  });
});

test("an empty item list is rejected rather than sent as an empty batch", async () => {
  const result = await handleImagesGenerate(request({ items: [] }), unreachable);
  assert.equal(result.errorCode, "INVALID_ARGUMENT");
  assert.equal(result.content.kind, "image-generation-error");
});

test("no runtime handler yields the typed unavailable result instead of throwing", async () => {
  const result = await handleImagesGenerate(request(), () => null);
  assert.deepEqual(result, failureShape("HOST_UNAVAILABLE", "The agent runtime is not available."));
});

test("the request reaches the runtime handler and its result is passed through", async () => {
  const seen = [];
  const handled = {
    ok: true,
    isError: false,
    content: { kind: "generated-images", results: [{ index: 0, status: "succeeded" }] },
  };
  const handler = async (input) => {
    // The signal is only aborted once the handler has returned, so read it here.
    seen.push({
      sessionId: input.sessionId,
      args: input.args,
      toolCallId: input.toolCallId,
      liveSignal: input.signal instanceof AbortSignal && !input.signal.aborted,
    });
    return handled;
  };
  const result = await handleImagesGenerate(
    request({ sessionId: " s1 ", items: [{ prompt: "a red fox", count: 2 }] }),
    () => handler,
  );
  assert.equal(result, handled);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionId, "s1");
  assert.deepEqual(seen[0].args, { items: [{ prompt: "a red fox", count: 2 }] });
  assert.equal(typeof seen[0].toolCallId, "string");
  assert.equal(seen[0].liveSignal, true);
});

test("a failing tool result is returned exactly as the runtime produced it", async () => {
  const handled = failureShape("IMAGE_NOT_CONFIGURED", "Configure an image generation model.");
  const result = await handleImagesGenerate(request(), () => async () => handled);
  assert.equal(result, handled);
});

test("the channel is registered on the renderer invoke map", () => {
  const registered = new Map();
  registerImagesIpc({
    registrar: { handleWithEvent: (channel, handler) => registered.set(channel, handler) },
    getActiveTool: () => null,
  });
  assert.equal(IPC.invoke.imagesGenerate, "pi-harbor/images/generate");
  const invoke = registered.get(IPC.invoke.imagesGenerate);
  assert.equal(typeof invoke, "function");
  return invoke({}, request()).then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "HOST_UNAVAILABLE");
  });
});
