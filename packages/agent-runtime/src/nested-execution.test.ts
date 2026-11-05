import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { CommandShellOption, SubagentDefinition } from "@pi-harbor/shared";
import { SESSION_ORCHESTRATOR_TASK_TOOL_NAME } from "./team-policy.js";
import { DEFAULT_DELEGATION_GUIDANCE } from "./delegation-guidance.js";
import { TEAM_MODE_GUIDANCE } from "./team-prompts.js";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

const nestedState = vi.hoisted(() => ({
  scenario: "success" as "success" | "cascade" | "worktree" | "barrier" | "idle",
  requests: [] as Array<{
    agentName: string;
    parentToolCallId: string;
    toolNames: string[];
    messages: unknown;
  }>,
  constructions: [] as any[],
  l2Id: undefined as string | undefined,
  releaseL2: undefined as (() => void) | undefined,
}));

vi.mock("./subagent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent.js")>();
  return {
    ...actual,
    SubagentRun: class extends actual.SubagentRun {
      constructor(options: any) {
        super(options);
        nestedState.constructions.push(options);
        if (options.definition.name === "worker") {
          nestedState.l2Id = options.delegationId;
        }
        let requestIndex = 0;
        (this as any).agent.streamFunction = (
          _model: unknown,
          context: { messages: unknown; tools?: Array<{ name: string }> },
          streamOptions: { signal?: AbortSignal },
        ) => {
          nestedState.requests.push({
            agentName: options.definition.name,
            parentToolCallId: options.parentToolCallId,
            toolNames: (this as any).agent.state.tools.map((tool: { name: string }) => tool.name),
            messages: context.messages,
          });
          return scriptedStream(
            options.definition.name,
            requestIndex++,
            streamOptions,
          );
        };
      }
    },
  };
});

function assistantMessage(overrides: {
  content: unknown[];
  stopReason?: string;
}): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "local",
    model: "local-model",
    stopReason: overrides.stopReason ?? "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: overrides.content,
  } as AssistantMessage;
}

function immediateStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    stream.end(message);
  });
  return stream;
}

function pendingL2Stream(options: { signal?: AbortSignal }) {
  const stream = createAssistantMessageEventStream();
  let finished = false;
  const finish = (aborted: boolean) => {
    if (finished) return;
    finished = true;
    const message = assistantMessage({
      content: aborted
        ? []
        : [{ type: "text", text: "L2 report" }],
      stopReason: aborted ? "aborted" : "stop",
    });
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: "stop",
        message,
      });
      stream.end(message);
    });
  };
  if (nestedState.scenario === "barrier" || nestedState.scenario === "idle") {
    nestedState.releaseL2 = () => finish(false);
  }
  if (options.signal?.aborted) finish(true);
  else options.signal?.addEventListener("abort", () => finish(true), { once: true });
  return stream;
}

function scriptedStream(
  agentName: string,
  requestIndex: number,
  options: { signal?: AbortSignal },
) {
  if (agentName === "worker") {
    if (nestedState.scenario === "cascade" || nestedState.scenario === "barrier" || nestedState.scenario === "idle") {
      return requestIndex === 0
        ? pendingL2Stream(options)
        : immediateStream(assistantMessage({ content: [{ type: "text", text: "L2 report" }] }));
    }
    if (nestedState.scenario === "success" && requestIndex === 0) {
      return immediateStream(assistantMessage({
        content: [{
          type: "toolCall",
          id: "l2-forbidden-task",
          name: "Task",
          arguments: { agent: "worker", task: "Start an illegal L3." },
        }],
        stopReason: "toolUse",
      }));
    }
    return immediateStream(assistantMessage({
      content: [{ type: "text", text: "L2 report" }],
    }));
  }

  if (requestIndex === 0) {
    return immediateStream(assistantMessage({
      content: [{
        type: "toolCall",
        id: "l1-nested-task",
        name: "Task",
        arguments: { agent: "worker", task: "Produce the L2 report." },
      }],
      stopReason: "toolUse",
    }));
  }
  if (nestedState.scenario === "idle" && requestIndex === 1) {
    return immediateStream(assistantMessage({
      content: [{ type: "text", text: "L1 interim before idle" }],
    }));
  }
  if (requestIndex === 1) {
    return immediateStream(assistantMessage({
      content: [{
        type: "toolCall",
        id: "l1-wait",
        name: "TaskWait",
        arguments: { delegationIds: [nestedState.l2Id] },
      }],
      stopReason: "toolUse",
    }));
  }
  return immediateStream(assistantMessage({
    content: [{ type: "text", text: "L1 final with L2" }],
  }));
}

const provider: RuntimeProviderConfig = {
  id: "local",
  name: "Local",
  baseUrl: "http://127.0.0.1:11434/v1",
  modelId: "local-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};
const commandShell: CommandShellOption = {
  id: "bash",
  label: "Bash",
  dialect: "posix",
  available: true,
  isDefault: true,
};

function definition(
  name: string,
  tools: string[],
): SubagentDefinition {
  return {
    name,
    description: `${name} test delegate`,
    tools,
    prompt: `Run as ${name}.`,
    source: "builtin",
  };
}

function harness(
  scenario: typeof nestedState.scenario,
  definitions: SubagentDefinition[],
  options: {
    workspaceRoot?: string;
    team?: boolean;
    sessionSpawner?: boolean;
  } = {},
) {
  nestedState.scenario = scenario;
  nestedState.requests.length = 0;
  nestedState.constructions.length = 0;
  nestedState.l2Id = undefined;
  nestedState.releaseL2 = undefined;
  const events: any[] = [];
  const host = {
    call: vi.fn(async (method: string, _args: unknown) => {
      if (method === "worktree.delegate.create") {
        return { worktree: { branch: "pi-harbor/test", status: "active" } };
      }
      if (method === "worktree.delegate.settle") {
        return { settlement: { result: "merged", commits: 1 } };
      }
      if (method === "tools.execute") return { ok: true, content: {} };
      return undefined;
    }),
    onNotification: vi.fn(() => () => {}),
  };
  const runtime = new DesktopAgentRuntime({
    host: host as never,
    sessionId: "nested-session",
    mode: "agent",
    provider,
    commandShell,
    thinkingLevel: "off",
    subagents: definitions,
    pluginTools: options.sessionSpawner
      ? [{
          name: SESSION_ORCHESTRATOR_TASK_TOOL_NAME,
          description: "External agent spawner",
          parameters: Type.Object({}),
        }]
      : [],
    projectPath: "/project",
    workspaceRoot: options.workspaceRoot,
    team: options.team === false ? undefined : { enabled: true, revision: 1 },
    onEvent: (envelope) => events.push(envelope),
  });
  return { runtime, events, host };
}

function rootTool(runtime: DesktopAgentRuntime, name: string) {
  return (runtime as any).agent.state.tools.find(
    (tool: { name: string }) => tool.name === name,
  );
}

async function startRoot(runtime: DesktopAgentRuntime) {
  return rootTool(runtime, "Task").execute("root-task", {
    agent: "explorer",
    task: "Delegate to the worker.",
  });
}

function records(runtime: DesktopAgentRuntime) {
  return (runtime as any).delegations.all() as any[];
}

async function waitForStatus(
  runtime: DesktopAgentRuntime,
  delegationId: string,
  status: string,
) {
  await vi.waitFor(
    () => {
      expect((runtime as any).delegations.get(delegationId)?.status).toBe(status);
    },
    { timeout: 10_000 },
  );
}

describe("nested delegation execution", () => {
  it("runs L0 to L1 to L2 with scoped reports, lineage, and no L3 Task", async () => {
    const sessionSpawner = SESSION_ORCHESTRATOR_TASK_TOOL_NAME;
    const { runtime, events } = harness("success", [
      { ...definition("explorer", []), inheritTools: true },
      { ...definition("worker", []), inheritTools: true },
    ], { sessionSpawner: true });
    try {
      const started = await startRoot(runtime);
      const rootId = started.details.delegationId as string;
      await waitForStatus(runtime, rootId, "completed");

      const all = records(runtime);
      expect(all).toHaveLength(2);
      const child = all.find((record) => record.depth === 2);
      expect(child).toMatchObject({
        ownerDelegationId: rootId,
        parentToolCallId: "l1-nested-task",
        status: "completed",
      });
      const l1Requests = nestedState.requests.filter((request) => request.agentName === "explorer");
      const l2Requests = nestedState.requests.filter((request) => request.agentName === "worker");
      expect(l1Requests[0].toolNames).toEqual(
        expect.arrayContaining(["Task", "TaskWait", "TaskList", "TaskStop"]),
      );
      expect(l1Requests[0].toolNames).not.toContain(sessionSpawner);
      expect(l2Requests[0].toolNames).not.toEqual(
        expect.arrayContaining(["Task", "TaskWait", "TaskList", "TaskStop", sessionSpawner]),
      );
      expect(l2Requests.length).toBeGreaterThan(1);
      expect(JSON.stringify(l1Requests[2].messages)).toContain("L2 report");

      const rootList = await rootTool(runtime, "TaskList").execute("root-list", {});
      expect(rootList.details.delegations.map((record: any) => record.delegationId)).toEqual([rootId]);
      const rootWait = await rootTool(runtime, "TaskWait").execute("root-wait", {
        delegationIds: [rootId],
      });
      expect(rootWait.details.delegations).toHaveLength(1);
      expect(rootWait.content[0].text).toContain("L1 final with L2");

      const nestedStart = events.find((envelope) =>
        envelope.event.type === "tool_start" &&
        envelope.event.toolCallId === "l1-nested-task"
      );
      expect(nestedStart).toMatchObject({
        parentToolCallId: "root-task",
        agentName: "explorer",
      });
      const settledNestedTask = events.find((envelope) =>
        envelope.event.type === "message_end" &&
        envelope.event.message.role === "tool" &&
        envelope.event.message.toolCallId === "l1-nested-task" &&
        envelope.event.message.toolResult?.details?.status === "completed"
      );
      expect(settledNestedTask.event.message).toMatchObject({
        id: "l1-nested-task",
        parentToolCallId: "root-task",
        agentName: "explorer",
      });
      const l2Message = events.find((envelope) =>
        envelope.event.type === "message_end" &&
        envelope.event.message.role === "assistant" &&
        envelope.event.message.agentName === "worker"
      );
      expect(l2Message).toMatchObject({
        parentToolCallId: "l1-nested-task",
        agentName: "worker",
      });
      const forbidden = events.find((envelope) =>
        envelope.event.type === "tool_end" &&
        envelope.event.toolCallId === "l2-forbidden-task"
      );
      expect(forbidden).toMatchObject({
        parentToolCallId: "l1-nested-task",
        agentName: "worker",
        event: { isError: true },
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("holds an idle L1 open, delivers L2 reports, and persists the barrier prompt", async () => {
    const { runtime, events } = harness("idle", [
      definition("explorer", ["Read"]),
      definition("worker", ["Read"]),
    ]);
    try {
      const started = await startRoot(runtime);
      const rootId = started.details.delegationId as string;
      await vi.waitFor(() => {
        expect(nestedState.requests.filter((request) => request.agentName === "explorer")).toHaveLength(2);
        expect(nestedState.releaseL2).toBeDefined();
        expect((runtime as any).delegations.get(rootId)?.status).toBe("running");
      });
      expect(records(runtime).find((record) => record.depth === 2)?.status).toBe("running");

      nestedState.releaseL2!();
      await waitForStatus(runtime, rootId, "completed");

      const l1Requests = nestedState.requests.filter((request) => request.agentName === "explorer");
      expect(l1Requests).toHaveLength(3);
      expect(JSON.stringify(l1Requests[2].messages)).toContain("L2 report");
      expect(JSON.stringify(l1Requests[2].messages)).toContain("The following subagents you started have finished");
      const rootWait = await rootTool(runtime, "TaskWait").execute("root-idle-wait", {
        delegationIds: [rootId],
      });
      expect(rootWait.content[0].text).toContain("L1 final with L2");
      expect(records(runtime).find((record) => record.depth === 2)?.status).toBe("completed");

      const promptRow = events.find((envelope) =>
        envelope.event.type === "message_end" &&
        envelope.event.message.role === "user" &&
        envelope.event.message.content?.includes("L2 report")
      );
      expect(promptRow).toMatchObject({
        parentToolCallId: "root-task",
        agentName: "explorer",
      });
      expect(
        (runtime as any).transcriptHistory.some(
          (row: any) => row.id === promptRow.event.message.id,
        ),
      ).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it("cascade-stops an L1 and its running L2", async () => {
    const { runtime } = harness("cascade", [
      definition("explorer", ["Read"]),
      definition("worker", ["Read"]),
    ]);
    try {
      const started = await startRoot(runtime);
      const rootId = started.details.delegationId as string;
      await vi.waitFor(() => {
        expect((runtime as any).delegations.ownedBy(rootId)).toHaveLength(1);
        expect(nestedState.requests.some((request) => request.agentName === "worker")).toBe(true);
      });

      const stopped = await runtime.stopSubagents([rootId]);

      expect(stopped.details.stopped.map((record: any) => record.delegationId)).toEqual([
        rootId,
        (runtime as any).delegations.ownedBy(rootId)[0].delegationId,
      ]);
      for (const record of records(runtime)) {
        expect(record.status).toBe("stopped");
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("shares the owner worktree without letting L2 settle it", async () => {
    const { runtime, host } = harness("worktree", [
      definition("explorer", ["Read", "Edit"]),
      definition("worker", ["Read", "Edit"]),
    ], { workspaceRoot: "/worktrees/session" });
    try {
      const started = await startRoot(runtime);
      const rootId = started.details.delegationId as string;
      await waitForStatus(runtime, rootId, "completed");
      const child = (runtime as any).delegations.ownedBy(rootId)[0];
      const owner = (runtime as any).delegations.get(rootId);

      expect(owner).toMatchObject({ worktreeKey: rootId, ownsWorktree: true });
      expect(child).toMatchObject({ worktreeKey: rootId, ownsWorktree: false });
      expect(host.call.mock.calls.filter(([method]) => method === "worktree.delegate.create")).toHaveLength(1);
      const settlements = host.call.mock.calls.filter(([method]) => method === "worktree.delegate.settle");
      expect(settlements).toHaveLength(1);
      expect(settlements[0][1]).toMatchObject({ delegationId: rootId, merge: true });
    } finally {
      await runtime.dispose();
    }
  });

  it("creates and settles an L2-owned worktree when the owner has none", async () => {
    const { runtime, host } = harness("worktree", [
      definition("explorer", ["Read", "Bash"]),
      definition("worker", ["Read", "Edit"]),
    ], { workspaceRoot: "/worktrees/session" });
    try {
      const started = await startRoot(runtime);
      const rootId = started.details.delegationId as string;
      await waitForStatus(runtime, rootId, "completed");
      const child = (runtime as any).delegations.ownedBy(rootId)[0];
      const owner = (runtime as any).delegations.get(rootId);

      expect(owner.worktreeKey).toBeUndefined();
      expect(owner.ownsWorktree).toBe(false);
      expect(child).toMatchObject({
        worktreeKey: child.delegationId,
        ownsWorktree: true,
      });
      expect(host.call.mock.calls.filter(([method]) => method === "worktree.delegate.create")).toHaveLength(1);
      const settlements = host.call.mock.calls.filter(([method]) => method === "worktree.delegate.settle");
      expect(settlements).toHaveLength(1);
      expect(settlements[0][1]).toMatchObject({ delegationId: child.delegationId, merge: true });
    } finally {
      await runtime.dispose();
    }
  });

  it("waits for preceding writable L2 calls using only the L1 message", async () => {
    const { runtime } = harness("barrier", [
      definition("explorer", ["Read", "Edit"]),
      definition("worker", ["Read", "Edit"]),
    ]);
    try {
      const started = await startRoot(runtime);
      const rootId = started.details.delegationId as string;
      await vi.waitFor(() => {
        expect((runtime as any).delegations.ownedBy(rootId)).toHaveLength(1);
        expect(nestedState.releaseL2).toBeDefined();
      });
      const ownerOptions = nestedState.constructions.find(
        (options) => options.parentToolCallId === "root-task",
      );
      (runtime as any).agent.state.messages = [];
      let released = false;
      const pending = ownerOptions.beforeToolCall({
        assistantMessage: assistantMessage({
          content: [
            { type: "toolCall", id: "l1-nested-task", name: "Task", arguments: {} },
            { type: "toolCall", id: "l1-read", name: "Read", arguments: { path: "a.ts" } },
          ],
          stopReason: "toolUse",
        }),
        toolCall: { id: "l1-read", name: "Read", arguments: { path: "a.ts" } },
        args: { path: "a.ts" },
        context: { messages: [], tools: ownerOptions.tools },
      }).then(() => {
        released = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(released).toBe(false);

      nestedState.releaseL2!();
      await pending;
      expect(released).toBe(true);
      await waitForStatus(runtime, rootId, "completed");
    } finally {
      await runtime.dispose();
    }
  });

  it("does not add nested tools or filter SessionTask when Team mode is off", async () => {
    const sessionSpawner = SESSION_ORCHESTRATOR_TASK_TOOL_NAME;
    const { runtime } = harness("worktree", [
      definition("explorer", ["Read", sessionSpawner]),
    ], { sessionSpawner: true, team: false });
    try {
      await startRoot(runtime);
      await vi.waitFor(() => {
        expect(nestedState.requests.some((request) => request.agentName === "explorer")).toBe(true);
      });
      const request = nestedState.requests.find((request) => request.agentName === "explorer");
      expect(request?.toolNames).toContain(sessionSpawner);
      expect(request?.toolNames).not.toEqual(
        expect.arrayContaining(["Task", "TaskWait", "TaskList", "TaskStop"]),
      );
    } finally {
      await runtime.dispose();
    }
  });
});

describe("Team mode main-agent steering and boundary (ADR 0339)", () => {
  function systemPrompt(runtime: DesktopAgentRuntime): string {
    return (runtime as any).agent.state.systemPrompt as string;
  }

  it("keeps registry-bypassing spawners out of the main agent catalog in Team mode only", async () => {
    const sessionSpawner = SESSION_ORCHESTRATOR_TASK_TOOL_NAME;
    const team = harness("success", [definition("explorer", ["Read"])], { sessionSpawner: true });
    try {
      const internal = team.runtime as any;
      expect(internal.toolCatalog.has(sessionSpawner)).toBe(false);
      expect(internal.deferredToolNames.has(sessionSpawner)).toBe(false);
      expect(internal.toolCatalog.has("Task")).toBe(true);
    } finally {
      await team.runtime.dispose();
    }
    const solo = harness("success", [definition("explorer", ["Read"])], {
      sessionSpawner: true,
      team: false,
    });
    try {
      expect((solo.runtime as any).toolCatalog.has(sessionSpawner)).toBe(true);
    } finally {
      await solo.runtime.dispose();
    }
  });

  it("replaces the Delegation section with Team mode steering based on the mode alone", async () => {
    const teamA = harness("success", [definition("explorer", ["Read"])]);
    const promptA = systemPrompt(teamA.runtime);
    await teamA.runtime.dispose();
    const teamB = harness("success", [
      definition("explorer", ["Read"]),
      { ...definition("worker", []), inheritTools: true },
    ]);
    const promptB = systemPrompt(teamB.runtime);
    await teamB.runtime.dispose();
    const solo = harness("success", [definition("explorer", ["Read"])], { team: false });
    const soloPrompt = systemPrompt(solo.runtime);
    await solo.runtime.dispose();

    expect(promptA).toContain(TEAM_MODE_GUIDANCE);
    expect(promptA).not.toContain(DEFAULT_DELEGATION_GUIDANCE);
    expect(promptA).not.toContain("No delegation model overrides are configured.");
    // The roster lives in the Task description, so the prefix does not move (ADR 0337).
    expect(promptB).toBe(promptA);

    expect(soloPrompt).toContain(DEFAULT_DELEGATION_GUIDANCE);
    expect(soloPrompt).not.toContain("## Team mode");
    expect(soloPrompt).toContain("No delegation model overrides are configured.");
  });

  it("cannot resume a member that is not on the session roster", async () => {
    const { runtime } = harness("success", [definition("explorer", ["Read"])]);
    try {
      const result = await rootTool(runtime, "Task").execute("root-resume", {
        agent: "worker",
        task: "Continue the earlier work.",
        resume: "delegation-from-an-earlier-run",
      });
      expect(result.content[0].text).toContain('Unknown subagent "worker"');
      expect(records(runtime)).toHaveLength(0);
      expect(nestedState.constructions).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("frames Team members with scope and acceptance rules at L1 and L2", async () => {
    const { runtime } = harness("success", [
      { ...definition("explorer", []), inheritTools: true },
      { ...definition("worker", []), inheritTools: true },
    ]);
    try {
      const started = await startRoot(runtime);
      await waitForStatus(runtime, started.details.delegationId as string, "completed");
      const prompt = (name: string) =>
        String(
          nestedState.constructions.find((options) => options.definition.name === name)
            ?.systemPrompt,
        );
      // L1 owns its result and may start sub-members; L2 may not delegate at all.
      expect(prompt("explorer")).toContain("You own the result of this task");
      expect(prompt("explorer")).toContain(
        "Check a sub-member's report before you rely on it",
      );
      expect(prompt("worker")).toContain("or delegate");
      expect(prompt("worker")).not.toContain("You own the result of this task");
      expect(prompt("worker")).toContain("Stay within your task's scope");
      expect(prompt("worker")).toContain("the report your coordinator receives");
    } finally {
      await runtime.dispose();
    }
  });
});
