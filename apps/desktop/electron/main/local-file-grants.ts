import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { FsChatRefMatch } from "@pi-harbor/shared";

/**
 * Local files the user opened from a reference the conversation named.
 *
 * An agent writes wherever its task takes it: a draft in `/tmp`, a report in a
 * sibling checkout, a log outside the project. Completion refuses to guess a
 * path no allowed root contains, but once the user acts on that reference the
 * app should simply show the file — `fs/read`, `fs/open` and `fs/reveal` must
 * accept the exact file it names instead of reporting an access limit the user
 * cannot satisfy.
 *
 * A grant is deliberately not a wider root. It names one canonical path the
 * user acted on, it is bounded and recency-ordered, and it refuses a reference
 * that does not name an existing regular file. Because the grant is keyed by
 * the canonical path, it stops applying the moment that spelling resolves to a
 * different file — a replaced symlink, a swapped mount — so nothing outside
 * the confirmed file is ever reachable through it.
 *
 * Only the user-driven completion path asks for a grant; verifying a reference
 * while rendering a transcript confirms the same file without granting it, so
 * reading a message never widens what the renderer may open.
 */

/** Kept small: these are files a user clicked, not a browse history. */
const MAX_GRANTS = 256;

/** Insertion order is also recency, so the oldest grant is the one evicted. */
const granted = new Set<string>();

function normalise(raw: string): string | null {
  const value = String(raw ?? "").trim();
  if (!value || value.startsWith("~")) return null;
  // A path the OS would truncate at a control character is never the one the
  // user saw, so it cannot be confirmed or re-checked honestly.
  if (/[\u0000-\u001f]/.test(value)) return null;
  return isAbsolute(value) ? value : null;
}

async function canonicalFile(raw: string): Promise<{ realPath: string } | null> {
  const value = normalise(raw);
  if (!value) return null;
  const realPath = await realpath(value).catch(() => null);
  if (!realPath) return null;
  const info = await stat(realPath).catch(() => null);
  return info?.isFile() ? { realPath } : null;
}

/**
 * Confirm one reference as an existing local regular file without granting it.
 *
 * Completion reports this shape so a rendered reference still becomes a link;
 * the grant is what a click adds.
 */
export async function confirmLocalFile(
  raw: string,
): Promise<{ realPath: string; absolutePath: string } | null> {
  const confirmed = await canonicalFile(raw);
  return confirmed ? { ...confirmed, absolutePath: String(raw).trim() } : null;
}

/** Confirm one local file the user is opening and unlock it for this run. */
export async function grantLocalFile(
  raw: string,
): Promise<{ realPath: string; absolutePath: string } | null> {
  const confirmed = await confirmLocalFile(raw);
  if (!confirmed) return null;
  granted.delete(confirmed.realPath);
  granted.add(confirmed.realPath);
  while (granted.size > MAX_GRANTS) {
    const oldest = granted.values().next().value;
    if (oldest === undefined) break;
    granted.delete(oldest);
  }
  return confirmed;
}

/**
 * The canonical file a granted reference still names, or null.
 *
 * Null covers every reason the request must stay refused — relative input, a
 * missing file, a path that now resolves somewhere else, or a file the user
 * never opened.
 */
export async function grantedLocalFile(raw: string): Promise<string | null> {
  if (granted.size === 0) return null;
  const confirmed = await canonicalFile(raw);
  return confirmed && granted.has(confirmed.realPath) ? confirmed.realPath : null;
}

/** Test seam: a fresh process starts with nothing granted. */
export function clearLocalFileGrants(): void {
  granted.clear();
}

/**
 * The match a reference outside every allowed root completes to, or null.
 *
 * `open` is the difference between the two answers this app needs: the
 * transcript paints a rendered reference as a link because completion reported
 * it, and only the click that follows unlocks the file for `fs/read`,
 * `fs/open`, and `fs/reveal`.
 */
export async function localChatRefMatch(
  raw: string,
  open: boolean,
): Promise<FsChatRefMatch | null> {
  const local = open ? await grantLocalFile(raw) : await confirmLocalFile(raw);
  if (!local) return null;
  return {
    root: "local",
    relativePath: local.absolutePath,
    absolutePath: local.absolutePath,
    matchedBy: "exact-absolute",
  };
}
