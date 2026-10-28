import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PI_KERNEL_PACKAGE,
  readPiKernelVersion,
} from "../../../scripts/pi-kernel-version.mjs";
import { readMainSource, readSettingsSource } from "./helpers/source-contracts.mjs";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const desktopManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const buildConfigSource = await readFile(
  new URL("../electron.vite.config.ts", import.meta.url),
  "utf8",
);
const shippedLocales = ["en", "zh-CN", "zh-TW", "tr", "de", "es", "fr", "ko", "pt-BR"];

test("the reported Pi version is the pinned dependency, not a restated constant", () => {
  const pin = desktopManifest.devDependencies[PI_KERNEL_PACKAGE];
  assert.match(pin, /^\d+\.\d+\.\d+$/, "the Pi kernel must stay an exact pin");
  assert.equal(readPiKernelVersion(desktopRoot), pin);
});

test("a build without the installed Pi package fails instead of shipping a blank version", async () => {
  const emptyRoot = await mkdtemp(join(tmpdir(), "pi-kernel-version-"));
  try {
    assert.throws(() => readPiKernelVersion(emptyRoot), /is not installed/);
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
  }
});

test("the Electron build bakes the installed Pi version into the main bundle", () => {
  assert.match(buildConfigSource, /from "\.\.\/\.\.\/scripts\/pi-kernel-version\.mjs"/);
  assert.match(
    buildConfigSource,
    /__PI_KERNEL_VERSION__: JSON\.stringify\(readPiKernelVersion\(__dirname\)\)/,
  );
});

test("the About payload and panel report the Pi version beside protocol and host", async () => {
  const [mainSource, settingsSource] = await Promise.all([
    readMainSource(),
    readSettingsSource(),
  ]);
  assert.match(mainSource, /piVersion: PI_KERNEL_VERSION/);
  assert.match(settingsSource, /t\("settings\.aboutMeta", \{/);
  assert.match(settingsSource, /pi: version\?\.piVersion \?\? "—"/);
});

test("every shipped catalog renders the Pi version in the About meta line", async () => {
  for (const locale of shippedLocales) {
    const source = await readFile(
      new URL(
        `../../../packages/i18n/src/locales/${locale}/index.ts`,
        import.meta.url,
      ),
      "utf8",
    );
    const line = source.match(/^\s*"?aboutMeta"?: .*$/m)?.[0];
    assert.ok(line, `${locale} is missing settings.aboutMeta`);
    for (const placeholder of ["{{protocol}}", "{{host}}", "{{pi}}"]) {
      assert.ok(
        line.includes(placeholder),
        `${locale} settings.aboutMeta is missing ${placeholder}`,
      );
    }
  }
});
