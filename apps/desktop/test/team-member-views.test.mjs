import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * The Team members the composer dock offers: one row per role Settings defines,
 * a switch on each row, and a sheet for one member's session-only settings.
 * Settings owns the roles, so nothing here adds, removes or defines one.
 */

function sourceUrl(name) {
  return new URL(`../src/features/team/${name}`, import.meta.url);
}

function source(name) {
  return readFileSync(sourceUrl(name), "utf8");
}

const rosterHook = source("useTeamRoster.ts");
const picker = source("TeamRosterPicker.tsx");
const card = source("TeamMemberCard.tsx");
const sheet = source("TeamMemberSheet.tsx");
const overrides = source("TeamMemberOverrides.tsx");
const pickerCss = source("team-roster-picker.css");

test("the roster edits members through the Team service and leaves the roles to Settings", () => {
  assert.match(rosterHook, /useTeamStore\(selectTeamSession\(session\.id\)\)/);
  assert.match(rosterHook, /useHostCollection\(fetchSubagentPageData/);
  assert.match(rosterHook, /teamRosterCards\(definitions, members, running\)/);
  assert.match(rosterHook, /teamService\.updateMember\(session, handle, patch, knownAgents\)/);
  assert.match(rosterHook, /teamService\.setMembersEnabled\(session, handles, enabled, knownAgents\)/);
  assert.match(rosterHook, /setSettingsTab\("subagents"\)/);
  // The composer's Team switch owns reading the configuration. A second reader
  // here would report one failure twice.
  assert.doesNotMatch(rosterHook, /teamService\.load/);
  assert.match(picker, /<TeamMemberSheet/);
  // Cards cannot be added or removed: Settings owns the roles.
  assert.equal(existsSync(sourceUrl("TeamManagerSheet.tsx")), false);
  for (const text of [rosterHook, picker, card, sheet, overrides]) {
    assert.doesNotMatch(text, /addMember|removeMember|setMemberModel|TeamManagerSheet/);
  }
});

test("Member settings use provider-bounded model choices and drop stale role prompts", () => {
  for (const helper of [
    "subagentModelChoices",
    "groupSubagentModelChoices",
    "subagentModelSelectValue",
    "subagentModelOrphanPin",
    "subagentModelDisplay",
  ]) {
    assert.match(overrides, new RegExp(`\\b${helper}\\b`), helper);
  }
  assert.match(overrides, /providerId: choice\.providerId, modelId: choice\.modelId/);
  assert.match(overrides, /<Select/);
  assert.doesNotMatch(overrides, /SettingsMenuSelect/);
  // A user-owned role's prompt is read on demand, and an answer that arrives
  // for another role is never shown.
  assert.match(sheet, /api\.readUserSubagent\(ownedId\)/);
  assert.match(sheet, /if \(!current\) return;/);
  assert.match(sheet, /owned\?\.id === ownedId \? owned\.prompt : \{ status: "loading" \}/);
});

test("the conversation area carries no Team panel, graph or drawer", () => {
  for (const name of [
    "TeamLayout.tsx",
    "TeamPanel.tsx",
    "TeamGraph.tsx",
    "TeamGraphNode.tsx",
    "TeamRosterStrip.tsx",
    "team-layout-store.ts",
    "team-layout-model.ts",
    "team-graph-model.ts",
    "team.css",
    "team-layout.css",
  ]) {
    assert.equal(existsSync(sourceUrl(name)), false, name);
  }
  // The Team view lives in the composer dock only.
  for (const file of ["../src/components/ChatSurface.tsx", "../src/components/ConversationTopbar.tsx"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(text, /features\/team\//, file);
  }
});

const ROLE_PROMPT = "Explore the repository and report back.";
const noop = () => {};

function role(name, tools, extra = {}) {
  return {
    name,
    description: `${name} role`,
    tools,
    prompt: ROLE_PROMPT,
    source: "builtin",
    ...extra,
  };
}

async function loadTeamViews(t) {
  const ssr = await slotSsr(t);
  const [{ TeamMemberCard }, { TeamMemberDialog }, model] = await Promise.all([
    ssr.load("/src/features/team/TeamMemberCard.tsx"),
    ssr.load("/src/features/team/TeamMemberSheet.tsx"),
    ssr.load("/src/features/team/team-roster-model.ts"),
  ]);
  return { ssr, TeamMemberCard, TeamMemberDialog, model };
}

test("member rows only switch members on and off; a role disabled in Settings stays listed but locked", async (t) => {
  const { ssr, TeamMemberCard, model } = await loadTeamViews(t);
  const definitions = [
    { handle: "explorer", definition: role("explorer", ["Read", "Grep"]), enabled: true },
    { handle: "fixer", definition: role("fixer", ["Read", "Edit", "Write"]), enabled: true },
    { handle: "archived", definition: role("archived", ["Read"]), enabled: false },
  ];
  const members = [{ agent: "explorer", thinkingLevel: "high" }, { agent: "archived" }];
  const render = (rosterCard) =>
    ssr.render(
      createElement(TeamMemberCard, { card: rosterCard, saving: false, onToggle: noop, onOpen: noop }),
      { sessionId: null },
    );
  const cards = model.teamRosterCards(definitions, members, new Map());
  assert.equal(cards.length, 3);
  const [explorer, fixer, archived] = cards.map(render);

  // Every row has one switch and a separate pencil that opens the member sheet.
  for (const row of [explorer, fixer, archived]) {
    assert.equal(row.match(/role="switch"/g)?.length, 1);
    assert.match(row, /aria-haspopup="dialog"/);
  }
  assert.match(explorer, /role="switch" aria-checked="true" aria-label="Use explorer in this session"/);
  assert.doesNotMatch(explorer, /role="switch"[^>]*disabled=""/);
  assert.match(explorer, /team-member-modified-dot/);
  assert.match(fixer, /role="switch" aria-checked="false" aria-label="Use fixer in this session"/);
  assert.match(fixer, /team-member-access is-write/);
  assert.doesNotMatch(fixer, /team-member-modified-dot/);
  assert.match(archived, /team-member-tile is-settings-disabled/);
  assert.match(
    archived,
    /role="switch" aria-checked="false" aria-label="Use archived in this session"[^>]*disabled=""/,
  );
  assert.match(archived, /Disabled in Settings/);
  // No add, remove, or manage entry points survive on a row.
  for (const row of [explorer, fixer, archived]) {
    assert.doesNotMatch(row, /Remove|Add member|Manage team/);
  }

  // A member with delegates running says how many.
  const [running] = model.teamRosterCards(definitions, members, new Map([["explorer", 2]]));
  const runningRow = render(running);
  assert.match(runningRow, /class="team-member-tile is-running"/);
  assert.match(runningRow, /2 running/);
});

test("the member sheet shows the role read-only and edits only this session's settings", async (t) => {
  const { ssr, TeamMemberDialog, model } = await loadTeamViews(t);
  const [explorerCard] = model.teamRosterCards(
    [
      {
        handle: "explorer",
        definition: role("explorer", ["Read", "Grep"], { permission: "ask" }),
        enabled: true,
      },
    ],
    [{ agent: "explorer", tools: ["Read", "Edit"], thinkingLevel: "high" }],
    new Map(),
  );
  const html = ssr.render(
    createElement(TeamMemberDialog, {
      card: explorerCard,
      prompt: { status: "ready", text: ROLE_PROMPT },
      saving: false,
      onUpdate: async () => true,
      onEditRole: noop,
      onClose: noop,
    }),
    { sessionId: null },
  );

  assert.match(html, /role="dialog" aria-modal="true"/);
  // The header switch turns the member on or off for this session.
  assert.match(html, /role="switch" aria-checked="true" aria-label="Use explorer in this session"/);
  const sections = [...html.matchAll(/<section[^>]*>([\s\S]*?)<\/section>/g)].map(
    (match) => match[1],
  );
  assert.equal(sections.length, 2);
  const [roleSection, sessionSection] = sections;

  assert.match(roleSection, /Role settings/);
  assert.match(roleSection, /Edit role in Settings/);
  assert.match(roleSection, /explorer role/);
  assert.match(roleSection, /Ask every time/);
  // The role prompt is collapsed by default.
  assert.match(
    roleSection,
    /class="team-member-prompt"[^>]*hidden=""[\s\S]*Explore the repository and report back\./,
  );
  assert.doesNotMatch(roleSection, /<select|<input|role="radiogroup"|role="switch"/);

  assert.match(sessionSection, /This session only/);
  assert.match(sessionSection, /Applies to this session from the next message/);
  assert.equal(sessionSection.match(/<select/g)?.length, 2);
  assert.match(sessionSection, /role="radiogroup"/);
  assert.equal(sessionSection.match(/>Modified</g)?.length, 2);
  assert.match(sessionSection, /Reset to role defaults/);
  assert.match(sessionSection, /<option value="high" selected="">high<\/option>/);
  assert.match(sessionSection, /aria-pressed="true"[^>]*>Read</);
  assert.match(sessionSection, /aria-pressed="true"[^>]*>Edit</);
  assert.match(sessionSection, /aria-pressed="false"[^>]*>Write</);
  // Edit makes this read-only role write-capable for the session.
  assert.match(sessionSection, /This delegate can change files on its own\./);
});

test("running motion in the member rows is disabled on request", () => {
  assert.match(pickerCss, /animation: team-running-pulse/);
  const reduced = pickerCss.slice(pickerCss.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /animation: none/);
});
