import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { normalizeSubagentName, type SessionTeamMember } from "@pi-harbor/shared";
import {
  IconChevronDown,
  IconChevronRight,
  IconPlus,
  IconSettings,
} from "../../components/icons";
import { Badge, Button, TooltipButton } from "../../components/ui";
import type { TeamSessionTarget } from "./team-service";
import { TeamMemberCard, type TeamDefinitionEntry } from "./TeamMemberCard";

export function TeamRosterStrip({
  session,
  members,
  definitions,
  runningByAgent,
  runningTotal,
  loading,
  saving,
  onManage,
  onError,
}: {
  session: TeamSessionTarget;
  members: readonly SessionTeamMember[];
  definitions: readonly TeamDefinitionEntry[];
  runningByAgent: ReadonlyMap<string, number>;
  runningTotal: number;
  loading: boolean;
  saving: boolean;
  onManage: () => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const listId = useId();
  const byHandle = new Map(definitions.map((entry) => [entry.handle, entry]));

  return (
    <section className="team-roster" aria-label={t("team.rosterListLabel")}>
      <div className="team-roster-head">
        <div className="team-roster-heading">
          <h2>{t("team.rosterTitle", { count: members.length })}</h2>
          {runningTotal > 0 ? (
            <Badge tone="success" className="team-roster-running">
              {t("team.runningCount", { count: runningTotal })}
            </Badge>
          ) : null}
        </div>
        <div className="team-roster-actions">
          <TooltipButton
            type="button"
            className="team-roster-action"
            tooltip={t("team.addMember")}
            ariaLabel={t("team.addMember")}
            onClick={onManage}
          >
            <IconPlus size={15} />
          </TooltipButton>
          <TooltipButton
            type="button"
            className="team-roster-action"
            tooltip={t("team.manage")}
            ariaLabel={t("team.manage")}
            onClick={onManage}
          >
            <IconSettings size={14} />
          </TooltipButton>
          <TooltipButton
            type="button"
            className="team-roster-action"
            tooltip={t(expanded ? "team.collapseRoster" : "team.expandRoster")}
            ariaLabel={t(expanded ? "team.collapseRoster" : "team.expandRoster")}
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          </TooltipButton>
        </div>
      </div>
      {expanded ? (
        loading ? (
          <p className="team-roster-empty">{t("common.loading")}</p>
        ) : members.length === 0 ? (
          <p className="team-roster-empty">{t("team.emptyRoster")}</p>
        ) : (
          <ul id={listId} className="team-roster-list" aria-label={t("team.rosterListLabel")}>
            {members.map((member) => {
              const handle = normalizeSubagentName(member.agent);
              return (
                <li key={handle}>
                  <TeamMemberCard
                    session={session}
                    member={member}
                    entry={byHandle.get(handle)}
                    runningCount={runningByAgent.get(handle) ?? 0}
                    saving={saving}
                    onError={onError}
                  />
                </li>
              );
            })}
          </ul>
        )
      ) : (
        <Button
          type="button"
          id={listId}
          variant="ghost"
          className="team-roster-summary"
          onClick={() => setExpanded(true)}
        >
          {t("team.rosterSummary", {
            count: members.length,
            running: runningTotal,
          })}
        </Button>
      )}
    </section>
  );
}
