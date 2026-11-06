// Launch the built desktop app in isolation and drive it the way a user does:
// real Main, real Host, real renderer, over CDP. Each scenario gets its own
// data, profile, and ports, and nothing outlives `close()`.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertDesktopBuild, repositoryRoot, resolveElectronBinary } from "./boot.mjs";
import { CdpClient, listTargets } from "./cdp-client.mjs";
import { Host, resolveHostBinary } from "./host.mjs";

const WAIT_TIMEOUT_MS = 45_000;
const POLL_MS = 100;
const STOP_TIMEOUT_MS = 8_000;

export function shortText(value, max = 700) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text && text.length > max ? `${text.slice(0, max)}...` : String(text);
}

export function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function exited(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

/** Stop Electron and everything it started (Host, sidecar, helpers). */
async function stopTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const signal = (name) => {
    try {
      if (process.platform === "win32") spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-child.pid, name);
    } catch {
      child.kill(name);
    }
  };
  signal("SIGTERM");
  if (!(await exited(child, STOP_TIMEOUT_MS))) {
    signal("SIGKILL");
    await exited(child, STOP_TIMEOUT_MS);
  }
}

export class DesktopApp {
  constructor(name) {
    this.name = name;
    this.root = repositoryRoot();
    this.electron = null;
    this.renderer = null;
    this.main = null;
    this.pages = new Set();
    this.output = "";
    this.error = null;
    this.stopping = false;
    this.diagnostics = [];
    this.expectedConsole = [];
  }

  /**
   * Start Electron on isolated state. `seed(host, app)` runs against the same
   * data directory before launch, through a short-lived Host of its own; it
   * can place fixture files under `app.tempRoot`.
   */
  static async launch(name, { seed, probe = false, expectedConsole = [] } = {}) {
    const app = new DesktopApp(name);
    app.expectedConsole = expectedConsole;
    try {
      const { appDir } = assertDesktopBuild(app.root);
      app.tempRoot = await realpath(await mkdtemp(join(tmpdir(), `pi-${name}-`)));
      app.dataDir = join(app.tempRoot, "data");
      app.profileDir = join(app.tempRoot, "profile");
      // A home of its own: no user agents, skills, or instructions leak in.
      app.homeDir = join(app.tempRoot, "home");
      app.artifactDir = resolve(process.env.PI_HARBOR_E2E_ARTIFACT_DIR?.trim() || join(tmpdir(), `pi-${name}-artifacts`));
      await Promise.all([app.dataDir, app.profileDir, app.homeDir, app.artifactDir].map((dir) => mkdir(dir, { recursive: true })));
      app.hostBinary = resolveHostBinary();
      console.log(`Host ${app.hostBinary}`);
      if (seed) {
        const host = new Host(app.hostBinary, app.dataDir, { quiet: true });
        await host.start();
        try {
          await seed(host, app);
        } finally {
          await host.stop();
        }
      }
      app.cdpPort = await freePort();
      app.inspectorPort = probe ? await freePort() : null;
      app.spawn(appDir, probe);
      if (probe) await app.connectMain();
      await app.connectRenderer();
      await app.waitForShell();
      return app;
    } catch (error) {
      const tail = app.output ? `\nElectron output:\n${shortText(app.output.slice(-3_000), 3_000)}` : "";
      await app.close();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${tail}`);
    }
  }

  spawn(appDir, probe) {
    // An occluded or unfocused test window must keep animation frames and
    // timers running: the UI waits on requestAnimationFrame to place popovers.
    const args = [
      `--remote-debugging-port=${this.cdpPort}`,
      `--user-data-dir=${this.profileDir}`,
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ];
    if (probe) args.push(`--inspect=${this.inspectorPort}`);
    this.electron = spawn(resolveElectronBinary(this.root).electronBinary, [...args, "."], {
      cwd: appDir,
      env: {
        ...process.env,
        PI_HARBOR_DATA_DIR: this.dataDir,
        PI_HARBOR_HOST_BIN: this.hostBinary,
        ELECTRON_RENDERER_URL: "",
        PI_HARBOR_START_MAXIMIZED: "0",
        HOME: this.homeDir,
        USERPROFILE: this.homeDir,
        GIT_CONFIG_GLOBAL: join(this.homeDir, ".gitconfig-absent"),
        GIT_CONFIG_SYSTEM: join(this.homeDir, ".gitconfig-absent"),
        GIT_TERMINAL_PROMPT: "0",
        ...(probe ? { PI_HARBOR_PLAN_UI_PROBE: "1" } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const record = (chunk) => {
      this.output = `${this.output}${chunk}`.slice(-200_000);
      if (process.env.DEBUG_PI_HARBOR_E2E === "1") process.stderr.write(chunk);
    };
    this.electron.stdout.on("data", record);
    this.electron.stderr.on("data", record);
    this.electron.once("error", (error) => this.fail(new Error(`Electron failed to start: ${error.message}`)));
    this.electron.once("exit", (code, signal) => this.fail(new Error(`Electron exited early (code=${code}, signal=${signal})`)));
  }

  /** The first unexpected failure; anything waiting rethrows it. */
  fail(error) {
    if (this.stopping || this.error) return;
    this.error = error;
  }

  async waitFor(predicate, label, timeoutMs = WAIT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      if (this.error) throw this.error;
      try {
        const value = await predicate();
        if (value) return value;
      } catch (error) {
        if (this.error) throw this.error;
        last = error;
      }
      await delay(POLL_MS);
    }
    throw new Error(`timed out waiting for ${label}${last ? `; last error: ${shortText(String(last.message ?? last))}` : ""}`);
  }

  async connectRenderer() {
    // The main window loads the renderer without a `surface` parameter; the
    // hidden plugin launcher loads the same page with `?surface=...`.
    const target = await this.waitFor(async () => (await listTargets(this.cdpPort)).find((candidate) => {
      if (candidate.type !== "page" || !candidate.webSocketDebuggerUrl) return false;
      const url = new URL(candidate.url);
      return url.protocol === "file:" && url.pathname.endsWith("/out/renderer/index.html") && !url.searchParams.has("surface");
    }), "the main window's renderer target");
    this.renderer = await CdpClient.connect(target.webSocketDebuggerUrl, (error) => this.fail(error));
    this.renderer.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      const text = exceptionDetails?.exception?.description || exceptionDetails?.text || "renderer exception";
      this.diagnostics.push(text);
      this.fail(new Error(`renderer exception: ${shortText(text)}`));
    });
    this.renderer.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type !== "error" && type !== "assert") return;
      const text = (args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" ");
      this.diagnostics.push(text);
      if (!this.expectedConsole.some((pattern) => pattern.test(text))) {
        this.fail(new Error(`renderer console ${type}: ${shortText(text)}`));
      }
    });
    await this.renderer.send("Runtime.enable");
    await this.renderer.send("Page.enable");
    // Focus-dependent UI (focus return, :focus-visible) behaves as if the
    // window were frontmost even while another app has focus.
    await this.renderer.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  }

  async connectMain() {
    const target = await this.waitFor(async () => (await listTargets(this.inspectorPort)).find(
      (candidate) => candidate.type === "node" && candidate.webSocketDebuggerUrl,
    ), "the Electron Main inspector target");
    this.main = await CdpClient.connect(target.webSocketDebuggerUrl, (error) => this.fail(error));
    await this.main.send("Runtime.enable");
    await this.waitFor(
      () => this.main.evaluateMain("typeof globalThis.__PI_HARBOR_PLAN_UI_PROBE === 'function'"),
      "the Plan UI probe in Main",
    );
  }

  /** Call the gated Plan UI probe in Main (`PI_HARBOR_PLAN_UI_PROBE=1`). */
  async planProbe(request) {
    const response = await this.main.evaluateMain(
      `globalThis.__PI_HARBOR_PLAN_UI_PROBE(${JSON.stringify(request)})`,
    );
    check(response?.ok === true, `Plan probe ${request.operation} failed: ${shortText(response)}`);
    return response;
  }

  async evaluate(expression) {
    try {
      return await this.renderer.evaluate(expression);
    } catch (error) {
      const what = expression.replace(/\s+/g, " ").trim().slice(0, 120);
      throw new Error(`${error instanceof Error ? error.message : String(error)} (evaluating: ${what})`);
    }
  }

  /** Call a preload channel the way `src/lib/api.ts` does; returns its `Result`. */
  async invokeResult(channel, ...args) {
    return this.evaluate(`(async () => {
      const bridge = window.piDesktop;
      const channel = bridge?.channels?.invoke?.[${JSON.stringify(channel)}];
      if (!channel) throw new Error("no preload channel " + ${JSON.stringify(channel)});
      return bridge.invoke(channel, ...${JSON.stringify(args)});
    })()`);
  }

  /** `invokeResult` for a call that must succeed; returns its data. */
  async invoke(channel, ...args) {
    const result = await this.invokeResult(channel, ...args);
    check(result?.ok === true, `${channel} failed: ${shortText(result)}`);
    return result.data;
  }

  /** Click the first visible, enabled match, waiting for it to appear. */
  async click(selector, { text, label = selector } = {}) {
    await this.waitFor(() => this.evaluate(`(() => {
      const wanted = ${JSON.stringify(text ?? null)};
      const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find((candidate) =>
        candidate instanceof HTMLElement && candidate.getClientRects().length > 0 && !candidate.disabled
          && (wanted === null || candidate.textContent.trim() === wanted));
      if (!node) return false;
      node.click();
      return true;
    })()`), `a clickable ${label}`);
  }

  /** A real key press through Chromium's input pipeline. */
  async pressKey(key, code = key, keyCode = 0) {
    for (const type of ["keyDown", "keyUp"]) {
      await this.renderer.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode });
    }
  }

  waitForShell() {
    return this.waitFor(() => this.evaluate(
      "Boolean(document.querySelector('.app-shell') && !document.querySelector('.app-shell.is-booting'))",
    ), "the app shell");
  }

  async reload() {
    const loaded = new Promise((resolveLoad) => {
      const off = this.renderer.on("Page.loadEventFired", () => {
        off();
        resolveLoad();
      });
    });
    await this.renderer.send("Page.reload");
    await Promise.race([loaded, delay(WAIT_TIMEOUT_MS, undefined, { ref: false })]);
    await this.waitForShell();
  }

  /** Select a session from its sidebar row, as a user does. */
  async selectSession(sessionId) {
    const id = JSON.stringify(sessionId);
    const row = `[data-sidebar-session-row=${JSON.stringify(sessionId)}]`;
    const how = await this.evaluate(`(async () => {
      const row = document.querySelector(${JSON.stringify(row)});
      const main = row?.querySelector("button.thread-item-main");
      if (main && main.getClientRects().length > 0) {
        main.click();
        return "row";
      }
      // A folded project or workspace node hides the row.
      await window.__PI_HARBOR__.selectSession(${id});
      return "store";
    })()`);
    await this.waitFor(() => this.evaluate(`(() => {
      const row = document.querySelector(${JSON.stringify(row)});
      return !row || row.classList.contains("active");
    })()`), `session ${sessionId} active (${how})`);
  }

  /** Page targets (docked plugin views included) whose URL matches. */
  async pageTargets(urlPattern) {
    return (await listTargets(this.cdpPort)).filter((target) =>
      target.type === "page" && target.webSocketDebuggerUrl && urlPattern.test(target.url));
  }

  /** A client for another page; its failures surface in that page's calls. */
  async attach(target) {
    const client = await CdpClient.connect(target.webSocketDebuggerUrl, () => undefined);
    this.pages.add(client);
    await client.send("Runtime.enable");
    return client;
  }

  async screenshot(label) {
    const { data } = await this.renderer.send("Page.captureScreenshot", { format: "png" });
    const path = join(this.artifactDir, `${this.name}-${label}.png`);
    await writeFile(path, Buffer.from(data, "base64"));
    return path;
  }

  async close() {
    this.stopping = true;
    for (const client of [...this.pages, this.renderer, this.main]) await client?.close();
    await stopTree(this.electron);
    if (this.tempRoot) await rm(this.tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/**
 * Launch once and run `cases` in order; each is `{ id, run(app) }`. A failure
 * stops the run: later cases depend on earlier state, so they report NOT RUN.
 */
export async function runScenario(name, launchOptions, cases) {
  const outcome = new Map();
  let app = null;
  let failure = null;
  try {
    app = await DesktopApp.launch(name, launchOptions);
    for (const { id, run } of cases) {
      const started = Date.now();
      try {
        const detail = await run(app);
        outcome.set(id, true);
        console.log(`PASS ${id} (${Date.now() - started} ms)${detail ? ` - ${detail}` : ""}`);
      } catch (error) {
        outcome.set(id, false);
        failure = error;
        console.log(`FAIL ${id} - ${error instanceof Error ? error.message : String(error)}`);
        const shot = await app.screenshot(id).catch(() => null);
        if (shot) console.log(`ARTIFACT ${shot}`);
        break;
      }
    }
  } catch (error) {
    failure = error;
    console.log(`FAIL launch - ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (failure && app?.output) console.log(`ELECTRON OUTPUT (tail)\n${app.output.slice(-3_000)}`);
    await app?.close().catch((error) => console.log(`FAIL cleanup - ${error.message}`));
  }
  for (const { id } of cases) if (!outcome.has(id)) console.log(`NOT RUN ${id}`);
  const passed = [...outcome.values()].filter(Boolean).length;
  console.log(`SUMMARY ${passed} passed, ${cases.length - passed} failed or not run`);
  if (passed !== cases.length) process.exitCode = 1;
  else if (app && !process.env.PI_HARBOR_E2E_ARTIFACT_DIR) await rm(app.artifactDir, { recursive: true, force: true });
}
