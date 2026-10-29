import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(name) {
  return readFileSync(new URL(`../src/features/team/${name}`, import.meta.url), "utf8");
}

const panel = source("TeamPanel.tsx");
const roster = source("TeamRosterStrip.tsx");
const card = source("TeamMemberCard.tsx");
const manager = source("TeamManagerSheet.tsx");
const graph = source("TeamGraph.tsx");
const graphNode = source("TeamGraphNode.tsx");
const css = source("team.css");

test("Team panel binds the session store, shared definitions and memoized live graph", () => {
  assert.match(panel, /useTeamStore\(selectTeamSession\(session\.id\)\)/);
  assert.match(panel, /teamService\.load\(session\)/);
  assert.match(panel, /useHostCollection\(fetchSubagentPageData/);
  assert.match(panel, /useMemo\(\(\) => buildTeamGraph\(messages\), \[messages\]\)/);
  assert.match(panel, /<TeamRosterStrip/);
  assert.match(panel, /<TeamGraph/);
  assert.match(panel, /<TeamManagerSheet/);
  assert.match(panel, /aria-live="polite"/);
  assert.match(roster, /normalizeSubagentName\(member\.agent\)/);
  assert.match(roster, /runningByAgent\.get\(handle\)/);
});

test("Roster and manager edits use bounded model choices and Team service mutations", () => {
  for (const helper of [
    "subagentModelChoices",
    "groupSubagentModelChoices",
    "subagentModelSelectValue",
    "subagentModelOrphanPin",
    "subagentModelDisplay",
  ]) {
    assert.match(card, new RegExp(`\\b${helper}\\b`), helper);
  }
  assert.match(card, /subagentCanMutate\(definition\)/);
  assert.match(card, /providerId: choice\.providerId, modelId: choice\.modelId/);
  assert.match(card, /teamService\.setMemberModel\(session, member\.agent, model\)/);
  assert.match(card, /teamService\.removeMember\(session, member\.agent\)/);
  assert.match(manager, /teamService\.addMember\(session, entry\.handle\)/);
  assert.match(manager, /teamService\s*\.setMemberModel/);
  assert.match(manager, /teamService\.removeMember/);
  assert.match(card, /<Select/);
  assert.doesNotMatch(card, /SettingsMenuSelect/);
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
