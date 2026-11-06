import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ErrorCodes } from "@pi-harbor/shared";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  BTW_MAX_TOOL_ROUNDS,
  type BtwHostCaller,
  btwHostClient,
  btwToolDecision,
  gateBtwTools,
} from "./btw-tool-gate.js";

function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `${name} fixture`,
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    execute: async () => {
      throw new Error(`main ${name} must not run`);
    },
  };
}

function recordingHost(reply: (method: string) => Promise<unknown>) {
  const calls: { method: string; params: unknown }[] = [];
  const host: BtwHostCaller = {
    call: <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      return reply(method) as Promise<T>;
    },
  };
  return { host, calls };
}

describe("gateBtwTools", () => {
  it("keeps every declaration and routes only Read, Glob, and Grep to the BTW runner", async () => {
    const tools = ["Read", "Glob", "Grep", "Write", "Bash", "Task"].map(tool);
    const ran: string[] = [];
    const gated = gateBtwTools(tools, async (toolName) => {
      ran.push(toolName);
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    });
    const declaration = ({ name, description, parameters }: AgentTool) => ({ name, description, parameters });
    expect(gated.map(declaration)).toEqual(tools.map(declaration));
    for (const name of ["Read", "Glob", "Grep"]) {
      await gated.find((candidate) => candidate.name === name)!.execute(`call-${name}`, {});
    }
    for (const name of ["Write", "Bash", "Task"]) {
      await expect(
        gated.find((candidate) => candidate.name === name)!.execute(`call-${name}`, {}),
      ).rejects.toThrow();
    }
    expect(ran).toEqual(["Read", "Glob", "Grep"]);
  });
});

describe("btwToolDecision", () => {
  it("allows the read-only tools within the round budget", () => {
    for (let round = 1; round <= BTW_MAX_TOOL_ROUNDS; round += 1) {
      expect(btwToolDecision("Read", round)).toEqual({ allow: true });
    }
  });

  it("blocks every other tool without ending the run", () => {
    const decision = btwToolDecision("Write", 1);
    expect(decision).toMatchObject({ allow: false, errorCode: ErrorCodes.TOOL_DISABLED_IN_READ_ONLY });
    expect(decision.allow === false && decision.result.terminate).toBeFalsy();
  });

  it("denies one round past the budget, then ends the run", () => {
    const soft = btwToolDecision("Read", BTW_MAX_TOOL_ROUNDS + 1);
    expect(soft).toMatchObject({ allow: false, errorCode: ErrorCodes.BTW_TOOL_BUDGET_EXHAUSTED });
    expect(soft.allow === false && soft.result.terminate).toBeFalsy();
    expect(btwToolDecision("Write", BTW_MAX_TOOL_ROUNDS + 2)).toMatchObject({
      allow: false,
      errorCode: ErrorCodes.BTW_TOOL_BUDGET_EXHAUSTED,
      result: { block: true, terminate: true },
    });
  });
});

describe("btwHostClient", () => {
  it("runs a call under the read-only profile with a namespaced id and no main-turn fields", async () => {
    const { host, calls } = recordingHost(async () => ({ ok: true, content: "body" }));
    const client = btwHostClient(host, { sessionId: "s1", runId: "r1", mode: "plan" });
    await expect(client.executeTool("Read", "c1", { path: "a.ts" })).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "tools.execute",
      params: {
        sessionId: "s1",
        toolCallId: "btw:r1:c1",
        toolName: "Read",
        args: { path: "a.ts" },
        mode: "plan",
        accessProfile: "read-only",
      },
    });
    for (const key of ["turnId", "fileBatchTicket", "delegationId", "permissionScope", "runInBackground"]) {
      expect(calls[0]?.params).not.toHaveProperty(key);
    }
  });

  it("settles an aborted call at once and asks the host to abort it", async () => {
    const { host, calls } = recordingHost((method) =>
      method === "tools.abort" ? Promise.resolve(undefined) : new Promise(() => undefined),
    );
    const controller = new AbortController();
    const pending = btwHostClient(host, { sessionId: "s1", runId: "r1", mode: "agent" }).executeTool(
      "Read",
      "c1",
      { path: "a.ts" },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.map((call) => call.method)).toEqual(["tools.execute", "tools.abort"]);
    expect(calls[1]?.params).toMatchObject({ sessionId: "s1", toolCallId: "btw:r1:c1" });
  });
});
