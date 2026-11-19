import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { APP_NAME } from "@pi-harbor/shared";

/**
 * The two directories that define an installation, and the development split
 * between them.
 *
 * A packaged PI-Harbor Desktop and a `pnpm dev` host used to share both: the
 * name-derived `userData` — where Electron keeps the single-instance lock,
 * renderer `localStorage`, and the plugin panel partitions — and
 * `~/.pi-harbor`, where host-core keeps `pi.sqlite` beside the persistence
 * outbox and the log tree. Sharing them meant a shipped app that was already
 * running held the lock, so the development launch quit on arrival; a
 * development host that won the race instead put a second host-core over the
 * same single-writer database, which is the divergence D236 exists to
 * prevent. Neither is workable while someone debugs against the app they use.
 *
 * Only the development side moves, and only these two names differ. A shipped
 * installation keeps `PI-Harbor Desktop` and `~/.pi-harbor`, so no upgrade relocates
 * a user's database, secrets, plugins, or renderer-local state, and
 * `PI_HARBOR_DATA_DIR` still overrides either profile outright.
 *
 * Every name here is also distinct from upstream PI-Desktop's `PI-Desktop`,
 * `~/.pi-desktop`, and `~/.pi-desktop-dev`. This fork and an installed
 * upstream build therefore never share a `userData` tree, a single-instance
 * lock, or a host-core database, so neither one can read, migrate, or corrupt
 * the other's profile.
 */

/** `userData` directory of a development installation, beside the shipped one. */
export const DEVELOPMENT_INSTALLATION_NAME = `${APP_NAME} Dev`;

/** Data directory of a shipped installation, below the user's home. */
export const INSTALLATION_DATA_DIR_NAME = ".pi-harbor";

/** Data directory of a development installation, below the user's home. */
export const DEVELOPMENT_DATA_DIR_NAME = ".pi-harbor-dev";

export type DataDirInput = {
  /** `PI_HARBOR_DATA_DIR`; an explicit directory wins over either profile. */
  override: string | undefined;
  /** True for a development build. */
  development: boolean;
  /** The user's home directory. */
  home: string;
};

/** The shipped installation's data directory, the one a development build must never open. */
export function shippedDataDir(home: string): string {
  return resolve(join(home, INSTALLATION_DATA_DIR_NAME));
}

/**
 * The explicit directory this build may actually use, if any.
 *
 * `PI_HARBOR_DATA_DIR` stays the escape hatch it always was: an explicit
 * directory wins, which is how the E2E harnesses, the capture rig, and
 * side-by-side profiles keep choosing their own root. The shipped profile is
 * the one value a development build refuses. That variable is inherited far
 * more often than it is chosen — a `pnpm dev` started from a shell that
 * exported the installed app's root, a launcher that copies its environment —
 * and honoring it puts a second host-core over the user's real database, which
 * is the divergence the profile split exists to prevent. A refused override is
 * absent, not an error: the development profile then owns the directory, the
 * same way it does when nothing was set.
 */
export function honoredDataDirOverride({
  override,
  development,
  home,
}: DataDirInput): string | undefined {
  const explicit = override?.trim();
  if (!explicit) return undefined;
  const resolved = resolve(explicit);
  if (!development) return resolved;
  return resolved === shippedDataDir(home) ? undefined : resolved;
}

/**
 * The data directory one installation owns.
 *
 * The result is absolute, because it reaches host-core as a child-process
 * environment variable from a working directory that need not be this one, and
 * because `homedir()` is the only other input that could be relative. Without
 * an honored override the profile picks the name, and that name is the whole
 * difference between the two installations.
 */
export function resolveDataDir(input: DataDirInput): string {
  const explicit = honoredDataDirOverride(input);
  if (explicit) return explicit;
  return resolve(
    join(
      input.home,
      input.development ? DEVELOPMENT_DATA_DIR_NAME : INSTALLATION_DATA_DIR_NAME,
    ),
  );
}

/**
 * The data directory this process owns.
 *
 * Electron main passes its own verdict for `development`, because only it can
 * ask `app.isPackaged`, and it publishes the resolved directory back to
 * `PI_HARBOR_DATA_DIR` at boot. That publication is what keeps the plugin
 * runtime — which resolves this root from the environment rather than taking
 * it as a parameter — on one directory instead of falling back to the shipped
 * default, which would strand a development host's plugin data inside the
 * packaged profile.
 */
export function desktopDataDir(
  development: boolean = process.env.PI_HARBOR_DEV === "1",
): string {
  return resolveDataDir({
    override: process.env.PI_HARBOR_DATA_DIR,
    development,
    home: homedir(),
  });
}

/** The Electron `app` surface this helper needs; kept structural so tests need no Electron. */
export type UserDataApp = {
  commandLine: { hasSwitch(name: string): boolean };
  getPath(name: "appData"): string;
  setPath(name: "userData", path: string): void;
};

/**
 * Give a development build its own `userData` so the single-instance lock
 * does not collide with a shipped app that is already running (D236, ADR 0094).
 * An explicit `--user-data-dir` wins, because that is how the E2E harnesses
 * point a build at a throwaway profile.
 */
export function applyDevelopmentUserData(
  app: UserDataApp,
  development: boolean,
): void {
  if (development && !app.commandLine.hasSwitch("user-data-dir")) {
    app.setPath(
      "userData",
      join(app.getPath("appData"), DEVELOPMENT_INSTALLATION_NAME),
    );
  }
}
