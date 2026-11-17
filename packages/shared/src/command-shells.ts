export const COMMAND_SHELL_IDS = [
  "windows-powershell",
  "windows-pwsh",
  "cmd",
  "git-bash",
  "bash",
] as const;

export type CommandShellId = (typeof COMMAND_SHELL_IDS)[number];

export const COMMAND_SHELL_DIALECTS = ["powershell", "cmd", "posix"] as const;
export type CommandShellDialect = (typeof COMMAND_SHELL_DIALECTS)[number];

export type CommandShellOption = {
  id: CommandShellId;
  label: string;
  dialect: CommandShellDialect;
  available: boolean;
  isDefault: boolean;
};

export type CommandShellCatalog = {
  configuredId: CommandShellId | null;
  effective: CommandShellOption | null;
  fallback: boolean;
  choices: CommandShellOption[];
};

export type CommandShellOutputStream = "stdout" | "stderr";

/** Host notification emitted while a Bash protocol tool is running. */
export type ToolsOutputParams = {
  sessionId: string;
  toolCallId: string;
  commandShellId: CommandShellId;
  stream: CommandShellOutputStream;
  chunk: string;
};

export type ToolsOutputNotification = ToolsOutputParams;

export function isCommandShellOutputStream(
  value: unknown,
): value is CommandShellOutputStream {
  return value === "stdout" || value === "stderr";
}

export function isToolsOutputParams(value: unknown): value is ToolsOutputParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  return (
    typeof output.sessionId === "string" &&
    typeof output.toolCallId === "string" &&
    isCommandShellId(output.commandShellId) &&
    isCommandShellOutputStream(output.stream) &&
    typeof output.chunk === "string"
  );
}

/**
 * One progress report for a running tool call.
 *
 * A command shell's own output names the shell and the stream it came from; a
 * plugin tool, an MCP server's `notifications/progress`, or any other runner
 * that can report progress may omit both. Progress is display-only: it never
 * becomes tool input, never reaches a provider request, and is never
 * persisted. A call's result is still exactly one `tool_end`.
 */
export type ToolProgressParams = {
  sessionId: string;
  toolCallId: string;
  chunk: string;
  stream?: CommandShellOutputStream;
  commandShellId?: CommandShellId;
};

/**
 * Whether a `tools.output` notification carries progress for any tool call.
 * `isToolsOutputParams` stays the strict command-shell shape; a consumer that
 * only ever saw Bash output can keep using it.
 */
export function isToolProgressParams(
  value: unknown,
): value is ToolProgressParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const progress = value as Record<string, unknown>;
  if (
    typeof progress.sessionId !== "string" ||
    typeof progress.toolCallId !== "string" ||
    typeof progress.chunk !== "string"
  ) {
    return false;
  }
  if (
    progress.commandShellId !== undefined &&
    !isCommandShellId(progress.commandShellId)
  ) {
    return false;
  }
  return (
    progress.stream === undefined ||
    isCommandShellOutputStream(progress.stream)
  );
}

export function isCommandShellId(value: unknown): value is CommandShellId {
  return (
    typeof value === "string" &&
    (COMMAND_SHELL_IDS as readonly string[]).includes(value)
  );
}

export function commandShellDialect(id: CommandShellId): CommandShellDialect {
  switch (id) {
    // Windows PowerShell 5.1 and PowerShell 7 share the invocation contract;
    // only the resolved executable differs.
    case "windows-powershell":
    case "windows-pwsh":
      return "powershell";
    case "cmd":
      return "cmd";
    case "git-bash":
    case "bash":
      return "posix";
  }
}

export function isCommandShellOption(value: unknown): value is CommandShellOption {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const option = value as Record<string, unknown>;
  if (
    !isCommandShellId(option.id) ||
    option.dialect !== commandShellDialect(option.id) ||
    typeof option.label !== "string" ||
    option.label.trim().length === 0 ||
    typeof option.available !== "boolean" ||
    typeof option.isDefault !== "boolean"
  ) {
    return false;
  }
  return true;
}

export function isCommandShellCatalog(value: unknown): value is CommandShellCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const catalog = value as Record<string, unknown>;
  return (
    (catalog.configuredId === null || isCommandShellId(catalog.configuredId)) &&
    (catalog.effective === null || isCommandShellOption(catalog.effective)) &&
    typeof catalog.fallback === "boolean" &&
    Array.isArray(catalog.choices) &&
    catalog.choices.every(isCommandShellOption)
  );
}

/** Defaults preserve the host's native shell on Windows and POSIX Bash elsewhere. */
export function defaultCommandShellForPlatform(platform: string): CommandShellId {
  return platform === "win32" ? "windows-powershell" : "bash";
}
