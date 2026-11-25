import {
  ErrorCodes,
  IPC,
  NATIVE_PI_SESSION_PREFIX,
  type AgentEventEnvelope,
  type PlanDebateHandoffRequest,
  type PlanDebateHandoffResult,
  type PlanDebateHandoffSelection,
  type PlanDebateHandoffTargetMode,
} from "@pi-harbor/shared";
import { durableUserMessageId } from "../prompt-attachments";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { FinishTurn } from "./plans";

export type HandoffErrorResult = Extract<PlanDebateHandoffResult, { ok: false }>;

export type HandoffPrepareResponse = {
  ok: boolean;
  enabled: boolean;
  revision: number;
  targetMode: PlanDebateHandoffTargetMode;
  members: unknown[];
};

export type PlanDebateHandoffServiceDependencies = {
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  resolveAgentRuntimeLaunch: (...args: any[]) => Promise<any>;
  acquireSessionOperation: (sessionId: string) => Promise<() => void>;
  /** True while the session owns a live or finalizing turn. */
  isSessionBusy: (sessionId: string) => boolean;
  activeTurns: Map<string, string>;
  activeTurnUsages?: Map<string, string>;
  recordTurnStart: (sessionId: string, turnId: string) => void;
  finishTurn: FinishTurn;
  emitAgentEvent: (envelope: AgentEventEnvelope) => void;
  logger: Pick<Logger, "app">;
};

export type PlanDebateHandoffRegistrar = {
  handle(channel: string, handler: (raw: unknown) => Promise<PlanDebateHandoffResult>): void;
};

type ValidationOutcome =
  | { ok: true; request: PlanDebateHandoffRequest }
  | { ok: false; result: HandoffErrorResult };

const TARGET_MODES: PlanDebateHandoffTargetMode[] = ["team", "single-agent"];
const SELECTION_KINDS = ["draft", "merged", "suggestion"];

/** Mirrors the RACP default prompt ceiling; handoff payloads are prompts. */
const MAX_SELECTION_TEXT_BYTES = 256 * 1024;
const MAX_ADDENDUM_BYTES = 64 * 1024;
const MAX_ROUND = 1_000_000;
const MAX_ROLE_LENGTH = 80;
const MAX_ERROR_MESSAGE_LENGTH = 500;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function safeTraceId(raw: unknown, fallback = globalThis.crypto.randomUUID()): string {
  return isNonEmptyString(raw) ? raw : fallback;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateErrorMessage(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength) + "…";
}

export function handoffError(
  traceId: string,
  errorCode: string,
  message: string,
  retryable = false,
): HandoffErrorResult {
  return { ok: false, errorCode, message, retryable, traceId };
}

export function buildHandoffContent(
  selection: PlanDebateHandoffSelection,
  userAddendum?: string,
): string {
  const addendum = userAddendum?.trim();
  if (!addendum) return selection.text.trim();
  return `${selection.text.trimEnd()}\n\n${addendum}`;
}

function validateSelection(
  traceId: string,
  raw: unknown,
): { ok: true; selection: PlanDebateHandoffSelection } | { ok: false; result: HandoffErrorResult } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, result: handoffError(traceId, ErrorCodes.INVALID_ARGUMENT, "selection is required") };
  }
  const input = raw as Record<string, unknown>;
  const kind = input.kind;
  const round = input.round;
  const text = input.text;

  if (!SELECTION_KINDS.includes(kind as string)) {
    return {
      ok: false,
      result: handoffError(traceId, ErrorCodes.INVALID_ARGUMENT, "selection.kind must be draft, merged, or suggestion"),
    };
  }
  if (!isPositiveInteger(round) || (round as number) > MAX_ROUND) {
    return {
      ok: false,
      result: handoffError(traceId, ErrorCodes.INVALID_ARGUMENT, `selection.round must be a positive integer up to ${MAX_ROUND}`),
    };
  }
  if (!isNonEmptyString(text)) {
    return {
      ok: false,
      result: handoffError(traceId, ErrorCodes.INVALID_ARGUMENT, "selection.text must contain non-empty text"),
    };
  }
  const trimmedText = text.trim();
  if (byteLength(trimmedText) > MAX_SELECTION_TEXT_BYTES) {
    return {
      ok: false,
      result: handoffError(traceId, ErrorCodes.INVALID_ARGUMENT, `selection.text exceeds ${MAX_SELECTION_TEXT_BYTES} bytes`),
    };
  }

  if (kind === "draft") {
    const role = input.role;
    if (!isNonEmptyString(role)) {
      return {
        ok: false,
        result: handoffError(traceId, ErrorCodes.INVALID_ARGUMENT, "selection.role is required for draft"),
      };
    }
    const trimmedRole = role.trim();
    if (trimmedRole.length > MAX_ROLE_LENGTH) {
      return {
        ok: false,
        result: handoffError(traceId, ErrorCodes.INVALID_ARGUMENT, `selection.role exceeds ${MAX_ROLE_LENGTH} characters`),
      };
    }
    return { ok: true, selection: { kind: "draft", round: round as number, role: trimmedRole, text: trimmedText } };
  }

  return { ok: true, selection: { kind: kind as "merged" | "suggestion", round: round as number, text: trimmedText } };
}

export function validateRequest(raw: unknown): ValidationOutcome {
  const rawTraceId =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).traceId : undefined;
  const traceId = safeTraceId(rawTraceId);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      result: handoffError(traceId, ErrorCodes.INVALID_ARGUMENT, "Handoff request must be an object"),
    };
  }
  const input = raw as Record<string, unknown>;
  const sourceSessionId = input.sourceSessionId;
  const targetMode = input.targetMode;
  const round = input.round;

  if (!isNonEmptyString(sourceSessionId)) {
    return {
      ok: false,
      result: handoffError(traceId, ErrorCodes.INVALID_ARGUMENT, "sourceSessionId is required"),
    };
  }
  if (!isNonEmptyString(rawTraceId)) {
    return {
      ok: false,
      result: handoffError(traceId, ErrorCodes.INVALID_ARGUMENT, "traceId is required"),
    };
  }
  if (!TARGET_MODES.includes(targetMode as PlanDebateHandoffTargetMode)) {
    return {
      ok: false,
      result: handoffError(
        traceId,
        ErrorCodes.INVALID_ARGUMENT,
        'targetMode must be "team" or "single-agent"',
      ),
    };
  }
  if (!isPositiveInteger(round) || (round as number) > MAX_ROUND) {
    return {
      ok: false,
      result: handoffError(traceId, ErrorCodes.INVALID_ARGUMENT, `round must be a positive integer up to ${MAX_ROUND}`),
    };
  }

  const selectionResult = validateSelection(traceId, input.selection);
  if (!selectionResult.ok) return selectionResult;

  if (selectionResult.selection.round !== (round as number)) {
    return {
      ok: false,
      result: handoffError(traceId, ErrorCodes.INVALID_ARGUMENT, "selection.round must match round"),
    };
  }

  const userAddendum = input.userAddendum;
  if (userAddendum !== undefined && typeof userAddendum !== "string") {
    return {
      ok: false,
      result: handoffError(traceId, ErrorCodes.INVALID_ARGUMENT, "userAddendum must be a string"),
    };
  }
  const trimmedAddendum = typeof userAddendum === "string" ? userAddendum.trim() : "";
  if (trimmedAddendum && byteLength(trimmedAddendum) > MAX_ADDENDUM_BYTES) {
    return {
      ok: false,
      result: handoffError(traceId, ErrorCodes.INVALID_ARGUMENT, `userAddendum exceeds ${MAX_ADDENDUM_BYTES} bytes`),
    };
  }

  return {
    ok: true,
    request: {
      sourceSessionId: sourceSessionId.trim(),
      targetMode: targetMode as PlanDebateHandoffTargetMode,
      traceId,
      round: round as number,
      selection: selectionResult.selection,
      ...(trimmedAddendum ? { userAddendum: trimmedAddendum } : {}),
    },
  };
}

function extractErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const direct =
      typeof record.errorCode === "string" ? record.errorCode : undefined;
    const nested =
      record.data && typeof record.data === "object"
        ? (record.data as Record<string, unknown>).errorCode
        : undefined;
    return typeof nested === "string" ? nested : direct;
  }
  return undefined;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return truncateErrorMessage(error.message, MAX_ERROR_MESSAGE_LENGTH);
  }
  return "Handoff failed";
}

export function mapHandoffFailure(
  traceId: string,
  error: unknown,
): HandoffErrorResult {
  const code = extractErrorCode(error) ?? ErrorCodes.INTERNAL;
  const message = safeErrorMessage(error);
  const retryable =
    code === ErrorCodes.AGENT_BUSY ||
    code === "TEAM_REVISION_STALE" ||
    code === ErrorCodes.HOST_UNAVAILABLE;
  return handoffError(traceId, code, message, retryable);
}

async function maybeDisableTeam(
  host: HostProcess,
  sessionId: string,
  targetMode: PlanDebateHandoffTargetMode,
  wasEnabled: boolean,
  revision: number,
  logger: PlanDebateHandoffServiceDependencies["logger"],
): Promise<void> {
  if (targetMode !== "team" || wasEnabled) return;
  try {
    await host.call("session.team.set", {
      sessionId,
      expectedRevision: revision,
      enabled: false,
    });
  } catch (error) {
    logger.app("session", "warn", "plan debate handoff team compensation failed", {
      sessionId,
      data: { errorCode: extractErrorCode(error) },
    });
  }
}

export async function executePlanDebateHandoff(
  deps: PlanDebateHandoffServiceDependencies,
  raw: unknown,
): Promise<PlanDebateHandoffResult> {
  const validation = validateRequest(raw);
  if (!validation.ok) return validation.result;
  const request = validation.request;
  const { sourceSessionId, targetMode, traceId, selection, userAddendum } = request;

  if (sourceSessionId.startsWith(NATIVE_PI_SESSION_PREFIX)) {
    return handoffError(
      traceId,
      "NATIVE_PI_UNSUPPORTED",
      "Plan-debate handoff is unsupported for native Pi sessions",
      false,
    );
  }

  const host = deps.getHost();
  const sidecar = deps.getSidecar();
  if (!host || !sidecar) {
    return handoffError(
      traceId,
      ErrorCodes.HOST_UNAVAILABLE,
      "Backend is not available",
      true,
    );
  }

  const releaseSessionOperation = await deps.acquireSessionOperation(sourceSessionId);
  try {
    let check: HandoffPrepareResponse;
    try {
      check = (await host.call("session.team.handoffCheck", {
        sessionId: sourceSessionId,
        targetMode,
      })) as HandoffPrepareResponse;
    } catch (error) {
      return mapHandoffFailure(traceId, error);
    }

    if (!check.ok) {
      return handoffError(
        traceId,
        "TEAM_NOT_ELIGIBLE",
        "Target mode is not eligible for this session",
        false,
      );
    }

    if (deps.isSessionBusy(sourceSessionId)) {
      return handoffError(
        traceId,
        ErrorCodes.AGENT_BUSY,
        "Session already has an active turn",
        true,
      );
    }

    const wasEnabled = check.enabled === true;

    let prepare: HandoffPrepareResponse;
    try {
      prepare = (await host.call("session.team.handoffPrepare", {
        sessionId: sourceSessionId,
        targetMode,
      })) as HandoffPrepareResponse;
    } catch (error) {
      return mapHandoffFailure(traceId, error);
    }

    let compensated = false;
    try {
      const settings = await host.call<Record<string, unknown>>("settings.get");
      const sessionResult = await host.call<{ session?: { messages?: unknown[] } }>("session.get", {
        id: sourceSessionId,
        messageLimit: 1,
      });
      const session = sessionResult.session;
      if (!session) {
        await maybeDisableTeam(host, sourceSessionId, targetMode, wasEnabled, prepare.revision, deps.logger);
        compensated = true;
        return handoffError(traceId, ErrorCodes.NOT_FOUND, "Session not found", false);
      }

      const launch = await deps.resolveAgentRuntimeLaunch(
        sourceSessionId,
        session,
        settings,
      );

      const turn = await host.call<{ turnId?: string }>("session.beginTurn", {
        sessionId: sourceSessionId,
        providerId: launch.providerId,
        modelId: launch.modelId,
      });
      const durableTurnId = String(turn?.turnId ?? "").trim();
      if (!durableTurnId) {
        await maybeDisableTeam(host, sourceSessionId, targetMode, wasEnabled, prepare.revision, deps.logger);
        compensated = true;
        throw new Error("session.beginTurn returned no turn");
      }
      deps.activeTurns.set(sourceSessionId, durableTurnId);
      deps.recordTurnStart(sourceSessionId, durableTurnId);

      const content = buildHandoffContent(selection, userAddendum);
      const userMessageId = durableUserMessageId(
        undefined,
        Array.isArray(session.messages) ? (session.messages as { id?: unknown }[]) : [],
      );
      const userMessage = {
        id: userMessageId,
        role: "user" as const,
        content,
        createdAt: new Date().toISOString(),
        status: "complete" as const,
      };

      try {
        await host.call("session.appendMessage", {
          sessionId: sourceSessionId,
          message: userMessage,
          turnId: durableTurnId,
        });
      } catch (error) {
        await deps.finishTurn(sourceSessionId, "error", extractErrorCode(error), {
          turnId: durableTurnId,
        });
        await maybeDisableTeam(host, sourceSessionId, targetMode, wasEnabled, prepare.revision, deps.logger);
        compensated = true;
        throw error;
      }

      deps.emitAgentEvent({
        sessionId: sourceSessionId,
        ts: Date.now(),
        event: { type: "message_start", message: userMessage },
      });
      deps.emitAgentEvent({
        sessionId: sourceSessionId,
        ts: Date.now(),
        event: { type: "message_end", message: userMessage },
      });

      const sidecarParams: Record<string, unknown> = { ...launch.sidecarParams };
      if (targetMode === "team") {
        sidecarParams.team = {
          enabled: true,
          revision: prepare.revision,
        };
      } else {
        delete sidecarParams.team;
      }

      let result: { accepted: boolean; turnId: string };
      try {
        result = await sidecar.call<{ accepted: boolean; turnId: string }>(
          "agent.planDebateHandoff",
          {
            ...sidecarParams,
            turnId: durableTurnId,
            content,
            userMessageId,
            targetMode,
          },
        );
      } catch (error) {
        await deps.finishTurn(sourceSessionId, "error", extractErrorCode(error), {
          turnId: durableTurnId,
        });
        await maybeDisableTeam(host, sourceSessionId, targetMode, wasEnabled, prepare.revision, deps.logger);
        compensated = true;
        return mapHandoffFailure(traceId, error);
      }

      deps.logger.app("session", "info", "plan debate handoff accepted", {
        sessionId: sourceSessionId,
        turnId: durableTurnId,
        traceId,
        planBytes: byteLength(selection.text),
        addendumBytes: byteLength(userAddendum ?? ""),
      });

      return { ok: true, turnId: result.turnId, traceId };
    } catch (error) {
      if (!compensated) {
        await maybeDisableTeam(host, sourceSessionId, targetMode, wasEnabled, prepare.revision, deps.logger);
      }
      deps.logger.app("session", "warn", "plan debate handoff failed", {
        sessionId: sourceSessionId,
        traceId,
        data: { errorCode: extractErrorCode(error) },
      });
      return mapHandoffFailure(traceId, error);
    }
  } finally {
    releaseSessionOperation();
  }
}

export function registerPlanDebateHandoffIpc(
  deps: PlanDebateHandoffServiceDependencies & { registrar: PlanDebateHandoffRegistrar },
): void {
  deps.registrar.handle(IPC.invoke.planDebateHandoff, (raw: unknown) =>
    executePlanDebateHandoff(deps, raw),
  );
}
