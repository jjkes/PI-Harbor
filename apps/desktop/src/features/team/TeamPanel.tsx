import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SUBAGENT_INHERIT_TOKEN,
  normalizeSubagentName,
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
import { TeamManagerSheet } from "./TeamManagerSheet";
import { TeamRosterStrip } from "./TeamRosterStrip";
import type { TeamDefinitionEntry } from "./TeamMemberCard";
import { buildTeamGraph } from "./team-graph-model";
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

export function TeamPanel({ session, messages, isRunning }: TeamPanelProps) {
  const { t } = useTranslation();
  const team = useTeamStore(selectTeamSession(session.id));
  const showToast = useAppStore((state) => state.showToast);
  const mainModelId = useAppStore((state) =>
    state.sessions.find((candidate) => candidate.id === session.id)?.modelId);
  const [managerOpen, setManagerOpen] = useState(false);
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
  const members = team.config?.members ?? [];

  return (
    <aside
      className="team-panel"
      aria-label={t("team.title")}
      aria-busy={team.loading || team.saving}
    >
      <TeamRosterStrip
        session={session}
        members={members}
        definitions={definitions}
        runningByAgent={runningByAgent}
        runningTotal={runningTotal}
        loading={(team.loading && !team.config) || page.loading}
        saving={team.saving}
        onManage={() => setManagerOpen(true)}
        onError={onError}
      />
      {team.error ? (
        <div className="team-panel-error" role="alert">
          <span>{team.error}</span>
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
      {managerOpen ? (
        <TeamManagerSheet
          session={session}
          members={members}
          definitions={definitions}
          loading={page.loading}
          saving={team.saving}
          onClose={() => setManagerOpen(false)}
          onError={onError}
        />
      ) : null}
    </aside>
  );
}
