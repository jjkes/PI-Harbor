import assert from "node:assert/strict";
import { dirname, join, resolve, sep } from "node:path";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readMainModule } from "./helpers/source-contracts.mjs";

const here = dirname(fileURLToPath(import.meta.url));

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  applyDevelopmentUserData,
  DEVELOPMENT_DATA_DIR_NAME,
  DEVELOPMENT_INSTALLATION_NAME,
  INSTALLATION_DATA_DIR_NAME,
  resolveDataDir,
} = await import("../electron/main/data-paths.ts");
const { APP_NAME } = await import("@pi-harbor/shared");
const {
  MCP_CONTROL_DEFAULT_PORT,
  MCP_CONTROL_DEVELOPMENT_DEFAULT_PORT,
  resolveMcpControlPort,
} = await import("../electron/main/mcp-control.ts");

const indexSource = await readMainModule("index.ts");
const installationSource = await readMainModule("installation.ts");
const entrySource = await readMainModule("entry.ts");

test("a development build owns a different data directory than the shipped app", () => {
  const home = join(tmpdir(), "pi-harbor-profile-home");

  assert.equal(
    resolveDataDir({ override: undefined, development: false, home }),
    join(home, INSTALLATION_DATA_DIR_NAME),
  );
  assert.equal(
    resolveDataDir({ override: undefined, development: true, home }),
    join(home, DEVELOPMENT_DATA_DIR_NAME),
  );

  // A shipped installation must keep the directory its users already have, so
  // the split can only have moved the development side.
  assert.equal(INSTALLATION_DATA_DIR_NAME, ".pi-harbor");
  assert.equal(DEVELOPMENT_DATA_DIR_NAME, ".pi-harbor-dev");
  assert.equal(DEVELOPMENT_INSTALLATION_NAME, "PI-Harbor Desktop Dev");
});

test("PI_HARBOR_DATA_DIR still overrides either profile", () => {
  const home = join(tmpdir(), "pi-harbor-profile-home");
  const override = join(tmpdir(), "pi-harbor-explicit-profile");

  for (const development of [false, true]) {
    assert.equal(
      resolveDataDir({ override, development, home }),
      override,
    );
  }

  // Every call site this replaced treated a blank value as unset, which is what
  // keeps `PI_HARBOR_DATA_DIR=` from naming a relative directory.
  assert.equal(
    resolveDataDir({ override: "   ", development: true, home }),
    join(home, DEVELOPMENT_DATA_DIR_NAME),
  );
});

test("an explicit data directory reaches the child processes as an absolute path", () => {
  // host-core and the plugin host read the value as an environment variable
  // from a different working directory, so a relative override would resolve to
  // two different trees.
  const relative = join("pi-harbor-relative-profile");
  assert.equal(
    resolveDataDir({
      override: relative,
      development: false,
      home: join(tmpdir(), "pi-harbor-profile-home"),
    }),
    resolve(relative),
  );
});

test("applyDevelopmentUserData sets userData unless --user-data-dir is set", () => {
  const calls = [];
  const app = {
    commandLine: { hasSwitch: () => false },
    getPath: () => "/tmp/appData",
    setPath: (name, path) => calls.push([name, path]),
  };
  applyDevelopmentUserData(app, true);
  assert.deepEqual(calls, [
    ["userData", join("/tmp/appData", DEVELOPMENT_INSTALLATION_NAME)],
  ]);
  calls.length = 0;
  applyDevelopmentUserData(app, false);
  assert.equal(calls.length, 0);
  applyDevelopmentUserData(
    { ...app, commandLine: { hasSwitch: (name) => name === "user-data-dir" } },
    true,
  );
  assert.equal(calls.length, 0);
});

test("a development build takes its own userData before the single-instance lock", async () => {
  // The lock lives under `userData`, so the profile has to be applied before
  // Electron asks for it; otherwise a running packaged app refuses the lock and
  // `pnpm dev` quits on arrival.
  const pathsSource = await readMainModule("data-paths.ts");
  const apply = installationSource.indexOf("applyDevelopmentUserData(app, isDevelopmentBuild)");
  const setName = installationSource.indexOf("app.setName(APP_NAME)");
  const lock = installationSource.indexOf("app.requestSingleInstanceLock()");

  assert.ok(apply > 0, "main must give the development build its own userData");
  assert.ok(lock > 0, "main must request the single-instance lock");
  assert.ok(setName > 0 && setName < apply);
  assert.ok(apply < lock);

  // An explicit `--user-data-dir` wins. The E2E harnesses point a build at a
  // throwaway profile with that switch, so overriding it would run their
  // assertions against the developer's own state instead.
  assert.match(
    pathsSource,
    /if \(development && !app\.commandLine\.hasSwitch\("user-data-dir"\)\) \{/,
  );
  assert.match(
    pathsSource,
    /app\.setPath\(\s*"userData",\s*join\(app\.getPath\("appData"\), DEVELOPMENT_INSTALLATION_NAME\)/,
  );

  // The two profiles are told apart by the same verdict everywhere, and it is
  // reached before the name the lock path derives from.
  const development = installationSource.search(
    /const isDevelopmentBuild =\s*\n?\s*process\.env\.PI_HARBOR_DEV === "1" \|\| !app\.isPackaged;/,
  );
  assert.ok(development > 0 && development < apply);
});

test("main resolves one data directory and publishes it to everything below", () => {
  assert.match(installationSource, /const defaultDataDir = desktopDataDir\(isDevelopmentBuild\);/);
  assert.match(entrySource, /prepareStorage\(defaultDataDir, !singleInstanceRequired\)/);
  assert.match(indexSource, /const storage = getStorageBootstrap\(\);/);
  assert.match(indexSource, /const dataDir = storage\.preferences\.roots\.data;/);
  // The plugin runtime resolves this root from the environment rather than
  // taking it as a parameter, so the resolved value has to be the one it reads.
  assert.match(indexSource, /process\.env\.PI_HARBOR_DATA_DIR = dataDir;/);
  assert.doesNotMatch(indexSource, /join\(homedir\(\), "\.pi-harbor"\)/);

  // Publishing happens after the lock verdict, which reads the same variable:
  // moving the write above `singleInstanceRequired` would make every launch
  // look like it had been given an explicit data directory and skip the lock.
  const lockVerdict = installationSource.indexOf(
    "const singleInstanceRequired = !process.env.PI_HARBOR_DATA_DIR;",
  );
  assert.ok(lockVerdict > 0);
  assert.doesNotMatch(installationSource, /process\.env\.PI_HARBOR_DATA_DIR = dataDir;/);
  assert.match(entrySource, /from ["']\.\/installation["']/);
  assert.match(entrySource, /\.then\([\s\S]*?import\(["']\.\/index["']\)/);
});

test("downstream data directories follow the profile instead of the shipped default", async () => {
  const runtimeSource = await readMainModule("plugin-runtime.ts");
  assert.match(runtimeSource, /const root = desktopDataDir\(\);/);
  assert.doesNotMatch(runtimeSource, /join\(homedir\(\), "\.pi-harbor"\)/);

  // The plugin services already receive the resolved directory; the scratch
  // root was the one place that re-derived it.
  const servicesSource = await readMainModule("services/plugin-services.ts");
  assert.match(servicesSource, /return join\(dataDir, "scratch", sessionId\);/);
  assert.doesNotMatch(servicesSource, /join\(homedir\(\), "\.pi-harbor"\)/);
});

test("no installation name can collide with an installed upstream build", () => {
  // Upstream PI-Desktop owns these names. Sharing any one of them would put two
  // different applications on a single userData tree, a single single-instance
  // lock, and a single single-writer host-core database, so an upstream install
  // could be read, migrated, or corrupted by this fork and the reverse.
  const upstream = {
    dataDir: ".pi-desktop",
    developmentDataDir: ".pi-desktop-dev",
    userData: "PI-Desktop",
    developmentUserData: "PI-Desktop Dev",
  };
  assert.notEqual(INSTALLATION_DATA_DIR_NAME, upstream.dataDir);
  assert.notEqual(INSTALLATION_DATA_DIR_NAME, upstream.developmentDataDir);
  assert.notEqual(DEVELOPMENT_DATA_DIR_NAME, upstream.dataDir);
  assert.notEqual(DEVELOPMENT_DATA_DIR_NAME, upstream.developmentDataDir);
  assert.notEqual(APP_NAME, upstream.userData);
  assert.notEqual(DEVELOPMENT_INSTALLATION_NAME, upstream.developmentUserData);

  // A component boundary, not a prefix: `.pi-harbor` must not be a child of the
  // upstream root either, which would hand an upstream uninstall this data.
  const home = join(tmpdir(), "pi-harbor-profile-home");
  for (const development of [false, true]) {
    const root = resolveDataDir({ override: undefined, development, home });
    assert.equal(root.startsWith(join(home, upstream.dataDir) + sep), false);
  }
});

test("the control plane port is distinct from upstream and split across installations", () => {
  // A TCP port is machine-global: two servers cannot hold one listener. Reusing
  // upstream's default would make whichever application booted second come up
  // without a control plane.
  const upstreamDefaultPort = 37_123;
  assert.notEqual(MCP_CONTROL_DEFAULT_PORT, upstreamDefaultPort);
  assert.notEqual(MCP_CONTROL_DEVELOPMENT_DEFAULT_PORT, upstreamDefaultPort);
  assert.notEqual(MCP_CONTROL_DEFAULT_PORT, MCP_CONTROL_DEVELOPMENT_DEFAULT_PORT);

  assert.equal(
    resolveMcpControlPort({ override: undefined, development: false }),
    MCP_CONTROL_DEFAULT_PORT,
  );
  assert.equal(
    resolveMcpControlPort({ override: undefined, development: true }),
    MCP_CONTROL_DEVELOPMENT_DEFAULT_PORT,
  );
  assert.equal(
    resolveMcpControlPort({ override: "   ", development: true }),
    MCP_CONTROL_DEVELOPMENT_DEFAULT_PORT,
  );

  // The E2E harnesses pass an explicit port, and `0` has to reach the server as
  // a request for an ephemeral one instead of falling back to a default.
  assert.equal(resolveMcpControlPort({ override: "45678", development: true }), 45_678);
  assert.equal(resolveMcpControlPort({ override: "0", development: false }), 0);

  // A typo must not quietly land on the other installation's port; `start()`
  // rejects NaN instead.
  assert.ok(Number.isNaN(resolveMcpControlPort({ override: "not-a-port", development: false })));
});

test("startup resolves the control plane port from the build profile", async () => {
  const startupSource = await readMainModule("bootstrap/startup.ts");
  assert.match(
    startupSource,
    /port: resolveMcpControlPort\(\{\s*override: process\.env\.PI_HARBOR_MCP_PORT,\s*development: isDevelopmentBuild,\s*\}\)/,
  );
  // The verdict has to come from the one place that can ask `app.isPackaged`.
  assert.match(indexSource, /registerApplicationStartup\(\{[\s\S]*?\n  isDevelopmentBuild,/);
});
