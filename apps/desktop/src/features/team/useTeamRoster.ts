import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SUBAGENT_INHERIT_TOKEN,
  normalizeSubagentName,
  type SessionTeamMember,
  type SubagentDefinition,
  type UserSubagentRecord,
} from "@pi-harbor/shared";
import type { SessionDelegations } from "../../lib/session-delegations";
import {
  EMPTY_SUBAGENT_PAGE,
  fetchSubagentPageData,
} from "../../components/settings/subagent-settings";
import { subagentModelPinParts } from "../../components/settings/subagent-models";
import { useHostCollection } from "../../hooks/use-host-collection";
import { useAppStore } from "../../stores/app-store";
import {
  TEAM_ROSTER_FULL,
  membersToToggle,
  runningByAgent,
  teamRosterCards,
  teamRosterCounts,
  type TeamDefinitionEntry,
  type TeamMemberPatch,
} from "./team-roster-model";
import { teamService, type TeamSessionTarget } from "./team-service";
import { selectTeamSession, useTeamStore } from "./team-store";

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

/** Roster data and member mutations for the composer dock's Team picker. */
export function useTeamRoster(session: TeamSessionTarget, delegations: SessionDelegations) {
  const { t } = useTranslation();
  const team = useTeamStore(selectTeamSession(session.id));
  const showToast = useAppStore((state) => state.showToast);
  const [selected, setSelected] = useState<{ sessionId: string; handle: string } | null>(null);
  const onError = useCallback((error: unknown) => {
    showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
  }, [showToast]);
  const page = useHostCollection(fetchSubagentPageData, EMPTY_SUBAGENT_PAGE, onError);

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

  const running = useMemo(() => runningByAgent(delegations), [delegations]);
  const runningTotal = useMemo(
    () => [...running.values()].reduce((total, count) => total + count, 0),
    [running],
  );
  const members = team.config?.members ?? NO_MEMBERS;
  const cards = useMemo(
    () => teamRosterCards(definitions, members, running),
    [definitions, members, running],
  );
  const counts = useMemo(() => teamRosterCounts(cards), [cards]);
  const knownAgents = useMemo(
    // An empty, not-yet-loaded Settings list must not make every entry stale.
    () => definitions.length > 0 ? new Set(definitions.map((entry) => entry.handle)) : undefined,
    [definitions],
  );

  const mutationFailed = useCallback((error: unknown): false => {
    if (errorCodeOf(error) === TEAM_ROSTER_FULL) {
      showToast(t("team.teamFull"), { variant: "error" });
    } else {
      onError(error);
    }
    return false;
  }, [onError, showToast, t]);

  /** Saves one member edit; resolves false when the host rejected it. */
  const updateMember = useCallback(async (
    handle: string,
    patch: TeamMemberPatch,
  ): Promise<boolean> => {
    try {
      await teamService.updateMember(session, handle, patch, knownAgents);
      return true;
    } catch (error) {
      return mutationFailed(error);
    }
  }, [knownAgents, mutationFailed, session]);

  /** Switches every eligible role that is not already in the requested state. */
  const setAll = useCallback(async (enabled: boolean): Promise<boolean> => {
    const handles = membersToToggle(cards, enabled);
    if (handles.length === 0) return true;
    try {
      await teamService.setMembersEnabled(session, handles, enabled, knownAgents);
      return true;
    } catch (error) {
      return mutationFailed(error);
    }
  }, [cards, knownAgents, mutationFailed, session]);

  const selectedHandle = selected?.sessionId === session.id ? selected.handle : null;
  const selectedCard = selectedHandle
    ? (cards.find((card) => card.handle === selectedHandle) ?? null)
    : null;
  const openMember = useCallback((handle: string) => {
    setSelected({ sessionId: session.id, handle });
  }, [session.id]);
  const closeMember = useCallback(() => setSelected(null), []);
  const editRole = useCallback(() => {
    setSelected(null);
    useAppStore.getState().setSettingsTab("subagents");
  }, []);
  const retry = useCallback(async () => {
    try {
      await teamService.reload(session);
    } catch (error) {
      onError(error);
    }
  }, [onError, session]);

  return {
    cards,
    counts,
    runningTotal,
    loading: team.config === null || page.loading,
    saving: team.saving,
    errorText: team.errorCode === TEAM_ROSTER_FULL ? t("team.teamFull") : team.error,
    selectedCard,
    openMember,
    closeMember,
    editRole,
    updateMember,
    setAll,
    retry,
  };
}
