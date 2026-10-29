import { isSessionThinkingLevel } from "./thinking-levels.js";
import type { PlanExecutionModel } from "./types/plans.js";

/**
 * Validate and trim an execution-model override from an untrusted boundary.
 * Null and undefined both mean that no override was supplied; malformed values
 * also return null, so callers must check presence separately when necessary.
 */
export function normalizePlanExecutionModel(value: unknown): PlanExecutionModel | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.providerId !== "string" || typeof candidate.modelId !== "string") {
    return null;
  }
  const providerId = candidate.providerId.trim();
  const modelId = candidate.modelId.trim();
  if (!providerId || !modelId) return null;
  if (
    candidate.thinkingLevel !== undefined &&
    !isSessionThinkingLevel(candidate.thinkingLevel)
  ) {
    return null;
  }
  return {
    providerId,
    modelId,
    ...(candidate.thinkingLevel !== undefined
      ? { thinkingLevel: candidate.thinkingLevel }
      : {}),
  };
}
