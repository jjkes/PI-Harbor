import { useRef, useState, type FormEvent } from "react";
import type { TFunction } from "i18next";
import type { SessionSummary } from "@pi-harbor/shared";
import { debateSeatHandle, type PlanDebateRole } from "./plan-debate-machine";
import { markRoundDeleted } from "./plan-debate-store";
import {
  buildPlanDebateHandoffRequest,
  executePlanDebateHandoff,
  type PlanDebateHandoffPlan,
  type PlanDebateHandoffTargetMode,
} from "./plan-debate-handoff";
import { releaseDebateMode } from "./debate-mode-preference";
import { planDebateDeleteErrorMessage } from "./plan-debate-delete";
import {
  removePlanDebateArtifactFromCache,
  planDebateArtifactCacheHasRound,
  type PlanDebateArtifactCache,
} from "./plan-debate-artifact-cache";
import { api } from "../../lib/api";
import type { PlanDebateRoundView } from "./plan-debate-view";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export type UsePlanDebateActionsOptions = {
  /** The session the panel is wired to; captured at call time, not read from the store. */
  sessionId: string;
  /** The session object, when it exists, so a handoff can be refused before it is built. */
  session: SessionSummary | undefined;
  /** The project path the current session resolves to. */
  projectPath: string | null;
  /** The current artifact cache; used by delete to revoke only the round being removed. */
  artifactCache: PlanDebateArtifactCache;
  /** Replace the artifact cache (used after deletion). */
  setArtifactCache: (updater: (current: PlanDebateArtifactCache) => PlanDebateArtifactCache) => void;
  /** Append a round to the persisted deleted list. */
  setDeletedRounds: (updater: (current: readonly number[]) => readonly number[]) => void;
  /** The user's typed suggestion, used as the addendum for draft/merged handoffs. */
  suggestion: string;
  /** The current objection text for a re-debate. */
  objection: string;
  /** Send a prompt from the composer; returns whether it was accepted. */
  sendPrompt: (prompt: string) => Promise<boolean>;
  /** Display a toast notification. */
  showToast: (message: string, options?: { variant?: "success" | "error" | "info" }) => void;
  /** Translate user-facing strings. */
  t: TFunction;
  /** Report or clear the single inline error the panel displays. */
  setError: (error: string | null) => void;
  /** Callback after a successful handoff so the component can persist and paint the marker. */
  onHandoffRecorded: (round: number, at: number) => void;
  /** Ask the component to refresh its artifact cache after a mutating backend call. */
  refreshArtifacts: () => void;
  /** Ask the component to revoke in-flight artifact refresh requests (used by delete). */
  revokeArtifactRequests: () => void;
};

export type UsePlanDebateActionsResult = {
  busy: boolean;
  starting: boolean;
  restarting: boolean;
  cancelling: boolean;
  ending: boolean;
  deleting: boolean;
  handOff: (plan: PlanDebateHandoffPlan, targetMode: PlanDebateHandoffTargetMode) => Promise<void>;
  startDebateForRound: (round: number) => Promise<void>;
  retryRound: (sourceRound: number) => Promise<void>;
  cancelRound: (round: number) => Promise<void>;
  endRound: (round: number) => Promise<void>;
  deleteRound: (round: number) => Promise<void>;
  submitRedebate: (
    event: FormEvent<HTMLFormElement>,
    latestRound: PlanDebateRoundView | null,
  ) => Promise<boolean>;
};

/**
 * All the asynchronous actions a plan-debate panel can take on a round.
 *
 * The component owns the view, the selection, the artifact cache and the
 * confirmation-dialog state; this hook owns the request lifecycle, the busy
 * flags and the epoch-based stale-call guard that keeps a slow recovery
 * response from overwriting a newer recovery request.
 */
export function usePlanDebateActions(
  options: UsePlanDebateActionsOptions,
): UsePlanDebateActionsResult {
  const {
    sessionId,
    session,
    projectPath,
    artifactCache,
    setArtifactCache,
    setDeletedRounds,
    suggestion,
    objection,
    sendPrompt,
    showToast,
    t,
    setError,
    onHandoffRecorded,
    refreshArtifacts,
    revokeArtifactRequests,
  } = options;

  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [ending, setEnding] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const recoveryEpochRef = useRef(0);

  async function handOff(
    plan: PlanDebateHandoffPlan,
    targetMode: PlanDebateHandoffTargetMode,
  ): Promise<void> {
    if (busy || !plan.ok) return;
    if (!session) return;
    // Capture the source session now so a session switch during the await cannot
    // redirect the handoff to a different session.
    const sourceSessionId = sessionId;
    setBusy(true);
    setError(null);
    try {
      const addendum = plan.selection.kind === "suggestion" ? "" : suggestion;
      const request = buildPlanDebateHandoffRequest(
        sourceSessionId,
        targetMode,
        plan,
        addendum,
      );
      const result = await executePlanDebateHandoff(request);
      if (!result.ok) {
        const why = result.message ?? result.errorCode ?? "";
        const retryable = result.retryable ? t("planning.errorHandoffRetryable") : "";
        setError(
          t("planning.errorHandoffTrace", {
            error: why,
            traceId: result.traceId,
            retryable,
          }),
        );
        return;
      }
      // The plan is the session's task now: the debate surface hands the
      // composer back to plain Agent development, so the chip stops naming a
      // round the team already owns. The marker is written only after the
      // backend confirms the prompt was accepted.
      await releaseDebateMode();
      const at = Date.now();
      onHandoffRecorded(plan.round, at);
      showToast(t("planning.handoffDone", { round: plan.round }), { variant: "success" });
    } catch (caught) {
      setError(t("planning.errorHandoff", { error: errorText(caught) }));
    } finally {
      setBusy(false);
    }
  }

  async function startDebateForRound(round: number): Promise<void> {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const result = await api.planDebateStart({ sessionId, round });
      if (!result.ok) {
        setError(
          t("planning.errorStartDebate", { error: result.message ?? result.errorCode ?? "" }),
        );
      }
    } catch (caught) {
      setError(t("planning.errorStartDebate", { error: errorText(caught) }));
    } finally {
      setStarting(false);
    }
  }

  async function retryRound(sourceRound: number): Promise<void> {
    if (restarting) return;
    const sourceSessionId = sessionId;
    const epoch = ++recoveryEpochRef.current;
    setRestarting(true);
    setError(null);
    try {
      const traceId = globalThis.crypto.randomUUID();
      const result = await api.planDebateRetry({
        sessionId: sourceSessionId,
        sourceRound,
        traceId,
      });
      if (epoch !== recoveryEpochRef.current) return;
      if (!result.ok) {
        const retryable = result.retryable ? t("planning.errorHandoffRetryable") : "";
        setError(
          t("planning.errorRetry", {
            error: result.message ?? result.errorCode ?? "",
            traceId: result.traceId,
            retryable,
          }),
        );
        return;
      }
      // The runtime now creates and starts the retry round atomically. The UI
      // only consumes the result; it never composes a separate start call.
      if (result.started || result.phase) {
        refreshArtifacts();
      }
    } catch (caught) {
      if (epoch !== recoveryEpochRef.current) return;
      setError(t("planning.errorRetry", { error: errorText(caught), traceId: "", retryable: "" }));
    } finally {
      if (epoch === recoveryEpochRef.current) {
        setRestarting(false);
      }
    }
  }

  async function cancelRound(round: number): Promise<void> {
    if (cancelling) return;
    const sourceSessionId = sessionId;
    const epoch = ++recoveryEpochRef.current;
    setCancelling(true);
    setError(null);
    try {
      const traceId = globalThis.crypto.randomUUID();
      const result = await api.planDebateCancel({
        sessionId: sourceSessionId,
        round,
        traceId,
      });
      if (epoch !== recoveryEpochRef.current) return;
      if (!result.ok) {
        const retryable = result.retryable ? t("planning.errorHandoffRetryable") : "";
        setError(
          t("planning.errorCancel", {
            error: result.message ?? result.errorCode ?? "",
            traceId: result.traceId,
            retryable,
          }),
        );
        return;
      }
      if (result.stopTimedOut) {
        setError(
          t("planning.errorCancelStopTimedOut", {
            round: result.round,
            traceId: result.traceId,
          }),
        );
        return;
      }
      // Cancel is authoritative; refresh artifacts so the panel shows the
      // stopped round instead of waiting for the transcript window.
      refreshArtifacts();
    } catch (caught) {
      if (epoch !== recoveryEpochRef.current) return;
      setError(t("planning.errorCancel", { error: errorText(caught), traceId: "", retryable: "" }));
    } finally {
      if (epoch === recoveryEpochRef.current) {
        setCancelling(false);
      }
    }
  }

  async function endRound(round: number): Promise<void> {
    if (ending) return;
    setEnding(true);
    setError(null);
    try {
      const result = await api.planDebateEnd({ sessionId, round });
      if (!result.ok) {
        setError(t("planning.errorEndRound", { error: result.message ?? result.errorCode ?? "" }));
      } else {
        // End has already stamped stoppedAt. Read it even when an
        // abort-resistant delegate leaves its transcript row running.
        refreshArtifacts();
      }
    } catch (caught) {
      setError(t("planning.errorEndRound", { error: errorText(caught) }));
    } finally {
      setEnding(false);
    }
  }

  async function deleteRound(round: number): Promise<void> {
    if (deleting) return;
    const deleteProjectPath = projectPath;
    if (deleteProjectPath === null) {
      setError(
        t("planning.errorDeleteRound", {
          error: t("planning.errorDeleteRoundProject"),
        }),
      );
      return;
    }
    const liveSession = options.session; // read the session passed at hook creation
    const currentProjectPath = liveSession?.projectPath ?? null;
    if (
      currentProjectPath !== deleteProjectPath ||
      !planDebateArtifactCacheHasRound(artifactCache, sessionId, deleteProjectPath, round)
    ) {
      setError(
        t("planning.errorDeleteRound", {
          error: t("planning.errorDeleteRoundProject"),
        }),
      );
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      // Main/sidecar re-check this binding against the session's current
      // project before removing anything; the renderer never chooses a path.
      const result = await api.planDebateDelete({
        sessionId,
        round,
        projectPath: deleteProjectPath,
      });
      if (!result.ok) {
        const message = planDebateDeleteErrorMessage(result, (key) => t(key));
        setError(t("planning.errorDeleteRound", { error: message }));
      } else {
        // The successful rm is authoritative. Revoke every older response before
        // evicting only this round; siblings stay cached without a forced refresh.
        revokeArtifactRequests();
        setArtifactCache((current) =>
          removePlanDebateArtifactFromCache(current, sessionId, deleteProjectPath, round),
        );
        // Persist the deletion so the panel stops drawing this round from the
        // transcript too — the disk rm alone only removed the artifact cache.
        markRoundDeleted(sessionId, round);
        setDeletedRounds((current) => (current.includes(round) ? current : [...current, round]));
      }
    } catch (caught) {
      setError(t("planning.errorDeleteRound", { error: errorText(caught) }));
    } finally {
      setDeleting(false);
    }
  }

  async function submitRedebate(
    event: FormEvent<HTMLFormElement>,
    latestRound: PlanDebateRoundView | null,
  ): Promise<boolean> {
    event.preventDefault();
    if (!latestRound) return false;
    const text = objection.trim();
    if (text === "") {
      setError(t("planning.errorEmptyObjection"));
      return false;
    }
    // The next round is numbered past every round the panel knows, so a round
    // that exists and has not started is never re-used as the re-debate's.
    const nextRound = latestRound.round + 1;
    const roster = latestRound.roles
      .map((role: PlanDebateRole) => debateSeatHandle(role.name, role.seat))
      .join(", ");
    // The panel is the user's gesture, so the prompt carries the tool's own
    // `intent: "start"`: without it the runtime opens no round at all.
    const prompt = `Start plan debate round ${nextRound} with the same roster: ${roster}. Reuse the original requirement and treat this user objection as an additional constraint: "${text}". Call PlanDebate now with intent: "start", round=${nextRound}, requirement = the original requirement plus that constraint, and the same roles.`;
    setError(null);
    try {
      const accepted = await sendPrompt(prompt);
      // A refused prompt keeps the objection in the form: the user's words are
      // the constraint, and retyping them would be the panel's fault.
      return accepted;
    } catch (caught) {
      setError(t("planning.errorRestart", { error: errorText(caught) }));
      return false;
    }
  }

  return {
    busy,
    starting,
    restarting,
    cancelling,
    ending,
    deleting,
    handOff,
    startDebateForRound,
    retryRound,
    cancelRound,
    endRound,
    deleteRound,
    submitRedebate,
  };
}
