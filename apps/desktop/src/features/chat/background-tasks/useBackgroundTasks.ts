import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type BackgroundTaskOutput, type BackgroundTaskSummary } from "../../../lib/api";
import {
  type BarVisibility,
  EMPTY_VISIBILITY,
  dismissTask,
  nextExpiryAt,
  observeTasks,
  selectVisibleTasks,
} from "./bar-visibility";

const REFRESH_MS = 1_000;
type Failure = "load" | "output" | "stop" | "remove";

/**
 * Background tasks for one session.
 *
 * The host registry is global and stays that way: filtering happens here so the
 * wire contract does not have to grow a session parameter and every consumer
 * keeps seeing the full picture. Switching sessions therefore changes only what
 * is displayed — never whether a task runs. The shared container's tab,
 * collapse and badge live in `useDockView`, which reads the snapshot returned
 * here.
 */
export function useBackgroundTasks(sessionId: string | null | undefined) {
  const [allTasks, setAllTasks] = useState<BackgroundTaskSummary[]>([]);
  // Renderer-local view state: which tasks the container may show. The registry
  // in host-core stays the source of truth for the processes themselves.
  const [visibility, setVisibility] = useState<BarVisibility>(EMPTY_VISIBILITY);
  const [clock, setClock] = useState(() => Date.now());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [output, setOutput] = useState<BackgroundTaskOutput | null>(null);
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<Failure | null>(null);
  const mounted = useRef(false);
  const pendingStops = useRef(new Set<string>());
  const refreshList = useRef<(() => void) | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let inFlight = false;
    let queued = false;
    let pollAgain = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      clearTimeout(timer);
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        const result = await api.backgroundTasksList();
        if (disposed) return;
        const observedAt = Date.now();
        setAllTasks(result.tasks);
        setVisibility((current) => observeTasks(current, result.tasks, observedAt));
        setClock(observedAt);
        setError((current) => current === "load" ? null : current);
        pollAgain = result.tasks.some((task) => task.state === "running");
      } catch (failure) {
        if (disposed) return;
        console.error("Background task list failed", failure);
        setError("load");
        pollAgain = true;
      } finally {
        inFlight = false;
        if (!disposed) {
          if (queued) {
            queued = false;
            void refresh();
          } else if (pollAgain) {
            timer = setTimeout(() => void refresh(), REFRESH_MS);
          }
        }
      }
    };
    refreshList.current = () => void refresh();
    const unsubscribe = api.onBackgroundTasksChanged(() => void refresh());
    void refresh();
    return () => {
      disposed = true;
      mounted.current = false;
      refreshList.current = null;
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  // Only this session's tasks reach the container. A task from another session
  // is not hidden because it ended: it simply belongs elsewhere.
  const sessionTasks = useMemo(
    () => (sessionId ? allTasks.filter((task) => task.sessionId === sessionId) : []),
    [allTasks, sessionId],
  );

  // Only what the container should render: running tasks, a finished task during
  // its post-exit grace window, and the row whose output the user is reading.
  const visibleTasks = selectVisibleTasks(visibility, sessionTasks, clock, expandedId);

  useEffect(() => {
    const expiry = nextExpiryAt(visibility, sessionTasks, clock, expandedId);
    if (expiry === null) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, expiry - clock));
    return () => clearTimeout(timer);
  }, [visibility, sessionTasks, clock, expandedId]);

  const selectedState = sessionTasks.find((task) => task.id === expandedId)?.state;
  useEffect(() => {
    setOutput(null);
    if (!expandedId || !sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sessionAtRequest = sessionId;
    const refresh = async () => {
      try {
        const result = await api.backgroundTasksOutput(expandedId);
        if (disposed) return;
        setOutput(result);
        setError((current) => current === "output" ? null : current);
      } catch (failure) {
        if (disposed) return;
        console.error("Background task output failed", failure);
        setError("output");
      } finally {
        // Only the selected log crosses IPC, with at most one read in flight.
        if (!disposed && selectedState === "running" && sessionIdRef.current === sessionAtRequest) {
          timer = setTimeout(() => void refresh(), REFRESH_MS);
        }
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [expandedId, selectedState, sessionId]);

  const toggleOutput = useCallback((id: string) => {
    setExpandedId((current) => current === id ? null : id);
    setError((current) => current === "output" ? null : current);
  }, []);

  /**
   * Remove a row from the container.
   *
   * The task is looked up here rather than trusting the caller's snapshot: a
   * running task — including one already stopping — is refused with `false` so
   * the UI can say why instead of silently dropping a live process.
   */
  const remove = useCallback((id: string): boolean => {
    const task = sessionTasks.find((candidate) => candidate.id === id);
    if (!task || task.state === "running") {
      setError("remove");
      return false;
    }
    setVisibility((current) => dismissTask(current, task));
    setExpandedId((current) => current === id ? null : current);
    return true;
  }, [sessionTasks]);

  const stop = useCallback(async (id: string) => {
    if (pendingStops.current.has(id)) return;
    pendingStops.current.add(id);
    setStoppingIds(new Set(pendingStops.current));
    setError(null);
    try {
      await api.backgroundTasksStop(id);
      if (mounted.current) refreshList.current?.();
    } catch (failure) {
      if (mounted.current) {
        console.error("Background task stop failed", failure);
        setError("stop");
      }
    } finally {
      pendingStops.current.delete(id);
      if (mounted.current) setStoppingIds(new Set(pendingStops.current));
    }
  }, []);

  return {
    /** Tasks belonging to the session on screen, after the grace window. */
    tasks: visibleTasks,
    /** Every task of this session, regardless of the grace window. */
    sessionTasks,
    /** The last registry snapshot, every session included. */
    registryTasks: allTasks,
    expandedId,
    output,
    stoppingIds,
    error,
    toggleOutput,
    stop,
    remove,
  };
}
