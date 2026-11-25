/**
 * Recover a plan-debate round from durable artifacts after the runtime that
 * ran it has been disposed or reloaded.
 *
 * The transcript is a window and in-memory rounds disappear with the runtime,
 * but every started round has its roster and settled seats written under
 * `<projectPath>/.pi-harbor/debate/<sessionId>/round-<N>`. This module reads
 * that index and turns it back into the data a retry needs: the requirement,
 * the roster, the integrator, and the original source-round link.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlanDebateRoleProposal } from "./plan-debate.js";
import {
  parsePlanDebateRoundIndex,
  planDebateSessionRoundDirectory,
} from "./plan-debate-artifacts.js";

/** The proposal data recovered from disk, enough to start a retry round. */
export type RecoveredPlanDebateRound = {
  round: number;
  requirement: string;
  objection: string;
  roles: PlanDebateRoleProposal[];
  integratorRole: string;
  integratorSeat: number;
  sourceRoundId?: number;
  stoppedAt?: number;
  completedAt?: number;
  failure?: { code: string; message: string };
};

/**
 * Read a round's index from disk and return its retryable data.
 *
 * Only the session-scoped directory may be attributed to this session. A legacy
 * project-wide index has no provable owner, so retrying it here would risk
 * attributing one session's history to another.
 */
export async function recoverPlanDebateRound(
  projectPath: string,
  sessionId: string,
  round: number,
): Promise<RecoveredPlanDebateRound | undefined> {
  const directory = planDebateSessionRoundDirectory(projectPath, sessionId, round);
  try {
    const raw = await readFile(join(directory, `round-${round}.json`), "utf8");
    const index = parsePlanDebateRoundIndex(raw, round);
    if (!index || index.sessionId !== sessionId) return undefined;
    const roles: PlanDebateRoleProposal[] = (index.roles ?? []).map((role) => ({
      name: role.name,
      brief: role.brief,
      seat: role.seat,
      ...(role.mission ? { mission: role.mission } : {}),
      ...(role.context_digest ? { context_digest: role.context_digest } : {}),
      ...(role.constraints && role.constraints.length > 0
        ? { constraints: role.constraints }
        : {}),
      ...(role.evidence_pack && role.evidence_pack.length > 0
        ? { evidence_pack: role.evidence_pack }
        : {}),
      ...(role.done_criteria && role.done_criteria.length > 0
        ? { done_criteria: role.done_criteria }
        : {}),
      ...(role.return_schema ? { return_schema: role.return_schema } : {}),
    }));
    return {
      round: index.round,
      requirement: index.requirement,
      objection: index.objection ?? "",
      roles,
      integratorRole: index.integratorRole ?? roles[0]?.name ?? "",
      integratorSeat: index.integratorSeat ?? 1,
      sourceRoundId: index.sourceRoundId,
      stoppedAt: index.stoppedAt,
      completedAt: index.completedAt,
      failure: index.failure,
    };
  } catch {
    // Missing or unreadable index: this session has no recoverable round.
    return undefined;
  }
}
