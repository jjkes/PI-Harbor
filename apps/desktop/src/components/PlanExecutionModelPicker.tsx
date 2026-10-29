import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app-store";
import {
  planExecutionModelDisplayLabel,
  type PlanExecutionModelSelection,
} from "../lib/plan-execution-model";
import { ComposerModelPicker } from "../features/chat/composer/ComposerModelPicker";
import { useComposerModelMenu } from "../features/chat/composer/hooks/useComposerModelMenu";
import {
  thinkingLevelForProvider,
  thinkingProviderForModel,
} from "../features/chat/composer/model";
import { HelpIcon } from "./ui";

/** Composer's model menu with an approval-local selection callback. */
export function PlanExecutionModelPicker({
  value,
  disabled,
  onChange,
}: {
  value: PlanExecutionModelSelection;
  disabled: boolean;
  onChange: (selection: PlanExecutionModelSelection) => void;
}) {
  const { t } = useTranslation();
  const providers = useAppStore((state) => state.providers);
  const providerModels = useAppStore((state) => state.providerModels);
  const provider = providers.find((candidate) => candidate.id === value.providerId);
  const thinkingProvider = thinkingProviderForModel(
    provider,
    value.modelId,
    provider ? providerModels[provider.id] : undefined,
  );
  const thinkingLevel = thinkingLevelForProvider(thinkingProvider, value.thinkingLevel);
  const controller = useComposerModelMenu({
    mode: "agent",
    activeSessionId: null,
    provider,
    modelId: value.modelId,
    thinkingProvider,
    thinkingLevel,
    controlsBlocked: disabled,
    configureActiveSession: async (configuration) => {
      const providerId = configuration.providerId ?? value.providerId;
      const modelId = configuration.modelId ?? value.modelId;
      const nextProvider = providers.find((candidate) => candidate.id === providerId);
      const nextThinkingProvider = thinkingProviderForModel(
        nextProvider,
        modelId,
        nextProvider ? providerModels[nextProvider.id] : undefined,
      );
      onChange({
        providerId,
        modelId,
        thinkingLevel: thinkingLevelForProvider(
          nextThinkingProvider,
          configuration.thinkingLevel,
        ),
      });
    },
  });
  const label = planExecutionModelDisplayLabel(
    { providerId: value.providerId, modelId: value.modelId },
    providers,
  );
  return (
    <div
      className="plan-execution-model"
      role="group"
      aria-label={t("planExecution.executeWith")}
      data-testid="plan-execution-model-picker"
    >
      <span className="plan-execution-model-label">{t("planExecution.executeWith")}</span>
      <HelpIcon label={t("planExecution.contextHint")} />
      <ComposerModelPicker
        t={t}
        controller={controller}
        modelLabel={label}
        thinkingLabel={thinkingLevel}
        thinkingLevel={thinkingLevel}
        selectedProviderId={value.providerId}
        selectedModelId={value.modelId}
        controlsBlocked={disabled}
        onCloseOtherMenus={() => {}}
      />
    </div>
  );
}
