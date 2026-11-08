import { sameRecentModel } from "../../../../lib/recent-models";
import type {
  Mode,
  ProviderPublic,
  SessionThinkingLevel,
} from "@pi-harbor/shared";
import {
  imageGenerationBindings,
  initialThinkingLevelForBinding,
  initialThinkingLevelForUnmatchedModel,
  isImageGenerationModel,
} from "@pi-harbor/shared";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  composerModelBinding,
  composerModelMatchesQuery,
  composerModelsForProvider,
  sameComposerModelId,
} from "../../../../lib/composer-models";
import {
  providerDisplayName,
  providerSearchText,
} from "../../../../lib/provider-display";
import { providerThinkingLevels } from "../../../../lib/session-thinking";
import { useAppStore } from "../../../../stores/app-store";
import {
  sessionThinkingMenuLevels,
  thinkingLevelForProvider,
  thinkingProviderForModel,
} from "../model";
import { createLatestCommitQueue } from "../thinking-commit-queue";

/**
 * A row click waits at most this long for a pending reasoning write to settle.
 * The wait exists only to order the two writes, never to gate the switch.
 */
const THINKING_FLUSH_TIMEOUT_MS = 400;

type UseComposerModelMenuOptions = {
  mode: Mode;
  activeSessionId: string | null | undefined;
  provider: ProviderPublic | undefined;
  modelId: string | undefined;
  thinkingProvider: ProviderPublic | null | undefined;
  thinkingLevel: SessionThinkingLevel;
  controlsBlocked: boolean;
  configureActiveSession: (configuration: {
    mode: Mode; providerId?: string; modelId?: string; thinkingLevel: SessionThinkingLevel;
  }) => Promise<void>;
};

export function useComposerModelMenu({
  mode,
  activeSessionId,
  provider,
  modelId,
  thinkingProvider: resolvedThinkingProvider,
  thinkingLevel,
  controlsBlocked,
  configureActiveSession,
}: UseComposerModelMenuOptions) {
  const providers = useAppStore((s) => s.providers);
  const recentModels = useAppStore((s) => s.recentModels);
  const imageGeneration = useAppStore((s) => s.settings?.imageGeneration);
  const imageGenerationModels = useAppStore((s) => s.settings?.imageGenerationModels);
  const imageGenerationCandidates = useMemo(
    () => imageGenerationBindings(imageGenerationModels, imageGeneration),
    [imageGenerationModels, imageGeneration],
  );
  const providerModels = useAppStore((s) => s.providerModels);
  const loadProviderModels = useAppStore((s) => s.loadProviderModels);
  const showToast = useAppStore((s) => s.showToast);
  const [open, setOpen] = useState(false);
  const [otherModelsExpanded, setOtherModelsExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [modelHighlight, setModelHighlight] = useState(-1);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const thinkingConfigRef = useRef({
    mode,
    providerId: provider?.id,
    modelId,
    configureActiveSession,
    showToast,
  });
  thinkingConfigRef.current = {
    mode,
    providerId: provider?.id,
    modelId,
    configureActiveSession,
    showToast,
  };
  const thinkingQueueRef = useRef<ReturnType<typeof createLatestCommitQueue<SessionThinkingLevel>> | null>(
    null,
  );
  if (!thinkingQueueRef.current) {
    thinkingQueueRef.current = createLatestCommitQueue<SessionThinkingLevel>({
      send: async (level) => {
        const current = thinkingConfigRef.current;
        await current.configureActiveSession({
          mode: current.mode,
          providerId: current.providerId,
          modelId: current.modelId,
          thinkingLevel: level,
        });
      },
      onError: (error) => {
        const current = thinkingConfigRef.current;
        current.showToast(error instanceof Error ? error.message : String(error), {
          variant: "error",
        });
      },
    });
  }

  const thinkingProvider =
    resolvedThinkingProvider ??
    thinkingProviderForModel(
      provider,
      modelId,
      provider ? providerModels[provider.id] : undefined,
    );
  const availableThinkingLevels = providerThinkingLevels(thinkingProvider);
  const thinkingMenuLevels = sessionThinkingMenuLevels(availableThinkingLevels);
  const modelGroups = useMemo(
    () =>
      providers
        .filter(
          (candidate) =>
            candidate.enabled &&
            (candidate.hasSecret || candidate.authKind === "none"),
        )
        .map((candidate) => {
          const models = composerModelsForProvider(
            candidate,
            providerModels[candidate.id],
            imageGenerationCandidates,
          );
          return {
            provider: candidate,
            providerDisplayName: providerDisplayName(candidate),
            providerSearchText: providerSearchText(candidate),
            models,
          };
        })
        .filter((group) => group.models.length > 0),
    [providers, providerModels, imageGenerationCandidates],
  );
  const recentEntries = useMemo(() => {
    const entries = modelGroups.flatMap(group => group.models.map(model => ({ provider: group.provider, model })));
    return (recentModels ?? []).flatMap(recent => {
      const entry = entries.find(entry => sameRecentModel(recent, {
        providerId: entry.provider.id, modelId: entry.model.modelId,
      }));
      return entry ? [entry] : [];
    }).slice(0, 3);
  }, [modelGroups, recentModels]);
  const queryNeedle = query.trim().toLowerCase();
  const filteredModelGroups = useMemo(
    () =>
      queryNeedle
        ? modelGroups
            .map((group) => ({
              ...group,
              models: group.models.filter((model) =>
                composerModelMatchesQuery(
                  model,
                  group.providerSearchText,
                  queryNeedle,
                  composerModelBinding(group.provider, model.modelId)?.alias,
                ),
              ),
            }))
            .filter((group) => group.models.length > 0)
        : modelGroups,
    [modelGroups, queryNeedle],
  );
  const showRecents = !queryNeedle && recentEntries.length > 0;
  /**
   * Every configured model stays reachable from the open menu. Recents are a
   * shortcut shelf, not a filter: with nothing recent to show, the provider
   * groups are listed directly, and the disclosure only appears when rows are
   * actually collapsed behind it — a disclosure that expands into nothing is
   * indistinguishable from a menu that lost the other providers' models.
   */
  const remainingGroups = useMemo(
    () => showRecents ? filteredModelGroups.map(group => ({
      ...group,
      models: group.models.filter(model => !recentEntries.some(entry =>
        entry.provider.id === group.provider.id && sameComposerModelId(entry.model.modelId, model.modelId))),
    })).filter(group => group.models.length > 0) : filteredModelGroups,
    [filteredModelGroups, recentEntries, showRecents],
  );
  const hasOtherModels = showRecents && remainingGroups.length > 0;
  const modelGroupsKey = useMemo(
    () => remainingGroups
      .map((group) => `${group.provider.id}:${group.models.map((model) => model.modelId).join(",")}`)
      .join("|"),
    [remainingGroups],
  );
  const visibleGroups = !hasOtherModels || otherModelsExpanded ? remainingGroups : [];
  const flatModels = useMemo(
    () =>
      [...(showRecents ? recentEntries : []), ...visibleGroups.flatMap((group) =>
        group.models.map((model) => ({ provider: group.provider, model })),
      )],
    [visibleGroups, showRecents, recentEntries],
  );
  const flatModelsKey = useMemo(
    () => flatModels.map((entry) => `${entry.provider.id}:${entry.model.modelId}`).join("|"),
    [flatModels],
  );
  const activeFlatIndex = useMemo(
    () =>
      flatModels.findIndex(
        (entry) =>
          entry.provider.id === provider?.id &&
          sameComposerModelId(entry.model.modelId, modelId ?? ""),
      ),
    [flatModels, provider?.id, modelId],
  );

  /**
   * Highlight follows the rows on screen. While the disclosure is collapsed
   * the visible list holds only the recents shelf, whose indices are the same
   * leading ones the flat list uses, so an index of -1 is all an arrow key
   * needs for "nothing highlighted yet".
   */
  const queryNeedsHighlight = queryNeedle.length > 0;
  useEffect(() => {
    if (!open) return;
    setModelHighlight(queryNeedsHighlight ? (flatModels.length ? 0 : -1) : activeFlatIndex);
  }, [activeFlatIndex, flatModels.length, flatModelsKey, open, queryNeedsHighlight]);

  useEffect(() => {
    if (!open) return;
    for (const candidate of providers) {
      if (candidate.enabled && (candidate.hasSecret || candidate.authKind === "none")) {
        void loadProviderModels(candidate.id);
      }
    }
  }, [loadProviderModels, open, providers]);

  useEffect(() => {
    if (open) return;
    setOtherModelsExpanded(false);
    setQuery("");
    setModelHighlight(-1);
  }, [open]);
  useEffect(() => {
    thinkingQueueRef.current?.invalidate();
  }, [activeSessionId, modelId, provider?.id]);

  useEffect(() => {
    if (!controlsBlocked) return;
    setOpen(false);
    thinkingQueueRef.current?.invalidate();
  }, [controlsBlocked]);

  useEffect(() => {
    if (!open || modelHighlight < 0) return;
    modelListRef.current
      ?.querySelector(`[data-model-index="${modelHighlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [modelHighlight, open]);

  /**
   * Selecting a row is one attempt per click. The reasoning queue is told to
   * drop its pending write and given a bounded moment to settle, but the switch
   * itself never waits on it: a stalled flush must not turn a click into a
   * silent no-op, and the queue is latest-wins, so a late commit is its own
   * concern rather than a reason to keep the old model.
   */
  const selectModel = useCallback(async (candidate: ProviderPublic, nextModelId: string) => {
    const queue = thinkingQueueRef.current;
    queue?.invalidate();
    // The wait only orders the two writes; it never gates the switch. A queue
    // that cannot settle in time is invalidated again and the selection
    // proceeds, because an unselectable row reads as a broken menu.
    const settled = !queue || await new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => resolve(false), THINKING_FLUSH_TIMEOUT_MS);
      void queue.idle().then(() => {
        window.clearTimeout(timer);
        resolve(true);
      });
    });
    if (!settled) thinkingQueueRef.current?.invalidate();
    if (isImageGenerationModel(
      imageGenerationBindings(
        useAppStore.getState().settings?.imageGenerationModels,
        useAppStore.getState().settings?.imageGeneration,
      ),
      candidate.id,
      nextModelId,
    )) return;
    try {
      const nextModelProvider = thinkingProviderForModel(
        candidate,
        nextModelId,
        providerModels[candidate.id],
      );
      const nextBinding = candidate.models.find((entry) =>
        sameComposerModelId(entry.id, nextModelId),
      );
      const nextModel = providerModels[candidate.id]?.find((entry) =>
        sameComposerModelId(entry.modelId, nextModelId),
      );
      const selectedSameModel =
        activeSessionId &&
        candidate.id === provider?.id &&
        sameComposerModelId(modelId ?? "", nextModelId);
      const nextThinkingLevel = selectedSameModel
        ? thinkingLevelForProvider(nextModelProvider, thinkingLevel)
        : (nextModel?.catalogSource === "models.dev"
          ? initialThinkingLevelForBinding(
              nextBinding,
              nextModelProvider?.supportedThinkingLevels,
            )
          : initialThinkingLevelForUnmatchedModel(
              nextBinding,
              nextModelProvider?.supportedThinkingLevels,
            ));
      await configureActiveSession({
        mode,
        providerId: candidate.id,
        modelId: nextModelId,
        thinkingLevel: nextThinkingLevel,
      });
      setQuery("");
      setOtherModelsExpanded(false);
      setModelHighlight(-1);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  }, [activeSessionId, configureActiveSession, mode, modelId, provider, providerModels, showToast, thinkingLevel]);

  /**
   * Commit a reasoning level without leaving the menu surface. Latest-wins:
   * a drag that crosses several stops only persists the last pending level
   * after the in-flight write settles. Returns false when the configuration
   * is rejected or invalidated by a session/model change.
   */
  const commitThinkingLevel = useCallback((level: SessionThinkingLevel) => {
    const queue = thinkingQueueRef.current;
    if (!queue) return Promise.resolve(false);
    return queue.commit(level);
  }, []);

  /**
   * Arrow keys and Enter walk the rows the user can actually see: while the
   * disclosure is collapsed, the rows behind it are not on screen, so the
   * walkable prefix is exactly the recents shelf.
   */
  const walkableModels = useMemo(
    () => (hasOtherModels && !otherModelsExpanded ? flatModels.slice(0, recentEntries.length) : flatModels),
    [flatModels, hasOtherModels, modelGroupsKey, otherModelsExpanded, recentEntries.length],
  );
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
        const entry = walkableModels[modelHighlight];
        if (entry) {
          event.preventDefault();
          void selectModel(entry.provider, entry.model.modelId);
        }
      }
      return;
    }
    if (!(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    if (!walkableModels.length) return;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    setModelHighlight((current) => {
      const base = current < 0 ? (delta > 0 ? -1 : walkableModels.length) : current;
      return (base + delta + walkableModels.length) % walkableModels.length;
    });
  };

  return {
    open,
    setOpen,
    otherModelsExpanded,
    setOtherModelsExpanded,
    query,
    setQuery,
    modelHighlight,
    setModelHighlight,
    modelSearchRef,
    modelListRef,
    modelGroups: visibleGroups,
    recentEntries: showRecents ? recentEntries : [],
    hasOtherModels,
    flatModels,
    thinkingMenuLevels,
    selectModel,
    commitThinkingLevel,
    onMenuKeyDown,
    controlsBlocked,
  };
}
