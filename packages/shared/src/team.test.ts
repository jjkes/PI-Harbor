import { describe, expect, it } from "vitest";
import * as Value from "typebox/value";

import {
  IPC,
  IPC_WHITELIST,
  MAX_DEFAULT_DELEGATION_DEPTH,
  MAX_NESTED_DELEGATIONS_PER_DELEGATE,
  MAX_SUBAGENT_DEFINITIONS,
  MAX_TEAM_DELEGATION_DEPTH,
  MAX_TEAM_MEMBERS,
  SessionTeamConfigSchema,
  SessionTeamMemberSchema,
  SessionTeamUpdateSchema,
  canDelegate,
  maxDelegationDepth,
  type SessionTeamConfig,
  type SessionTeamMember,
  type SessionTeamUpdate,
} from "./index.js";

function update(members?: SessionTeamMember[]): SessionTeamUpdate {
  return {
    sessionId: "session-1",
    expectedRevision: 0,
    enabled: true,
    ...(members ? { members } : {}),
  };
}

describe("Team delegation limits", () => {
  it("locks the fixed Team and default limits", () => {
    expect(MAX_TEAM_DELEGATION_DEPTH).toBe(2);
    expect(MAX_DEFAULT_DELEGATION_DEPTH).toBe(1);
    expect(MAX_NESTED_DELEGATIONS_PER_DELEGATE).toBe(4);
    expect(MAX_TEAM_MEMBERS).toBe(MAX_SUBAGENT_DEFINITIONS);
    expect(MAX_TEAM_MEMBERS).toBe(16);
    expect(maxDelegationDepth(false)).toBe(1);
    expect(maxDelegationDepth(true)).toBe(2);
  });

  it("allows tools at L0 and L1 only in Team mode and never at L2", () => {
    const depths = [0, 1, 2, 3];
    expect(depths.map((depth) => canDelegate(depth, false))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(depths.map((depth) => canDelegate(depth, true))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("rejects invalid depth values without external state", () => {
    for (const depth of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(canDelegate(depth, true)).toBe(false);
      expect(canDelegate(depth, false)).toBe(false);
    }
  });
});

describe("SessionTeam schemas", () => {
  it("accepts a typed config and partial update with a model pin", () => {
    const member: SessionTeamMember = {
      agent: "explorer",
      model: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
    };
    const config: SessionTeamConfig = {
      sessionId: "session-1",
      enabled: true,
      members: [member],
      revision: 3,
    };
    expect(Value.Check(SessionTeamMemberSchema, member)).toBe(true);
    expect(Value.Check(SessionTeamConfigSchema, config)).toBe(true);
    expect(Value.Check(SessionTeamUpdateSchema, update([member]))).toBe(true);
    expect(
      Value.Check(SessionTeamUpdateSchema, {
        sessionId: "session-1",
        expectedRevision: 3,
        enabled: false,
      }),
    ).toBe(true);
    expect(Value.Check(SessionTeamUpdateSchema, update([]))).toBe(true);
  });

  it("accepts the provider and model id boundaries", () => {
    const member = {
      agent: "explorer",
      model: { providerId: "p".repeat(128), modelId: "m".repeat(256) },
    };
    expect(Value.Check(SessionTeamUpdateSchema, update([member]))).toBe(true);
  });

  it("caps the roster at sixteen members", () => {
    const members = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ agent: `agent-${index}` }));
    expect(
      Value.Check(SessionTeamUpdateSchema, update(members(MAX_TEAM_MEMBERS))),
    ).toBe(true);
    expect(
      Value.Check(
        SessionTeamUpdateSchema,
        update(members(MAX_TEAM_MEMBERS + 1)),
      ),
    ).toBe(false);
  });

  it("rejects duplicate agent names after normalization", () => {
    expect(
      Value.Check(
        SessionTeamUpdateSchema,
        update([{ agent: "Code_Reviewer" }, { agent: "code-reviewer.md" }]),
      ),
    ).toBe(false);
    expect(
      Value.Check(
        SessionTeamUpdateSchema,
        update([
          {
            agent: "Explorer",
            model: { providerId: "anthropic", modelId: "sonnet" },
          },
          { agent: "explorer" },
        ]),
      ),
    ).toBe(false);
    expect(Value.Check(SessionTeamUpdateSchema, update([{ agent: ".md" }]))).toBe(
      false,
    );
  });

  it("rejects empty, whitespace-only, and overlong model ids", () => {
    for (const model of [
      { providerId: "", modelId: "model" },
      { providerId: "provider", modelId: "" },
      { providerId: " \t", modelId: "model" },
      { providerId: "provider", modelId: " \t" },
      { providerId: "p".repeat(129), modelId: "model" },
      { providerId: "provider", modelId: "m".repeat(257) },
    ]) {
      expect(
        Value.Check(SessionTeamUpdateSchema, update([{ agent: "explorer", model }])),
      ).toBe(false);
    }
  });

  it("requires a non-negative integer expectedRevision and a session id", () => {
    expect(
      Value.Check(SessionTeamUpdateSchema, {
        sessionId: "session-1",
        enabled: true,
      }),
    ).toBe(false);
    for (const expectedRevision of [-1, 0.5, Number.NaN]) {
      expect(
        Value.Check(SessionTeamUpdateSchema, {
          sessionId: "session-1",
          expectedRevision,
        }),
      ).toBe(false);
    }
    for (const sessionId of ["", " \t"]) {
      expect(
        Value.Check(SessionTeamUpdateSchema, { sessionId, expectedRevision: 0 }),
      ).toBe(false);
    }
  });

  it("rejects unknown fields instead of forwarding them to the host", () => {
    expect(
      Value.Check(SessionTeamUpdateSchema, {
        ...update(),
        revision: 4,
      }),
    ).toBe(false);
  });
});

describe("Team IPC contract", () => {
  it("exposes only the additive get and update invoke channels", () => {
    expect(IPC.invoke.sessionTeamGet).toBe("pi-harbor/session/team/get");
    expect(IPC.invoke.sessionTeamUpdate).toBe("pi-harbor/session/team/update");
    expect(IPC_WHITELIST.has(IPC.invoke.sessionTeamGet)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.invoke.sessionTeamUpdate)).toBe(true);
  });
});
