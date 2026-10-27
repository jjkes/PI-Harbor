/**
 * Canonical location of this distribution's project. The update feed, the
 * feedback links, the remote-host artifact URLs, and the plugin catalog all
 * derive from here so a repository move has one place to change.
 */
export const PROJECT_ORIGIN = "https://gitlab.jjkets.top";
export const PROJECT_PATH = "jjkets/pi-harbor";
export const PROJECT_URL = `${PROJECT_ORIGIN}/${PROJECT_PATH}`;
export const PROJECT_ISSUES_URL = `${PROJECT_URL}/-/issues`;
export const PROJECT_NEW_ISSUE_URL = `${PROJECT_ISSUES_URL}/new`;
export const PROJECT_RELEASES_URL = `${PROJECT_URL}/-/releases`;
/** Bodies of release assets, resolved by GitLab to the newest release. */
export const PROJECT_LATEST_ASSETS_URL = `${PROJECT_RELEASES_URL}/permalink/latest/downloads`;
export const PROJECT_CATALOG_URL = `${PROJECT_URL}/-/raw/main/marketplace/catalog.json`;

/** Release asset base for one released version. */
export function projectReleaseAssetsUrl(version: string): string {
  return `${PROJECT_RELEASES_URL}/v${version}/downloads`;
}
