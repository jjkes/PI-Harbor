import {
  ErrorCodes,
  IPC,
  PROGRESS_MAX_OUTPUT_TOKENS,
  PROGRESS_TIMEOUT_MS,
  PROGRESS_WINDOW_MESSAGES,
  parseProgressCollectRequest,
  parseProgressSettingsPatch,
  progressAvailableFor,
  type ProgressCollectResult,
  type ProgressReport,
  type ProgressReportPage,
  type ProgressSettings,
  type ProgressTrigger,
  type SessionSummary,
  type SessionTodoSnapshot,
  type UiMessage,
} from "@pi-harbor/shared";
import {
  buildProgressDigest,
  buildProgressPrompt,
  buildProgressSnapshot,
  parseProgressReport,
  progressFingerprint,
  resolveProgressModelRef,
  type ProgressModelLookup,
  type RuntimeProviderConfig,
} from "@pi-harbor/agent-runtime";
import { OAUTH_AUTH_KIND } from "@pi-harbor/shared";
import type { Context } from "@earendil-works/pi-ai";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { HostProcess } from "../host-process";
import type { VendorOAuth } from "../oauth";
import type { IpcRegistrar } from "./types";

/**
 * Read-only session progress reports (ADR 0350).
 *
 * Main validates the request, registers one run per session, and then makes a
 * single tool-free completion over a bounded digest of the persisted
 * transcript. It never calls `agent.*`, never appends a message, never enters
 * the per-session serializer, and never touches the sidecar that runs the main
 * turn, so collecting cannot affect the session it reports on.
 */

/** At most this many collections run at once across the app. */
const MAX_ACTIVE_RUNS = 3;

export type ProgressRun = {
  runId: string;
  sessionId: string;
  trigger: ProgressTrigger;
  controller: AbortController;
  startedAt: number;
};

export type ProgressRuns = {
  /** Throws `PROGRESS_BUSY` when the session or the app cap is reached. */
  register(run: ProgressRun, senderId?: number): void;
  settle(runId: string): void;
  cancel(runId: string): boolean;
  abortSender(senderId: number): void;
  abortAll(): void;
  size(): number;
};

/** Main's registry of collections. One per session, three app-wide. */
export function createProgressRuns(): ProgressRuns {
  const runs = new Map<string, { run: ProgressRun; senderId?: number }>();

  return {
    register(run, senderId) {
      for (const entry of runs.values()) {
        if (entry.run.sessionId === run.sessionId) {
          throw codedError(
            ErrorCodes.PROGRESS_BUSY,
            "a collection is already running for this session",
          );
        }
      }
      if (runs.size >= MAX_ACTIVE_RUNS) {
        throw codedError(ErrorCodes.PROGRESS_BUSY, "too many collections are running");
      }
      runs.set(run.runId, { run, senderId });
    },
    settle(runId) {
      runs.delete(runId);
    },
    cancel(runId) {
      const entry = runs.get(runId);
      if (!entry) return false;
      entry.run.controller.abort();
      return true;
    },
    abortSender(senderId) {
      for (const [runId, entry] of runs) {
        if (entry.senderId !== senderId) continue;
        entry.run.controller.abort();
        runs.delete(runId);
      }
    },
    abortAll() {
      for (const entry of runs.values()) entry.run.controller.abort();
      runs.clear();
    },
    size() {
      return runs.size;
    },
  };
}

function codedError(errorCode: string, message: string, details?: Record<string, unknown>) {
  return Object.assign(new Error(message), { errorCode, data: details });
}

/** The renderer that asked, when the call came over Electron IPC. */
function senderOf(event: IpcMainInvokeEvent | undefined): WebContents | undefined {
  const sender = event?.sender;
  return sender && typeof sender.id === "number" && typeof sender.on === "function"
    ? sender
    : undefined;
}

/** The session fields a snapshot and its availability check need. */
type ProgressSession = {
  id: string;
  source?: SessionSummary["source"];
  providerId?: string;
  modelId?: string;
  mode?: string;
  permissionMode?: string;
  /** Exclusive end of the bounded read, i.e. the message count. */
  messageEnd?: number;
  /** Newest `messageLimit` messages, oldest first. */
  messages?: UiMessage[];
};

type ProgressLaunch = {
  providerId: string;
  modelId: string;
  sidecarParams: { provider: Record<string, unknown>; thinkingLevel?: string };
};

type CompleteOneShot = (
  provider: RuntimeProviderConfig,
  context: Context,
  thinkingLevel: "off",
  options?: {
    signal?: AbortSignal;
    maxOutputTokens?: number;
    sessionId?: string;
    emptyErrorCode?: string;
  },
) => Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>;

export type ProgressIpcDependencies = {
  registrar: Pick<IpcRegistrar, "handleWithEvent">;
  getHost: () => Pick<HostProcess, "call"> | null;
  /** The same resolution the plugin `agent.complete` path uses. */
  resolveAgentRuntimeLaunch: (
    sessionId: string,
    session: unknown,
    settings: unknown,
    overrides: { mode?: string; providerId?: string; modelId?: string; thinkingLevel?: string },
  ) => Promise<ProgressLaunch>;
  vendorOAuth: Pick<VendorOAuth, "resolveAuth">;
  completeOneShot: CompleteOneShot;
  runs: ProgressRuns;
  now: () => number;
};

export function registerProgressIpc(dependencies: ProgressIpcDependencies): void {
  const {
    registrar,
    getHost,
    resolveAgentRuntimeLaunch,
    vendorOAuth,
    completeOneShot,
    runs,
    now,
  } = dependencies;

  // A renderer that reloads, crashes, or closes has lost its request, so Main
  // stops its collections instead of letting them finish unseen.
  const observed = new WeakSet<WebContents>();
  const observeSender = (sender: WebContents): void => {
    if (observed.has(sender)) return;
    observed.add(sender);
    const senderId = sender.id;
    sender.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) runs.abortSender(senderId);
    });
    sender.once("render-process-gone", () => runs.abortSender(senderId));
    sender.once("destroyed", () => runs.abortSender(senderId));
  };

  registrar.handleWithEvent(
    IPC.invoke.progressCollect,
    async (event: IpcMainInvokeEvent, raw: unknown): Promise<ProgressCollectResult> => {
      const parsed = parseProgressCollectRequest(raw);
      if (!parsed.ok) throw codedError(ErrorCodes.INVALID_ARGUMENT, parsed.message);
      const request = parsed.request;
      const host = getHost();
      if (!host) throw codedError(ErrorCodes.AGENT_UNAVAILABLE, "host unavailable");

      // Remote and Pi-native ids are refused before any host call.
      if (!progressAvailableFor({ id: request.sessionId })) {
        throw codedError(
          ErrorCodes.PROGRESS_UNAVAILABLE,
          "progress reports are not available for this session",
        );
      }
      // `session.get` answers `{ session }`, and the bounded window rides *inside*
      // it: `SessionDetail` flattens the summary and adds `messages`. Reading the
      // window off the envelope instead yields an empty transcript, which silently
      // produced reports whose only content was "not enough information".
      const detail = await host.call<{ session?: ProgressSession }>("session.get", {
        id: request.sessionId,
        messageLimit: PROGRESS_WINDOW_MESSAGES,
      });
      const session = detail?.session;
      if (!session) throw codedError(ErrorCodes.PROGRESS_NO_SESSION, "session not found");
      if (!progressAvailableFor(session)) {
        throw codedError(
          ErrorCodes.PROGRESS_UNAVAILABLE,
          "progress reports are not available for this session",
        );
      }

      const messages = session.messages ?? [];
      // Both reads are cheap and read-only; neither takes the agent lock.
      const todos = await readTodos(host, request.sessionId);
      const latest = await host.call<ProgressReport | null>("progress.reports.latest", {
        sessionId: request.sessionId,
      });

      const snapshot = buildProgressSnapshot({
        session,
        messages,
        todos,
        totalMessages: session.messageEnd,
      });
      const fingerprint = progressFingerprint(snapshot);
      // Only automatic runs dedupe: a manual collection is the user asking now.
      if (request.trigger !== "manual" && latest?.fingerprint === fingerprint) {
        return { kind: "skipped", report: latest ?? null, skipped: true };
      }

      const sender = senderOf(event);
      const run: ProgressRun = {
        runId: request.runId,
        sessionId: request.sessionId,
        trigger: request.trigger,
        controller: new AbortController(),
        startedAt: now(),
      };
      runs.register(run, sender?.id);
      if (sender) observeSender(sender);

      const startedAt = now();
      try {
        const providers = await host.call<{ providers: ProviderRow[] }>("providers.list", {
          includeDisabled: false,
        });
        const resolution = resolveProgressModelRef(
          request.model,
          { providerId: session.providerId, modelId: session.modelId },
          lookupFromProviders(providers?.providers ?? []),
        );
        if (!resolution.ok) {
          throw codedError(ErrorCodes.PROGRESS_MODEL_UNAVAILABLE, resolution.message);
        }

        const launch = await resolveAgentRuntimeLaunch(
          request.sessionId,
          session,
          await host.call<unknown>("settings.get"),
          {
            mode: "agent",
            providerId: resolution.providerId,
            modelId: resolution.modelId,
            // A report is cheap and fast whatever the session's level is.
            thinkingLevel: "off",
          },
        );
        const provider = {
          ...launch.sidecarParams.provider,
          ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
            ? { resolveAuth: () => vendorOAuth.resolveAuth(launch.providerId) }
            : {}),
        } as RuntimeProviderConfig;

        const digest = buildProgressDigest(snapshot);
        const context = buildProgressPrompt(digest, now(), request.locale);
        const completion = await completeOneShot(provider, context, "off", {
          signal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(PROGRESS_TIMEOUT_MS)]),
          maxOutputTokens: PROGRESS_MAX_OUTPUT_TOKENS,
          sessionId: `progress:${run.runId}`,
          emptyErrorCode: ErrorCodes.PROGRESS_EMPTY_OUTPUT,
        });

        // An answer that does not match the shape is still worth keeping: the
        // history shows what the model actually said.
        const decoded = parseProgressReport(completion.text);
        const report = await host.call<ProgressReport>("progress.reports.append", {
          sessionId: request.sessionId,
          runId: request.runId,
          trigger: request.trigger,
          providerId: launch.providerId,
          modelId: launch.modelId,
          status: decoded.status,
          body: decoded.status === "ok" ? decoded.body : null,
          raw: decoded.status === "unparsed" ? decoded.raw : null,
          fingerprint,
          lastMessageId: snapshot.lastMessageId,
          messageCount: snapshot.messageCount,
          includedMessages: snapshot.messages.length,
          inputTokens: completion.usage?.inputTokens ?? null,
          outputTokens: completion.usage?.outputTokens ?? null,
          durationMs: now() - startedAt,
          createdAt: now(),
        });
        return { kind: "ok", report, skipped: false };
      } catch (error) {
        return collectionFailure(error);
      } finally {
        runs.settle(request.runId);
      }
    },
  );

  registrar.handleWithEvent(
    IPC.invoke.progressCancel,
    async (_event: IpcMainInvokeEvent, raw: unknown): Promise<{ aborted: boolean }> => {
      const runId = isRecord(raw) && typeof raw.runId === "string" ? raw.runId : "";
      if (runId.length === 0) throw codedError(ErrorCodes.INVALID_ARGUMENT, "runId required");
      return { aborted: runs.cancel(runId) };
    },
  );

  registrar.handleWithEvent(
    IPC.invoke.progressReportsList,
    async (_event: IpcMainInvokeEvent, raw: unknown): Promise<ProgressReportPage> => {
      const host = requireHost(getHost);
      const sessionId = sessionIdOf(raw);
      const before = isRecord(raw) && typeof raw.before === "string" ? raw.before : undefined;
      const limit = isRecord(raw) && typeof raw.limit === "number" ? raw.limit : undefined;
      return host.call<ProgressReportPage>("progress.reports.list", {
        sessionId,
        ...(before ? { before } : {}),
        ...(limit ? { limit } : {}),
      });
    },
  );

  registrar.handleWithEvent(
    IPC.invoke.progressSettingsGet,
    async (_event: IpcMainInvokeEvent, raw: unknown): Promise<ProgressSettings> => {
      const host = requireHost(getHost);
      return host.call<ProgressSettings>("progress.settings.get", { sessionId: sessionIdOf(raw) });
    },
  );

  registrar.handleWithEvent(
    IPC.invoke.progressSettingsSet,
    async (_event: IpcMainInvokeEvent, raw: unknown): Promise<ProgressSettings> => {
      const host = requireHost(getHost);
      const sessionId = sessionIdOf(raw);
      const patch = parseProgressSettingsPatch(isRecord(raw) ? raw.patch : undefined);
      if (!patch.ok) throw codedError(ErrorCodes.INVALID_ARGUMENT, patch.message);
      return host.call<ProgressSettings>("progress.settings.set", { sessionId, ...patch.patch });
    },
  );
}

function requireHost(getHost: ProgressIpcDependencies["getHost"]): Pick<HostProcess, "call"> {
  const host = getHost();
  if (!host) throw codedError(ErrorCodes.AGENT_UNAVAILABLE, "host unavailable");
  return host;
}

function sessionIdOf(raw: unknown): string {
  const sessionId = isRecord(raw) && typeof raw.sessionId === "string" ? raw.sessionId : "";
  if (sessionId.length === 0) throw codedError(ErrorCodes.INVALID_ARGUMENT, "sessionId required");
  return sessionId;
}

type ProviderRow = {
  id: string;
  modelId?: string;
  models?: { id?: string; modelId?: string }[];
  apiKey?: string;
  hasSecret?: boolean;
  hasOauth?: boolean;
  authKind?: string;
  extensionAgentKey?: string;
  enabled?: boolean;
};

/**
 * The catalog questions pure model resolution asks. `resolveAgentRuntimeLaunch`
 * stays the final authority on credentials; this only rejects the obvious
 * answer before a run is registered.
 */
function lookupFromProviders(providers: ProviderRow[]): ProgressModelLookup {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return {
    providerExists: (providerId: string) => byId.has(providerId),
    modelIds: (providerId: string) => {
      const provider = byId.get(providerId);
      if (!provider) return [];
      const ids = (provider.models ?? [])
        .map((model) => model.id ?? model.modelId ?? "")
        .filter((id) => id.length > 0);
      // A provider that lists no models is discovered later, so the request
      // carries the authority rather than a false negative here.
      return ids.length > 0 ? ids : provider.modelId ? [provider.modelId] : [];
    },
    hasCredential: (providerId: string) => {
      const provider = byId.get(providerId);
      if (!provider) return false;
      return (
        provider.hasSecret === true ||
        provider.hasOauth === true ||
        typeof provider.apiKey === "string" ||
        typeof provider.extensionAgentKey === "string" ||
        (provider.authKind !== undefined && provider.authKind !== "none")
      );
    },
  };
}

async function readTodos(
  host: Pick<HostProcess, "call">,
  sessionId: string,
): Promise<SessionTodoSnapshot | null> {
  try {
    return await host.call<SessionTodoSnapshot | null>("todos.get", { sessionId });
  } catch {
    // A session without a checklist is normal, not a failure of the report.
    return null;
  }
}

type ProgressFailure = { kind: "error"; code: string; message: string; retriable: boolean };

/** Fail closed and name the failure, so the popover can explain it. */
function collectionFailure(error: unknown): ProgressFailure {
  const code = errorCodeOf(error);
  if (code === ErrorCodes.PROGRESS_BUSY || code === ErrorCodes.PROGRESS_MODEL_UNAVAILABLE) {
    return { kind: "error", code, message: messageOf(error), retriable: code === ErrorCodes.PROGRESS_BUSY };
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError") {
    return {
      kind: "error",
      code: ErrorCodes.PROGRESS_CANCELLED,
      message: "the collection was cancelled",
      retriable: true,
    };
  }
  if (name === "TimeoutError") {
    return {
      kind: "error",
      code: ErrorCodes.PROGRESS_TIMEOUT,
      message: `the model did not answer within ${PROGRESS_TIMEOUT_MS / 1000} s`,
      retriable: true,
    };
  }
  if (code === ErrorCodes.PROGRESS_EMPTY_OUTPUT) {
    return { kind: "error", code, message: "the model returned no text", retriable: true };
  }
  return {
    kind: "error",
    code: code.length > 0 ? code : ErrorCodes.PROGRESS_PROVIDER_ERROR,
    message: messageOf(error),
    retriable: true,
  };
}

function errorCodeOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const code = Reflect.get(error, "errorCode");
  return typeof code === "string" ? code : "";
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "the collection failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
