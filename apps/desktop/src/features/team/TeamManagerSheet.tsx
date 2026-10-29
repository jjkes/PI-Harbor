import { useEffect, useId } from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_TEAM_MEMBERS,
  normalizeSubagentName,
  subagentCanMutate,
  type SessionTeamMember,
} from "@pi-harbor/shared";
import { IconBot, IconPlus, IconTrash, IconX } from "../../components/icons";
import { Badge, Button, Panel, TooltipButton, portalOverlay } from "../../components/ui";
import { teamService, type TeamSessionTarget } from "./team-service";
import { TeamModelSelect, type TeamDefinitionEntry } from "./TeamMemberCard";

export function TeamManagerSheet({
  session,
  members,
  definitions,
  loading,
  saving,
  onClose,
  onError,
}: {
  session: TeamSessionTarget;
  members: readonly SessionTeamMember[];
  definitions: readonly TeamDefinitionEntry[];
  loading: boolean;
  saving: boolean;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const memberByHandle = new Map(
    members.map((member) => [normalizeSubagentName(member.agent), member]),
  );
  const atCapacity = members.length >= MAX_TEAM_MEMBERS;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, saving]);

  return portalOverlay(
    <div
      className="overlay team-manager-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div
        className="dialog team-manager-sheet"
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
      >
        <div className="team-manager-head">
          <div>
            <h2 id={titleId}>{t("team.managerTitle")}</h2>
            <p>{t("team.managerDescription")}</p>
          </div>
          <TooltipButton
            type="button"
            className="team-manager-close"
            tooltip={t("common.close")}
            ariaLabel={t("common.close")}
            disabled={saving}
            autoFocus
            onClick={onClose}
          >
            <IconX size={15} />
          </TooltipButton>
        </div>
        <div className="team-manager-body">
          {loading ? (
            <p className="team-manager-empty">{t("common.loading")}</p>
          ) : definitions.length === 0 ? (
            <p className="team-manager-empty">{t("team.noDefinitions")}</p>
          ) : (
            <ul className="team-manager-list" aria-label={t("team.managerListLabel")}>
              {definitions.map((entry) => {
                const member = memberByHandle.get(entry.handle);
                const canMutate = subagentCanMutate(entry.definition);
                return (
                  <li key={`${entry.definition.source}:${entry.handle}`}>
                    <Panel className="team-manager-card">
                      <div
                        className="team-manager-card-main"
                        title={entry.definition.description}
                      >
                        <span className="team-member-avatar" aria-hidden>
                          <IconBot size={16} />
                        </span>
                        <div className="team-manager-card-copy">
                          <strong>{entry.handle}</strong>
                          <span>{entry.definition.description}</span>
                        </div>
                        <Badge tone={!entry.enabled ? "error" : canMutate ? "warning" : "neutral"}>
                          {!entry.enabled
                            ? t("team.unavailable")
                            : canMutate
                              ? t("team.writeAccess")
                              : t("team.readOnly")}
                        </Badge>
                      </div>
                      <div className="team-manager-card-actions">
                        {member ? (
                          <>
                            <TeamModelSelect
                              member={member}
                              entry={entry}
                              disabled={saving}
                              onChange={(model) => {
                                void teamService
                                  .setMemberModel(session, entry.handle, model)
                                  .catch(onError);
                              }}
                            />
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={saving}
                              aria-label={t("team.removeMember", { name: entry.handle })}
                              onClick={() => {
                                void teamService.removeMember(session, entry.handle).catch(onError);
                              }}
                            >
                              <IconTrash size={13} />
                              {t("team.remove")}
                            </Button>
                          </>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="primary"
                            disabled={saving || !entry.enabled || atCapacity}
                            title={atCapacity ? t("team.teamFull") : undefined}
                            aria-label={t("team.addNamed", { name: entry.handle })}
                            onClick={() => {
                              void teamService.addMember(session, entry.handle).catch(onError);
                            }}
                          >
                            <IconPlus size={13} />
                            {t("team.add")}
                          </Button>
                        )}
                      </div>
                    </Panel>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>,
  );
}
