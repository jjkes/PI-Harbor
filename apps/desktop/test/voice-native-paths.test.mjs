import assert from "node:assert/strict";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";

register(new URL("./helpers/voice-service-stubs-hook.mjs", import.meta.url).href);

const { configurePackagedTranscribeLibrary, findUnpackedTranscribeLibrary } = await import(
  "../electron/main/voice-native-paths.ts"
);

const RESOURCES = path.join(path.sep, "Applications", "PI.app", "Contents", "Resources");
const SCOPE = path.join(RESOURCES, "app.asar.unpacked", "node_modules", "@transcribe-cpp");
const METAL = path.join(SCOPE, "darwin-arm64-metal");
const LIBRARY = path.join(METAL, "libtranscribe.dylib");

function fakeFs(files, dirs = {}) {
  const existing = new Set([...files, ...Object.keys(dirs)]);
  return {
    existsSync: (target) => existing.has(target),
    readdirSync: (target) => dirs[target] ?? [],
  };
}

const unpacked = () =>
  fakeFs([path.join(METAL, "contract.json"), LIBRARY], { [SCOPE]: ["darwin-arm64-metal"] });

test("finds the unpacked transcribe library beside its contract", () => {
  assert.equal(findUnpackedTranscribeLibrary(RESOURCES, unpacked()), LIBRARY);
});

test("ignores packages without a contract and returns null when nothing is unpacked", () => {
  const stray = path.join(SCOPE, "stray");
  assert.equal(
    findUnpackedTranscribeLibrary(
      RESOURCES,
      fakeFs([path.join(stray, "libtranscribe.dylib")], { [SCOPE]: ["stray"] }),
    ),
    null,
  );
  assert.equal(findUnpackedTranscribeLibrary(RESOURCES, fakeFs([])), null);
});

test("points transcribe-cpp at the unpacked library only in packaged builds", () => {
  const dev = {};
  configurePackagedTranscribeLibrary(false, RESOURCES, dev, unpacked());
  assert.equal(dev.TRANSCRIBE_LIBRARY, undefined);

  const packaged = {};
  configurePackagedTranscribeLibrary(true, RESOURCES, packaged, unpacked());
  assert.equal(packaged.TRANSCRIBE_LIBRARY, LIBRARY);

  const explicit = { TRANSCRIBE_LIBRARY: "/custom/libtranscribe.dylib" };
  configurePackagedTranscribeLibrary(true, RESOURCES, explicit, unpacked());
  assert.equal(explicit.TRANSCRIBE_LIBRARY, "/custom/libtranscribe.dylib");
});
