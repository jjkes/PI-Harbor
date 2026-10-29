import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { MAX_TEAM_MEMBERS } = await import("@pi-harbor/shared");
const {
  TEAM_INVALID_MEMBER,
  TEAM_MEMBER_RESET_PATCH,
  TEAM_ROSTER_FULL,
  applyTeamMemberPatch,
  canonicalTeamTools,
  roleToolGrant,
  sameTeamMembers,
  teamCardStatus,
  teamRosterCards,
} = await import("../src/features/team/team-roster-model.ts");

/*
 * Roster v2 (ADR 0339): one card per Settings role, a per-session switch, and
 * session-only model, tools, and reasoning. An absent entry is an off card.
 */

const model = { providerId: "anthropic", modelId: "claude-sonnet" };

function entry(handle, tools, { enabled = true, ...extra } = {}) {
  return {
    handle,
    enabled,
    definition: {
      name: handle,
      description: `${handle} role`,
      tools,
      prompt: "",
      source: "builtin",
      ...extra,
    },
  };
}

test("a first edit appends an off card, settings survive switching off, and a bare off entry is dropped", () => {
  const roster = [{ agent: "explorer" }];
  const pinned = applyTeamMemberPatch(roster, "Fixer", { thinkingLevel: "high" });
  assert.deepEqual(pinned, [
    { agent: "explorer" },
    { agent: "fixer", enabled: false, thinkingLevel: "high" },
  ]);
  assert.deepEqual(roster, [{ agent: "explorer" }], "the input roster is not modified");

  const on = applyTeamMemberPatch(pinned, "fixer", { enabled: true });
  assert.deepEqual(on[1], { agent: "fixer", thinkingLevel: "high" }, "enabled: true is omitted");
  const off = applyTeamMemberPatch(on, "fixer", { enabled: false });
  assert.deepEqual(off[1], { agent: "fixer", enabled: false, thinkingLevel: "high" });
  assert.deepEqual(applyTeamMemberPatch(off, "fixer", TEAM_MEMBER_RESET_PATCH), [
    { agent: "explorer" },
  ]);
  assert.deepEqual(applyTeamMemberPatch(roster, "explorer", { enabled: false }), []);
  assert.throws(() => applyTeamMemberPatch(roster, "  ", { enabled: true }), {
    code: TEAM_INVALID_MEMBER,
  });
});

test("tool grants are deduplicated in the host's order and a custom choice starts from the role's grant", () => {
  assert.deepEqual(canonicalTeamTools(["Write", "inherit", "Read", "Write", "Unknown"]), [
    "inherit",
    "Read",
    "Write",
  ]);
  assert.deepEqual(roleToolGrant({ tools: ["Grep", "Read"], inheritTools: true }), [
    "inherit",
    "Read",
    "Grep",
  ]);
  assert.deepEqual(roleToolGrant({ tools: [] }), []);
  const granted = applyTeamMemberPatch([{ agent: "explorer" }], "explorer", {
    tools: ["Edit", "Read", "Edit"],
  });
  assert.deepEqual(granted, [{ agent: "explorer", tools: ["Read", "Edit"] }]);
  assert.deepEqual(applyTeamMemberPatch(granted, "explorer", { tools: [] }), [
    { agent: "explorer" },
  ]);
});

test("roster equality ignores name case and tool order but not order, switches, or settings", () => {
  const roster = [
    { agent: "explorer", tools: ["Read", "Grep"], model },
    { agent: "fixer", enabled: false, thinkingLevel: "low" },
  ];
  assert.equal(
    sameTeamMembers(roster, [
      { agent: "Explorer", tools: ["Grep", "Read"], model: { ...model } },
      { agent: "fixer", enabled: false, thinkingLevel: "low" },
    ]),
    true,
  );
  assert.equal(sameTeamMembers(roster, [...roster].reverse()), false);
  assert.equal(sameTeamMembers(roster, [roster[0], { agent: "fixer", thinkingLevel: "low" }]), false);
  assert.equal(sameTeamMembers(roster, [roster[0], { agent: "fixer", enabled: false }]), false);
  assert.equal(sameTeamMembers(roster, roster.slice(0, 1)), false);
});

test("an over-limit roster drops only entries of deleted roles, oldest first, never the edited member", () => {
  const live = Array.from({ length: MAX_TEAM_MEMBERS - 2 }, (_, index) => ({
    agent: `live-${index}`,
  }));
  const liveNames = live.map((member) => member.agent);
  const roster = [
    { agent: "gone-a", thinkingLevel: "low" },
    ...live,
    { agent: "gone-b", enabled: false, thinkingLevel: "low" },
  ];
  assert.equal(roster.length, MAX_TEAM_MEMBERS);

  const added = applyTeamMemberPatch(roster, "newcomer", { enabled: true }, {
    knownAgents: new Set([...liveNames, "newcomer"]),
  });
  assert.deepEqual(
    added.map((member) => member.agent),
    [...liveNames, "gone-b", "newcomer"],
  );
  // The edited member stays even when its own role is not in the list.
  const unlisted = applyTeamMemberPatch(roster, "newcomer", { enabled: true }, {
    knownAgents: new Set(liveNames),
  });
  assert.deepEqual(
    unlisted.map((member) => member.agent),
    [...liveNames, "gone-b", "newcomer"],
  );
  // Without a loaded role list nothing counts as deleted, so the edit is refused.
  assert.throws(() => applyTeamMemberPatch(roster, "newcomer", { enabled: true }), {
    code: TEAM_ROSTER_FULL,
  });
  // Within the limit nothing is pruned, even with deleted roles present.
  const small = [{ agent: "gone-a", thinkingLevel: "low" }, { agent: "explorer" }];
  assert.deepEqual(
    applyTeamMemberPatch(small, "fixer", { enabled: true }, {
      knownAgents: new Set(["explorer", "fixer"]),
    }).map((member) => member.agent),
    ["gone-a", "explorer", "fixer"],
  );
});

test("cards follow the Settings roles, apply session settings to a copy, and list roles disabled in Settings last", () => {
  const reader = entry("reader", ["Read", "Grep"], {
    model: { providerId: "anthropic", modelId: "role-model" },
    fallbackModels: [{ providerId: "anthropic", modelId: "fallback" }],
  });
  const writer = entry("writer", ["Read", "Write"]);
  const archived = entry("archived", ["Read"], { enabled: false });
  const members = [
    { agent: "Archived" },
    { agent: "reader", model, tools: ["Read", "Edit"], thinkingLevel: "high" },
  ];
  const cards = teamRosterCards([archived, reader, writer], members, new Map([["writer", 2]]));
  assert.deepEqual(
    cards.map((card) => card.handle),
    ["reader", "writer", "archived"],
  );
  const [readerCard, writerCard, archivedCard] = cards;

  assert.equal(readerCard.on, true);
  assert.equal(readerCard.hasSettings, true);
  assert.equal(readerCard.canMutate, true, "a session tool grant decides the write label");
  assert.equal(readerCard.roleCanMutate, false);
  assert.deepEqual(readerCard.effective.tools, ["Read", "Edit"]);
  assert.equal(readerCard.effective.inheritTools, false);
  assert.deepEqual(readerCard.effective.model, model);
  assert.deepEqual(readerCard.effective.fallbackModels, [], "a locked model never falls back");
  assert.equal(readerCard.effective.thinkingLevel, "high");
  assert.deepEqual(reader.definition.tools, ["Read", "Grep"], "the role definition is untouched");
  assert.equal(reader.definition.fallbackModels.length, 1);
  assert.equal(reader.definition.thinkingLevel, undefined);

  assert.equal(writerCard.member, undefined);
  assert.equal(writerCard.on, false, "a role without an entry is an off card");
  assert.equal(writerCard.running, 2);
  assert.equal(writerCard.effective, writer.definition);

  assert.equal(archivedCard.settingsEnabled, false);
  assert.equal(archivedCard.on, false, "a role disabled in Settings is never on");

  assert.equal(teamCardStatus(writerCard), "running");
  assert.equal(teamCardStatus(archivedCard), "settings-disabled");
  assert.equal(teamCardStatus({ running: 0, settingsEnabled: true, on: false }), "off");
  assert.equal(teamCardStatus(readerCard), "on");
  assert.equal(teamCardStatus(readerCard, true), "model-unavailable");
});
