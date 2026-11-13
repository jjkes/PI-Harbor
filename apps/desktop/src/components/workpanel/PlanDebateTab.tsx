/**
 * The plan debate as a work-panel tab: the round's timeline, what each seat
 * drafted and objected, the merged plan, and the one decision the panel owns —
 * carry a plan forward, either into another round or into team mode.
 *
 * The timeline is derived from the session's transcript (the `PlanDebate` and
 * delegate `Task` rows the runtime publishes), so a reload repaints the round
 * that actually ran instead of a second copy that could drift. The only stored
 * facts are the choice and the handoff record: whether this round's plan
 * already went to the team, which the transcript cannot state.
 *
 * The panel draws one round: the one that owns the delegates that ran
 * (`planDebatePanelRound`), because a newest round that has proposed a roster
 * and started nothing says nothing about the debate. The switcher at the top
 * opens any earlier round read-only, so history is browsable without the tab
 * ever drawing the same round twice.
 *
 * A phase row lists its seats and each seat's report — the delegate's
 * conclusion is the artifact, not a count.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "../Markdown";
import { Badge, Button, Textarea } from "../ui";
import {
  planDebateArtifactCacheForProject,
  planDebateArtifactCacheAfterRefresh,
  planDebateArtifactCacheHasRound,
  planDebateArtifactRequestIsCurrent,
  planDebateArtifactsForProject,
  planDebateProjectPath,
  removePlanDebateArtifactFromCache,
  type PlanDebateArtifactCache,
} from "../../features/plan-debate/plan-debate-artifact-cache";
import { planDebateDeleteErrorMessage } from "../../features/plan-debate/plan-debate-delete";
import {
  choosePlan,
  debateSeatHandle,
  planDebateChoices,
  planDebateElapsed,
  type PlanDebateHandoff,
  type PlanDebatePhaseName,
  type PlanDebatePhaseStatus,
  type PlanDebateSelection,
} from "../../features/plan-debate/plan-debate-machine";
import {
  PLAN_DEBATE_STATUS_TONE,
  planDebateAwaitingStart,
  planDebateNodeLabel,
  planDebatePanelRound,
  planDebatePendingRounds,
  planDebateRoundRunning,
  planDebatePhaseStatuses,
  planDebateState,
  planDebateViewWithArtifacts,
  type PlanDebateNode,
  type PlanDebateRoundView,
} from "../../features/plan-debate/plan-debate-view";
import {
  planDebateHandoffPlan,
  type PlanDebateHandoffPlan,
} from "../../features/plan-debate/plan-debate-handoff";
import {
  readPlanDebateHandoff,
  writePlanDebateHandoff,
  readDeletedRounds,
  markRoundDeleted,
} from "../../features/plan-debate/plan-debate-store";
import {
  planDebateSelectionOf,
  setPlanDebateSelection,
  subscribePlanDebateSelection,
} from "../../features/plan-debate/plan-debate-selection";
import { useSessionDelegations } from "../../features/chat/subagent-dock/useSessionDelegations";
import { teamService } from "../../features/team/team-service";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import "../../styles/plan-debate.css";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Milliseconds a delegate has run, through the machine's own elapsed rule. */
function nodeSeconds(node: PlanDebateNode, now: number): number {
  return Math.round(
    planDebateElapsed(
      {
        name: "drafting",
        status: node.status,
        ...(node.startedAt !== undefined ? { startedAt: node.startedAt } : {}),
        ...(node.completedAt !== undefined ? { completedAt: node.completedAt } : {}),
      },
      now,
    ) / 1000,
  );
}

/** The delegates a phase row lists: only the three that have delegates. */
function nodesOfPhase(
  round: PlanDebateRoundView,
  name: PlanDebatePhaseName,
): PlanDebateNode[] {
  if (name === "drafting") return round.drafts;
  if (name === "critiquing") return round.critiques;
  if (name === "integrating") return round.integrator ? [round.integrator] : [];
  return [];
}

/** How a whole round reads on its chip: the four states a phase badge has. */
export type PlanDebateRoundStatus = "running" | "complete" | "failed" | "stopped";

/** The phases that spend delegates, and so the only ones a round is coloured by. */
const SPENDING_PHASES: ReadonlySet<PlanDebatePhaseName> = new Set<PlanDebatePhaseName>([
  "drafting",
  "critiquing",
  "integrating",
]);

/**
 * The status a whole round reports.
 *
 * Only the phases that spend delegates colour the round: once drafting,
 * critiquing and integrating are all terminal the round is `complete`, whatever
 * the phases around them say. `reviewing` is the reason this rule exists — it
 * stays open while the user reads a plan that is already selectable, so
 * counting it made a finished round's chip say `Running` forever, and said it
 * again after the plan had been handed to team mode.
 */
export function roundStatus(round: PlanDebateRoundView): PlanDebateRoundStatus {
  if (round.stoppedAt !== undefined) return "stopped";
  const spending = planDebatePhaseStatuses(round).filter((phase) =>
    SPENDING_PHASES.has(phase.name),
  );
  if (spending.some((phase) => phase.status === "failed")) return "failed";
  if (spending.some((phase) => phase.status === "stopped")) return "stopped";
  return spending.every((phase) => phase.status === "complete") ? "complete" : "running";
}

/** What a round's chip draws: its status, and the handed-off fact when it has one. */
export type PlanDebateRoundChip = {
  status: PlanDebateRoundStatus;
  /** The round whose plan already went to team mode, from the stored record. */
  handedOff: boolean;
  tone: (typeof PLAN_DEBATE_STATUS_TONE)[PlanDebatePhaseStatus];
  /** The catalog key the badge reads, so the chip carries no literal text. */
  labelKey: string;
};

/**
 * The chip a round draws.
 *
 * A round whose plan already went to team mode says so instead of reporting a
 * status it no longer has: "Handed to team mode" replaces the phase word, while
 * `status` still carries the honest `complete` for anything reading the chip's
 * data attributes.
 */
export function roundChip(
  round: PlanDebateRoundView,
  handoff: PlanDebateHandoff | null,
): PlanDebateRoundChip {
  const status = roundStatus(round);
  const handedOff = handoff !== null && handoff.round === round.round;
  if (handedOff) {
    return { status, handedOff, tone: "success", labelKey: "planning.handoffAlready" };
  }
  // Once any round is handed to team mode the debate is over: every other round
  // reads as ended rather than still running, even if its phases never settled.
  if (handoff !== null) {
    return { status: "stopped", handedOff: false, tone: "neutral", labelKey: "planning.status.stopped" };
  }
  return {
    status,
    handedOff,
    tone: PLAN_DEBATE_STATUS_TONE[status],
    labelKey: `planning.status.${status}`,
  };
}

export function PlanDebateTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  // The panel shows the active session, and `sessionId` only keys the remount,
  // so the store's live transcript is the same one the chat pane paints.
  const messages = useAppStore((state) => state.messages);
  const session = useAppStore((state) =>
    state.sessions.find((item) => item.id === state.activeSessionId),
  );
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const showToast = useAppStore((state) => state.showToast);

  // Read on the first paint, not after it: the round the panel opens on already
  // carries the handoff, so its chip never flashes a status the plan no longer
  // has. The effect below still re-reads on a session change.
  const [handoff, setHandoff] = useState<PlanDebateHandoff | null>(() =>
    readPlanDebateHandoff(sessionId),
  );
  // Rounds the user deleted from the panel; persisted so a reload keeps them hidden.
  const [deletedRounds, setDeletedRounds] = useState<readonly number[]>(() =>
    readDeletedRounds(sessionId),
  );
  // The choice is shared with the conversation card, which reports the plan the
  // user picked; one store keeps the two drawings of the round in agreement.
  const selection = useSyncExternalStore(
    subscribePlanDebateSelection,
    () => planDebateSelectionOf(sessionId),
    () => null,
  );
  /** The round the switcher opened; `null` keeps the panel's own round. */
  const [openedRound, setOpenedRound] = useState<number | null>(null);
  const [redebating, setRedeabating] = useState(false);
  const [objection, setObjection] = useState("");
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [suggestion, setSuggestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  useEffect(() => {
    setHandoff(readPlanDebateHandoff(sessionId));
  }, [sessionId]);

  // A seat's status is the delegation's own: the panel reads the same map the
  // subagent dock draws, so one seat cannot be `running` here and `aborted`
  // there when the coordinator's turn closes while the round keeps running.
  const delegations = useSessionDelegations(sessionId);
  /**
   * The rounds the runtime wrote to disk.
   *
   * The live transcript is a window: a debate is about fifteen rows, so its
   * drafts fall out of it while its critiques are still in it, and the panel
   * used to draw a settled draft as still drafting — or, after a reload, draw
   * nothing at all. The files under the project are the durable copy; the
   * transcript stays the live one, and a session that debated before the files
   * existed still renders exactly as before.
   */
  const projectPath = planDebateProjectPath(session?.projectPath);
  const [artifactCache, setArtifactCache] = useState<PlanDebateArtifactCache>(() =>
    planDebateArtifactCacheForProject(projectPath),
  );
  const artifacts = planDebateArtifactsForProject(artifactCache, projectPath);
  const view = useMemo(() => {
    const built = planDebateViewWithArtifacts(messages, artifacts, handoff, delegations.statuses);
    // A deleted round is filtered out of the panel's view: the transcript rows
    // stay in the conversation, but the record no longer appears here.
    const rounds = built.rounds.filter((round) => !deletedRounds.includes(round.round));
    return { rounds, latest: rounds.length > 0 ? rounds[rounds.length - 1] : null };
  }, [messages, artifacts, handoff, delegations.statuses, deletedRounds]);
  const latest = view.latest;
  // Notify when a round finishes with a merged plan. Rounds already complete on
  // the first load are not announced again — only newly completed ones are.
  const completedRoundsRef = useRef<Set<number> | null>(null);
  useEffect(() => {
    const done = new Set(
      view.rounds.filter((round) => (round.merged?.text.trim() ?? "") !== "").map((round) => round.round),
    );
    if (completedRoundsRef.current === null) {
      completedRoundsRef.current = done;
      return;
    }
    for (const round of done) {
      if (!completedRoundsRef.current.has(round)) {
        showToast(t("planning.debateComplete", { round }), { variant: "success" });
      }
    }
    completedRoundsRef.current = done;
  }, [view.rounds, showToast, t]);
  // The round that owns the delegates the transcript describes. A newest round
  // that has proposed a roster and started nothing has nothing to draw, so the
  // round whose artifacts exist is the one on screen.
  const panelRound = useMemo(() => planDebatePanelRound(view), [view]);
  // Only transcript settlements trigger a disk refresh. In particular, evicting
  // a deleted round must not schedule an empty refresh that could hide its siblings.
  const roundStatusSignature = useMemo(
    () =>
      planDebateViewWithArtifacts(messages, [], handoff, delegations.statuses).rounds
        .map((round) => `${round.round}:${roundStatus(round)}`)
        .join("|"),
    [messages, handoff, delegations.statuses],
  );
  // A round the panel has already read back, so a repaint that changes nothing
  // does not re-fetch the same files into a new array and re-render forever.
  const artifactsRef = useRef({ projectPath: "", serialized: "" });
  // Every refresh owns a sequence number; deletion advances it to revoke older responses.
  const artifactsRequestRef = useRef(0);
  const [artifactsRefresh, setArtifactsRefresh] = useState(0);
  const handoffAt = handoff?.at ?? 0;
  useEffect(() => {
    // Clear the previous project's rounds before its next paint can use them.
    artifactsRef.current = { projectPath: "", serialized: "" };
    setArtifactCache((current) =>
      current.projectPath === projectPath
        ? current
        : planDebateArtifactCacheForProject(projectPath),
    );
  }, [sessionId, projectPath]);
  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    const requestId = ++artifactsRequestRef.current;
    void (async () => {
      try {
        const result = await api.planDebateArtifacts({ sessionId });
        if (
          !planDebateArtifactRequestIsCurrent(requestId, artifactsRequestRef.current, cancelled)
        ) {
          return;
        }
        const rounds = result.rounds;
        if (!Array.isArray(rounds)) throw new Error("Invalid plan-debate artifacts response");
        const serialized = JSON.stringify(rounds);
        if (
          artifactsRef.current.projectPath === projectPath &&
          serialized === artifactsRef.current.serialized
        ) {
          return;
        }
        artifactsRef.current = { projectPath, serialized };
        setArtifactCache((current) =>
          planDebateArtifactCacheAfterRefresh(current, projectPath, { ok: true, rounds }),
        );
      } catch {
        if (
          !planDebateArtifactRequestIsCurrent(requestId, artifactsRequestRef.current, cancelled)
        ) {
          return;
        }
        setArtifactCache((current) =>
          planDebateArtifactCacheAfterRefresh(current, projectPath, { ok: false }),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, projectPath, roundStatusSignature, handoffAt, artifactsRefresh]);
  const panelRoundNumber = panelRound?.round ?? null;
  // The round on screen: the panel's own round by default, an earlier one while
  // the switcher holds it. A round that no longer exists falls back instead of
  // drawing an empty tab.
  const shownRound = useMemo(() => {
    if (openedRound === null) return panelRound;
    return view.rounds.find((round) => round.round === openedRound) ?? panelRound;
  }, [view, openedRound, panelRound]);
  const shownIsLatest =
    shownRound !== null && latest !== null && shownRound.round === latest.round;
  /**
   * Whether the round on screen is the one the panel decides on.
   *
   * Not "the newest round in the transcript": a round that has been proposed
   * and not started is newer than the one whose artifacts exist, and gating the
   * controls on the newest round is what once left the artifacts with no choose
   * button, no suggestion box and no handoff button at all. Choosing, the
   * suggestion, the re-debate and the handoff belong to the round whose plan
   * the user is reading; only an earlier round opened from the switcher is
   * history.
   */
  const shownIsCurrent =
    shownRound !== null && panelRound !== null && shownRound.round === panelRound.round;
  // The newer rounds that own no delegate yet: one header line each, above the
  // round with the artifacts, so a round waiting for its start is visible
  // without replacing the body.
  const pendingRounds = useMemo(
    () => planDebatePendingRounds(view, shownRound),
    [view, shownRound],
  );
  const pendingRound = pendingRounds.length > 0 ? pendingRounds[pendingRounds.length - 1] : null;
  const state = useMemo(
    () => planDebateState(view, selection, handoff),
    [view, selection, handoff],
  );
  const phases = useMemo(
    () => (shownRound ? planDebatePhaseStatuses(shownRound) : []),
    [shownRound],
  );
  // One gate for the button and for the click: a chosen plan the round still
  // has, not yet handed over. Selecting is what enables it, and the gate reads
  // the round the choice names rather than the round on screen — so a choice
  // made before a repaint still enables the button after it.
  const handoffPlan = useMemo(
    () => planDebateHandoffPlan(view, selection, handoff),
    [view, selection, handoff],
  );
  const alreadyHandedOff = !handoffPlan.ok && handoffPlan.reason === "already-handed-off";

  // Elapsed time is a value of two numbers, not a stored duration: a reload
  // repaints the same span, and only a running phase needs a tick.
  const [now, setNow] = useState(() => Date.now());
  const phaseRunning = phases.some((phase) => phase.status === "running");
  useEffect(() => {
    if (!phaseRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [phaseRunning]);

  // A new round is a new debate, so the previous round's choice no longer
  // applies — the same rule the machine applies when a round starts — and the
  // switcher returns to the current round, which is the one to read.
  // The identity watched here is the *panel's* round, not the newest round in
  // the transcript: an empty round that merely exists (a roster proposed and
  // not started) is not a new debate, and resetting the choice for it wiped a
  // selection the user had just made on the round whose plan they were reading
  // — one of the ways the handoff button came up disabled with a plan on screen.
  // Only an actual round change resets them: settlement re-renders, panel
  // remounts and a reload's repaint all keep the user's place.
  const previousRoundRef = useRef<number | null>(null);
  useEffect(() => {
    if (previousRoundRef.current !== null && previousRoundRef.current !== panelRoundNumber) {
      setPlanDebateSelection(sessionId, null);
      setOpenedRound(null);
    }
    previousRoundRef.current = panelRoundNumber;
  }, [sessionId, panelRoundNumber]);

  function choose(next: PlanDebateSelection) {
    const message =
      next.kind === "suggestion"
        ? t("planning.errorEmptySuggestion")
        : t("planning.errorNoSelection");
    // Only the user's own choice is ever stored: a choice the round cannot
    // honour (a draft that is not there, an empty suggestion) is an inline
    // error, never a fallback to whatever the model produced.
    const applied = choosePlan(state, next);
    if (applied.selection !== next) {
      setError(message);
      return;
    }
    setPlanDebateSelection(sessionId, applied.selection);
    setError(null);
  }

  function chooseSuggestion(round: number) {
    if (suggestion.trim() === "") {
      setError(t("planning.errorEmptySuggestion"));
      return;
    }
    // The choice names the round it was written in — the round on screen — so a
    // suggestion is never attached to a newer round that owns nothing.
    choose({ kind: "suggestion", round, text: suggestion });
  }

  function editSuggestion(round: number, value: string) {
    setSuggestion(value);
    // Editing the box of an already-chosen suggestion updates the choice, so
    // the handoff always carries the text the user is looking at.
    if (
      selection !== null &&
      selection.kind === "suggestion" &&
      selection.round === round &&
      value.trim() !== ""
    ) {
      choose({ kind: "suggestion", round, text: value });
    }
  }

  async function startDebateForRound(round: number) {
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

  /**
   * A seat's own transcript, in a work-panel tab keyed by its delegation id:
   * the debate reads the documents, this opens the thinking and tool calls
   * behind one of them. Same tab type the topology node opens.
   */
  function openTranscript(node: PlanDebateNode) {
    useAppStore.getState().openSubagentTab(node.delegationId, node.role);
  }

  async function submitRedebate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!latest) return;
    const text = objection.trim();
    if (text === "") {
      setError(t("planning.errorEmptyObjection"));
      return;
    }
    // The next round is numbered past every round the panel knows, so a round
    // that exists and has not started is never re-used as the re-debate's.
    const nextRound = latest.round + 1;
    const roster = latest.roles
      .map((role) => debateSeatHandle(role.name, role.seat))
      .join(", ");
    // The panel is the user's gesture, so the prompt carries the tool's own
    // `intent: "start"`: without it the runtime opens no round at all.
    const prompt = `Start plan debate round ${nextRound} with the same roster: ${roster}. Reuse the original requirement and treat this user objection as an additional constraint: "${text}". Call PlanDebate now with intent: "start", round=${nextRound}, requirement = the original requirement plus that constraint, and the same roles.`;
    setError(null);
    try {
      const accepted = await sendPrompt(prompt);
      // A refused prompt keeps the objection in the form: the user's words are
      // the constraint, and retyping them would be the panel's fault.
      if (!accepted) return;
      setObjection("");
      setRedeabating(false);
    } catch (caught) {
      setError(t("planning.errorRestart", { error: errorText(caught) }));
    }
  }

  async function handOff(plan: PlanDebateHandoffPlan) {
    if (busy || !plan.ok) return;
    // Team mode is a session setting and the plan is its first task, so the
    // steps are ordered: enable, switch the session, send the plan.
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await teamService.setEnabled({ id: session.id, source: session.source }, true);
      await useAppStore.getState().configureActiveSession({
        mode: "agent",
        thinkingLevel: session.thinkingLevel ?? "medium",
      });
      // The user's suggestion rides as a supplement to the chosen plan, not a
      // replacement: choosing a merged plan or a draft still carries their words.
      let text = plan.text;
      const supplement = suggestion.trim();
      if (supplement !== "" && plan.selection.kind !== "suggestion") {
        text = `${text}\n\n### Additional user suggestion\n\n${supplement}`;
      }
      const accepted = await useAppStore.getState().sendPrompt(text);
      // A refused prompt is a failed handoff: the round stays untouched so
      // the user can retry.
      if (!accepted) throw new Error("prompt refused");
      const at = Date.now();
      // The record is written before the repaint so a second click finds the
      // button disabled instead of handing the same round over twice.
      writePlanDebateHandoff(sessionId, { round: plan.round, at });
      setHandoff({ round: plan.round, at });
    } catch (caught) {
      setError(t("planning.errorHandoff", { error: errorText(caught) }));
    } finally {
      setBusy(false);
    }
  }

  async function endRound(round: number) {
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
        setArtifactsRefresh((current) => current + 1);
      }
    } catch (caught) {
      setError(t("planning.errorEndRound", { error: errorText(caught) }));
    } finally {
      setEnding(false);
      setConfirmEnd(null);
    }
  }

  async function deleteRound(round: number) {
    if (deleting) return;
    const deleteProjectPath = projectPath;
    const liveSession = useAppStore.getState().sessions.find((item) => item.id === sessionId);
    const currentProjectPath = planDebateProjectPath(liveSession?.projectPath);
    if (
      currentProjectPath !== deleteProjectPath ||
      !planDebateArtifactCacheHasRound(artifactCache, deleteProjectPath, round)
    ) {
      setError(
        t("planning.errorDeleteRound", {
          error: t("planning.errorDeleteRoundProject"),
        }),
      );
      setConfirmDelete(null);
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
        artifactsRequestRef.current += 1;
        setArtifactCache((current) =>
          removePlanDebateArtifactFromCache(current, deleteProjectPath, round),
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
      setConfirmDelete(null);
    }
  }


  if (!latest || !shownRound) {
    return (
      <div className="work-panel-plan-debate" data-session-id={sessionId}>
        <div className="work-panel-plan-debate-empty">
          <p className="work-panel-plan-debate-empty-title">{t("planning.emptyTitle")}</p>
          <p className="work-panel-plan-debate-empty-body">{t("planning.emptyBody")}</p>
        </div>
      </div>
    );
  }

  /** The draft handles a round can hand over. */
  function draftChoices(round: PlanDebateRoundView): string[] {
    return planDebateChoices(round.state).drafts.map((draft) => draft.role);
  }

  /**
   * A seat's artifact: the report the delegate returned. A settled seat with
   * nothing to read says so — the artifact of a delegate is its conclusion, and
   * a missing one is a fact about the round, not an empty space.
   */
  function renderReport(node: PlanDebateNode) {
    if (node.text.trim() !== "") {
      return (
        <details className="work-panel-plan-debate-report" data-plan-debate-report={node.delegationId}>
          <summary>{t("planning.openReport")}</summary>
          <div className="work-panel-plan-debate-report-body">
            <Markdown source={node.text} />
          </div>
        </details>
      );
    }
    if (node.status === "running") return null;
    return (
      <p
        className="work-panel-plan-debate-missing"
        role="status"
        data-plan-debate-missing-report={node.delegationId}
      >
        {t("planning.seatNoReport")}
      </p>
    );
  }

  /** One seat: who ran, how it ended, and the document it left behind. */
  function renderSeat(node: PlanDebateNode) {
    const handle = planDebateNodeLabel(node);
    return (
      <li
        key={node.delegationId}
        className="work-panel-plan-debate-seat"
        data-plan-debate-node={node.delegationId}
        data-plan-debate-seat={`${node.role}#${node.seat}`}
        data-plan-debate-seat-status={node.status}
      >
        <div className="work-panel-plan-debate-seat-head">
          <span className="work-panel-plan-debate-node-role">{handle}</span>
          <Badge tone={PLAN_DEBATE_STATUS_TONE[node.status]}>
            {t(`planning.status.${node.status}`)}
          </Badge>
          {/* A seat with no span has no duration to report: an unknown
              start is drawn as nothing, never as `0s`. */}
          {node.startedAt !== undefined ? (
            <span className="work-panel-plan-debate-elapsed">
              {t("planning.elapsed", { seconds: nodeSeconds(node, now) })}
            </span>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="work-panel-plan-debate-open"
            aria-label={`${t("planning.openTranscript")} · ${handle}`}
            data-plan-debate-open={node.delegationId}
            onClick={() => openTranscript(node)}
          >
            {t("planning.openTranscript")}
          </Button>
        </div>
        {node.error ? (
          <p className="work-panel-plan-debate-node-error" role="status">
            {t("planning.roleFailed", { role: handle, error: node.error })}
          </p>
        ) : null}
        {renderReport(node)}
      </li>
    );
  }

  /**
   * The round's three sections, in reading order. Drafts carry the choice, so
   * only the round the user is deciding on gets the choose buttons.
   */
  function renderBlocks(round: PlanDebateRoundView, selectable: boolean) {
    // `selectable` already means "this is the round the panel is deciding on";
    // re-testing it against the newest round here is what removed every choose
    // button from the artifacts whenever a newer, empty round existed.
    const choices = draftChoices(round);
    const roundMerged = planDebateChoices(round.state).merged;
    return (
      <>
        <div className="work-panel-plan-debate-block" data-plan-debate-block="drafts">
          <h4 className="work-panel-plan-debate-block-title">{t("planning.drafts")}</h4>
          {round.drafts.length === 0 ? (
            <p className="work-panel-plan-debate-block-empty">{t("planning.phaseEmpty")}</p>
          ) : (
            <ul className="work-panel-plan-debate-list">
              {round.drafts.map((node) => {
                const handle = planDebateNodeLabel(node);
                const chosen =
                  selection !== null &&
                  selection.kind === "draft" &&
                  selection.round === round.round &&
                  selection.role === handle;
                return (
                  <li
                    key={node.delegationId}
                    className="work-panel-plan-debate-row"
                    data-plan-debate-draft={node.delegationId}
                  >
                    <div className="work-panel-plan-debate-row-head">
                      <span className="work-panel-plan-debate-row-role">{handle}</span>
                      <Badge tone={PLAN_DEBATE_STATUS_TONE[node.status]}>
                        {t(`planning.status.${node.status}`)}
                      </Badge>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="work-panel-plan-debate-open"
                        aria-label={`${t("planning.openTranscript")} · ${handle}`}
                        data-plan-debate-open={node.delegationId}
                        onClick={() => openTranscript(node)}
                      >
                        {t("planning.openTranscript")}
                      </Button>
                    </div>
                    {node.error ? (
                      <p className="work-panel-plan-debate-node-error" role="status">
                        {t("planning.roleFailed", { role: handle, error: node.error })}
                      </p>
                    ) : null}
                    {renderReport(node)}
                    {selectable && choices.includes(handle) ? (
                      <Button
                        type="button"
                        size="sm"
                        variant={chosen ? "primary" : "secondary"}
                        className="work-panel-plan-debate-choice"
                        aria-pressed={chosen}
                        data-plan-debate-choice={`draft:${handle}`}
                        onClick={() => choose({ kind: "draft", round: round.round, role: handle })}
                      >
                        {chosen ? t("planning.selected") : t("planning.selectDraft")}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="work-panel-plan-debate-block" data-plan-debate-block="objections">
          <h4 className="work-panel-plan-debate-block-title">{t("planning.objections")}</h4>
          {round.critiques.length === 0 ? (
            <p className="work-panel-plan-debate-block-empty">{t("planning.phaseEmpty")}</p>
          ) : (
            <ul className="work-panel-plan-debate-list">
              {round.critiques.map((node) => (
                <li
                  key={node.delegationId}
                  className="work-panel-plan-debate-row"
                  data-plan-debate-objection={node.delegationId}
                >
                  <div className="work-panel-plan-debate-row-head">
                    <span className="work-panel-plan-debate-row-role">
                      {planDebateNodeLabel(node)}
                    </span>
                    <Badge tone={PLAN_DEBATE_STATUS_TONE[node.status]}>
                      {t(`planning.status.${node.status}`)}
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="work-panel-plan-debate-open"
                      aria-label={`${t("planning.openTranscript")} · ${planDebateNodeLabel(node)}`}
                      data-plan-debate-open={node.delegationId}
                      onClick={() => openTranscript(node)}
                    >
                      {t("planning.openTranscript")}
                    </Button>
                  </div>
                  {node.error ? (
                    <p className="work-panel-plan-debate-node-error" role="status">
                      {t("planning.roleFailed", {
                        role: planDebateNodeLabel(node),
                        error: node.error,
                      })}
                    </p>
                  ) : null}
                  {renderReport(node)}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div
          className="work-panel-plan-debate-block work-panel-plan-debate-merged"
          data-plan-debate-block="merged"
        >
          {round.merged === null ? (
            round.integrator === null ? (
              <p className="work-panel-plan-debate-block-empty">{t("planning.mergedEmpty")}</p>
            ) : (
              renderReport(round.integrator)
            )
          ) : (
            <details className="work-panel-plan-debate-merged-details">
              <summary className="work-panel-plan-debate-merged-summary">
                {t("planning.merged")}
              </summary>
              <div className="work-panel-plan-debate-merged-body">
                <Markdown source={round.merged.text} />
              </div>
              <div className="work-panel-plan-debate-verdicts">
                <h5 className="work-panel-plan-debate-verdicts-title">
                  {t("planning.verdicts")}
                </h5>
                {round.merged.verdicts.length === 0 ? (
                  <p className="work-panel-plan-debate-block-empty">
                    {t("planning.verdictEmpty")}
                  </p>
                ) : (
                  <ul className="work-panel-plan-debate-verdict-list">
                    {round.merged.verdicts.map((verdict, index) => (
                      <li
                        key={`${verdict.item}:${index}`}
                        className="work-panel-plan-debate-verdict"
                      >
                        <Badge tone={verdict.verdict === "adopted" ? "success" : "error"}>
                          {t(
                            verdict.verdict === "adopted"
                              ? "planning.verdictAdopted"
                              : "planning.verdictRejected",
                          )}
                        </Badge>
                        <span className="work-panel-plan-debate-verdict-item">
                          {verdict.item}
                        </span>
                        <span className="work-panel-plan-debate-verdict-source">
                          {t("planning.verdictSource", { source: verdict.source })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {selectable && roundMerged ? (
                <Button
                  type="button"
                  size="sm"
                  variant={
                    selection?.kind === "merged" && selection.round === round.round
                      ? "primary"
                      : "secondary"
                  }
                  className="work-panel-plan-debate-choice"
                  aria-pressed={selection?.kind === "merged" && selection.round === round.round}
                  data-plan-debate-choice="merged"
                  onClick={() => choose({ kind: "merged", round: round.round })}
                >
                  {selection?.kind === "merged" && selection.round === round.round
                    ? t("planning.selected")
                    : t("planning.selectMerged")}
                </Button>
              ) : null}
            </details>
          )}
        </div>

        {selectable ? (
          <div className="work-panel-plan-debate-block" data-plan-debate-block="suggestion">
            <h4 className="work-panel-plan-debate-block-title">{t("planning.suggestionLabel")}</h4>
            <Textarea
              className="work-panel-plan-debate-suggestion-input"
              aria-label={t("planning.suggestionLabel")}
              placeholder={t("planning.suggestionPlaceholder")}
              rows={3}
              // The stored choice is the source of truth, so a panel remount
              // repaints the suggestion the user already made and chose.
              value={
                selection?.kind === "suggestion" && selection.round === round.round
                  ? selection.text
                  : suggestion
              }
              onChange={(event) => editSuggestion(round.round, event.target.value)}
            />
            <Button
              type="button"
              size="sm"
              variant={
                selection?.kind === "suggestion" && selection.round === round.round
                  ? "primary"
                  : "secondary"
              }
              className="work-panel-plan-debate-choice"
              aria-pressed={selection?.kind === "suggestion" && selection.round === round.round}
              data-plan-debate-choice="suggestion"
              onClick={() => chooseSuggestion(round.round)}
            >
              {selection?.kind === "suggestion" && selection.round === round.round
                ? t("planning.selected")
                : t("planning.selectSuggestion")}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className="work-panel-plan-debate" data-session-id={sessionId}>
      <h2 className="work-panel-plan-debate-title">{t("planning.title")}</h2>

      {/*
        The round switcher: newest first, so any earlier round is one press
        away and the round the panel opens on stays the default. Each entry
        carries its own status, so history is readable without opening it.
      */}
      <section
        className="work-panel-plan-debate-rounds"
        role="group"
        aria-label={t("planning.title")}
        data-plan-debate-rounds={view.rounds.length}
      >
        {[...view.rounds].reverse().map((round) => {
          const chip = roundChip(round, handoff);
          const active = round.round === shownRound.round;
          return (
            <button
              key={round.round}
              type="button"
              className={`work-panel-plan-debate-round-chip${active ? " is-active" : ""}`}
              data-plan-debate-round-switch={round.round}
              data-status={chip.status}
              data-plan-debate-round-handoff={chip.handedOff ? "done" : undefined}
              aria-pressed={active}
              onClick={() => setOpenedRound(round.round)}
            >
              <span className="work-panel-plan-debate-round-chip-title">
                {t("planning.roundTitle", { round: round.round })}
              </span>
              <Badge tone={chip.tone}>{t(chip.labelKey)}</Badge>
            </button>
          );
        })}
      </section>

      {/* The roster: one row per seat, so peers of one specialty are visible. */}
      <section className="work-panel-plan-debate-proposal" data-plan-debate-block="proposal">
        <h3 className="work-panel-plan-debate-block-title">{t("planning.proposal")}</h3>
        <p className="work-panel-plan-debate-locked">{t("planning.proposalLocked")}</p>
        <ul className="work-panel-plan-debate-roles">
          {shownRound.roles.map((role) => (
            <li
              key={`${role.name}#${role.seat}`}
              className="work-panel-plan-debate-role"
              data-plan-debate-role-seat={`${role.name}#${role.seat}`}
            >
              <span className="work-panel-plan-debate-role-name">
                {debateSeatHandle(role.name, role.seat)}
              </span>
              <span className="work-panel-plan-debate-role-brief" title={t("planning.roleBrief")}>
                {role.brief}
              </span>
            </li>
          ))}
        </ul>
        {shownRound.rationale !== undefined ? (
          <p className="work-panel-plan-debate-rationale">{shownRound.rationale}</p>
        ) : null}
        {/* The start control belongs to a round nobody has started. It is drawn
            inside this section only when that round is the one on screen; a
            round that is merely newer than the artifacts is announced above the
            round body instead. */}
        {/* Start control: shown on the round that is currently displayed,
            not only on the latest round. This lets the user start round N
            while viewing round N's own page. */}
        {planDebateAwaitingStart(shownRound) ? (
          <div className="work-panel-plan-debate-start">
            <Button
              type="button"
              size="sm"
              variant="primary"
              aria-busy={starting || undefined}
              disabled={starting}
              data-plan-debate-start={shownRound.round}
              onClick={() => void startDebateForRound(shownRound.round)}
            >
              {starting ? t("planning.startDebateBusy") : t("planning.startDebate")}
            </Button>
          </div>
        ) : null}
      </section>

      {/* A round that exists and has not started: one header line above the
          round with the artifacts, with the control that opens it. It never
          replaces the body — the artifacts are what the user came to read. */}
      {pendingRound !== null ? (
        <div
          className="work-panel-plan-debate-pending"
          role="status"
          data-plan-debate-pending-round={pendingRound.round}
        >
          <span className="work-panel-plan-debate-pending-title">
            {t("planning.roundNotStarted", { round: pendingRound.round })}
          </span>
          {planDebateAwaitingStart(pendingRound) ? (
            <Button
              type="button"
              size="sm"
              variant="primary"
              aria-busy={starting || undefined}
              disabled={starting}
              data-plan-debate-start={pendingRound.round}
              onClick={() => void startDebateForRound(pendingRound.round)}
            >
              {starting ? t("planning.startDebateBusy") : t("planning.startDebate")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <section
        className="work-panel-plan-debate-round"
        data-plan-debate-round={shownRound.round}
        data-plan-debate-latest={shownIsLatest ? "true" : "false"}
        data-plan-debate-current={shownIsCurrent ? "true" : "false"}
      >
        <header className="work-panel-plan-debate-round-head">
          <h3 className="work-panel-plan-debate-round-title">
            {t("planning.roundTitle", { round: shownRound.round })}
          </h3>
          {shownRound.state.redebate ? (
            <Badge tone="neutral">{t("planning.redebateBadge")}</Badge>
          ) : null}
          {!shownIsCurrent ? (
            <Badge tone="neutral">{t("planning.historyRound")}</Badge>
          ) : null}
          {/* The round was read back from its files: the transcript no longer
              holds it, which is exactly why the panel went looking. */}
          {shownRound.fromDisk ? (
            <Badge tone="neutral">{t("planning.diskRound")}</Badge>
          ) : null}
          {handoff?.round === shownRound.round ? (
            <Badge tone="success">{t("planning.handoffDone", { round: shownRound.round })}</Badge>
          ) : null}
        </header>

        {/* One compact row per phase: label, status, elapsed, then its seats. */}
        <div
          className="work-panel-plan-debate-timeline"
          aria-label={t("planning.roundTitle", { round: shownRound.round })}
          data-plan-debate-timeline={shownRound.round}
        >
          {phases.map((phase) => {
            const nodes = nodesOfPhase(shownRound, phase.name);
            const empty = nodes.length === 0;
            return (
              <div
                key={phase.name}
                className={`work-panel-plan-debate-phase${empty ? " is-empty" : ""}`}
                data-plan-debate-phase={phase.name}
                data-status={phase.status}
                data-plan-debate-empty={empty ? "true" : undefined}
                data-plan-debate-artifacts={nodes.length}
              >
                <div className="work-panel-plan-debate-phase-head">
                  <span className="work-panel-plan-debate-phase-label">
                    {t(`planning.phase.${phase.name}`)}
                  </span>
                  <Badge tone={PLAN_DEBATE_STATUS_TONE[phase.status]}>
                    {t(`planning.status.${phase.status}`)}
                  </Badge>
                  {phase.startedAt !== undefined ? (
                    <span className="work-panel-plan-debate-elapsed">
                      {t("planning.elapsed", {
                        seconds: Math.round(planDebateElapsed(phase, now) / 1000),
                      })}
                    </span>
                  ) : null}
                </div>
                {/* An empty phase is one line, not a block with a placeholder. */}
                {empty ? null : (
                  <ul className="work-panel-plan-debate-nodes">{nodes.map(renderSeat)}</ul>
                )}
              </div>
            );
          })}
        </div>

        {renderBlocks(shownRound, shownIsCurrent)}

        {/* Controls belong to the round the panel decides on: a round opened
            from the switcher is history, and a newer round that owns nothing is
            announced above this body, not drawn instead of it. */}
        {shownIsCurrent ? (
          <div className="work-panel-plan-debate-controls">
            <div className="work-panel-plan-debate-actions">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                aria-expanded={redebating}
                onClick={() => setRedeabating((current) => !current)}
              >
                {t("planning.redebate")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="primary"
                aria-busy={busy || undefined}
                disabled={!handoffPlan.ok || busy}
                data-plan-debate-handoff={
                  handoffPlan.ok ? "ready" : handoffPlan.reason
                }
                onClick={() => void handOff(handoffPlan)}
              >
                {busy
                  ? t("planning.handoffBusy")
                  : alreadyHandedOff
                    ? t("planning.handoffAlready")
                    : t("planning.handoff")}
              </Button>
              {/* End round: only for a round that is still producing. */}
              {planDebateRoundRunning(shownRound) ? (
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={ending}
                  onClick={() => setConfirmEnd(shownRound.round)}
                >
                  {t("planning.endRound")}
                </Button>
              ) : null}
              {/* Delete is armed only by a round loaded from the current project. */}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={
                  deleting ||
                  !planDebateArtifactCacheHasRound(artifactCache, projectPath, shownRound.round)
                }
                onClick={() => setConfirmDelete(shownRound.round)}
              >
                {t("planning.deleteRound")}
              </Button>
            </div>
            {error !== null ? (
              <p className="work-panel-plan-debate-error" role="status">
                {error}
              </p>
            ) : null}
            {redebating ? (
              <form className="work-panel-plan-debate-redebate" onSubmit={submitRedebate}>
                <Textarea
                  className="work-panel-plan-debate-redebate-input"
                  aria-label={t("planning.redebatePrompt")}
                  placeholder={t("planning.redebatePlaceholder")}
                  rows={3}
                  value={objection}
                  onChange={(event) => setObjection(event.target.value)}
                />
                <div className="work-panel-plan-debate-redebate-actions">
                  <Button type="submit" size="sm" variant="primary">
                    {t("planning.redebateSubmit", { round: latest.round + 1 })}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRedeabating(false);
                      setObjection("");
                      setError(null);
                    }}
                  >
                    {t("planning.redebateCancel")}
                  </Button>
                </div>
              </form>
            ) : null}
          </div>
        ) : null}

        {/* Confirmation dialogs for destructive actions. */}
        {confirmEnd !== null ? (
          <div className="work-panel-plan-debate-confirm-overlay" role="dialog" aria-label={t("planning.confirmEndTitle")}>
            <div className="work-panel-plan-debate-confirm">
              <p>{t("planning.confirmEndBody", { round: confirmEnd })}</p>
              <div className="work-panel-plan-debate-confirm-actions">
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={ending}
                  onClick={() => void endRound(confirmEnd)}
                >
                  {t("planning.confirmEndYes")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmEnd(null)}
                >
                  {t("planning.confirmEndNo")}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {confirmDelete !== null ? (
          <div className="work-panel-plan-debate-confirm-overlay" role="dialog" aria-label={t("planning.confirmDeleteTitle")}>
            <div className="work-panel-plan-debate-confirm">
              <p>{t("planning.confirmDeleteBody", { round: confirmDelete })}</p>
              <div className="work-panel-plan-debate-confirm-actions">
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={deleting}
                  onClick={() => void deleteRound(confirmDelete)}
                >
                  {t("planning.confirmDeleteYes")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmDelete(null)}
                >
                  {t("planning.confirmDeleteNo")}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
