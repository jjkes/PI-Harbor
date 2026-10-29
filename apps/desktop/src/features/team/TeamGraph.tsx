import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-harbor/shared";
import { IconChevronLeft, IconChevronRight, IconTarget } from "../../components/icons";
import { Button, TooltipButton } from "../../components/ui";
import { buildTranscriptEntries } from "../../lib/assistant-turns";
import { toolResultPayload } from "../../lib/tool-presentation";
import { useAppStore } from "../../stores/app-store";
import { TeamGraphNode } from "./TeamGraphNode";
import type {
  TeamGraph as TeamGraphModel,
  TeamGraphNode as TeamGraphNodeModel,
} from "./team-graph-model";

const MAIN_NODE_ID = "__team_main__";

type TokenUsage = { total: number; input?: number; output?: number };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function messageTokenUsage(message: UiMessage | undefined): TokenUsage | null {
  if (!message) return null;
  const payload = record(toolResultPayload(message));
  const usage = record(payload?.usage);
  const total = tokenCount(usage?.totalTokens) ?? tokenCount(payload?.totalTokens);
  if (total === undefined) return null;
  const input = tokenCount(usage?.inputTokens);
  const output = tokenCount(usage?.outputTokens);
  return {
    total,
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

export function TeamGraph({
  graph,
  messages,
  mainModelId,
  isRunning,
  onLoadOlder,
  onError,
}: {
  graph: TeamGraphModel;
  messages: readonly UiMessage[];
  mainModelId?: string;
  isRunning: boolean;
  onLoadOlder?: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const openSubagentTab = useAppStore((state) => state.openSubagentTab);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());
  const [activeId, setActiveId] = useState(MAIN_NODE_ID);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const nodeRefs = useRef(new Map<string, HTMLElement>());

  const allTurnIds = useMemo(
    () => buildTranscriptEntries([...messages]).entries.flatMap((entry) =>
      entry.kind === "assistant-turn" ? [entry.id] : []),
    [messages],
  );
  const liveTurnId = graph.turns[graph.turns.length - 1]?.id ?? allTurnIds[allTurnIds.length - 1];
  const currentTurnId = selectedTurnId && allTurnIds.includes(selectedTurnId)
    ? selectedTurnId
    : liveTurnId;
  const currentTurnIndex = currentTurnId ? allTurnIds.indexOf(currentTurnId) : -1;
  const currentTurn = graph.turns.find((turn) => turn.id === currentTurnId);
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const roots = (currentTurn?.rootIds ?? []).flatMap((id) => {
    const node = nodeById.get(id);
    return node && node.depth === 1 && !node.orphan && !node.cycle && !node.depthAnomaly
      ? [node]
      : [];
  });
  const childrenByOwner = new Map<string, TeamGraphNodeModel[]>();
  for (const id of currentTurn?.nodeIds ?? []) {
    const node = nodeById.get(id);
    if (!node || node.depth !== 2 || !node.ownerId || node.orphan || node.cycle || node.depthAnomaly) {
      continue;
    }
    const siblings = childrenByOwner.get(node.ownerId) ?? [];
    siblings.push(node);
    childrenByOwner.set(node.ownerId, siblings);
  }

  useEffect(() => {
    if (selectedTurnId && !allTurnIds.includes(selectedTurnId)) setSelectedTurnId(null);
  }, [allTurnIds, selectedTurnId]);
  useEffect(() => setActiveId(MAIN_NODE_ID), [currentTurnId]);

  const openNode = useCallback((node: TeamGraphNodeModel) => {
    openSubagentTab(node.delegationId ?? node.toolCallId ?? node.messageId, node.agentName || undefined);
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-message-id="${CSS.escape(node.messageId)}"]`)
        ?.scrollIntoView({ block: "center" });
    });
  }, [openSubagentTab]);

  const tokenLabels = useMemo(() => {
    const labels = new Map<string, { own?: string; subtree?: string }>();
    const messageById = new Map(messages.map((message) => [message.id, message]));
    const usages = new Map(graph.nodes.map((node) => [
      node.id,
      messageTokenUsage(messageById.get(node.messageId)),
    ]));
    const format = (value: number) => value.toLocaleString();
    for (const node of graph.nodes) {
      const own = usages.get(node.id);
      const label: { own?: string; subtree?: string } = {};
      if (own) {
        label.own = own.input !== undefined && own.output !== undefined
          ? t("team.tokenUsageDetailed", {
              total: format(own.total), input: format(own.input), output: format(own.output),
            })
          : t("team.tokenUsage", { total: format(own.total) });
      }
      if (node.depth === 1) {
        const subtreeTotal = graph.nodes.reduce((total, candidate) => (
          candidate.rootId === node.id ? total + (usages.get(candidate.id)?.total ?? 0) : total
        ), 0);
        if (subtreeTotal > 0) label.subtree = t("team.tokenSubtreeUsage", { total: format(subtreeTotal) });
      }
      labels.set(node.id, label);
    }
    return labels;
  }, [graph.nodes, messages, t]);

  const historyNodes = graph.nodes.filter((node) => node.orphan);
  const anomalyNodes = [...new Map([
    ...graph.nodes.filter((node) => node.cycle),
    ...(currentTurn?.nodeIds ?? []).flatMap((id) => {
      const node = nodeById.get(id);
      return node && !node.cycle && node.depthAnomaly ? [node] : [];
    }),
  ].map((node) => [node.id, node])).values()];
  const diagnosticKey = graph.nodes
    .filter((node) => node.depthAnomaly || node.cycle)
    .map((node) => `${node.id}:${node.depth}:${node.cycle}`)
    .join("|");
  useEffect(() => {
    if (!diagnosticKey) return;
    console.warn("[TeamGraph] Unsupported delegation ancestry", diagnosticKey);
  }, [diagnosticKey]);

  const toggleNode = useCallback((node: TeamGraphNodeModel) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
    setActiveId(node.id);
  }, []);
  const registerNode = useCallback((id: string, element: HTMLElement | null) => {
    if (element) nodeRefs.current.set(id, element);
    else nodeRefs.current.delete(id);
  }, []);
  const focusNode = useCallback((id: string) => {
    setActiveId(id);
    nodeRefs.current.get(id)?.focus();
  }, []);

  const visibleIds = [MAIN_NODE_ID];
  for (const root of roots) {
    visibleIds.push(root.id);
    if (!collapsedIds.has(root.id)) {
      for (const child of childrenByOwner.get(root.id) ?? []) visibleIds.push(child.id);
    }
  }
  const rovingId = visibleIds.includes(activeId) ? activeId : MAIN_NODE_ID;

  const navigate = (
    event: ReactKeyboardEvent<HTMLElement>,
    node?: TeamGraphNodeModel,
  ) => {
    const id = node?.id ?? MAIN_NODE_ID;
    const index = visibleIds.indexOf(id);
    const children = node ? childrenByOwner.get(node.id) ?? [] : roots;
    const expanded = children.length > 0 && !collapsedIds.has(id);
    let target: string | undefined;
    if (event.key === "ArrowDown") target = visibleIds[Math.min(visibleIds.length - 1, index + 1)];
    else if (event.key === "ArrowUp") target = visibleIds[Math.max(0, index - 1)];
    else if (event.key === "Home") target = visibleIds[0];
    else if (event.key === "End") target = visibleIds[visibleIds.length - 1];
    else if (event.key === "ArrowRight") {
      if (node && children.length > 0 && !expanded) toggleNode(node);
      else target = visibleIds[index + 1];
    } else if (event.key === "ArrowLeft") {
      if (node && expanded) toggleNode(node);
      else if (node?.depth === 2 && node.ownerId) target = node.ownerId;
      else if (node) target = MAIN_NODE_ID;
    } else if (event.key === "Enter" || event.key === " ") {
      if (node) openNode(node);
    } else return;
    event.preventDefault();
    event.stopPropagation();
    if (target) focusNode(target);
  };

  const renderNode = (node: TeamGraphNodeModel, level: 2 | 3) => {
    const children = level === 2 ? childrenByOwner.get(node.id) ?? [] : [];
    const expanded = children.length > 0 && !collapsedIds.has(node.id);
    const usage = tokenLabels.get(node.id);
    return (
      <TeamGraphNode
        key={node.id}
        node={node}
        level={level}
        nestedCount={children.length}
        expanded={expanded}
        active={rovingId === node.id}
        tokenLabel={usage?.own}
        subtreeTokenLabel={usage?.subtree}
        onOpen={openNode}
        onToggle={toggleNode}
        onNavigate={(event, current) => navigate(event, current)}
        onActivate={setActiveId}
        registerNode={registerNode}
      >
        {expanded ? (
          <div className="team-graph-children" role="group">
            {children.map((child) => renderNode(child, 3))}
          </div>
        ) : null}
      </TeamGraphNode>
    );
  };

  const loadOlder = async () => {
    if (!onLoadOlder || loadingOlder) return;
    setLoadingOlder(true);
    try {
      await onLoadOlder();
    } catch (error) {
      onError(error);
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <section className="team-graph" aria-label={t("team.graphTitle")}>
      <div className="team-graph-head">
        <h2>{t("team.graphTitle")}</h2>
        <div className="team-turn-stepper" aria-label={t("team.turnStepper")}>
          <TooltipButton
            type="button"
            tooltip={t("team.previousTurn")}
            ariaLabel={t("team.previousTurn")}
            disabled={currentTurnIndex <= 0}
            onClick={() => setSelectedTurnId(allTurnIds[currentTurnIndex - 1] ?? null)}
          >
            <IconChevronLeft size={14} />
          </TooltipButton>
          <span aria-live="polite">
            {currentTurnIndex >= 0
              ? t("team.turn", { number: currentTurnIndex + 1 })
              : t("team.noTurns")}
          </span>
          <TooltipButton
            type="button"
            tooltip={t("team.nextTurn")}
            ariaLabel={t("team.nextTurn")}
            disabled={currentTurnIndex < 0 || currentTurnIndex >= allTurnIds.length - 1}
            onClick={() => setSelectedTurnId(allTurnIds[currentTurnIndex + 1] ?? null)}
          >
            <IconChevronRight size={14} />
          </TooltipButton>
        </div>
        {selectedTurnId ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setSelectedTurnId(null)}>
            {t("team.backToLive")}
          </Button>
        ) : null}
      </div>
      <div className="team-graph-scroll">
        <div className="team-graph-tree" role="tree" aria-label={t("team.treeLabel")}>
          <div
            ref={(element) => registerNode(MAIN_NODE_ID, element)}
            className="team-graph-treeitem team-graph-main-item"
            role="treeitem"
            aria-level={1}
            aria-expanded={roots.length > 0 ? true : undefined}
            aria-label={`${t("chat.subagentCoordinator")}, ${isRunning ? t("chat.running") : t("team.ready")}`}
            tabIndex={rovingId === MAIN_NODE_ID ? 0 : -1}
            onFocus={() => setActiveId(MAIN_NODE_ID)}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget) navigate(event);
            }}
          >
            <div className="team-graph-main">
              <span className="team-graph-main-icon" aria-hidden><IconTarget size={16} /></span>
              <div>
                <strong>{t("chat.subagentCoordinator")}</strong>
                <span>{mainModelId || t("team.modelPending")}</span>
                <span>{isRunning ? t("chat.running") : t("team.ready")}</span>
              </div>
            </div>
            {roots.length > 0 ? (
              <>
                <span className="team-graph-connector" aria-hidden />
                <div className="team-graph-roots" role="group">
                  {roots.map((root) => renderNode(root, 2))}
                </div>
              </>
            ) : null}
          </div>
        </div>
        {roots.length === 0 ? <p className="team-graph-empty">{t("team.emptyTurn")}</p> : null}
        {historyNodes.length > 0 ? (
          <section className="team-graph-history" aria-label={t("team.orphanTitle")}>
            <h3>{t("team.orphanTitle")}</h3>
            <p>{t("team.orphanDescription")}</p>
            {onLoadOlder ? (
              <Button type="button" size="sm" variant="secondary" disabled={loadingOlder} onClick={() => void loadOlder()}>
                {loadingOlder ? t("team.loadingEarlier") : t("team.loadEarlier")}
              </Button>
            ) : null}
            <ul>
              {historyNodes.map((node) => (
                <li key={node.id}>
                  <TeamGraphNode node={node} anomaly onOpen={openNode} tokenLabel={tokenLabels.get(node.id)?.own} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {anomalyNodes.length > 0 ? (
          <section className="team-graph-anomalies" aria-label={t("team.anomaliesTitle")}>
            <h3>{t("team.anomaliesTitle")}</h3>
            <ul aria-label={t("team.anomalyListLabel")}>
              {anomalyNodes.map((node) => (
                <li key={node.id} title={node.cycle ? t("team.cycleDescription") : t("team.deepDescription")}>
                  <TeamGraphNode node={node} anomaly onOpen={openNode} tokenLabel={tokenLabels.get(node.id)?.own} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </section>
  );
}
