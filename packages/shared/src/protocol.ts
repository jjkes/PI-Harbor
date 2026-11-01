export const PROTOCOL_VERSION = 11 as const;
export const SCHEMA_VERSION = 16 as const;
export const APP_ID = "top.jjkets.pi-harbor";
export const APP_NAME = "PI-Harbor Desktop";
export const APP_VERSION = "0.21.0";

export const APP_MENU_COMMANDS = [
  "newTask",
  "openProject",
  "openSettings",
  "openSearch",
  "openCommandPalette",
  "toggleSidebar",
  "openHelp",
  "openLogs",
  "checkForUpdates",
] as const;

export type AppMenuCommand = (typeof APP_MENU_COMMANDS)[number];

export const NATIVE_MENU_ACTIONS = [
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "selectAll",
  "reload",
  "zoomIn",
  "zoomOut",
  "resetZoom",
  "toggleFullScreen",
  "minimize",
  "toggleMaximize",
  "close",
  "restoreMainWindow",
  "toggleMainWindow",
] as const;

export type NativeMenuAction = (typeof NATIVE_MENU_ACTIONS)[number];

export const WINDOW_CONTROL_ACTIONS = [
  "getState",
  "minimize",
  "toggleMaximize",
  "close",
] as const;

export type WindowControlAction = (typeof WINDOW_CONTROL_ACTIONS)[number];

export type LifecycleDialogKind = "quit-confirmation" | "close-behavior";
export type LifecycleDialogChoice = "cancel" | "confirm" | "tray" | "quit";
export type LifecycleDialogRequest = {
  requestId: string;
  kind: LifecycleDialogKind;
};
export type LifecycleDialogDismiss = { requestId: string };
export const IPC = {
  invoke: {
    storageGet: "pi-harbor/storage/get",
    storageChoose: "pi-harbor/storage/choose",
    storageMigrate: "pi-harbor/storage/migrate",
    storageClearCache: "pi-harbor/storage/clearCache",
    storageRemoveBackup: "pi-harbor/storage/removeBackup",
    appGetVersion: "pi-harbor/app/getVersion",
    appOpenFeedback: "pi-harbor/app/openFeedback",
    appHealth: "pi-harbor/app/health",
    appGetOnboarding: "pi-harbor/app/getOnboarding",
    appDismissOnboarding: "pi-harbor/app/dismissOnboarding",
    /**
     * Quit the whole application through the ordered shutdown. Exposed for the
     * surfaces that own the window while the shell has no data yet — a stuck
     * startup must always be able to exit the app (issue #831).
     */
    appQuit: "pi-harbor/app/quit",
    /** Installed system font families, resolved by Electron main. */
    systemFontsList: "pi-harbor/app/systemFonts",
    updatesGetState: "pi-harbor/updates/getState",
    updatesCheck: "pi-harbor/updates/check",
    updatesDownload: "pi-harbor/updates/download",
    updatesInstall: "pi-harbor/updates/install",
    updatesOpenReleases: "pi-harbor/updates/openReleases",
    /** Persist the user's decision to stop nudging about one version (#1317). */
    updatesDismiss: "pi-harbor/updates/dismiss",
    notificationList: "pi-harbor/notification/list",
    notificationMarkRead: "pi-harbor/notification/markRead",
    notificationMarkAllRead: "pi-harbor/notification/markAllRead",
    notificationClear: "pi-harbor/notification/clear",
    notificationShowNative: "pi-harbor/notification/showNative",
    notificationSetViewingSession: "pi-harbor/notification/setViewingSession",
    agentPrompt: "pi-harbor/agent/prompt",
    agentSteer: "pi-harbor/agent/steer",
    speechTranscribe: "pi-harbor/speech/transcribe",
    speechSynthesize: "pi-harbor/speech/synthesize",
    speechGetStatus: "pi-harbor/speech/getStatus",
    voiceStart: "pi-harbor/voice/start",
    voiceStop: "pi-harbor/voice/stop",
    voiceCancel: "pi-harbor/voice/cancel",
    voiceGetState: "pi-harbor/voice/getState",
    voiceGetDevices: "pi-harbor/voice/getDevices",
    voiceGetModels: "pi-harbor/voice/getModels",
    voiceDownloadModel: "pi-harbor/voice/downloadModel",
    voiceDeleteModel: "pi-harbor/voice/deleteModel",
    voiceUpdateSettings: "pi-harbor/voice/updateSettings",
    voiceCheckPermission: "pi-harbor/voice/checkPermission",
    voiceRequestPermission: "pi-harbor/voice/requestPermission",
    liveVoiceStatus: "pi-harbor/voice/live/status",
    liveVoicePrepare: "pi-harbor/voice/live/prepare",
    liveVoiceConnect: "pi-harbor/voice/live/connect",
    liveVoiceSetMuted: "pi-harbor/voice/live/setMuted",
    liveVoiceReportMedia: "pi-harbor/voice/live/reportMedia",
    liveVoiceReportPlayback: "pi-harbor/voice/live/reportPlayback",
    liveVoiceReportDelegation: "pi-harbor/voice/live/reportDelegation",
    liveVoiceReportControlApplied: "pi-harbor/voice/live/reportControlApplied",
    liveVoiceEnd: "pi-harbor/voice/live/end",
    liveVoiceHeartbeat: "pi-harbor/voice/live/heartbeat",
    liveVoiceResolveWorkSelection: "pi-harbor/voice/live/work/resolveSelection",
    liveVoiceStopWorkOperation: "pi-harbor/voice/live/work/stopOperation",
    liveVoiceCancelQueuedOperation: "pi-harbor/voice/live/work/cancelQueuedOperation",
    liveVoiceWidgetAction: "pi-harbor/voice/live/widget/action",
    liveVoiceWidgetOwnerState: "pi-harbor/voice/live/widget/ownerState",
    liveVoiceWidgetVisibility: "pi-harbor/voice/live/widget/visibility",
    agentCompact: "pi-harbor/agent/compact",
    agentAbort: "pi-harbor/agent/abort",
    agentStopSubagents: "pi-harbor/agent/stop-subagents",
    agentStop: "pi-harbor/agent/stop",
    agentQueuePush: "pi-harbor/agent/queue/push",
    agentQueueList: "pi-harbor/agent/queue/list",
    agentQueueRemove: "pi-harbor/agent/queue/remove",
    agentQueuePrioritize: "pi-harbor/agent/queue/prioritize",
    agentQueueReorder: "pi-harbor/agent/queue/reorder",
    agentGetStatus: "pi-harbor/agent/getStatus",
    agentInstructionsGet: "pi-harbor/agent/instructions/get",
    agentInstructionsSave: "pi-harbor/agent/instructions/save",
    sessionList: "pi-harbor/session/list",
    sessionCreate: "pi-harbor/session/create",
    sessionFork: "pi-harbor/session/fork",
    sessionMoveProject: "pi-harbor/session/moveProject",
    sessionSearch: "pi-harbor/session/search",
    sessionSearchContext: "pi-harbor/session/searchContext",
    sessionGet: "pi-harbor/session/get",
    sessionCollaboration: "pi-harbor/session/collaboration",
    sessionTeamGet: "pi-harbor/session/team/get",
    sessionTeamUpdate: "pi-harbor/session/team/update",
    /** Validate and select a durable session from a reviewed host operation. */
    sessionOpen: "pi-harbor/session/open",
    sessionDelete: "pi-harbor/session/delete",
    /** Isolated sessions in git worktrees (ADR 0329). */
    worktreeProbe: "pi-harbor/worktree/probe",
    worktreePreview: "pi-harbor/worktree/preview",
    worktreeMerge: "pi-harbor/worktree/merge",
    worktreePendingWork: "pi-harbor/worktree/pendingWork",
    /** "Sync from project": project commits the session lacks, and the sync. */
    worktreeBehind: "pi-harbor/worktree/behind",
    worktreeSync: "pi-harbor/worktree/sync",
    /** Behind counts of every isolated session, for the sidebar marker. */
    worktreeBehindAll: "pi-harbor/worktree/behindAll",
    worktreeSetupLog: "pi-harbor/worktree/setupLog",
    /** Opens the worktree folder in the OS file manager; no path is returned. */
    worktreeReveal: "pi-harbor/worktree/reveal",
    worktreeSetupCommandGet: "pi-harbor/worktree/setupCommand/get",
    worktreeSetupCommandSet: "pi-harbor/worktree/setupCommand/set",
    /**
     * Project workspaces: named git worktrees at `<project>/.pi/worktree/<name>`
     * that own their own sessions. Distinct from `worktree*` above (per-session
     * isolation, ADR 0329) and from `workspace*` (the active project).
     */
    projectWorkspaceList: "pi-harbor/projectWorkspace/list",
    projectWorkspaceProbe: "pi-harbor/projectWorkspace/probe",
    /** Remote branches for the create dialog; `refresh` runs `git fetch`. */
    projectWorkspaceBranches: "pi-harbor/projectWorkspace/branches",
    projectWorkspaceCreate: "pi-harbor/projectWorkspace/create",
    projectWorkspaceDelete: "pi-harbor/projectWorkspace/delete",
    /** What deleting the workspace would lose, for the confirmation. */
    projectWorkspacePendingWork: "pi-harbor/projectWorkspace/pendingWork",
    projectWorkspaceRepair: "pi-harbor/projectWorkspace/repair",
    projectWorkspaceSetupLog: "pi-harbor/projectWorkspace/setupLog",
    /** Opens the workspace folder in the OS file manager; no path is returned. */
    projectWorkspaceReveal: "pi-harbor/projectWorkspace/reveal",
    sessionRename: "pi-harbor/session/rename",
    /** Deterministic first-prompt title for a session that is still untitled. */
    sessionDeriveTitle: "pi-harbor/session/deriveTitle",
    sessionConfigure: "pi-harbor/session/configure",
    sessionImportScan: "pi-harbor/session/importScan",
    sessionImportRun: "pi-harbor/session/importRun",
    modelConfigImportScan: "pi-harbor/modelConfig/importScan",
    modelConfigImportRun: "pi-harbor/modelConfig/importRun",
    sessionReplaceMessages: "pi-harbor/session/replaceMessages",
    sessionSaveRevision: "pi-harbor/session/saveRevision",
    sessionListRevisions: "pi-harbor/session/listRevisions",
    sessionActivateRevision: "pi-harbor/session/activateRevision",
    sessionGetScratchPath: "pi-harbor/session/getScratchPath",
    sessionOpenScratchPath: "pi-harbor/session/openScratchPath",
    projectOpenFolder: "pi-harbor/project/openFolder",
    settingsGet: "pi-harbor/settings/get",
    settingsSet: "pi-harbor/settings/set",
    configSyncGetState: "pi-harbor/configSync/getState",
    backgroundTasksList: "pi-harbor/backgroundTasks/list",
    backgroundTasksOutput: "pi-harbor/backgroundTasks/output",
    backgroundTasksStop: "pi-harbor/backgroundTasks/stop",
    configSyncConfigure: "pi-harbor/configSync/configure",
    configSyncTest: "pi-harbor/configSync/test",
    configSyncSyncNow: "pi-harbor/configSync/syncNow",
    configSyncPause: "pi-harbor/configSync/pause",
    configSyncUnlock: "pi-harbor/configSync/unlock",
    configSyncApprove: "pi-harbor/configSync/approve",
    configSyncReject: "pi-harbor/configSync/reject",
    configSyncMapProject: "pi-harbor/configSync/mapProject",
    configSyncListHistory: "pi-harbor/configSync/listHistory",
    configSyncRestore: "pi-harbor/configSync/restore",
    configSyncChangePassword: "pi-harbor/configSync/changePassword",
    configSyncDisconnect: "pi-harbor/configSync/disconnect",
    networkProxyTest: "pi-harbor/network/testProxy",
    commandShellList: "pi-harbor/commandShell/list",
    secretsSet: "pi-harbor/secrets/set",
    secretsDelete: "pi-harbor/secrets/delete",
    secretsHas: "pi-harbor/secrets/has",
    projectOpen: "pi-harbor/project/open",
    projectPickFolders: "pi-harbor/project/pickFolders",
    projectMemoryGet: "pi-harbor/project/memory/get",
    projectMemorySave: "pi-harbor/project/memory/save",
    projectGroupList: "pi-harbor/project-group/list",
    projectGroupCreateRemote: "pi-harbor/project-group/createRemote",
    projectGroupCreate: "pi-harbor/project-group/create",
    projectGroupRename: "pi-harbor/project-group/rename",
    projectGroupUpdate: "pi-harbor/project-group/update",
    projectGroupMemoryGet: "pi-harbor/project-group/memory/get",
    projectGroupMemorySave: "pi-harbor/project-group/memory/save",
    projectGroupInstructionsGet: "pi-harbor/project-group/instructions/get",
    projectGroupInstructionsSave: "pi-harbor/project-group/instructions/save",
    projectClone: "pi-harbor/project/clone",
    projectCloneCheckout: "pi-harbor/project/cloneCheckout",
    projectGet: "pi-harbor/project/get",
    projectList: "pi-harbor/project/list",
    projectSet: "pi-harbor/project/set",
    projectClear: "pi-harbor/project/clear",
    projectRemove: "pi-harbor/project/remove",
    scheduledList: "pi-harbor/scheduled/list",
    scheduledCreate: "pi-harbor/scheduled/create",
    scheduledUpdate: "pi-harbor/scheduled/update",
    scheduledDelete: "pi-harbor/scheduled/delete",
    scheduledRun: "pi-harbor/scheduled/run",
    scheduledExecute: "pi-harbor/scheduled/execute",
    scheduledListRuns: "pi-harbor/scheduled/listRuns",
    toolResolvePermission: "pi-harbor/tool/resolvePermission",
    todosGet: "pi-harbor/todos/get",
    askToolResolve: "pi-harbor/agent/askTool/resolve",
    plansPending: "pi-harbor/plans/pending",
    pendingInteractive: "pi-harbor/agent/pendingInteractive",
    plansResolve: "pi-harbor/plans/resolve",
    /**
     * List every paired remote `pi-host` this desktop knows, redacted so no
     * device token reaches the renderer. See ADR 0286 (R2b pairing UX).
     */
    remoteHostList: "pi-harbor/remoteHost/list",
    /**
     * Pair with a `pi-host` at `url` using a single-use `pairingToken`, mint
     * a device token, persist it encrypted, and open the live connection.
     */
    remoteHostPair: "pi-harbor/remoteHost/pair",
    /** Close the live connection for `hostKey` and drop its persisted record. */
    remoteHostRemove: "pi-harbor/remoteHost/remove",
    /**
     * Install and pair a `pi-host` on a machine the user reaches over SSH:
     * upload the bootstrap script, download and verify the published bundle
     * there, start the host, forward its loopback port, and exchange the
     * pairing token (spec §5.2). Uses the user's own SSH keys; no credential
     * crosses this channel.
     */
    remoteHostBootstrap: "pi-harbor/remoteHost/bootstrap",
    remoteHostReconnect: "pi-harbor/remoteHost/reconnect",
    remoteHostProjects: "pi-harbor/remoteHost/projects",
    remoteHostBrowseProjects: "pi-harbor/remoteHost/browseProjects",
    remoteHostRegisterProject: "pi-harbor/remoteHost/registerProject",
    remoteHostSessions: "pi-harbor/remoteHost/sessions",
    remoteHostCreateSession: "pi-harbor/remoteHost/createSession",
    remoteHostSyncProviders: "pi-harbor/remoteHost/syncProviders",
    providersList: "pi-harbor/providers/list",
    providersReorder: "pi-harbor/providers/reorder",
    providersCreate: "pi-harbor/providers/create",
    providersUpdate: "pi-harbor/providers/update",
    providersDelete: "pi-harbor/providers/delete",
    /**
     * Set or clear one provider's API key. Separate from `providersUpdate`
     * because a plugin-declared row refuses a generic update while still
     * needing the credential its declaration asks for.
     */
    providersSetSecret: "pi-harbor/providers/setSecret",
    providersTest: "pi-harbor/providers/testConnection",
    /**
     * Check a TypeSafe key before the Jev settings row keeps it.
     *
     * Jev is not a provider row, so `providersTest` cannot answer this: the
     * key is checked by the same System One round trip the Agent's
     * `JevClassify` tool makes, and only a key that answered is stored.
     */
    jevTest: "pi-harbor/jev/test",
    providersListModels: "pi-harbor/providers/listModels",
    /**
     * Look one model id up in the local models.dev snapshot.
     *
     * `providersListModels` cannot answer this: it describes a saved or
     * reached provider's catalogue, and a hand-typed custom id exists nowhere
     * yet when the settings picker needs its published limits. This is a
     * snapshot read — no provider network access and no host call — so the
     * picker can seed a custom row without probing an endpoint that does not
     * know the id.
     */
    providersLookupModel: "pi-harbor/providers/lookupModel",
    providersRefreshModelCatalog: "pi-harbor/providers/refreshModelCatalog",
    providersModelCatalogStatus: "pi-harbor/providers/modelCatalogStatus",
    providersOauthVendors: "pi-harbor/providers/oauth/vendors",
    providersOauthStart: "pi-harbor/providers/oauth/start",
    providersOauthRespond: "pi-harbor/providers/oauth/respond",
    providersOauthCancel: "pi-harbor/providers/oauth/cancel",
    providersOauthDelete: "pi-harbor/providers/oauth/delete",
    pluginList: "pi-harbor/plugin/list",
    /** A renderer slot component asking its own plugin for one JSON answer. */
    pluginRendererCall: "pi-harbor/plugin/rendererCall",
    /** Invoke a declared, user-facing Composer transform action. */
    pluginComposerTransform: "pi-harbor/plugin/composerTransform",
    /** Plugin-contributed agent extensions (D387/D388, ADR 0214). */
    pluginImportExtension: "pi-harbor/plugin/importExtension",
    extensionsCommandRun: "pi-harbor/extensions/commands/run",
    extensionsUiRespond: "pi-harbor/extensions/ui/respond",
    pluginLoadDev: "pi-harbor/plugin/loadDev",
    /**
     * The answer to a development plugin's permission review. Loading a folder
     * is a two-step: `pluginLoadDev` returns the declaration, and this commits
     * the permissions the user accepted.
     */
    pluginLoadDevConfirm: "pi-harbor/plugin/loadDevConfirm",
    pluginReload: "pi-harbor/plugin/reload",
    /** Commits a reviewed widening for an already-loaded development plugin. */
    pluginReloadConfirm: "pi-harbor/plugin/reloadConfirm",
    pluginCreateFromTemplate: "pi-harbor/plugin/createFromTemplate",
    pluginInstallFromPath: "pi-harbor/plugin/installFromPath",
    pluginInstallFromPackage: "pi-harbor/plugin/installFromPackage",
    pluginEnable: "pi-harbor/plugin/enable",
    pluginDisable: "pi-harbor/plugin/disable",
    pluginSetScope: "pi-harbor/plugin/setScope",
    pluginUninstall: "pi-harbor/plugin/uninstall",
    pluginSetAutoUpdate: "pi-harbor/plugin/setAutoUpdate",
    pluginSettingsGet: "pi-harbor/plugin/settings/get",
    pluginSettingsSet: "pi-harbor/plugin/settings/set",
    pluginOpenPanel: "pi-harbor/plugin/openPanel",
    pluginLauncherToggle: "pi-harbor/pluginLauncher/toggle",
    pluginLauncherDismiss: "pi-harbor/pluginLauncher/dismiss",
    pluginThemes: "pi-harbor/plugin/themes",
    pluginProviderCatalog: "pi-harbor/plugin/providerCatalog",
    pluginScenicThemesDestinations: "pi-harbor/plugin/scenicThemes/destinations",
    pluginScenicThemesSetBlur: "pi-harbor/plugin/scenicThemes/setBlur",
    pluginServices: "pi-harbor/plugin/services",
    pluginViews: "pi-harbor/plugin/views",
    pluginViewOpen: "pi-harbor/plugin/view/open",
    pluginViewClose: "pi-harbor/plugin/view/close",
    pluginViewSetBounds: "pi-harbor/plugin/view/setBounds",
    pluginViewSetVisible: "pi-harbor/plugin/view/setVisible",
    /**
     * The session the user is looking at, pushed by the renderer. The shell owns
     * the selection; the main process owns turn identity, so the plugin
     * `session:activated` snapshot is assembled from both (spec 07-plugins/03).
     */
    pluginSessionActive: "pi-harbor/plugin/session/active",
    /**
     * The shell's answer to one composer suggestion (`pi.composer.suggest`):
     * whether it went on screen and, if not, why. The main process is waiting
     * on this invoke, so a suggestion's caller learns what happened to it.
     */
    pluginComposerSuggestionResult: "pi-harbor/plugin/composer/suggestionResult",
    mcpList: "pi-harbor/mcp/list",
    mcpUpsert: "pi-harbor/mcp/upsert",
    mcpRemove: "pi-harbor/mcp/remove",
    mcpSetEnabled: "pi-harbor/mcp/setEnabled",
    mcpSetScope: "pi-harbor/mcp/setScope",
    mcpTransfer: "pi-harbor/mcp/transfer",
    mcpTest: "pi-harbor/mcp/test",
    mcpOauthStart: "pi-harbor/mcp/oauth/start",
    mcpOauthCancel: "pi-harbor/mcp/oauth/cancel",
    mcpImport: "pi-harbor/mcp/import",
    mcpImportScan: "pi-harbor/mcp/importScan",
    mcpImportRun: "pi-harbor/mcp/importRun",
    mcpMarketSearch: "pi-harbor/mcp/market/search",
    skillList: "pi-harbor/skill/list",
    skillBuiltinList: "pi-harbor/skill/builtin/list",
    skillBuiltinSetEnabled: "pi-harbor/skill/builtin/setEnabled",
    skillCreate: "pi-harbor/skill/create",
    skillImport: "pi-harbor/skill/import",
    skillImportScan: "pi-harbor/skill/importScan",
    skillImportRun: "pi-harbor/skill/importRun",
    skillMarketSearch: "pi-harbor/skill/market/search",
    skillMarketFetch: "pi-harbor/skill/market/fetch",
    skillUpdate: "pi-harbor/skill/update",
    skillRemove: "pi-harbor/skill/remove",
    skillSetEnabled: "pi-harbor/skill/setEnabled",
    skillSetScope: "pi-harbor/skill/setScope",
    skillTransfer: "pi-harbor/skill/transfer",
    skillRead: "pi-harbor/skill/read",
    skillReveal: "pi-harbor/skill/reveal",
    subagentList: "pi-harbor/subagent/list",
    subagentCatalog: "pi-harbor/subagent/catalog",
    subagentCreate: "pi-harbor/subagent/create",
    subagentUpdate: "pi-harbor/subagent/update",
    subagentRead: "pi-harbor/subagent/read",
    subagentRemove: "pi-harbor/subagent/remove",
    subagentSetEnabled: "pi-harbor/subagent/setEnabled",
    subagentSetScope: "pi-harbor/subagent/setScope",
    subagentSetBuiltinEnabled: "pi-harbor/subagent/setBuiltinEnabled",
    subagentReveal: "pi-harbor/subagent/reveal",
    marketRefresh: "pi-harbor/market/refresh",
    marketSearch: "pi-harbor/market/search",
    marketGetDetail: "pi-harbor/market/getDetail",
    marketInstall: "pi-harbor/market/install",
    marketCheckUpdates: "pi-harbor/market/checkUpdates",
    marketApplyUpdates: "pi-harbor/market/applyUpdates",
    marketCancelInstall: "pi-harbor/market/cancelInstall",
    marketReviewSummaries: "pi-harbor/market/reviewSummaries",
    marketReviewTickers: "pi-harbor/market/reviewTickers",
    marketReviews: "pi-harbor/market/reviews",
    commandPaletteSearch: "pi-harbor/commandPalette/search",
    commandPaletteExecute: "pi-harbor/commandPalette/execute",
    logOpenFolder: "pi-harbor/log/openFolder",
    devtoolsToggle: "pi-harbor/devtools/toggle",
    composerPickFiles: "pi-harbor/composer/pickFiles",
    composerPickPhotos: "pi-harbor/composer/pickPhotos",
    composerImportFiles: "pi-harbor/composer/importFiles",
    composerPasteFiles: "pi-harbor/composer/pasteFiles",
    clipboardRecordPaste: "pi-harbor/clipboard/recordPaste",
    composerCommands: "pi-harbor/composer/commands",
    workspaceDiff: "pi-harbor/workspace/diff",
    workspaceReviewRollback: "pi-harbor/workspace/review/rollback",
    workspaceReviewFileDiff: "pi-harbor/workspace/review/fileDiff",
    browserNavigate: "pi-harbor/browser/navigate",
    browserAction: "pi-harbor/browser/action",
    browserSetBounds: "pi-harbor/browser/setBounds",
    browserSetVisible: "pi-harbor/browser/setVisible",
    browserOpenExternal: "pi-harbor/browser/openExternal",
    browserGetState: "pi-harbor/browser/getState",
    browserGetPages: "pi-harbor/browser/getPages",
    fsList: "pi-harbor/fs/list",
    fsRead: "pi-harbor/fs/read",
    fsReadImageDataUrl: "pi-harbor/fs/readImageDataUrl",
    statsGetTokenUsageHistory: "pi-harbor/stats/getTokenUsageHistory",
    fsReveal: "pi-harbor/fs/reveal",
    fsOpen: "pi-harbor/fs/open",
    fsIndex: "pi-harbor/fs/index",
    fsSearch: "pi-harbor/fs/search",
    fsResolveRef: "pi-harbor/fs/resolveRef",
    windowSetWorkPanelReservation:
      "pi-harbor/window/setWorkPanelReservation",
    windowSetWorkPanelChatWidth: "pi-harbor/window/setWorkPanelChatWidth",
    windowSetBackgroundColor: "pi-harbor/window/setBackgroundColor",
    windowControl: "pi-harbor/window/control",
    closeBehaviorGet: "pi-harbor/window/closeBehavior/get",
    closeBehaviorSet: "pi-harbor/window/closeBehavior/set",
    lifecycleDialogReady: "pi-harbor/window/lifecycleDialog/ready",
    lifecycleDialogRespond: "pi-harbor/window/lifecycleDialog/respond",
    menuRendererReady: "pi-harbor/menu/rendererReady",
    traySetSessionPreferences: "pi-harbor/tray/setSessionPreferences",
    nativeMenuAction: "pi-harbor/menu/nativeAction",
    /** Browser web access settings (ADR 0342); the desktop window only. */
    webAccessGetStatus: "pi-harbor/webAccess/getStatus",
    webAccessConfigure: "pi-harbor/webAccess/configure",
    webAccessRevokeSessions: "pi-harbor/webAccess/revokeSessions",
  },
  event: {
    pluginChanged: "pi-harbor/event/pluginChanged",
    /** Progress of an install or update, while it is still running. */
    pluginInstallProgress: "pi-harbor/plugin/event/installProgress",
    /** Host-originated app settings mutation (e.g. plugin `app.setTheme`). */
    settingsChanged: "pi-harbor/app/event/settingsChanged",
    configSyncChanged: "pi-harbor/configSync/event/changed",
    /** A chat-started background task started, exited, or was stopped. */
    backgroundTasksChanged: "pi-harbor/backgroundTasks/event/changed",
    /** What a running sync is doing, while it is still running. */
    configSyncProgress: "pi-harbor/configSync/event/progress",
    extensionsUiPrompt: "pi-harbor/extensions/event/uiPrompt",
    extensionsStatus: "pi-harbor/extensions/event/status",
    pluginLauncherShown: "pi-harbor/pluginLauncher/event/shown",
    agentMessage: "pi-harbor/agent/event/message",
    agentQueueChanged: "pi-harbor/agent/event/queueChanged",
    hostStatus: "pi-harbor/app/event/hostStatus",
    toast: "pi-harbor/app/event/toast",
    /**
     * The first plaintext hop to an endpoint the user typed, sent once and only
     * until the shell records `networkPolicy.insecureNoticeAcknowledged`. The
     * shell owns the wording, because the address is not a secret and the copy
     * is localized.
     */
    insecureEndpointNotice: "pi-harbor/network/event/insecureEndpointNotice",
    browserState: "pi-harbor/browser/event/state",
    browserPreview: "pi-harbor/browser/event/preview",
    browserOpenFile: "pi-harbor/browser/event/openFile",
    /**
     * A plugin asked the shell to show one of its own work-panel views
     * (`pi.ui.revealView`). The shell owns tabs, so it — not the plugin — decides
     * which session's panel takes the view.
     */
    pluginViewReveal: "pi-harbor/plugin/view/event/reveal",
    /**
     * One composer suggestion (`pi.composer.suggest`): an offer to show a
     * plugin's line in the placeholder layer, or the shell's order to drop what
     * it shows. The shell owns the composer, so it decides and answers over
     * `pluginComposerSuggestionResult`.
     */
    pluginComposerSuggestion: "pi-harbor/plugin/composer/event/suggestion",
    windowMaximized: "pi-harbor/window/event/maximized",
    windowFullScreen: "pi-harbor/window/event/fullscreen",
    windowWorkPanelResize: "pi-harbor/window/event/workPanelResize",
    lifecycleDialogRequest: "pi-harbor/window/event/lifecycleDialogRequest",
    lifecycleDialogDismiss: "pi-harbor/window/event/lifecycleDialogDismiss",
    menuCommand: "pi-harbor/menu/event/command",
    traySessionActivated: "pi-harbor/tray/event/sessionActivated",
    notificationChanged: "pi-harbor/notification/event/changed",
    sessionsChanged: "pi-harbor/session/event/changed",
    remoteInteractions: "pi-harbor/remote/event/interactions",
    notificationActivated: "pi-harbor/notification/event/activated",
    notificationSound: "pi-harbor/notification/event/sound",
    plansChanged: "pi-harbor/plans/event/changed",
    todosChanged: "pi-harbor/todos/event/changed",
    providersOauth: "pi-harbor/providers/oauth/event",
    mcpOauth: "pi-harbor/mcp/oauth/event",
    updatesState: "pi-harbor/updates/event/state",
    voiceStateChanged: "pi-harbor/voice/event/stateChanged",
    voiceModelProgress: "pi-harbor/voice/event/modelProgress",
    liveVoiceChanged: "pi-harbor/voice/live/event/changed",
    liveVoicePort: "pi-harbor/voice/live/event/port",
    liveVoiceControl: "pi-harbor/voice/live/event/control",
    liveVoiceTranscript: "pi-harbor/voice/live/event/transcript",
    liveVoiceWidgetState: "pi-harbor/voice/live/event/widgetState",
    liveVoiceWidgetAction: "pi-harbor/voice/live/event/widgetAction",
    /** Browser web access status (ADR 0342); never forwarded to a browser. */
    webAccessChanged: "pi-harbor/webAccess/event/changed",
  },
} as const;

export const IPC_WHITELIST = new Set<string>([
  ...Object.values(IPC.invoke),
  ...Object.values(IPC.event),
]);
