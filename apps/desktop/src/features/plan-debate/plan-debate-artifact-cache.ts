import type { PlanDebateRoundArtifacts } from "@pi-harbor/shared";

/** Disk rounds are meaningful only together with the project they were read from. */
export type PlanDebateArtifactCache = {
  projectPath: string;
  rounds: readonly PlanDebateRoundArtifacts[];
};

export function planDebateProjectPath(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function planDebateArtifactCacheForProject(
  projectPath: string,
  rounds: readonly PlanDebateRoundArtifacts[] = [],
): PlanDebateArtifactCache {
  const normalized = planDebateProjectPath(projectPath);
  return { projectPath: normalized, rounds: normalized ? [...rounds] : [] };
}

/** A project switch invalidates the old project's rounds immediately. */
export function planDebateArtifactsForProject(
  cache: PlanDebateArtifactCache,
  projectPath: string,
): readonly PlanDebateRoundArtifacts[] {
  const normalized = planDebateProjectPath(projectPath);
  return normalized !== "" && cache.projectPath === normalized ? cache.rounds : [];
}

/** Delete only a round actually loaded from the session's current project. */
export function planDebateArtifactCacheHasRound(
  cache: PlanDebateArtifactCache,
  projectPath: string,
  round: number,
): boolean {
  return planDebateArtifactsForProject(cache, projectPath).some(
    (artifact) => artifact.round === round,
  );
}

/** Successful deletion evicts one round; every unrelated round survives. */
export function removePlanDebateArtifactFromCache(
  cache: PlanDebateArtifactCache,
  projectPath: string,
  round: number,
): PlanDebateArtifactCache {
  if (!planDebateArtifactCacheHasRound(cache, projectPath, round)) return cache;
  return {
    ...cache,
    rounds: cache.rounds.filter((artifact) => artifact.round !== round),
  };
}

export type PlanDebateArtifactRefresh =
  | { ok: true; rounds: readonly PlanDebateRoundArtifacts[] }
  | { ok: false };

/**
 * Only the newest uncancelled request may write the artifact cache. Successful
 * deletion advances the same sequence, invalidating every pre-delete response.
 */
export function planDebateArtifactRequestIsCurrent(
  requestId: number,
  currentRequestId: number,
  cancelled: boolean,
): boolean {
  return !cancelled && requestId === currentRequestId;
}

/** A failed read keeps this project's last good rounds, never a sibling-clearing empty list. */
export function planDebateArtifactCacheAfterRefresh(
  cache: PlanDebateArtifactCache,
  projectPath: string,
  refresh: PlanDebateArtifactRefresh,
): PlanDebateArtifactCache {
  const normalized = planDebateProjectPath(projectPath);
  if (!refresh.ok) {
    return cache.projectPath === normalized
      ? cache
      : planDebateArtifactCacheForProject(normalized);
  }
  return planDebateArtifactCacheForProject(normalized, refresh.rounds);
}
