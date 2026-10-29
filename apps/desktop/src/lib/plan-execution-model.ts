import type {
  AppSettings,
  ModelInfo,
  PlanExecutionModel,
  ProviderPublic,
  SessionSummary,
  SessionThinkingLevel,
} from "@pi-harbor/shared";
import {
  imageGenerationBindings,
  initialThinkingLevelForBinding,
  initialThinkingLevelForUnmatchedModel,
  isSessionThinkingLevel,
} from "@pi-harbor/shared";
import {
  composerModelDisplayName,
  composerModelsForProvider,
  sameComposerModelId,
} from "./composer-models";
import { providerDisplayName } from "./provider-display";
import type { RecentModel } from "./recent-models";
import { sessionAllows } from "./remote-session-safety";
import { inheritedSessionModelBinding } from "./session-model";
import { resolveComposerThinkingProvider } from "./session-thinking";
import {
  isThinkingLevel,
  thinkingLevelForProvider,
  thinkingProviderForModel,
} from "../features/chat/composer/model";

export type PlanExecutionModelSelection = {
  providerId: string;
  modelId: string;
  thinkingLevel: SessionThinkingLevel;
};

export type PlanExecutionModelContext = {
  session?: SessionSummary;
  providers: readonly ProviderPublic[];
  providerModels: Readonly<Record<string, ModelInfo[] | undefined>>;
  settings?: AppSettings | null;
  recentModels?: readonly RecentModel[];
};

function imageBindings(options: PlanExecutionModelContext) {
  return imageGenerationBindings(
    options.settings?.imageGenerationModels,
    options.settings?.imageGeneration,
  );
}

/** The exact effective provider/model/thinking triple shown by Composer. */
export function resolveSessionExecutionModel(
  options: PlanExecutionModelContext,
): PlanExecutionModelSelection | null {
  const { session, providers, providerModels, settings, recentModels = [] } = options;
  const selected = inheritedSessionModelBinding({
    draft: session,
    settings,
    providers,
    recentModels,
  });
  if (!selected.providerId || !selected.modelId) return null;
  const provider = providers.find((candidate) => candidate.id === selected.providerId);
  const catalog = provider ? providerModels[provider.id] : undefined;
  const catalogThinkingProvider = thinkingProviderForModel(
    provider,
    selected.modelId,
    catalog,
  );
  const thinkingProvider = resolveComposerThinkingProvider({
    provider,
    modelId: selected.modelId,
    activeSession: session,
    catalogThinkingProvider,
  });
  const binding = provider?.models.find((candidate) =>
    sameComposerModelId(candidate.id, selected.modelId ?? ""),
  );
  const model = catalog?.find((candidate) =>
    sameComposerModelId(candidate.modelId, selected.modelId ?? ""),
  );
  const fallbackThinkingLevel = model?.catalogSource === "models.dev"
    ? initialThinkingLevelForBinding(binding, thinkingProvider?.supportedThinkingLevels)
    : initialThinkingLevelForUnmatchedModel(binding, thinkingProvider?.supportedThinkingLevels);
  const configured = session?.thinkingLevel ?? fallbackThinkingLevel;
  const level = isThinkingLevel(configured) ? configured : "off";
  return {
    providerId: selected.providerId,
    modelId: selected.modelId,
    thinkingLevel: thinkingLevelForProvider(thinkingProvider, level),
  };
}

function availableRememberedModel(
  remembered: PlanExecutionModel | null | undefined,
  options: PlanExecutionModelContext,
): PlanExecutionModelSelection | null {
  if (!remembered) return null;
  const provider = options.providers.find((candidate) =>
    candidate.id === remembered.providerId &&
    candidate.enabled &&
    (candidate.hasSecret || candidate.authKind === "none")
  );
  if (!provider) return null;
  const catalog = options.providerModels[provider.id];
  const model = composerModelsForProvider(provider, catalog, imageBindings(options))
    .find((candidate) => sameComposerModelId(candidate.modelId, remembered.modelId));
  if (!model) return null;
  const thinkingProvider = thinkingProviderForModel(provider, model.modelId, catalog);
  return {
    providerId: provider.id,
    modelId: model.modelId,
    thinkingLevel: thinkingLevelForProvider(
      thinkingProvider,
      isSessionThinkingLevel(remembered.thinkingLevel) ? remembered.thinkingLevel : "off",
    ),
  };
}

/** Prefer a still-selectable remembered target, then the session's model. */
export function resolvePlanExecutionModel(
  options: PlanExecutionModelContext & { remembered?: PlanExecutionModel | null },
): PlanExecutionModelSelection | null {
  return availableRememberedModel(options.remembered, options) ??
    resolveSessionExecutionModel(options);
}

/** An unchanged selection must produce the legacy approval request exactly. */
export function planExecutionTargetForApproval({
  selection,
  sessionModel,
  providers,
  providerModels,
}: {
  selection: PlanExecutionModelSelection | null;
  sessionModel: PlanExecutionModelSelection | null;
  providers: readonly ProviderPublic[];
  providerModels: Readonly<Record<string, ModelInfo[] | undefined>>;
}): PlanExecutionModel | undefined {
  if (!selection) return undefined;
  const provider = providers.find((candidate) => candidate.id === selection.providerId);
  const thinkingProvider = thinkingProviderForModel(
    provider,
    selection.modelId,
    provider ? providerModels[provider.id] : undefined,
  );
  const target = {
    providerId: selection.providerId,
    modelId: selection.modelId,
    thinkingLevel: thinkingLevelForProvider(thinkingProvider, selection.thinkingLevel),
  };
  if (
    sessionModel &&
    sessionModel.providerId === target.providerId &&
    sameComposerModelId(sessionModel.modelId, target.modelId) &&
    sessionModel.thinkingLevel === target.thinkingLevel
  ) {
    return undefined;
  }
  return target;
}

/** Match Composer's native/capability gate without consulting renderer input in Main. */
export function canConfigurePlanExecutionModel(
  session: Pick<SessionSummary, "id" | "source" | "capabilities"> | undefined,
  sessionId: string,
): boolean {
  if (
    session?.source === "pi-native" ||
    session?.source === "remote" ||
    sessionId.startsWith("native-pi:") ||
    sessionId.startsWith("remote:")
  ) {
    return false;
  }
  return sessionAllows(session, "canConfigureModel");
}

/** Provider/account and configured model alias, shared by picker and history. */
export function planExecutionModelDisplayLabel(
  target: PlanExecutionModel,
  providers: readonly ProviderPublic[],
): string {
  const provider = providers.find((candidate) => candidate.id === target.providerId);
  const model = provider
    ? composerModelDisplayName(provider, target.modelId)
    : target.modelId;
  if (!provider) return `${target.providerId} · ${model}`;
  const name = providerDisplayName(provider);
  const duplicate = providers.some((candidate) =>
    candidate.id !== provider.id && providerDisplayName(candidate).toLowerCase() === name.toLowerCase()
  );
  const level = target.thinkingLevel ? ` · ${target.thinkingLevel}` : "";
  return `${name}${duplicate ? ` (${provider.id})` : ""} · ${model}${level}`;
}
