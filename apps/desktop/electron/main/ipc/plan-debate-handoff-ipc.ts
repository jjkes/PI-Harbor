import {
  buildHandoffContent,
  executePlanDebateHandoff,
  registerPlanDebateHandoffIpc as registerPlanDebateHandoffIpcService,
  type PlanDebateHandoffServiceDependencies,
} from "../runtime/plan-debate-handoff";
import type { IpcRegistrar } from "./types";

export type PlanDebateHandoffIpcDependencies = PlanDebateHandoffServiceDependencies & {
  registrar: Pick<IpcRegistrar, "handle">;
};

export { buildHandoffContent, executePlanDebateHandoff };

export function registerPlanDebateHandoffIpc(
  deps: PlanDebateHandoffIpcDependencies,
): void {
  registerPlanDebateHandoffIpcService(deps);
}
