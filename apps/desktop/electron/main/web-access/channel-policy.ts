import { IPC } from "@pi-harbor/shared";

/**
 * Which renderer IPC a browser web access client may use (ADR 0342).
 *
 * A signed-in browser acts as the owner, so it reaches the same handlers as
 * the desktop window. It cannot use what acts on this computer's own screen
 * or devices: native dialogs and window controls, revealing or opening files
 * in the OS, the embedded browser panel, plugin views and panel windows, voice
 * capture, storage relocation, quitting the app, and the web access settings
 * themselves. Channels registered with the sender event (`handleWithEvent`)
 * are not in the dispatch table at all, so they are unavailable without a
 * rule here.
 */
export type WebChannelDecision = "dispatch" | "deny" | "noop";

const DENIED_PREFIXES: readonly string[] = [
  "pi-harbor/webAccess/",
  "pi-harbor/storage/",
  "pi-harbor/browser/",
  "pi-harbor/voice/",
];

const DENIED_CHANNELS: ReadonlySet<string> = new Set<string>([
  IPC.invoke.appQuit,
  IPC.invoke.appOpenFeedback,
  IPC.invoke.devtoolsToggle,
  IPC.invoke.windowControl,
  IPC.invoke.nativeMenuAction,
  IPC.invoke.logOpenFolder,
  IPC.invoke.fsReveal,
  IPC.invoke.fsOpen,
  IPC.invoke.worktreeReveal,
  // Deny by name without depending on the optional project-workspaces IPC
  // surface; that feature may land independently of browser web access.
  "pi-harbor/projectWorkspace/reveal",
  IPC.invoke.sessionOpenScratchPath,
  IPC.invoke.projectOpenFolder,
  IPC.invoke.skillReveal,
  IPC.invoke.subagentReveal,
  // These always open a native picker on the desktop screen.
  IPC.invoke.skillImport,
  IPC.invoke.pluginLoadDev,
  IPC.invoke.pluginCreateFromTemplate,
  IPC.invoke.pluginInstallFromPath,
  IPC.invoke.pluginInstallFromPackage,
  IPC.invoke.pluginImportExtension,
  // A plugin view or panel window is a native window on this computer.
  IPC.invoke.pluginViewOpen,
  IPC.invoke.pluginOpenPanel,
]);

/**
 * Desktop-window bookkeeping with no meaning in a browser tab. Answering
 * success keeps the shared renderer code quiet without touching the desktop
 * window's layout.
 */
const NOOP_CHANNELS: ReadonlySet<string> = new Set<string>([
  IPC.invoke.windowSetWorkPanelReservation,
  IPC.invoke.windowSetWorkPanelChatWidth,
  IPC.invoke.windowSetBackgroundColor,
  IPC.invoke.menuRendererReady,
  IPC.invoke.lifecycleDialogReady,
  IPC.invoke.traySetSessionPreferences,
  // Plugin view bookkeeping. A browser never opens a native view, so these
  // answer success without touching the views on this computer.
  IPC.invoke.pluginViewClose,
  IPC.invoke.pluginViewSetBounds,
  IPC.invoke.pluginViewSetVisible,
]);

const INVOKE_CHANNELS: ReadonlySet<string> = new Set<string>(Object.values(IPC.invoke));

export function webChannelDecision(channel: string): WebChannelDecision {
  if (!INVOKE_CHANNELS.has(channel)) return "deny";
  if (NOOP_CHANNELS.has(channel)) return "noop";
  if (DENIED_CHANNELS.has(channel)) return "deny";
  if (DENIED_PREFIXES.some((prefix) => channel.startsWith(prefix))) return "deny";
  return "dispatch";
}

/** Events a browser never receives: its own settings, and native voice ports. */
const WITHHELD_EVENTS: ReadonlySet<string> = new Set<string>([
  IPC.event.webAccessChanged,
  IPC.event.liveVoicePort,
]);

export function forwardsEventToWeb(channel: string): boolean {
  return !WITHHELD_EVENTS.has(channel);
}
