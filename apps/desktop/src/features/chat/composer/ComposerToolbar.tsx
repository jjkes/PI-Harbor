import { useMemo, type Dispatch, type SetStateAction } from "react";
import type { TFunction } from "i18next";
import {
  keybindingDisplayParts,
  type Mode,
  type PermissionMode,
  type ShortcutPlatform,
  type SessionThinkingLevel,
  type PluginComposerTransformMeta,
} from "@pi-harbor/shared";
import { useAppStore } from "../../../stores/app-store";
import type { AppState } from "../../../stores/app-store";
import { ComposerModePicker } from "./ComposerModePicker";
import { ComposerPermissionPicker } from "./ComposerPermissionPicker";
import { ContextUsageInspector } from "../../../components/ContextUsageInspector";
import { SessionTokenUsagePanel } from "../../../components/SessionTokenUsagePanel";
import type { SessionTokenUsage } from "../../../lib/session-token-usage";
import { ComposerControlSlots } from "./ComposerControlSlots";
import { TooltipButton } from "../../../components/ui";
import { planDebateRequest } from "../../plan-debate/plan-debate-prompt";
import {
  planDebateRunning,
  planDebateUnfinishedRound,
} from "../../plan-debate/plan-debate-view";
import { planDebateWorkPanelTab } from "../../../lib/work-panel-tabs";
import {
  IconArrowUp,
  IconPlus,
  IconSparkles,
  IconStop,
  IconUndo2,
} from "../../../components/icons";
import { DictationControl } from "../../voice/DictationControl";
import type { ComposerDictation } from "../../voice/useComposerDictation";
import { LiveVoiceControls } from "../../voice/live/LiveVoiceControls";
import { useComposerTeamMode } from "../../team/useComposerTeamMode";
import { ComposerModelPicker } from "./ComposerModelPicker";
import type { useComposerModelMenu } from "./hooks/useComposerModelMenu";

type ModelMenuController = ReturnType<typeof useComposerModelMenu>;
type ContextUsage = Parameters<typeof ContextUsageInspector>[0];

export type ComposerToolbarProps = {
  t: TFunction;
  mode: Mode;
  planningLive: boolean;
  providerId?: string;
  modelId?: string;
  thinkingLevel: SessionThinkingLevel;
  composerPermissionMode: Exclude<PermissionMode, "inherit">;
  modeOpen: boolean;
  setModeOpen: Dispatch<SetStateAction<boolean>>;
  permissionOpen: boolean;
  setPermissionOpen: Dispatch<SetStateAction<boolean>>;
  controlsBlocked: boolean;
  localToolsAllowed?: boolean;
  attachmentsAllowed?: boolean;
  stopAllowed?: boolean;
  pasting: boolean;
  pickAndAttach: () => Promise<void>;
  configureActiveSession: AppState["configureActiveSession"];
  showToast: AppState["showToast"];
  modelMenu: ModelMenuController;
  modelLabel: string;
  thinkingLabel: string;
  contextUsage: ContextUsage | null;
  sessionTokenUsage: SessionTokenUsage | null;
  /** The selected model asks for OpenAI's priority tier (ADR 0334). */
  modelFastMode?: boolean;
  value: string;
  modelReady: boolean;
  sendBlocked: boolean;
  composerTransforms: PluginComposerTransformMeta[];
  activeTransformKey: string | null;
  undoTransform: PluginComposerTransformMeta | null;
  runComposerTransform: (transform: PluginComposerTransformMeta) => Promise<void>;
  undoComposerTransform: () => void;
  runActive: boolean;
  hasDraftContent: boolean;
  abort: AppState["abort"];
  submit: (steering?: boolean, rewrite?: (text: string) => string) => Promise<void>;
  /**
   * Plan mode adds the debate action beside send. It is the composer's own send
   * path with a stated intent, not a second way to reach the runtime.
   */
  planMode: boolean;
  workSessionId?: string;
  workSessionLabel?: string;
  /** Local Dictation; the control renders only while it is enabled. */
  dictation?: ComposerDictation;
};

/** Out of plan mode the toolbar does not subscribe to the transcript. */
const NO_MESSAGES: readonly AppState["messages"][number][] = [];
/** Composer controls: mode, permission, model, plugin actions, and send/stop. */
export function ComposerToolbar({
  t,
  mode,
  planningLive,
  providerId,
  modelId,
  thinkingLevel,
  composerPermissionMode,
  modeOpen,
  setModeOpen,
  permissionOpen,
  setPermissionOpen,
  controlsBlocked,
  localToolsAllowed = true,
  attachmentsAllowed = true,
  stopAllowed = true,
  pasting,
  pickAndAttach,
  configureActiveSession,
  showToast,
  modelMenu,
  modelLabel,
  thinkingLabel,
  modelFastMode = false,
  contextUsage,
  sessionTokenUsage,
  value,
  modelReady,
  sendBlocked,
  composerTransforms,
  activeTransformKey,
  undoTransform,
  runComposerTransform,
  undoComposerTransform,
  runActive,
  hasDraftContent,
  abort,
  submit,
  planMode,
  workSessionId,
  workSessionLabel,
  dictation,
}: ComposerToolbarProps) {
  const platform = (window.piDesktop?.platform ?? "darwin") as ShortcutPlatform;
  const steeringShortcut = keybindingDisplayParts("Alt+Enter", platform).join("+");
  const team = useComposerTeamMode();
  // The same gates the send button uses, plus a running turn: a debate cannot
  // start inside one, and both plan actions stay off a disabled composer.
  const planActionBlocked = !hasDraftContent || sendBlocked || runActive;
  // The debate action is three-state and every state reads the same transcript
  // rows the planning panel draws: launching while no round is live, stopping
  // while one is producing, and pointing at the panel while one is unfinished
  // but no turn is behind it. A round that never settled with no turn behind it
  // — an abort that left its rows `running`, or a session reopened after a
  // crash — must still flip back to launching on its own, hence the `runActive`
  // guard.
  const debateMessages = useAppStore((state) => (planMode ? state.messages : NO_MESSAGES));
  const debateRunning = useMemo(
    () => planMode && runActive && planDebateRunning(debateMessages),
    [planMode, runActive, debateMessages],
  );
  // The round the panel is showing is still unfinished (proposing, drafting,
  // critiquing, integrating). Sending the debate prompt here would ask the
  // model for `PlanDebate` again, and the runtime would have to refuse it while
  // the panel already had a round: that second, empty round is what hid the
  // round the delegates belonged to. So the button opens the panel instead, and
  // the panel's re-debate is the only thing that advances the round number.
  const unfinishedRound = useMemo(
    () => (planMode ? planDebateUnfinishedRound(debateMessages) : null),
    [planMode, debateMessages],
  );
  return (
    <div className="composer-toolbar">
      <div className="composer-left">
        <div className="composer-plus">
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={t("chat.addFiles")}
            ariaLabel={t("chat.addFiles")}
            disabled={controlsBlocked || pasting || !attachmentsAllowed}
            onClick={() => {
              setPermissionOpen(false);
              void pickAndAttach();
            }}
          >
            <IconPlus size={15} aria-hidden="true" />
          </TooltipButton>
        </div>
        {localToolsAllowed && dictation?.enabled ? <DictationControl t={t} dictation={dictation} /> : null}
        {localToolsAllowed ? <LiveVoiceControls t={t} workSessionId={workSessionId} /> : null}
        <ComposerModePicker
          t={t}
          mode={mode}
          planningLive={planningLive}
          open={modeOpen}
          setOpen={setModeOpen}
          controlsBlocked={controlsBlocked}
          team={team}
          onCloseOtherMenus={() => {
            modelMenu.setOpen(false);
            setPermissionOpen(false);
          }}
          onSelect={async (next) => {
            try {
              await configureActiveSession({
                mode: next,
                providerId,
                modelId,
                thinkingLevel,
              });
            } catch (error) {
              showToast(error instanceof Error ? error.message : String(error), {
                variant: "error",
              });
            }
          }}
        />
        <ComposerPermissionPicker t={t} mode={mode}
          composerPermissionMode={composerPermissionMode}
          permissionOpen={permissionOpen} setPermissionOpen={setPermissionOpen}
          controlsBlocked={controlsBlocked}
          onCloseOtherMenus={() => {
            modelMenu.setOpen(false);
            setModeOpen(false);
          }}
          onSelect={async (candidate) => {
                try {
                  await configureActiveSession({
                    mode,
                    providerId,
                    modelId,
                    thinkingLevel,
                    permissionMode: candidate,
                  });
                } catch (error) {
                  showToast(error instanceof Error ? error.message : String(error), {
                    variant: "error",
                  });
                }
          }} />
        {localToolsAllowed ? <ComposerControlSlots side="left" /> : null}
      </div>

      <div className="composer-right">
        {sessionTokenUsage ? <SessionTokenUsagePanel usage={sessionTokenUsage} /> : null}
        {localToolsAllowed ? <ComposerControlSlots side="right" /> : null}
        {contextUsage ? <ContextUsageInspector {...contextUsage} /> : null}
        <ComposerModelPicker
          t={t}
          controller={modelMenu}
          modelLabel={modelLabel}
          thinkingLabel={thinkingLabel}
          fastMode={modelFastMode}
          thinkingLevel={thinkingLevel}
          selectedProviderId={providerId}
          selectedModelId={modelId}
          controlsBlocked={controlsBlocked}
          onCloseOtherMenus={() => setPermissionOpen(false)}
        />
        {composerTransforms.map((transform) => {
          const key = `${transform.pluginId}/${transform.id}`;
          const isActive = activeTransformKey === key;
          return (
          <TooltipButton
            key={key}
            type="button"
            className={`icon-btn icon-btn-square composer-plugin-transform-btn${isActive ? " is-loading" : ""}`}
            tooltip={transform.title}
            ariaLabel={transform.title}
            aria-busy={isActive}
            disabled={
              !value.trim() ||
              value.trim().startsWith("/") ||
              controlsBlocked ||
              sendBlocked ||
              pasting ||
              activeTransformKey !== null
            }
            onClick={() => void runComposerTransform(transform)}
          >
            {isActive ? <span className="tool-spinner" aria-hidden="true" /> : <IconSparkles size={15} aria-hidden="true" />}
          </TooltipButton>
          );
        })}
        {undoTransform ? (
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square composer-plugin-transform-undo"
            tooltip={undoTransform.undoTitle}
            ariaLabel={undoTransform.undoTitle}
            disabled={controlsBlocked}
            onClick={undoComposerTransform}
          >
            <IconUndo2 size={15} aria-hidden="true" />
          </TooltipButton>
        ) : null}
        {/*
          Plan mode adds one choice, not two. The ordinary send button already
          sends the requirement as a plain message, so the only extra action is
          wrapping it in the debate instruction — kept as a compact icon beside
          send so the toolbar stays on one line at every width. While a round is
          producing the same spot stops it, through the composer's own abort;
          while a round is unfinished with no turn behind it, the same spot
          opens the planning panel instead of asking for a second round.
        */}
        {planMode ? (
          debateRunning ? (
            <TooltipButton
              type="button"
              className="icon-btn icon-btn-square composer-plan-debate"
              data-composer-plan-action="stop-debate"
              tooltip={t("planning.stopDebate")}
              ariaLabel={t("planning.stopDebate")}
              disabled={!stopAllowed}
              onClick={() => void abort()}
            >
              <IconStop size={15} aria-hidden="true" />
            </TooltipButton>
          ) : unfinishedRound !== null ? (
            // Never disabled: opening the round that is already running is the
            // one thing this press can honestly do, and the panel is where the
            // user reads it and where the next round is started.
            <TooltipButton
              type="button"
              className="icon-btn icon-btn-square composer-plan-debate"
              data-composer-plan-action="open-debate"
              data-plan-debate-live-round={unfinishedRound}
              tooltip={t("planning.openPanel")}
              ariaLabel={t("planning.openPanel")}
              onClick={() => useAppStore.getState().openWorkPanelTab(planDebateWorkPanelTab())}
            >
              <IconSparkles size={15} aria-hidden="true" />
            </TooltipButton>
          ) : (
            <TooltipButton
              type="button"
              className="icon-btn icon-btn-square composer-plan-debate"
              data-composer-plan-action="debate"
              tooltip={t("planning.startDebate")}
              ariaLabel={t("planning.startDebate")}
              disabled={planActionBlocked || !modelReady}
              onClick={() => void submit(false, planDebateRequest)}
            >
              <IconSparkles size={15} aria-hidden="true" />
            </TooltipButton>
          )
        ) : null}
        {runActive && !hasDraftContent ? (
          <TooltipButton
            type="button"
            className="stop-btn"
            tooltip={t("chat.stopGenerating")}
            ariaLabel={t("chat.stopGenerating")}
            disabled={!stopAllowed}
            onClick={() => void abort()}
          >
            <IconStop size={14} />
          </TooltipButton>
        ) : (
          <TooltipButton
            type="button"
            className="send-btn"
            ariaLabel={modelReady ? t("chat.send") : t("settings.addProvider")}
            tooltip={
              runActive
                ? t("chat.sendWhileRunning", { shortcut: steeringShortcut })
                : modelReady
                  ? t("chat.send")
                  : t("settings.addProvider")
            }
            disabled={
              !hasDraftContent ||
              sendBlocked ||
              (!modelReady && !value.trim().startsWith("/"))
            }
            onClick={() => void submit()}
          >
            <IconArrowUp size={15} />
          </TooltipButton>
        )}
      </div>
    </div>
  );
}
