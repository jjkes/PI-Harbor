import type { ProgressModelRef } from "@pi-harbor/shared";

/**
 * Turning the report-model choice into the provider/model pair the completion
 * runs as (design § 7.5). Pure: the caller injects the catalog and the
 * credential check, so nothing here reaches a store, a database, or a network.
 */

/** The catalog questions a resolution needs, all answered by the caller. */
export type ProgressModelLookup = {
  /** Whether the provider still exists in the catalog. */
  providerExists(providerId: string): boolean;
  /** The provider's selectable model ids. */
  modelIds(providerId: string): readonly string[];
  /** Whether the user configured a credential or a working auth mode. */
  hasCredential(providerId: string): boolean;
};

export type ProgressModelResolution =
  | { ok: true; providerId: string; modelId: string }
  | { ok: false; code: "PROGRESS_MODEL_UNAVAILABLE"; message: string };

export type ProgressSessionModel = {
  providerId?: string | null;
  modelId?: string | null;
};

function unavailable(message: string): ProgressModelResolution {
  return { ok: false, code: "PROGRESS_MODEL_UNAVAILABLE", message };
}

/**
 * Resolve the report model. An explicit pair is checked before any request is
 * sent, so a removed provider or a cleared credential fails with a reason the
 * popover can act on instead of a provider error later.
 */
export function resolveProgressModelRef(
  ref: ProgressModelRef,
  session: ProgressSessionModel,
  lookup: ProgressModelLookup,
): ProgressModelResolution {
  const pair =
    "followSession" in ref
      ? {
          providerId: session.providerId ?? "",
          modelId: session.modelId ?? "",
          followsSession: true,
        }
      : { providerId: ref.providerId, modelId: ref.modelId, followsSession: false };
  const { providerId, modelId, followsSession } = pair;

  if (providerId.length === 0 || modelId.length === 0) {
    return unavailable(
      followsSession ? "this session has no model selected" : "no provider or model was given",
    );
  }
  if (!lookup.providerExists(providerId)) {
    return unavailable(`provider ${providerId} was removed`);
  }
  if (!lookup.modelIds(providerId).includes(modelId)) {
    return unavailable(`model ${modelId} is not offered by ${providerId}`);
  }
  if (!lookup.hasCredential(providerId)) {
    return unavailable(`provider ${providerId} has no credential`);
  }
  return { ok: true, providerId, modelId };
}
