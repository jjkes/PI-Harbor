import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SUBAGENT_INHERIT_TOKEN,
  normalizeSubagentName,
  type SessionTeamMember,
  type SubagentDefinition,
  type UiMessage,
  type UserSubagentRecord,
} from "@pi-harbor/shared";
import {
  EMPTY_SUBAGENT_PAGE,
  fetchSubagentPageData,
} from "../../components/settings/subagent-settings";
import { subagentModelPinParts } from "../../components/settings/subagent-models";
import { Button } from "../../components/ui";
import { useHostCollection } from "../../hooks/use-host-collection";
import { useAppStore } from "../../stores/app-store";
import { TeamGraph } from "./TeamGraph";
import { TeamMemberSheet } from "./TeamMemberSheet";
import { TeamRosterStrip } from "./TeamRosterStrip";
import { buildTeamGraph } from "./team-graph-model";
import { teamLayoutStore, useTeamLayoutStore } from "./team-layout-store";
import {
  TEAM_ROSTER_FULL,
  teamRosterCards,
  type TeamDefinitionEntry,
  type TeamMemberPatch,
} from "./team-roster-model";
import { teamService, type TeamSessionTarget } from "./team-service";
import { selectTeamSession, useTeamStore } from "./team-store";
import "./team.css";

export type TeamPanelProps = {
  /** Local session whose configuration and work-panel tabs are being controlled. */
  session: TeamSessionTarget;
  /** Loaded transcript projection; nested Task rows are deliberately retained. */
  messages: readonly UiMessage[];
  isRunning: boolean;
};

const NO_MEMBERS: readonly SessionTeamMember[] = [];

function ownedDefinition(record: UserSubagentRecord): SubagentDefinition {
  const model = record.model ? subagentModelPinParts(record.model) : null;
  return {
    name: record.id,
    description: record.description,
    tools: record.tools.filter((tool) => tool !== SUBAGENT_INHERIT_TOKEN),
    inheritTools: record.tools.includes(SUBAGENT_INHERIT_TOKEN),
    ...(model ? { model: { providerId: model.providerPart, modelId: model.modelId } } : {}),
    ...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel } : {}),
    ...(record.maxTokens !== undefined ? { maxTokens: record.maxTokens } : {}),
    prompt: "",
    source: "user",
    filePath: record.path,
  };
}

function errorCodeOf(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

export function TeamPanel({ session, messages, isRunning }: TeamPanelProps) {
  const { t } = useTranslation();
  const team = useTeamStore(selectTeamSession(session.id));
  const showToast = useAppStore((state) => state.showToast);
  const mainModelId = useAppStore((state) =>
    state.sessions.find((candidate) => candidate.id === session.id)?.modelId);
  const rosterCollapsed = useTeamLayoutStore((state) => state.rosterCollapsed);
  const setRosterCollapsed = useTeamLayoutStore((state) => state.setRosterCollapsed);
  // Keyed by session: this panel is reused when the visible session changes.
  const [selected, setSelected] = useState<{ sessionId: string; handle: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const onError = useCallback((error: unknown) => {
    showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
  }, [showToast]);
  const page = useHostCollection(fetchSubagentPageData, EMPTY_SUBAGENT_PAGE, onError);

  useEffect(() => {
    // The service keeps the concrete failure in the feature store for the alert.
    void teamService.load(session).catch(onError);
  }, [session.id, session.source, onError]);

  const definitions = useMemo(() => {
    const entries: TeamDefinitionEntry[] = [];
    const seen = new Set<string>();
    for (const record of page.data.owned) {
      const handle = normalizeSubagentName(record.id);
      if (!handle || seen.has(handle)) continue;
      seen.add(handle);
      entries.push({ handle, definition: ownedDefinition(record), enabled: record.enabled });
    }
    for (const definition of page.data.builtins) {
      const handle = normalizeSubagentName(definition.name);
      if (!handle || seen.has(handle)) continue;
      seen.add(handle);
      entries.push({ handle, definition, enabled: definition.enabled });
    }
    return entries;
  }, [page.data.owned, page.data.builtins]);

  const graph = useMemo(() => buildTeamGraph(messages), [messages]);
  const runningByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of graph.nodes) {
      if (node.status !== "running") continue;
      const handle = normalizeSubagentName(node.agentName);
      if (handle) counts.set(handle, (counts.get(handle) ?? 0) + 1);
    }
    return counts;
  }, [graph.nodes]);
  const runningTotal = [...runningByAgent.values()].reduce((total, count) => total + count, 0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAnnouncement(t("team.runningAnnouncement", { count: runningTotal }));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [runningTotal, t]);

  const loadOlder = useCallback(async () => {
    await useAppStore.getState().loadTranscriptPage(session.id, "before");
  }, [session.id]);
  const members = team.config?.members ?? NO_MEMBERS;
  const cards = useMemo(
    () => teamRosterCards(definitions, members, runningByAgent),
    [definitions, members, runningByAgent],
  );

  /** Saves one member edit; resolves false when the host rejected it. */
  const updateMember = useCallback(
    async (handle: string, patch: TeamMemberPatch): Promise<boolean> => {
      // Stale entries are pruned only against a loaded Settings list; while it
      // is still empty every stored entry would look stale.
      const knownAgents = definitions.length > 0
        ? new Set(definitions.map((entry) => entry.handle))
        : undefined;
      try {
        await teamService.updateMember(session, handle, patch, knownAgents);
        return true;
      } catch (error) {
        if (errorCodeOf(error) === TEAM_ROSTER_FULL) {
          showToast(t("team.teamFull"), { variant: "error" });
        } else {
          onError(error);
        }
        return false;
      }
    },
    [definitions, onError, session, showToast, t],
  );

  const selectedHandle = selected?.sessionId === session.id ? selected.handle : null;
  const selectedCard = selectedHandle
    ? (cards.find((card) => card.handle === selectedHandle) ?? null)
    : null;
  const closeMember = useCallback(() => setSelected(null), []);
  const editRole = useCallback(() => {
    setSelected(null);
    // Leaving the conversation must not keep the narrow-window drawer, and its
    // key handling, armed behind Settings.
    teamLayoutStore.getState().closeOverlay(session.id);
    useAppStore.getState().setSettingsTab("subagents");
  }, [session.id]);
  const errorText = team.errorCode === TEAM_ROSTER_FULL ? t("team.teamFull") : team.error;

  return (
    <aside
      className="team-panel"
      aria-label={t("team.title")}
      aria-busy={team.loading || team.saving}
    >
      <TeamRosterStrip
        cards={cards}
        runningTotal={runningTotal}
        loading={(team.loading && !team.config) || page.loading}
        saving={team.saving}
        collapsed={rosterCollapsed}
        onCollapsedChange={setRosterCollapsed}
        onToggleMember={(card, on) => void updateMember(card.handle, { enabled: on })}
        onOpenMember={(card) => setSelected({ sessionId: session.id, handle: card.handle })}
      />
      {errorText ? (
        <div className="team-panel-error" role="alert">
          <span>{errorText}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={team.loading || team.saving}
            onClick={() => void teamService.reload(session).catch(onError)}
          >
            {t("team.retry")}
          </Button>
        </div>
      ) : null}
      <TeamGraph
        key={session.id}
        graph={graph}
        messages={messages}
        mainModelId={mainModelId}
        isRunning={isRunning}
        onLoadOlder={loadOlder}
        onError={onError}
      />
      <div className="team-sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {selectedCard ? (
        <TeamMemberSheet
          key={`${session.id}:${selectedCard.handle}`}
          card={selectedCard}
          saving={team.saving}
          onUpdate={(patch) => updateMember(selectedCard.handle, patch)}
          onEditRole={editRole}
          onClose={closeMember}
        />
      ) : null}
    </aside>
  );
}
