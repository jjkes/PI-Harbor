import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type LineHandler = (line: string) => Promise<void>;

const transport = vi.hoisted(() => ({
  handler: undefined as LineHandler | undefined,
}));
const host = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; params: unknown }>,
  projectPath: "",
  blockNextSessionGet: false,
  releaseSessionGet: undefined as (() => void) | undefined,
}));
const runtimeRegistry = vi.hoisted(() => ({
  constructors: 0,
  events: [] as string[],
}));

vi.mock("@pi-harbor/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pi-harbor/shared")>();
  return {
    ...actual,
    readNdjsonLines: (_stream: unknown, handler: LineHandler) => {
      transport.handler = handler;
    },
  };
});

vi.mock("./parent-host-proxy.js", () => ({
  ParentHostProxy: class {
    handleParentMessage(): boolean {
      return false;
    }

    async call(method: string, params: unknown): Promise<unknown> {
      host.calls.push({ method, params });
      if (method === "session.get") {
        if (host.blockNextSessionGet) {
          host.blockNextSessionGet = false;
          await new Promise<void>((resolve) => {
            host.releaseSessionGet = resolve;
          });
        }
        return { session: { projectPath: host.projectPath, messages: [] } };
      }
      throw new Error(`unexpected host call: ${method}`);
    }
  },
}));

vi.mock("./plan-debate-artifacts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plan-debate-artifacts.js")>();
  return {
    ...actual,
    removePlanDebateRound: async (projectPath: string, round: number) => {
      runtimeRegistry.events.push("remove:start");
      try {
        return await actual.removePlanDebateRound(projectPath, round);
      } finally {
        runtimeRegistry.events.push("remove:end");
      }
    },
  };
});

vi.mock("./runtime.js", () => ({
  DesktopAgentRuntime: class {
    constructor() {
      runtimeRegistry.constructors += 1;
      runtimeRegistry.events.push("runtime:create");
    }

    async loadTrustedExtensions(): Promise<void> {}

    getStatus() {
      return { isRunning: false, currentTurnId: undefined };
    }

    async prompt(): Promise<void> {
      runtimeRegistry.events.push("runtime:prompt");
    }
  },
}));
vi.mock("./node-proxy.js", () => ({ applyNodeNetworkProxy: () => {} }));
vi.mock("./system-ca.js", () => ({ applyAdditiveDefaultCaCertificates: () => {} }));

async function handler(): Promise<LineHandler> {
  await import("./sidecar.js");
  const registered = transport.handler;
  expect(registered).toBeDefined();
  if (!registered) throw new Error("sidecar input handler was not registered");
  return registered;
}

async function writeRound(projectPath: string, round: number): Promise<string> {
  const directory = join(projectPath, ".pi-harbor", "debate", `round-${round}`);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `round-${round}.json`),
    JSON.stringify({ version: 1, round, requirement: "disk only", seats: [] }),
    "utf8",
  );
  return directory;
}

function response(
  output: string[],
  id: number,
): { id?: number; result?: unknown; error?: unknown } | undefined {
  return output
    .map((line) => JSON.parse(line) as { id?: number; result?: unknown; error?: unknown })
    .find((message) => message.id === id);
}

describe("plan-debate sidecar artifact deletion", () => {
  const output: string[] = [];

  beforeEach(() => {
    output.length = 0;
    host.calls.length = 0;
    host.projectPath = "";
    host.blockNextSessionGet = false;
    host.releaseSessionGet = undefined;
    runtimeRegistry.constructors = 0;
    runtimeRegistry.events.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    host.releaseSessionGet?.();
    vi.restoreAllMocks();
  });

  it("deletes a disk round from its session project without an active runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sidecar-debate-delete-"));
    try {
      host.projectPath = root;
      const directory = await writeRound(root, 7);
      const handle = await handler();

      await handle(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "agent.planDebateDelete",
        params: { sessionId: "disk-only-session", round: 7, projectPath: root },
      }));

      expect(response(output, 1)?.result).toEqual({ ok: true, round: 7 });
      expect(runtimeRegistry.constructors).toBe(0);
      expect(host.calls).toEqual([{
        method: "session.get",
        params: { id: "disk-only-session", messageLimit: 1 },
      }]);
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a stale project binding without deleting either project's round", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sidecar-debate-project-check-"));
    const projectA = join(root, "a");
    const projectB = join(root, "b");
    try {
      const directoryA = await writeRound(projectA, 7);
      const directoryB = await writeRound(projectB, 7);
      host.projectPath = projectB;
      const handle = await handler();

      await handle(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "agent.planDebateDelete",
        params: { sessionId: "moved-session", round: 7, projectPath: projectA },
      }));

      expect(response(output, 2)?.result).toMatchObject({
        ok: false,
        round: 7,
        errorCode: "PLAN_DEBATE_PROJECT_CHANGED",
      });
      await expect(stat(directoryA)).resolves.toBeDefined();
      await expect(stat(directoryB)).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes fallback deletion with a prompt creating the session runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sidecar-debate-delete-lock-"));
    try {
      host.projectPath = root;
      const directory = await writeRound(root, 9);
      const handle = await handler();
      host.blockNextSessionGet = true;

      const deleting = handle(JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "agent.planDebateDelete",
        params: { sessionId: "delete-lock-session", round: 9, projectPath: root },
      }));
      await vi.waitFor(() => expect(host.calls).toHaveLength(1));
      const prompting = handle(JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "agent.prompt",
        params: {
          sessionId: "delete-lock-session",
          content: "start work",
          turnId: "turn-delete-lock",
          mode: "agent",
          projectPath: root,
          commandShell: {
            id: "bash",
            label: "Bash",
            executable: "/bin/bash",
            dialect: "posix",
            available: true,
            isDefault: true,
            args: [],
          },
          provider: {
            id: "fixture",
            name: "Fixture",
            modelId: "fixture",
            apiKey: "",
            authKind: "none",
            apiStyle: "openai-chat",
            baseUrl: "http://127.0.0.1:1/v1",
          },
        },
      }));

      await Promise.resolve();
      await Promise.resolve();
      expect(runtimeRegistry.constructors).toBe(0);
      expect(host.calls).toHaveLength(1);
      host.releaseSessionGet?.();
      await Promise.all([deleting, prompting]);

      expect(response(output, 3)?.result).toEqual({ ok: true, round: 9 });
      expect(response(output, 4)?.result).toMatchObject({ accepted: true });
      expect(runtimeRegistry.events).toEqual([
        "remove:start",
        "remove:end",
        "runtime:create",
        "runtime:prompt",
      ]);
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
