/**
 * BTW side-question runs of the sidecar (ADR 0344). Validates `btw.ask`,
 * keeps one active run per main session, numbers each run's events, and
 * routes `btw.abort`. A run touches the main runtime only to read its
 * snapshot.
 */

import {
  ErrorCodes,
  parseBtwAskRequest,
  type AppError,
  type BtwEvent,
  type BtwEventEnvelope,
  type BtwHistoryTurn,
} from "@pi-harbor/shared";
import { BtwRun } from "./btw-run.js";
import { btwHostClient, type BtwHostCaller } from "./btw-tool-gate.js";
import type { SideQuestionSnapshot } from "./btw-types.js";

/** The part of a main runtime a BTW run may use. */
export type BtwSnapshotSource = { sideQuestionSnapshot(): SideQuestionSnapshot };

export type BtwServiceDeps = {
  /**
   * The session's registered runtime as it is, or a new one from
   * `launchIfAbsent`. Runs under the session's runtime creation guard.
   */
  runtimeFor: (
    sessionId: string,
    launchIfAbsent: Record<string, unknown> | undefined,
  ) => Promise<BtwSnapshotSource>;
  host: BtwHostCaller;
  notify: (envelope: BtwEventEnvelope) => void;
  classifyError: (error: unknown) => AppError;
};

type RunEntry = {
  runId: string;
  sessionId: string;
  seq: number;
  ended: boolean;
  aborted: boolean;
  run?: BtwRun;
};

function rpcError(rpcCode: number, errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { rpcCode, errorCode });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class BtwService {
  private readonly deps: BtwServiceDeps;
  private readonly runs = new Map<string, RunEntry>();
  private readonly activeBySession = new Map<string, string>();

  constructor(deps: BtwServiceDeps) {
    this.deps = deps;
  }

  /** `btw.ask`: accept the question, then stream `btw.event` notifications. */
  ask(params: unknown): { accepted: true } {
    const parsed = parseBtwAskRequest(params);
    if (!parsed.ok) throw rpcError(-32602, ErrorCodes.INVALID_ARGUMENT, parsed.message);
    const { runId, sessionId, question, history } = parsed.request;
    const launch = isPlainRecord(params) ? params.launchIfAbsent : undefined;
    const launchIfAbsent = isPlainRecord(launch) ? launch : undefined;
    if (this.runs.has(runId)) {
      throw rpcError(-32602, ErrorCodes.INVALID_ARGUMENT, "the BTW run id is already in use");
    }
    if (this.activeBySession.has(sessionId)) {
      throw rpcError(
        -32000,
        ErrorCodes.BTW_BUSY,
        "a side question is already running for this session",
      );
    }
    const entry: RunEntry = { runId, sessionId, seq: 0, ended: false, aborted: false };
    this.runs.set(runId, entry);
    this.activeBySession.set(sessionId, runId);
    void this.start(entry, question, history, launchIfAbsent);
    return { accepted: true };
  }

  /** `btw.abort`: stop a run. An unknown or finished run is a no-op. */
  abort(params: unknown): { aborted: boolean } {
    const runId = isPlainRecord(params) && typeof params.runId === "string" ? params.runId : "";
    const entry = this.runs.get(runId);
    if (!entry || entry.ended) return { aborted: false };
    entry.aborted = true;
    entry.run?.abort();
    return { aborted: true };
  }

  private emit(entry: RunEntry, event: BtwEvent): void {
    if (entry.ended) return;
    // A terminal event frees the session before it is delivered, so a client
    // that sees it can ask the next question at once.
    if (event.type === "done" || event.type === "error") this.release(entry);
    const envelope: BtwEventEnvelope = {
      runId: entry.runId,
      sessionId: entry.sessionId,
      seq: entry.seq,
      event,
    };
    entry.seq += 1;
    this.deps.notify(envelope);
  }

  private release(entry: RunEntry): void {
    entry.ended = true;
    this.runs.delete(entry.runId);
    if (this.activeBySession.get(entry.sessionId) === entry.runId) {
      this.activeBySession.delete(entry.sessionId);
    }
  }

  private async start(
    entry: RunEntry,
    question: string,
    history: readonly BtwHistoryTurn[],
    launchIfAbsent: Record<string, unknown> | undefined,
  ): Promise<void> {
    const emit = (event: BtwEvent) => this.emit(entry, event);
    try {
      const runtime = await this.deps.runtimeFor(entry.sessionId, launchIfAbsent);
      if (entry.aborted) {
        emit({ type: "done", stopReason: "aborted" });
        return;
      }
      let snapshot: SideQuestionSnapshot;
      try {
        snapshot = runtime.sideQuestionSnapshot();
      } catch (error) {
        emit({
          type: "error",
          error: {
            code: ErrorCodes.BTW_CONTEXT_UNAVAILABLE,
            message: "The main conversation's context could not be read.",
            retriable: true,
            details: { cause: error instanceof Error ? error.name : typeof error },
          },
        });
        return;
      }
      emit({
        type: "started",
        providerId: snapshot.provider.id,
        modelId: snapshot.provider.modelId,
        mainTurnRunning: snapshot.mainTurnRunning,
      });
      const run = new BtwRun({
        runId: entry.runId,
        snapshot,
        question,
        history,
        client: btwHostClient(this.deps.host, {
          sessionId: entry.sessionId,
          runId: entry.runId,
          mode: snapshot.mode,
        }),
        emit,
      });
      entry.run = run;
      await run.execute();
      if (!entry.ended) {
        emit({
          type: "error",
          error: {
            code: ErrorCodes.INTERNAL,
            message: "The side question ended without a result.",
            retriable: true,
          },
        });
      }
    } catch (error) {
      if (entry.aborted) emit({ type: "done", stopReason: "aborted" });
      else emit({ type: "error", error: this.deps.classifyError(error) });
    } finally {
      this.release(entry);
    }
  }
}
