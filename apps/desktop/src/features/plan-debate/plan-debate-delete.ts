import type { PlanDebateDeleteResult } from "@pi-harbor/shared";

/** The typed server refusal owns its translation; English RPC text is only a fallback. */
export function planDebateDeleteErrorMessage(
  result: Pick<PlanDebateDeleteResult, "errorCode" | "message">,
  translate: (key: "planning.errorDeleteRoundProject") => string,
): string {
  if (result.errorCode === "PLAN_DEBATE_PROJECT_CHANGED") {
    return translate("planning.errorDeleteRoundProject");
  }
  return result.message ?? result.errorCode ?? "";
}
