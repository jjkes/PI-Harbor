import { memo } from "react";
import type { AssistantActivityItem } from "../../../lib/assistant-turns";
import { isDelegationActivityItem, type DelegationActivityItem, type SubagentOutcome, type SubagentTiming } from "../../../lib/subagent-topology";
import { reviewChangeFromMessage } from "../../../lib/workspace-review";
import { ReviewChangeCard } from "../../../components/ReviewChangeCard";
import { ThinkingRow } from "./shared";
import { HostedSearchRow } from "./HostedSearchRow";
import { DelegationSummaryRow } from "./DelegationSummaryRow";
import { ToolRow } from "./ToolRow";
import { useRenderBlocks, type RenderBlock } from "./render-blocks";

function itemKey(item: AssistantActivityItem) {
  if (item.kind === "tool") return item.message.id;
  if (item.kind === "hostedSearch") return `hosted-search-${item.message.id}-${item.round.id}`;
  return `thinking-${item.message.id}`;
}

type ActivityItemsProps = {
  items: readonly AssistantActivityItem[];
  isActive: boolean;
  delegateItems: DelegationActivityItem[];
  delegationStatuses: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings: ReadonlyMap<string, SubagentTiming>;
  /** End of the owning activity part, once it has settled. */
  endedAt?: string;
  onUserInteraction: () => void;
};

type ActivityItemBlockProps = Omit<ActivityItemsProps, "items" | "delegateItems" | "delegationStatuses" | "delegationTimings"> & {
  block: RenderBlock<AssistantActivityItem>;
  /** The group's first delegation row; set only on the block that holds it. */
  summaryItem?: AssistantActivityItem;
  groupItems?: readonly AssistantActivityItem[];
  delegateItems?: DelegationActivityItem[];
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
};

const ActivityItemBlock = memo(function ActivityItemBlock({
  block, isActive, summaryItem, groupItems,
  delegateItems, delegationStatuses, delegationTimings, endedAt, onUserInteraction,
}: ActivityItemBlockProps) {
  return <>{block.items.map((item) => {
    // The topology predicate narrows to all tools, but a false result can still
    // be an ordinary tool. Do not exclude tools from the remaining branches.
    const delegation = Boolean(isDelegationActivityItem(item));
    if (delegation) {
      // One summary row stands for every delegation row of the group. The call
      // graph is drawn once, in the composer dock.
      if (item !== summaryItem || !groupItems || !delegateItems || !delegationStatuses || !delegationTimings) return null;
      return <DelegationSummaryRow
        key="delegation-summary"
        groupItems={groupItems}
        delegateItems={delegateItems}
        delegationStatuses={delegationStatuses}
        delegationTimings={delegationTimings}
        groupActive={isActive}
        endedAt={endedAt}
      />;
    }
    // A tool or hosted-search row always starts collapsed: only the user opens
    // a payload, never the row's position in the turn. A review-backed edit is
    // already a complete tool-level row (file header + diff body), so rendering
    // the generic tool row above it would repeat the file header.
    if (item.kind === "tool") {
      if (reviewChangeFromMessage(item.message)) {
        return <ReviewChangeCard
          key={item.message.id}
          message={item.message}
          asToolRow
        />;
      }
      return <ToolRow
        key={item.message.id}
        imagesInTurn
        message={item.message}
        onUserInteraction={onUserInteraction}
        {...(item.delegate ? { delegate: item.delegate } : {})}
      />;
    }
    if (item.kind === "hostedSearch") return <HostedSearchRow
      key={`hosted-search-${item.message.id}-${item.round.id}`}
      messageId={item.message.id}
      round={item.round}
      streaming={isActive && item.message.status === "streaming"}
      onUserInteraction={onUserInteraction}
    />;
    return <ThinkingRow
      key={`thinking-${item.message.id}`}
      message={item.message}
      streaming={isActive && item.message.status === "streaming"}
      autoOpen
      onUserInteraction={onUserInteraction}
    />;
  })}</>;
});

export const ActivityItems = memo(function ActivityItems({ items, ...context }: ActivityItemsProps) {
  const blocks = useRenderBlocks(items, itemKey);
  const summaryItem = context.delegateItems[0];
  return <>{blocks.map((block) => {
    const ownsSummary = summaryItem !== undefined && block.items.includes(summaryItem);
    return <ActivityItemBlock
      key={block.key}
      block={block}
      isActive={context.isActive}
      summaryItem={ownsSummary ? summaryItem : undefined}
      groupItems={ownsSummary ? items : undefined}
      delegateItems={ownsSummary ? context.delegateItems : undefined}
      delegationStatuses={ownsSummary ? context.delegationStatuses : undefined}
      delegationTimings={ownsSummary ? context.delegationTimings : undefined}
      endedAt={ownsSummary ? context.endedAt : undefined}
      onUserInteraction={context.onUserInteraction}
    />;
  })}</>;
});
