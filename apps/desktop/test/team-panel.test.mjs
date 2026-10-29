import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

function sourceUrl(name) {
  return new URL(`../src/features/team/${name}`, import.meta.url);
}

function source(name) {
  return readFileSync(sourceUrl(name), "utf8");
}

const panel = source("TeamPanel.tsx");
const card = source("TeamMemberCard.tsx");
const sheet = source("TeamMemberSheet.tsx");
const overrides = source("TeamMemberOverrides.tsx");
const graph = source("TeamGraph.tsx");
const graphNode = source("TeamGraphNode.tsx");
const css = source("team.css");

test("Team panel lists one card per Settings role and edits members through updateMember", () => {
  assert.match(panel, /useTeamStore\(selectTeamSession\(session\.id\)\)/);
  assert.match(panel, /teamService\.load\(session\)/);
  assert.match(panel, /useHostCollection\(fetchSubagentPageData/);
  assert.match(panel, /useMemo\(\(\) => buildTeamGraph\(messages\), \[messages\]\)/);
  assert.match(panel, /teamRosterCards\(definitions, members, runningByAgent\)/);
  assert.match(panel, /teamService\.updateMember\(session, handle, patch, knownAgents\)/);
  assert.match(
    panel,
    /onToggleMember=\{\(card, on\) => void updateMember\(card\.handle, \{ enabled: on \}\)\}/,
  );
  assert.match(panel, /onUpdate=\{\(patch\) => updateMember\(selectedCard\.handle, patch\)\}/);
  assert.match(panel, /setSettingsTab\("subagents"\)/);
  assert.match(panel, /<TeamRosterStrip/);
  assert.match(panel, /<TeamGraph/);
  assert.match(panel, /<TeamMemberSheet/);
  assert.match(panel, /aria-live="polite"/);
  // Cards cannot be added or removed: Settings owns the roles.
  assert.equal(existsSync(sourceUrl("TeamManagerSheet.tsx")), false);
  for (const text of [panel, card, sheet, overrides]) {
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
  const [{ TeamRosterStrip }, { TeamMemberDialog }, model] = await Promise.all([
    ssr.load("/src/features/team/TeamRosterStrip.tsx"),
    ssr.load("/src/features/team/TeamMemberSheet.tsx"),
    ssr.load("/src/features/team/team-roster-model.ts"),
  ]);
  return { ssr, TeamRosterStrip, TeamMemberDialog, model };
}

test("member cards only switch members on and off; a role disabled in Settings stays listed but locked", async (t) => {
  const { ssr, TeamRosterStrip, model } = await loadTeamViews(t);
  const definitions = [
    { handle: "explorer", definition: role("explorer", ["Read", "Grep"]), enabled: true },
    { handle: "fixer", definition: role("fixer", ["Read", "Edit", "Write"]), enabled: true },
    { handle: "archived", definition: role("archived", ["Read"]), enabled: false },
  ];
  const members = [{ agent: "explorer", thinkingLevel: "high" }, { agent: "archived" }];
  const cards = model.teamRosterCards(definitions, members, new Map());
  const render = (collapsed) =>
    ssr.render(
      createElement(TeamRosterStrip, {
        cards,
        runningTotal: 0,
        loading: false,
        saving: false,
        collapsed,
        onCollapsedChange: noop,
        onToggleMember: noop,
        onOpenMember: noop,
      }),
      { sessionId: null },
    );

  const html = render(false);
  assert.match(html, /Members · 1\/3 on/);
  assert.match(html, /class="team-roster-toggle" aria-expanded="true"/);
  const tiles = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => match[1]);
  assert.equal(tiles.length, 3);
  const [explorer, fixer, archived] = tiles;
  // Every tile opens the member sheet, and the switch is its only control.
  for (const tile of tiles) {
    assert.match(tile, /aria-haspopup="dialog"/);
    assert.equal(tile.match(/role="switch"/g)?.length, 1);
  }
  assert.match(explorer, /role="switch" aria-checked="true" aria-label="Use explorer in this session"/);
  assert.doesNotMatch(explorer, /disabled=""/);
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
  // No add, remove, or manage entry points survive.
  assert.doesNotMatch(html, /Remove|Add member|Manage team/);

  const collapsed = render(true);
  assert.match(collapsed, /class="team-roster-toggle" aria-expanded="false"/);
  assert.match(collapsed, /class="team-roster-body" hidden=""/);
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

test("Team graph keeps accessible two-level navigation and existing subagent actions", () => {
  assert.match(graph, /role="tree"/);
  assert.match(graph, /role="treeitem"/);
  assert.match(graph, /aria-level=\{1\}/);
  assert.match(graphNode, /role=\{level \? "treeitem" : "listitem"\}/);
  assert.match(graph, /renderNode\(root, 2\)/);
  assert.match(graph, /renderNode\(child, 3\)/);
  assert.match(graph, /node\.depth !== 2/);
  assert.match(graph, /node\.depthAnomaly/);
  assert.match(graph, /node\.orphan/);
  assert.match(graph, /console\.warn\("\[TeamGraph\] Unsupported delegation ancestry"/);
  assert.match(graph, /openSubagentTab\(node\.delegationId \?\? node\.toolCallId \?\? node\.messageId/);
  assert.match(graphNode, /<SubagentStopButton/);
  assert.match(graphNode, /running=\{running\}/);
  for (const key of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Enter"]) {
    assert.match(graph, new RegExp(`"${key}"`), key);
  }
  assert.match(graph, /tabIndex=\{rovingId === MAIN_NODE_ID \? 0 : -1\}/);
  assert.match(graphNode, /tabIndex=\{level \? \(active \? 0 : -1\) : undefined\}/);
  assert.match(graph, /team\.previousTurn/);
  assert.match(graph, /team\.nextTurn/);
  assert.match(graph, /team\.backToLive/);
});

test("Team styles reuse topology materials and disable running motion on request", () => {
  assert.match(css, /styles\/messages\.css/);
  assert.match(css, /background: var\(--ds-raised\)/);
  assert.match(css, /box-shadow: var\(--ds-raised-shadow\)/);
  assert.match(css, /background: var\(--ds-tile-deep\)/);
  assert.match(css, /height: 18px/);
  assert.match(css, /padding-left: 28px/);
  assert.match(css, /left: 14px/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /animation: none/);
  assert.doesNotMatch(css, /var\(--ds-border\)/);
});
