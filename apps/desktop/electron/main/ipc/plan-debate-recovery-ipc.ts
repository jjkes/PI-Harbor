import { ErrorCodes, IPC, isRemoteSessionId } from "@pi-harbor/shared";
import type {
  PlanDebateArtifactPhase,
  PlanDebateCancelRequest,
  PlanDebateCancelResult,
  PlanDebateRetryRequest,
  PlanDebateRetryResult,
} from "@pi-harbor/shared";
import type { AgentSidecar } from "../agent-sidecar";
import type { IpcRegistrar } from "./types";

/**
 * Dependencies for registering the plan-debate recovery IPC surface.
 *
 * Recovery is intentionally small: validation, remote-session guarding, and a
 * single sidecar forward. All failures are returned as stable structured errors
 * with `errorCode`/`retryable`/`traceId` so the renderer never has to parse an
 * exception message.
 */
export type PlanDebateRecoveryIpcDependencies = {
  registrar: Pick<IpcRegistrar, "handle">;
  getSidecar: () => AgentSidecar | null;
};

const MAX_ROUND = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function safeTraceId(raw: unknown): string {
  return isNonEmptyString(raw) ? raw : globalThis.crypto.randomUUID();
}

function extractErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const direct = typeof error.errorCode === "string" ? error.errorCode : undefined;
  const nested =
    isRecord(error.data) && typeof error.data.errorCode === "string"
      ? error.data.errorCode
      : undefined;
  return nested ?? direct;
}

function isRetryableErrorCode(code: string): boolean {
  return (
    code === ErrorCodes.HOST_UNAVAILABLE ||
    code === ErrorCodes.AGENT_UNAVAILABLE ||
    code === ErrorCodes.NETWORK_ERROR ||
    code === ErrorCodes.TIMEOUT ||
    code === ErrorCodes.APP_DEGRADED
  );
}

type RecoveryError = {
  ok: false;
  errorCode: string;
  message: string;
  retryable: boolean;
  traceId: string;
};

function recoveryError(
  traceId: string,
  errorCode: string,
  message: string,
  retryable = false,
): RecoveryError {
  return { ok: false, errorCode, message, retryable, traceId };
}

function validateRetry(raw: unknown): { ok: true; request: PlanDebateRetryRequest; traceId: string } | RecoveryError {
  const rawTraceId = isRecord(raw) ? raw.traceId : undefined;
  const traceId = safeTraceId(rawTraceId);
  if (!isRecord(raw)) {
    return recoveryError(traceId, ErrorCodes.INVALID_ARGUMENT, "Request must be an object");
  }
  if (!isNonEmptyString(raw.sessionId)) {
    return recoveryError(traceId, ErrorCodes.INVALID_ARGUMENT, "sessionId is required");
  }
  if (!isPositiveInteger(raw.sourceRound) || raw.sourceRound > MAX_ROUND) {
    return recoveryError(
      traceId,
      ErrorCodes.INVALID_ARGUMENT,
      `sourceRound must be a positive integer up to ${MAX_ROUND}`,
    );
  }
  return {
    ok: true,
    request: {
      sessionId: raw.sessionId.trim(),
      sourceRound: raw.sourceRound,
      ...(isNonEmptyString(rawTraceId) ? { traceId } : {}),
    },
    traceId,
  };
}

function validateCancel(raw: unknown): { ok: true; request: PlanDebateCancelRequest; traceId: string } | RecoveryError {
  const rawTraceId = isRecord(raw) ? raw.traceId : undefined;
  const traceId = safeTraceId(rawTraceId);
  if (!isRecord(raw)) {
    return recoveryError(traceId, ErrorCodes.INVALID_ARGUMENT, "Request must be an object");
  }
  if (!isNonEmptyString(raw.sessionId)) {
    return recoveryError(traceId, ErrorCodes.INVALID_ARGUMENT, "sessionId is required");
  }
  if (!isPositiveInteger(raw.round) || raw.round > MAX_ROUND) {
    return recoveryError(
      traceId,
      ErrorCodes.INVALID_ARGUMENT,
      `round must be a positive integer up to ${MAX_ROUND}`,
    );
  }
  return {
    ok: true,
    request: {
      sessionId: raw.sessionId.trim(),
      round: raw.round,
      ...(isNonEmptyString(rawTraceId) ? { traceId } : {}),
    },
    traceId,
  };
}

function guardRemoteSession(sessionId: string, traceId: string): RecoveryError | undefined {
  if (isRemoteSessionId(sessionId)) {
    return recoveryError(
      traceId,
      ErrorCodes.CAPABILITY_UNAVAILABLE,
      "Plan-debate recovery is not supported for remote sessions",
      false,
    );
  }
  return undefined;
}

type SidecarRetryResponse =
  | { ok: true; round: number; sourceRoundId: number; proposed: boolean; started?: boolean; phase?: PlanDebateArtifactPhase | "proposing" }
  | { ok: false; errorCode?: string; message?: string; retryable?: boolean };

type SidecarCancelResponse =
  | { ok: true; cancelled: boolean; round: number; stopTimedOut: boolean }
  | { ok: false; errorCode?: string; message?: string };

function mapSidecarRetryResponse(
  response: SidecarRetryResponse,
  traceId: string,
): PlanDebateRetryResult {
  if (!response.ok) {
    const code = response.errorCode ?? ErrorCodes.INTERNAL;
    const retryable =
      typeof response.retryable === "boolean" ? response.retryable : isRetryableErrorCode(code);
    return recoveryError(
      traceId,
      code,
      response.message ?? "Plan-debate retry failed",
      retryable,
    );
  }
  return { ...response, traceId };
}

function mapSidecarCancelResponse(
  response: SidecarCancelResponse,
  traceId: string,
): PlanDebateCancelResult {
  if (!response.ok) {
    const code = response.errorCode ?? ErrorCodes.INTERNAL;
    return recoveryError(
      traceId,
      code,
      response.message ?? "Plan-debate cancel failed",
      isRetryableErrorCode(code),
    );
  }
  return { ...response, traceId };
}

async function callRetry(
  sidecar: AgentSidecar,
  request: PlanDebateRetryRequest,
  traceId: string,
): Promise<PlanDebateRetryResult> {
  try {
    const response = await sidecar.call<SidecarRetryResponse>("agent.planDebateRetry", {
      sessionId: request.sessionId,
      sourceRound: request.sourceRound,
    });
    return mapSidecarRetryResponse(response, traceId);
  } catch (error) {
    const code = extractErrorCode(error) ?? ErrorCodes.INTERNAL;
    // Thrown exceptions are never echoed: the sidecar's structured failures are
    // the only source of a detailed message; a throw only means "failed".
    const message = "Plan-debate retry failed";
    return recoveryError(traceId, code, message, isRetryableErrorCode(code));
  }
}

async function callCancel(
  sidecar: AgentSidecar,
  request: PlanDebateCancelRequest,
  traceId: string,
): Promise<PlanDebateCancelResult> {
  try {
    const response = await sidecar.call<SidecarCancelResponse>("agent.planDebateCancel", {
      sessionId: request.sessionId,
      round: request.round,
    });
    return mapSidecarCancelResponse(response, traceId);
  } catch (error) {
    const code = extractErrorCode(error) ?? ErrorCodes.INTERNAL;
    const message = "Plan-debate cancel failed";
    return recoveryError(traceId, code, message, isRetryableErrorCode(code));
  }
}

/**
 * Register the plan-debate recovery IPC handlers.
 *
 * - `planDebateRetry` forwards to `agent.planDebateRetry`.
 * - `planDebateCancel` forwards to `agent.planDebateCancel`.
 *
 * Both channels validate their inputs, refuse remote sessions with a typed
 * capability error, and convert sidecar/runtime failures into a stable error
 * shape that includes `errorCode`, `retryable`, and `traceId`. Unexpected
 * internal failures are mapped to `INTERNAL` so no raw exception leaks to the
 * renderer.
 */
export function registerPlanDebateRecoveryIpc(
  deps: PlanDebateRecoveryIpcDependencies,
): void {
  deps.registrar.handle(IPC.invoke.planDebateRetry, async (raw: unknown): Promise<PlanDebateRetryResult> => {
    const validation = validateRetry(raw);
    if (!validation.ok) return validation;
    const { request, traceId } = validation;
    const remoteError = guardRemoteSession(request.sessionId, traceId);
    if (remoteError) return remoteError;
    const sidecar = deps.getSidecar();
    if (!sidecar) {
      return recoveryError(
        traceId,
        ErrorCodes.HOST_UNAVAILABLE,
        "Agent sidecar is unavailable",
        true,
      );
    }
    return callRetry(sidecar, request, traceId);
  });

  deps.registrar.handle(IPC.invoke.planDebateCancel, async (raw: unknown): Promise<PlanDebateCancelResult> => {
    const validation = validateCancel(raw);
    if (!validation.ok) return validation;
    const { request, traceId } = validation;
    const remoteError = guardRemoteSession(request.sessionId, traceId);
    if (remoteError) return remoteError;
    const sidecar = deps.getSidecar();
    if (!sidecar) {
      return recoveryError(
        traceId,
        ErrorCodes.HOST_UNAVAILABLE,
        "Agent sidecar is unavailable",
        true,
      );
    }
    return callCancel(sidecar, request, traceId);
  });
}
