import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanExecution, UiMessage } from "@pi-harbor/shared";

type LineHandler = (line: string) => Promise<void>;
type FakeRuntimeOptions = {
  sessionId: string;
  provider: { id: string; modelId: string };
  history: UiMessage[];
};

const transport = vi.hoisted(() => ({
  handler: undefined as LineHandler | undefined,
}));
const host = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; params: unknown }>,
  messages: [] as UiMessage[],
}));
const runtimeRegistry = vi.hoisted(() => ({
  instances: [] as FakeRuntime[],
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
        return { session: { messages: host.messages } };
      }
      throw new Error(`unexpected host call: ${method}`);
    }
  },
}));

class FakeRuntime {
  readonly sessionId: string;
  readonly provider: { id: string; modelId: string };
  readonly history: UiMessage[];
  readonly executeApprovedPlan = vi.fn(async (_execution: PlanExecution, turnId: string) => ({
    turnId,
  }));
  disposed = false;

  constructor(options: FakeRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.provider = options.provider;
    this.history = options.history;
    runtimeRegistry.instances.push(this);
  }

  getStatus() {
    return { isRunning: false, currentTurnId: undefined, planningState: "inactive" };
  }

  firstMismatch(config: { provider: { id: string; modelId: string } }): string | null {
    if (this.provider.id !== config.provider.id) return "provider.id";
    if (this.provider.modelId !== config.provider.modelId) return "provider.modelId";
    return null;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  async loadTrustedExtensions(): Promise<void> {}
}

vi.mock("./runtime.js", () => ({ DesktopAgentRuntime: FakeRuntime }));
vi.mock("./node-proxy.js", () => ({ applyNodeNetworkProxy: () => {} }));
vi.mock("./system-ca.js", () => ({ applyAdditiveDefaultCaCertificates: () => {} }));

function execution(id: string): PlanExecution {
  return {
    id,
    proposalId: `proposal-${id}`,
    sessionId: "session-1",
    kind: "plan",
    plan: "# Approved",
    title: "Approved",
    question: "Continue?",
    artifact: { relativePath: ".pi/plan/approved.md", sha256: "abc", sizeBytes: 10 },
    targetPermissionMode: "auto",
    state: "running",
  };
}

function params(providerId: string, modelId: string, executionId: string, turnId: string) {
  return {
    sessionId: "session-1",
    turnId,
    execution: execution(executionId),
    provider: {
      id: providerId,
      modelId,
      apiKey: "",
      authKind: "none",
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
      modelConfig: { input: ["text"] },
    },
    thinkingLevel: "off",
    commandShell: {
      id: "bash",
      label: "Bash",
      dialect: "posix",
      available: true,
      isDefault: true,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  transport.handler = undefined;
  host.calls.length = 0;
  host.messages = [];
  runtimeRegistry.instances.length = 0;
});

describe("approved-plan sidecar runtime replacement", () => {
  it("rebuilds on a provider change before executeApprovedPlan and restores host history", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    host.messages = [{
      id: "history-1",
      role: "user",
      content: "Planning context",
      status: "complete",
      createdAt: "2026-10-28T00:00:00.000Z",
    }];
    await import("./sidecar.js");
    const handler = transport.handler;
    expect(handler).toBeDefined();
    if (!handler) throw new Error("sidecar input handler was not registered");

    await handler(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "agent.executeApprovedPlan",
      params: params("provider-a", "model-a", "execution-1", "turn-1"),
    }));
    await handler(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "agent.executeApprovedPlan",
      params: params("provider-b", "model-b", "execution-2", "turn-2"),
    }));

    expect(runtimeRegistry.instances).toHaveLength(2);
    const [planning, executionRuntime] = runtimeRegistry.instances;
    expect(planning.disposed).toBe(true);
    expect(executionRuntime.provider).toMatchObject({ id: "provider-b", modelId: "model-b" });
    expect(executionRuntime.history).toMatchObject([{ id: "history-1", content: "Planning context" }]);
    expect(executionRuntime.executeApprovedPlan).toHaveBeenCalledWith(execution("execution-2"), "turn-2");
    expect(host.calls.filter((call) => call.method === "session.get")).toHaveLength(2);
  });
});
