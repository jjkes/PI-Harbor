import {
  btwAvailableFor,
  ErrorCodes,
  IPC,
  parseBtwAskRequest,
  type BtwAskResult,
  type SessionSummary,
} from "@pi-harbor/shared";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { BtwRunRegistry } from "../runtime/btw-runs";
import type { IpcRegistrar } from "./types";

/**
 * BTW side questions (ADR 0344). Main validates the request and checks that
 * the session may host BTW, then forwards only `btw.ask` and `btw.abort`. The
 * run itself lives in the agent sidecar.
 */
export type BtwIpcDependencies = {
  registrar: Pick<IpcRegistrar, "handleWithEvent">;
  getHost: () => Pick<HostProcess, "call"> | null;
  getSidecar: () => Pick<AgentSidecar, "call"> | null;
  activeTurns: ReadonlyMap<string, string>;
  /** Resolves the launch the session's next prompt would use. */
  resolveAgentRuntimeLaunch: (
    sessionId: string,
    session: unknown,
    settings: unknown,
  ) => Promise<{ sidecarParams: object }>;
  btwRuns: Pick<BtwRunRegistry, "track" | "untrack" | "has" | "abortSender">;
};

const UNAVAILABLE_MESSAGE = "BTW side questions are not available for this session";

function codedError(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

/** The renderer that asked, when the call came over Electron IPC. */
function senderOf(event: IpcMainInvokeEvent | undefined): WebContents | undefined {
  const sender = event?.sender;
  return sender && typeof sender.id === "number" && typeof sender.on === "function"
    ? sender
    : undefined;
}

function runIdOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const runId = (value as { runId?: unknown }).runId;
  return typeof runId === "string" ? runId : undefined;
}

export function registerBtwIpc({
  registrar,
  getHost,
  getSidecar,
  activeTurns,
  resolveAgentRuntimeLaunch,
  btwRuns,
}: BtwIpcDependencies): void {
  // A renderer that reloads, crashes, or closes has lost its BTW threads, so
  // Main stops their runs instead of letting them finish unseen.
  const observed = new WeakSet<WebContents>();
  const observeSender = (sender: WebContents): void => {
    if (observed.has(sender)) return;
    observed.add(sender);
    const senderId = sender.id;
    sender.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) btwRuns.abortSender(senderId);
    });
    sender.once("render-process-gone", () => btwRuns.abortSender(senderId));
    sender.once("destroyed", () => btwRuns.abortSender(senderId));
  };

  registrar.handleWithEvent(
    IPC.invoke.btwAsk,
    async (event: IpcMainInvokeEvent, raw: unknown): Promise<BtwAskResult> => {
      const parsed = parseBtwAskRequest(raw);
      if (!parsed.ok) throw codedError(ErrorCodes.INVALID_ARGUMENT, parsed.message);
      const request = parsed.request;
      // Remote and Pi-native ids are refused before any host call.
      if (!btwAvailableFor({ id: request.sessionId })) {
        throw codedError(ErrorCodes.BTW_UNAVAILABLE, UNAVAILABLE_MESSAGE);
      }
      if (btwRuns.has(request.runId)) {
        throw codedError(ErrorCodes.BTW_BUSY, "this side question is already running");
      }
      const host = getHost();
      const sidecar = getSidecar();
      if (!host || !sidecar) {
        throw codedError(ErrorCodes.AGENT_UNAVAILABLE, "agent runtime unavailable");
      }
      const result = await host.call<{ session?: SessionSummary | null }>("session.get", {
        id: request.sessionId,
        messageLimit: 1,
      });
      const session = result?.session;
      if (!session) throw codedError(ErrorCodes.SESSION_NOT_FOUND, "session not found");
      if (!btwAvailableFor(session)) {
        throw codedError(ErrorCodes.BTW_UNAVAILABLE, UNAVAILABLE_MESSAGE);
      }
      // A running main turn already has its runtime and the auth bindings it
      // signs requests with. Resolving a launch now would rewrite them.
      const launch = activeTurns.has(request.sessionId)
        ? undefined
        : await resolveAgentRuntimeLaunch(
            request.sessionId,
            session,
            await host.call<unknown>("settings.get"),
          );
      const sender = senderOf(event);
      btwRuns.track(request.runId, request.sessionId, sender?.id);
      if (sender) observeSender(sender);
      try {
        return await sidecar.call<BtwAskResult>("btw.ask", {
          ...request,
          launchIfAbsent: launch?.sidecarParams,
        });
      } catch (error) {
        btwRuns.untrack(request.runId);
        throw error;
      }
    },
  );

  registrar.handleWithEvent(
    IPC.invoke.btwAbort,
    async (_event: IpcMainInvokeEvent, raw: unknown): Promise<{ aborted: boolean }> => {
      const runId = runIdOf(raw);
      // Only a run Main started can be stopped through Main.
      if (!runId || !btwRuns.has(runId)) return { aborted: false };
      const sidecar = getSidecar();
      if (!sidecar) return { aborted: false };
      return sidecar.call<{ aborted: boolean }>("btw.abort", { runId });
    },
  );
}
