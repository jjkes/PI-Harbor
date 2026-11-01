/**
 * Name and branch validation for project workspaces (design §4.2).
 *
 * Pure and dependency-free so the rules can be unit-tested without a DOM:
 * the dialog maps the returned reason to a catalog key, host-core re-validates
 * authoritatively and answers with `WORKSPACE_NAME_INVALID` /
 * `WORKSPACE_BRANCH_INVALID` if these rules ever drift from it.
 */

/** Directory prefix every workspace of a project lives under. */
export const PROJECT_WORKSPACE_PREFIX = ".pi/worktree";

export const PROJECT_WORKSPACE_NAME_MAX_CHARS = 64;

/** Why a typed workspace name is not a usable single path segment. */
export type ProjectWorkspaceNameProblem =
  | "required"
  | "tooLong"
  | "separator"
  | "relative"
  | "control"
  | "leadingDot"
  | "whitespace"
  | "trailingDot"
  | "forbidden"
  | "reserved";

/** Why a typed branch name would be rejected by `git check-ref-format`. */
export type ProjectWorkspaceBranchProblem = "required" | "invalid";

/**
 * Device names Windows reserves in every directory, with or without an
 * extension. Checked case-insensitively against the part before the first dot.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/**
 * NFC is the form host-core stores and compares, and the form macOS hands back
 * from the filesystem, so the renderer normalizes before sending and before
 * measuring length.
 */
export function normalizeProjectWorkspaceName(value: string): string {
  return value.normalize("NFC");
}

/**
 * The first rule the name breaks, or `null` when it is a usable single path
 * segment. The name is not slugified: what the user types is what appears on
 * disk, so an unusable name is rejected rather than rewritten.
 *
 * The rules and their order mirror host-core's `validate_name`
 * (`crates/host-core/src/project_workspaces/mod.rs:182`) so that every name
 * the host would refuse is named inline instead of failing on submit.
 */
export function projectWorkspaceNameProblem(
  value: string,
): ProjectWorkspaceNameProblem | null {
  const name = normalizeProjectWorkspaceName(value);
  if (!name || !name.trim()) return "required";
  // Count code points, not UTF-16 units, so an emoji is one character.
  if ([...name].length > PROJECT_WORKSPACE_NAME_MAX_CHARS) return "tooLong";
  if (name.includes("/") || name.includes("\\")) return "separator";
  if (name.includes("..")) return "relative";
  // The whole Unicode Cc block, which is what `char::is_control` refuses
  // host-side; the C1 range U+0080-U+009F counts too.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return "control";
  if (name.startsWith(".")) return "leadingDot";
  if (name !== name.trim()) return "whitespace";
  // A trailing dot is dropped by the Windows filesystem, which would make the
  // directory name differ from the stored name.
  if (name.endsWith(".")) return "trailingDot";
  // `:` is the Windows stream separator, the rest cannot appear in a file name
  // there at all.
  if (/[:*?"<>|]/.test(name)) return "forbidden";
  const device = name.split(".")[0]?.toLowerCase() ?? "";
  if (WINDOWS_RESERVED_NAMES.has(device)) return "reserved";
  return null;
}

/** Project-relative folder a workspace of this name would occupy. */
export function projectWorkspacePathPreview(name: string): string {
  return `${PROJECT_WORKSPACE_PREFIX}/${normalizeProjectWorkspaceName(name)}`;
}

/**
 * `git check-ref-format --branch` in the renderer, so the dialog can refuse a
 * branch name before a round trip. Rules verified against git in design §5.
 */
export function projectWorkspaceBranchProblem(
  value: string,
): ProjectWorkspaceBranchProblem | null {
  const branch = value.normalize("NFC");
  if (!branch.trim()) return "required";
  // `--branch` additionally rejects a leading `-` and the name `HEAD`.
  if (branch.startsWith("-") || branch === "HEAD") return "invalid";
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) {
    return "invalid";
  }
  if (branch.endsWith(".") || branch.endsWith(".lock")) return "invalid";
  if (branch.includes("..") || branch.includes("@{") || branch === "@") return "invalid";
  if (/[\u0000-\u001f\u007f ~^:?*[\\]/.test(branch)) return "invalid";
  // No path component may start with a dot or end with `.lock`.
  for (const part of branch.split("/")) {
    if (!part || part.startsWith(".") || part.endsWith(".lock")) return "invalid";
  }
  return null;
}
