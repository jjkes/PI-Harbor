import { describe, expect, it } from "vitest";
import {
  assertFeedbackIssueUrl,
  buildBugReportUrl,
  formatFeedbackEnvironment,
  osLabelForFeedback,
} from "./feedback.js";
import { PROJECT_ORIGIN, PROJECT_PATH } from "./project-urls.js";

const sample = {
  version: "0.21.0",
  platform: "darwin",
  arch: "arm64",
  protocolVersion: 11,
  hostVersion: "0.21.0",
};

describe("GitLab feedback issue URL", () => {
  it("maps Electron platforms onto the issue OS labels", () => {
    expect(osLabelForFeedback("darwin")).toBe("macOS");
    expect(osLabelForFeedback("win32")).toBe("Windows");
    expect(osLabelForFeedback("linux")).toBe("Linux");
    expect(osLabelForFeedback("freebsd")).toBe("Other");
  });

  it("builds an issue URL that pre-fills the title and the environment block", () => {
    const url = new URL(buildBugReportUrl(sample));
    expect(url.origin).toBe(PROJECT_ORIGIN);
    expect(url.pathname).toBe(`/${PROJECT_PATH}/-/issues/new`);
    expect(url.searchParams.get("issue[title]")).toBe(
      "Bug: PI-Harbor Desktop 0.21.0 (macOS)",
    );
    expect(url.searchParams.get("issue[description]")).toContain(
      "PI-Harbor Desktop 0.21.0 · darwin arm64 · protocol 11 · host 0.21.0",
    );
  });

  it("treats a missing host version as unknown", () => {
    expect(
      formatFeedbackEnvironment({ ...sample, hostVersion: "  " }),
    ).toContain("host unknown");
  });

  it("rejects URLs that leave the allowlisted issue form", () => {
    expect(() => assertFeedbackIssueUrl(buildBugReportUrl(sample))).not.toThrow();
    expect(() =>
      assertFeedbackIssueUrl("https://evil.example/-/issues/new"),
    ).toThrow(/origin/);
    expect(() =>
      assertFeedbackIssueUrl("https://gitlab.jjkets.top/jjkets/pi-harbor/-/issues"),
    ).toThrow(/path/);
    expect(() =>
      assertFeedbackIssueUrl(
        `https://gitlab.jjkets.top/jjkets/pi-harbor/-/issues/new?issue[title]=x`,
      ),
    ).toThrow(/description/);
  });
});
