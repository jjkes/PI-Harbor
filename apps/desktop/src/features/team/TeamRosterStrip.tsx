import { useId } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown, IconChevronRight } from "../../components/icons";
import { Badge, cx } from "../../components/ui";
import { TeamMemberCard } from "./TeamMemberCard";
import type { TeamRosterCard } from "./team-roster-model";

/**
 * Member cards above the call graph: one per Settings role, each with only a
 * session switch. Collapsed, the strip keeps its heading row and the graph gets
 * the height.
 */
export function TeamRosterStrip({
  cards,
  runningTotal,
  loading,
  saving,
  collapsed,
  onCollapsedChange,
  onToggleMember,
  onOpenMember,
}: {
  cards: readonly TeamRosterCard[];
  runningTotal: number;
  loading: boolean;
  saving: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onToggleMember: (card: TeamRosterCard, on: boolean) => void;
  onOpenMember: (card: TeamRosterCard) => void;
}) {
  const { t } = useTranslation();
  const bodyId = useId();
  const enabled = cards.filter((card) => card.on).length;

  return (
    <section
      className={cx("team-roster", collapsed && "is-collapsed")}
      aria-label={t("team.rosterListLabel")}
    >
      <div className="team-roster-head">
        <h2 className="team-roster-heading">
          <button
            type="button"
            className="team-roster-toggle"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            title={collapsed ? t("team.expandRoster") : t("team.collapseRoster")}
            onClick={() => onCollapsedChange(!collapsed)}
          >
            {collapsed ? (
              <IconChevronRight size={14} aria-hidden="true" />
            ) : (
              <IconChevronDown size={14} aria-hidden="true" />
            )}
            <span>
              {loading
                ? t("team.rosterListLabel")
                : t("team.rosterHeading", { enabled, total: cards.length })}
            </span>
          </button>
        </h2>
        {runningTotal > 0 ? (
          <Badge tone="success" className="team-roster-running">
            {t("team.runningCount", { count: runningTotal })}
          </Badge>
        ) : null}
      </div>
      <div id={bodyId} className="team-roster-body" hidden={collapsed}>
        {loading ? (
          <p className="team-roster-empty">{t("common.loading")}</p>
        ) : cards.length === 0 ? (
          <p className="team-roster-empty">{t("team.noDefinitions")}</p>
        ) : (
          <ul className="team-roster-grid">
            {cards.map((card) => (
              <li key={card.handle}>
                <TeamMemberCard
                  card={card}
                  saving={saving}
                  onToggle={(on) => onToggleMember(card, on)}
                  onOpen={() => onOpenMember(card)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
