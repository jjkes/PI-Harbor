import { PROJECT_NEW_ISSUE_URL, PROJECT_ORIGIN, PROJECT_PATH } from "./project-urls.js";

export type FeedbackIssueContext = {
  version: string;
  platform: string;
  arch: string;
  protocolVersion: number;
  hostVersion?: string;
};

export type FeedbackOsLabel = "macOS" | "Windows" | "Linux" | "Other";

export function osLabelForFeedback(platform: string): FeedbackOsLabel {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return "Other";
  }
}

export function formatFeedbackEnvironment(info: FeedbackIssueContext): string {
  const host = info.hostVersion?.trim() || "unknown";
  return `PI-Harbor Desktop ${info.version} · ${info.platform} ${info.arch} · protocol ${info.protocolVersion} · host ${host}`;
}

/**
 * GitLab takes the issue body from the link itself rather than from a template
 * file, so the environment block travels in `issue[description]`.
 */
export function buildBugReportUrl(info: FeedbackIssueContext): string {
  const url = new URL(PROJECT_NEW_ISSUE_URL);
  url.searchParams.set(
    "issue[title]",
    `Bug: PI-Harbor Desktop ${info.version} (${osLabelForFeedback(info.platform)})`,
  );
  url.searchParams.set(
    "issue[description]",
    `### Environment\n\n${formatFeedbackEnvironment(info)}\n\n### What happened\n\n\n### Expected\n`,
  );
  return url.toString();
}

export function assertFeedbackIssueUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid feedback URL");
  }
  if (parsed.origin !== PROJECT_ORIGIN) {
    throw new Error("invalid feedback URL origin");
  }
  if (parsed.pathname !== `/${PROJECT_PATH}/-/issues/new`) {
    throw new Error("invalid feedback URL path");
  }
  if (!parsed.searchParams.get("issue[title]")) {
    throw new Error("invalid feedback URL title");
  }
  if (!parsed.searchParams.get("issue[description]")) {
    throw new Error("invalid feedback URL description");
  }
}
