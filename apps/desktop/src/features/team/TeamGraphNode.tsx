import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  IconBot,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCircleAlert,
  IconStop,
} from "../../components/icons";
import { Badge, TooltipButton, cx } from "../../components/ui";
import { formatToolDuration } from "../../lib/tool-display";
import { SubagentStopButton } from "../chat/transcript/SubagentStopButton";
import type { TeamGraphNode as TeamGraphNodeModel } from "./team-graph-model";

export function TeamGraphNode({
  node,
  level,
  nestedCount = 0,
  expanded = false,
  active = false,
  anomaly = false,
  tokenLabel,
  subtreeTokenLabel,
  children,
  onOpen,
  onToggle,
  onNavigate,
  onActivate,
  registerNode,
}: {
  node: TeamGraphNodeModel;
  level?: 2 | 3;
  nestedCount?: number;
  expanded?: boolean;
  active?: boolean;
  anomaly?: boolean;
  tokenLabel?: string;
  subtreeTokenLabel?: string;
  children?: ReactNode;
  onOpen: (node: TeamGraphNodeModel) => void;
  onToggle?: (node: TeamGraphNodeModel) => void;
  onNavigate?: (event: ReactKeyboardEvent<HTMLElement>, node: TeamGraphNodeModel) => void;
  onActivate?: (id: string) => void;
  registerNode?: (id: string, element: HTMLElement | null) => void;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const running = node.status === "running";
  const elapsedMs = node.durationMs ??
    (running && node.startedAt !== undefined ? Math.max(0, now - node.startedAt) : undefined);
  const elapsed = elapsedMs !== undefined ? formatToolDuration(elapsedMs / 1000) : "";
  const statusLabel = t(`chat.subagentStatus.${node.status}`);
  const name = node.agentName || t("chat.subagentUnnamed");
  const anomalyLabel = node.cycle
    ? t("team.cycleAnomaly")
    : node.depthAnomaly
      ? t("team.depthAnomaly")
      : "";

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const openFromMouse = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest("button")) return;
    event.stopPropagation();
    onActivate?.(node.id);
    onOpen(node);
  };
  const label = [
    name,
    statusLabel,
    node.modelId || undefined,
    elapsed || undefined,
    nestedCount > 0 ? t("chat.subagentNestedCount", { count: nestedCount }) : undefined,
    anomalyLabel || undefined,
  ].filter(Boolean).join(", ");

  return (
    <div
      ref={(element) => registerNode?.(node.id, element)}
      className={cx("team-graph-treeitem", anomaly && "is-anomaly")}
      role={level ? "treeitem" : "listitem"}
      aria-level={level}
      aria-expanded={level && nestedCount > 0 ? expanded : undefined}
      aria-label={label}
      tabIndex={level ? (active ? 0 : -1) : undefined}
      data-team-node-id={node.id}
      onFocus={() => onActivate?.(node.id)}
      onClick={openFromMouse}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        onNavigate?.(event, node);
      }}
    >
      <div
        className={cx("team-graph-node", `outcome-${node.status.replaceAll("_", "-")}`)}
        title={[node.description, tokenLabel, subtreeTokenLabel].filter(Boolean).join("\n") || undefined}
      >
        {level && nestedCount > 0 ? (
          <TooltipButton
            type="button"
            tabIndex={-1}
            className="team-graph-expand"
            tooltip={t(expanded ? "team.collapseNode" : "team.expandNode", { name })}
            ariaLabel={t(expanded ? "team.collapseNode" : "team.expandNode", { name })}
            onClick={(event) => {
              event.stopPropagation();
              onToggle?.(node);
            }}
          >
            {expanded ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          </TooltipButton>
        ) : null}
        <span className="team-graph-avatar" aria-hidden>
          <IconBot size={15} />
          <span className="team-graph-status-icon">
            {node.status === "completed" ? (
              <IconCheck size={8} />
            ) : node.status === "aborted" || node.status === "stopped" ? (
              <IconStop size={7} />
            ) : running ? (
              <span />
            ) : (
              <IconCircleAlert size={8} />
            )}
          </span>
        </span>
        <div className="team-graph-node-copy">
          <div className="team-graph-node-title-row">
            <strong>{name}</strong>
            {node.resumed ? <Badge tone="neutral">{t("team.resumed")}</Badge> : null}
            {anomalyLabel ? <Badge tone="warning">{anomalyLabel}</Badge> : null}
          </div>
          {node.description ? (
            <span className="team-graph-node-description">{node.description}</span>
          ) : null}
          <div className="team-graph-node-meta">
            <span className="team-graph-node-model">{node.modelId || t("team.modelPending")}</span>
            <span>{statusLabel}{elapsed ? ` · ${elapsed}` : ""}</span>
            {nestedCount > 0 ? (
              <span>{t("chat.subagentNestedCount", { count: nestedCount })}</span>
            ) : null}
          </div>
        </div>
        {node.delegationId ? (
          <SubagentStopButton delegationId={node.delegationId} running={running} name={name} compact />
        ) : null}
      </div>
      {children}
    </div>
  );
}
