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
  methodCalls: [] as Array<{ method: string; args: unknown[] }>,
  lastConfig: undefined as Record<string, unknown> | undefined,
  lastPrompt: undefined as unknown[] | undefined,
  retryResponse: undefined as
    | { ok: true; round: number; sourceRoundId: number; proposed: boolean; started?: boolean; phase?: string }
    | { ok: false; errorCode: string; message: string; retryable?: boolean }
    | undefined,
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
    removePlanDebateRound: async (projectPath: string, round: number, sessionId?: string) => {
      runtimeRegistry.events.push("remove:start");
      try {
        return await actual.removePlanDebateRound(projectPath, round, sessionId);
      } finally {
        runtimeRegistry.events.push("remove:end");
      }
    },
  };
});

vi.mock("./runtime.js", () => ({
  DesktopAgentRuntime: class {
    private config: Record<string, unknown>;

    constructor(config: Record<string, unknown>) {
      runtimeRegistry.constructors += 1;
      runtimeRegistry.events.push("runtime:create");
      runtimeRegistry.lastConfig = config;
      this.config = config;
    }

    async loadTrustedExtensions(): Promise<void> {}

    getStatus() {
      return { isRunning: false, currentTurnId: undefined };
    }

    firstMismatch(candidate: Record<string, unknown>) {
      // Only team changes matter for these handoff tests; everything else is
      // considered compatible so the same runtime can be reused.
      const a = JSON.stringify(this.config?.team);
      const b = JSON.stringify(candidate?.team);
      return a === b ? null : "team";
    }

    setPluginSkills() {}
    setCompactionSettings() {}
    setInfiniteProviderRetry() {}
    setFastMode() {}
    setMode() {}
    async dispose() {}

    async startPlanDebate(round: number) {
      runtimeRegistry.methodCalls.push({ method: "startPlanDebate", args: [round] });
      return { ok: true, started: true, round, delegationIds: ["d-1"] };
    }

    async endPlanDebate(round: number) {
      runtimeRegistry.methodCalls.push({ method: "endPlanDebate", args: [round] });
      return { ok: true, stopped: true, round, delegationIds: [] };
    }

    async cancelPlanDebate(round: number) {
      runtimeRegistry.methodCalls.push({ method: "cancelPlanDebate", args: [round] });
      return { ok: true, cancelled: true, round, stopTimedOut: false };
    }

    async retryPlanDebate(sourceRound: number) {
      runtimeRegistry.methodCalls.push({ method: "retryPlanDebate", args: [sourceRound] });
      if (runtimeRegistry.retryResponse) return runtimeRegistry.retryResponse;
      return { ok: true, round: sourceRound + 1, sourceRoundId: sourceRound, proposed: true, started: true };
    }

    async deletePlanDebate(round: number) {
      runtimeRegistry.methodCalls.push({ method: "deletePlanDebate", args: [round] });
      return { ok: true, round, stopTimedOut: false };
    }

    async prompt(...args: unknown[]): Promise<void> {
      runtimeRegistry.events.push("runtime:prompt");
      runtimeRegistry.lastPrompt = args;
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

async function writeRound(
  projectPath: string,
  round: number,
  sessionId = "disk-only-session",
): Promise<string> {
  const directory = join(projectPath, ".pi-harbor", "debate", sessionId, `round-${round}`);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `round-${round}.json`),
    JSON.stringify({ version: 2, sessionId, round, requirement: "disk only", seats: [] }),
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
    runtimeRegistry.lastConfig = undefined;
    runtimeRegistry.lastPrompt = undefined;
    runtimeRegistry.retryResponse = undefined;
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
      const directory = await writeRound(root, 9, "delete-lock-session");
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

describe("plan-debate sidecar handoff", () => {
  const output: string[] = [];

  beforeEach(() => {
    output.length = 0;
    host.calls.length = 0;
    host.projectPath = "/tmp/handoff-project";
    host.blockNextSessionGet = false;
    host.releaseSessionGet = undefined;
    runtimeRegistry.constructors = 0;
    runtimeRegistry.events.length = 0;
    runtimeRegistry.lastConfig = undefined;
    runtimeRegistry.lastPrompt = undefined;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseParams = {
    sessionId: "handoff-session",
    content: "selected plan text",
    turnId: "turn-handoff-1",
    userMessageId: "msg-handoff-1",
    mode: "agent",
    projectPath: "/tmp/handoff-project",
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
  };

  it("routes a single-agent handoff to the runtime prompt", async () => {
    const handle = await handler();

    await handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "agent.planDebateHandoff",
      params: { ...baseParams, targetMode: "single-agent" },
    }));

    expect(response(output, 10)?.result).toMatchObject({
      accepted: true,
      turnId: "turn-handoff-1",
    });
    expect(runtimeRegistry.constructors).toBe(1);
    expect(runtimeRegistry.events).toEqual(["runtime:create", "runtime:prompt"]);
    expect(runtimeRegistry.lastConfig?.team).toBeUndefined();
    expect(runtimeRegistry.lastPrompt?.[0]).toMatchObject({
      text: "selected plan text",
    });
  });

  it("enables team mode on the runtime for a team handoff", async () => {
    const handle = await handler();

    await handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "agent.planDebateHandoff",
      params: {
        ...baseParams,
        targetMode: "team",
        team: { enabled: true, revision: 7 },
      },
    }));

    expect(response(output, 11)?.result).toMatchObject({
      accepted: true,
      turnId: "turn-handoff-1",
    });
    expect(runtimeRegistry.lastConfig?.team).toEqual({
      enabled: true,
      revision: 7,
    });
  });

  it("rejects empty handoff content before touching the runtime", async () => {
    const handle = await handler();

    await handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      method: "agent.planDebateHandoff",
      params: { ...baseParams, content: "   " },
    }));

    expect(response(output, 12)?.error).toMatchObject({
      data: { errorCode: "INVALID_ARGUMENT" },
    });
    expect(runtimeRegistry.constructors).toBe(0);
    expect(runtimeRegistry.events).toEqual([]);
  });
});
describe("plan-debate sidecar sessionId validation", () => {
  const output: string[] = [];

  beforeEach(() => {
    output.length = 0;
    host.calls.length = 0;
    runtimeRegistry.constructors = 0;
    runtimeRegistry.events.length = 0;
    runtimeRegistry.methodCalls.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    "agent.planDebateStart",
    "agent.planDebateEnd",
    "agent.planDebateCancel",
    "agent.planDebateRetry",
    "agent.planDebateDelete",
    "agent.planDebateHandoff",
  ])("rejects empty sessionId for %s", async (method) => {
    const handle = await handler();

    await handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: method === "agent.planDebateHandoff"
        ? { sessionId: "   ", content: "handoff text" }
        : method === "agent.planDebateRetry"
          ? { sessionId: "", sourceRound: 1 }
          : { sessionId: null, round: 1 },
    }));

    expect(response(output, 1)?.error).toMatchObject({
      data: { errorCode: "INVALID_ARGUMENT" },
    });
    expect(runtimeRegistry.constructors).toBe(0);
  });

  it("rejects whitespace-only sessionId for handoff", async () => {
    const handle = await handler();

    await handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "agent.planDebateHandoff",
      params: { sessionId: "\t\n", content: "handoff text" },
    }));

    expect(response(output, 2)?.error).toMatchObject({
      data: { errorCode: "INVALID_ARGUMENT" },
    });
  });
});

describe("plan-debate sidecar cancel and retry", () => {
  const output: string[] = [];
  const baseParams = {
    sessionId: "cancel-retry-session",
    content: "start work",
    turnId: "turn-cancel-retry-1",
    mode: "agent",
    projectPath: "/tmp/cancel-retry-project",
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
  };

  beforeEach(() => {
    output.length = 0;
    host.calls.length = 0;
    host.projectPath = "/tmp/cancel-retry-project";
    host.blockNextSessionGet = false;
    host.releaseSessionGet = undefined;
    runtimeRegistry.constructors = 0;
    runtimeRegistry.events.length = 0;
    runtimeRegistry.methodCalls.length = 0;
    runtimeRegistry.lastConfig = undefined;
    runtimeRegistry.lastPrompt = undefined;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function ensureRuntime(handle: LineHandler): Promise<void> {
    await handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "agent.prompt",
      params: baseParams,
    }));
    expect(response(output, 1)?.result).toMatchObject({ accepted: true });
  }

  it("routes agent.planDebateCancel to the runtime", async () => {
    const handle = await handler();
    await ensureRuntime(handle);

    await handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "agent.planDebateCancel",
      params: { sessionId: baseParams.sessionId, round: 3 },
    }));

    expect(response(output, 2)?.result).toEqual({
      ok: true,
      cancelled: true,
      round: 3,
      stopTimedOut: false,
    });
    expect(runtimeRegistry.methodCalls).toEqual([
      { method: "cancelPlanDebate", args: [3] },
    ]);
  });

  it("routes agent.planDebateRetry to the runtime", async () => {
    const handle = await handler();
    await ensureRuntime(handle);

    await handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "agent.planDebateRetry",
      params: { sessionId: baseParams.sessionId, sourceRound: 5 },
    }));

    expect(response(output, 3)?.result).toEqual({
      ok: true,
      round: 6,
      sourceRoundId: 5,
      proposed: true,
      started: true,
    });
    expect(runtimeRegistry.methodCalls).toEqual([
      { method: "retryPlanDebate", args: [5] },
    ]);
  });

  it("returns NOT_FOUND when the session has no runtime", async () => {
    const handle = await handler();

    await handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "agent.planDebateCancel",
      params: { sessionId: "missing-session", round: 1 },
    }));
    expect(response(output, 4)?.error).toMatchObject({
      data: { errorCode: "PLAN_DEBATE_NOT_FOUND" },
    });

    await handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "agent.planDebateRetry",
      params: { sessionId: "missing-session", sourceRound: 1 },
    }));
    expect(response(output, 5)?.error).toMatchObject({
      data: { errorCode: "PLAN_DEBATE_NOT_FOUND" },
    });
    expect(runtimeRegistry.constructors).toBe(0);
  });

  it("rejects invalid round arguments", async () => {
    const handle = await handler();
    await ensureRuntime(handle);

    await handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "agent.planDebateCancel",
      params: { sessionId: baseParams.sessionId, round: 0 },
    }));
    expect(response(output, 6)?.error).toMatchObject({
      data: { errorCode: "INVALID_ARGUMENT" },
    });

    await handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "agent.planDebateRetry",
      params: { sessionId: baseParams.sessionId, sourceRound: -1 },
    }));
    expect(response(output, 7)?.error).toMatchObject({
      data: { errorCode: "INVALID_ARGUMENT" },
    });
    expect(runtimeRegistry.methodCalls).toEqual([]);
  });

  it("returns the current phase when a retry round is already running", async () => {
    const handle = await handler();
    await ensureRuntime(handle);
    runtimeRegistry.retryResponse = {
      ok: true,
      round: 6,
      sourceRoundId: 5,
      proposed: false,
      started: false,
      phase: "draft",
    };

    await handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "agent.planDebateRetry",
      params: { sessionId: baseParams.sessionId, sourceRound: 5 },
    }));

    expect(response(output, 8)?.result).toEqual({
      ok: true,
      round: 6,
      sourceRoundId: 5,
      proposed: false,
      started: false,
      phase: "draft",
    });
  });

  it("surfaces a retryable start failure so the panel can retry again", async () => {
    const handle = await handler();
    await ensureRuntime(handle);
    runtimeRegistry.retryResponse = {
      ok: false,
      errorCode: "PLAN_DEBATE_UNAVAILABLE",
      message: "No debate delegate could be started.",
      retryable: true,
    };

    await handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "agent.planDebateRetry",
      params: { sessionId: baseParams.sessionId, sourceRound: 5 },
    }));

    expect(response(output, 9)?.result).toMatchObject({
      ok: false,
      errorCode: "PLAN_DEBATE_UNAVAILABLE",
      retryable: true,
    });
  });
});
