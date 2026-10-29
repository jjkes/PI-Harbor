import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { SubagentDefinition } from "@pi-harbor/shared";
import { IconChevronDown, IconChevronRight, IconX } from "../../components/icons";
import {
  Badge,
  Button,
  SettingsToggle,
  TooltipButton,
  portalOverlay,
} from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { teamStatusLabel, useTeamCardStatus } from "./TeamMemberCard";
import {
  TeamMemberOverrides,
  teamPinModelId,
  teamRoleToolNames,
  teamThinkingText,
} from "./TeamMemberOverrides";
import { containTabFocus } from "./team-focus";
import type { TeamMemberPatch, TeamRosterCard } from "./team-roster-model";

export type TeamRolePrompt =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "unavailable" };

/**
 * The role's instructions. Built-in roles carry them; a user-owned role's are
 * read from its document, and an answer for another role is never shown.
 */
function useRolePrompt(definition: SubagentDefinition): TeamRolePrompt {
  const ownedId = definition.source === "user" ? definition.name : null;
  const [owned, setOwned] = useState<{ id: string; prompt: TeamRolePrompt } | null>(null);
  useEffect(() => {
    if (!ownedId) return;
    let current = true;
    void api.readUserSubagent(ownedId).then(
      (result) => {
        if (!current) return;
        setOwned({
          id: ownedId,
          prompt: result.subagent
            ? { status: "ready", text: result.body ?? "" }
            : { status: "unavailable" },
        });
      },
      (error: unknown) => {
        if (!current) return;
        console.warn("[TeamMemberSheet] Could not read the role document", error);
        setOwned({ id: ownedId, prompt: { status: "unavailable" } });
      },
    );
    return () => {
      current = false;
    };
  }, [ownedId]);
  if (!ownedId) return { status: "ready", text: definition.prompt };
  return owned?.id === ownedId ? owned.prompt : { status: "loading" };
}

function sourceLabel(t: TFunction, definition: SubagentDefinition): string {
  return definition.source === "builtin"
    ? t("extensions.subagents.sourceBuiltin")
    : t("team.sourceCustom");
}

function permissionText(t: TFunction, permission: SubagentDefinition["permission"]): string {
  switch (permission) {
    case "ask":
      return t("chat.permissionAsk");
    case "accept-edits":
      return t("chat.permissionAcceptEdits");
    case "auto":
      return t("chat.permissionAuto");
    default:
      return t("team.permissionInherit");
  }
}

/**
 * Member details: the role's settings read-only, this session's settings
 * editable. The sheet can open above the Team drawer, whose focus trap listens
 * on the document during capture; claiming Escape and Tab on the window first
 * keeps both inside the sheet. Focus returns to the card that opened it.
 */
export function TeamMemberSheet({
  card,
  saving,
  onUpdate,
  onEditRole,
  onClose,
}: {
  card: TeamRosterCard;
  saving: boolean;
  onUpdate: (patch: TeamMemberPatch) => Promise<boolean>;
  onEditRole: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  const prompt = useRolePrompt(card.entry.definition);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (closeRef.current ?? dialogRef.current)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (dialogRef.current) containTabFocus(event, dialogRef.current);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return portalOverlay(
    <div
      className="overlay team-member-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <TeamMemberDialog
        card={card}
        prompt={prompt}
        saving={saving}
        dialogRef={dialogRef}
        closeRef={closeRef}
        onUpdate={onUpdate}
        onEditRole={onEditRole}
        onClose={onClose}
      />
    </div>,
  );
}

/** The sheet's dialog, rendered without the portal or key handling. */
export function TeamMemberDialog({
  card,
  prompt,
  saving,
  dialogRef,
  closeRef,
  onUpdate,
  onEditRole,
  onClose,
}: {
  card: TeamRosterCard;
  prompt: TeamRolePrompt;
  saving: boolean;
  dialogRef?: RefObject<HTMLDivElement | null>;
  closeRef?: RefObject<HTMLButtonElement | null>;
  onUpdate: (patch: TeamMemberPatch) => Promise<boolean>;
  onEditRole: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const roleHeadingId = useId();
  const promptId = useId();
  const [promptOpen, setPromptOpen] = useState(false);
  const providers = useAppStore((state) => state.providers);
  const status = useTeamCardStatus(card);
  const role = card.entry.definition;
  const toolNames = teamRoleToolNames(t, role);

  return (
    <div
      ref={dialogRef}
      className="dialog team-member-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <div className="team-member-sheet-head">
        <div className="team-member-sheet-title">
          <h2 id={titleId}>{card.handle}</h2>
          <div className="team-member-sheet-meta">
            <Badge>{sourceLabel(t, role)}</Badge>
            <Badge tone={card.canMutate ? "warning" : "neutral"}>
              {card.canMutate ? t("team.writeAccess") : t("team.readOnly")}
            </Badge>
            <span className="team-member-sheet-status">
              {teamStatusLabel(t, status, card.running)}
            </span>
          </div>
        </div>
        <div className="team-member-sheet-switch">
          <span aria-hidden="true">{t("team.useInSession")}</span>
          <SettingsToggle
            checked={card.on}
            label={t("team.useMember", { name: card.handle })}
            disabled={saving || !card.settingsEnabled}
            onChange={() => void onUpdate({ enabled: !card.on })}
          />
        </div>
        <TooltipButton
          ref={closeRef}
          type="button"
          className="team-member-sheet-close"
          tooltip={t("common.close")}
          ariaLabel={t("common.close")}
          onClick={onClose}
        >
          <IconX size={15} />
        </TooltipButton>
      </div>
      <div className="team-member-sheet-body">
        <section className="team-member-sheet-section" aria-labelledby={roleHeadingId}>
          <div className="team-member-section-head">
            <h3 id={roleHeadingId}>{t("team.roleSettings")}</h3>
            <Button type="button" size="sm" variant="ghost" onClick={onEditRole}>
              {t("team.editRoleInSettings")}
            </Button>
          </div>
          {role.description ? (
            <p className="team-member-description">{role.description}</p>
          ) : null}
          <dl className="team-member-facts">
            <div>
              <dt>{t("extensions.subagents.model")}</dt>
              <dd>
                {role.model
                  ? teamPinModelId(role.model, providers)
                  : t("extensions.subagents.modelInherit")}
              </dd>
            </div>
            <div>
              <dt>{t("extensions.subagents.thinking")}</dt>
              <dd>{teamThinkingText(t, role.thinkingLevel)}</dd>
            </div>
            <div>
              <dt>{t("extensions.subagents.tools")}</dt>
              <dd>
                {toolNames.length > 0 ? (
                  <span className="team-member-chips">
                    {toolNames.map((name) => (
                      <span key={name} className="team-member-chip">
                        {name}
                      </span>
                    ))}
                  </span>
                ) : (
                  t("team.none")
                )}
              </dd>
            </div>
            {role.source === "builtin" ? (
              <div>
                <dt>{t("chat.permissionMode")}</dt>
                <dd>{permissionText(t, role.permission)}</dd>
              </div>
            ) : null}
          </dl>
          <button
            type="button"
            className="team-member-prompt-toggle"
            aria-expanded={promptOpen}
            aria-controls={promptId}
            onClick={() => setPromptOpen((open) => !open)}
          >
            {promptOpen ? (
              <IconChevronDown size={13} aria-hidden="true" />
            ) : (
              <IconChevronRight size={13} aria-hidden="true" />
            )}
            <span>{t("extensions.subagents.body")}</span>
          </button>
          <div id={promptId} className="team-member-prompt" hidden={!promptOpen}>
            {prompt.status === "loading" ? (
              <p className="team-member-note">{t("common.loading")}</p>
            ) : prompt.status === "unavailable" ? (
              <p className="team-member-note">{t("team.promptUnavailable")}</p>
            ) : prompt.text.trim() ? (
              <pre>{prompt.text}</pre>
            ) : (
              <p className="team-member-note">{t("team.none")}</p>
            )}
          </div>
        </section>
        <TeamMemberOverrides card={card} saving={saving} onUpdate={onUpdate} />
      </div>
    </div>
  );
}
