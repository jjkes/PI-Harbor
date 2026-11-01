import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WEB_ACCESS_DEFAULT_PORT,
  WEB_ACCESS_MAX_PORT,
  WEB_ACCESS_MIN_PORT,
  type WebAccessBind,
  type WebAccessTlsMode,
} from "@pi-harbor/shared";
import { isPasswordHash } from "./password";

/**
 * The owner's web access settings (ADR 0342). They live in their own file
 * under the data directory, written with owner-only permissions, because they
 * hold the password hash and must stay out of the general app settings.
 */
export type WebAccessConfig = {
  enabled: boolean;
  bind: WebAccessBind;
  port: number;
  username: string;
  /** scrypt hash from `password.ts`; empty until the owner sets a password. */
  passwordHash: string;
  tls: { mode: WebAccessTlsMode; certPath: string; keyPath: string };
};

export const DEFAULT_WEB_ACCESS_CONFIG: WebAccessConfig = {
  enabled: false,
  bind: "all",
  port: WEB_ACCESS_DEFAULT_PORT,
  username: "",
  passwordHash: "",
  tls: { mode: "self-signed", certPath: "", keyPath: "" },
};

export function defaultWebAccessConfig(): WebAccessConfig {
  return { ...DEFAULT_WEB_ACCESS_CONFIG, tls: { ...DEFAULT_WEB_ACCESS_CONFIG.tls } };
}

export function webAccessDirectory(dataDir: string): string {
  return join(dataDir, "web-access");
}

function configPath(dataDir: string): string {
  return join(webAccessDirectory(dataDir), "config.json");
}

/** A missing file is the default, disabled configuration; an unreadable one throws. */
export async function loadWebAccessConfig(dataDir: string): Promise<WebAccessConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath(dataDir), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return defaultWebAccessConfig();
    throw error;
  }
  return parseWebAccessConfig(JSON.parse(raw));
}

export async function saveWebAccessConfig(dataDir: string, config: WebAccessConfig): Promise<void> {
  await mkdir(webAccessDirectory(dataDir), { recursive: true, mode: 0o700 });
  const target = configPath(dataDir);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
}

/**
 * Coerces file contents. Anything unexpected falls back to a disabled,
 * loopback-only value so a damaged file can never widen exposure.
 */
export function parseWebAccessConfig(value: unknown): WebAccessConfig {
  if (!isRecord(value)) return { ...defaultWebAccessConfig(), bind: "loopback" };
  const tls: Record<string, unknown> = isRecord(value.tls) ? value.tls : {};
  const passwordHash =
    typeof value.passwordHash === "string" && isPasswordHash(value.passwordHash)
      ? value.passwordHash
      : "";
  const username = typeof value.username === "string" ? value.username.trim() : "";
  const port =
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port >= WEB_ACCESS_MIN_PORT &&
    value.port <= WEB_ACCESS_MAX_PORT
      ? value.port
      : WEB_ACCESS_DEFAULT_PORT;
  return {
    enabled: value.enabled === true && username.length > 0 && passwordHash.length > 0,
    bind: value.bind === "all" ? "all" : "loopback",
    port,
    username,
    passwordHash,
    tls: {
      mode: tls.mode === "custom" ? "custom" : "self-signed",
      certPath: typeof tls.certPath === "string" ? tls.certPath : "",
      keyPath: typeof tls.keyPath === "string" ? tls.keyPath : "",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
