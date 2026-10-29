import { normalizePlanExecutionModel, type GlobalPermissionMode } from "@pi-harbor/shared";
import type { PlanExecutionModelSelection } from "./plan-execution-model";

export const PLAN_APPROVAL_MODE_STORAGE_KEY = "pi.desktop.planApprovalMode";
export const PLAN_EXECUTION_MODEL_STORAGE_KEY = "pi.desktop.planExecutionModel";
export const PLAN_APPROVAL_FALLBACK_MODE: GlobalPermissionMode = "ask";

function isApprovalMode(value: unknown): value is GlobalPermissionMode {
  return value === "ask" || value === "accept-edits" || value === "auto";
}

function storage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

export function readPlanApprovalMode(): GlobalPermissionMode {
  const store = storage();
  if (!store) return PLAN_APPROVAL_FALLBACK_MODE;
  try {
    const value = store.getItem(PLAN_APPROVAL_MODE_STORAGE_KEY);
    return isApprovalMode(value) ? value : PLAN_APPROVAL_FALLBACK_MODE;
  } catch {
    return PLAN_APPROVAL_FALLBACK_MODE;
  }
}

export function rememberPlanApprovalMode(mode: GlobalPermissionMode): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(PLAN_APPROVAL_MODE_STORAGE_KEY, mode);
  } catch {
    // A blocked or full localStorage must not prevent approval.
  }
}

export function readPlanExecutionModel(): PlanExecutionModelSelection | null {
  const store = storage();
  if (!store) return null;
  try {
    const normalized = normalizePlanExecutionModel(
      JSON.parse(store.getItem(PLAN_EXECUTION_MODEL_STORAGE_KEY) ?? "null") as unknown,
    );
    // Every value written by the approval bar includes its effective level.
    return normalized?.thinkingLevel
      ? {
          providerId: normalized.providerId,
          modelId: normalized.modelId,
          thinkingLevel: normalized.thinkingLevel,
        }
      : null;
  } catch {
    return null;
  }
}

export function rememberPlanExecutionModel(model: PlanExecutionModelSelection): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(PLAN_EXECUTION_MODEL_STORAGE_KEY, JSON.stringify(model));
  } catch {
    // Preference persistence is best-effort and never gates approval.
  }
}
