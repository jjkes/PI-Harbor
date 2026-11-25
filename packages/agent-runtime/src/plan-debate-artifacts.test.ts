import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanDebateParsedSynthesis } from "./plan-debate-driver.js";
import {
  PlanDebateArtifactWriter,
  parsePlanDebateRoundIndex,
  planDebateRoundDirectory,
  planDebateSessionRoundDirectory,
  removePlanDebateRound,
} from "./plan-debate-artifacts.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plan-debate-artifacts-"));
}

const INTEGRATOR_REPORT = [
  "RULINGS",
  "- conflict A | keep the public API | draft from backend",
  "UNRESOLVED_CONFLICTS",
  "- conflict B | no evidence either way",
  "EVIDENCE",
  "- backend draft | the public API is already used",
  "CONFIDENCE",
  "- public API | high | already shipped",
  "VERDICTS",
  "- adopted | keep the public API | backend",
  "- rejected | remove the public API | frontend",
  "PLAN",
  "Keep the public API and add tests.",
].join("\n");

const PARSED_SYNTHESIS: PlanDebateParsedSynthesis = {
  rulings: ["- conflict A | keep the public API | draft from backend"],
  unresolved: ["- conflict B | no evidence either way"],
  evidence: ["- backend draft | the public API is already used"],
  confidence: ["- public API | high | already shipped"],
  verdicts: [
    { verdict: "adopted", item: "keep the public API", source: "backend" },
    { verdict: "rejected", item: "remove the public API", source: "frontend" },
  ],
  plan: "Keep the public API and add tests.",
};

describe("plan-debate artifact session isolation", () => {
  it("writes same round for two sessions in the same project to different directories", async () => {
    const projectPath = await tempProject();
    try {
      const writerA = new PlanDebateArtifactWriter(projectPath, undefined, "session-a");
      const writerB = new PlanDebateArtifactWriter(projectPath, undefined, "session-b");

      await writerA.recordRoster({
        round: 1,
        requirement: "requirement A",
        roles: [{ name: "backend", brief: "api", seat: 1 }],
      });
      await writerB.recordRoster({
        round: 1,
        requirement: "requirement B",
        roles: [{ name: "frontend", brief: "ui", seat: 1 }],
      });

      await writerA.record({
        round: 1,
        requirement: "requirement A",
        phase: "draft",
        role: "backend",
        seat: 1,
        outcome: "complete",
        delegationId: "d-a-1",
        report: "draft A",
      });
      await writerB.record({
        round: 1,
        requirement: "requirement B",
        phase: "draft",
        role: "frontend",
        seat: 1,
        outcome: "complete",
        delegationId: "d-b-1",
        report: "draft B",
      });

      const dirA = planDebateSessionRoundDirectory(projectPath, "session-a", 1);
      const dirB = planDebateSessionRoundDirectory(projectPath, "session-b", 1);
      expect(dirA).not.toBe(dirB);

      const indexA = parsePlanDebateRoundIndex(await readFile(join(dirA, "round-1.json"), "utf8"), 1);
      const indexB = parsePlanDebateRoundIndex(await readFile(join(dirB, "round-1.json"), "utf8"), 1);

      expect(indexA?.sessionId).toBe("session-a");
      expect(indexA?.requirement).toBe("requirement A");
      expect(indexA?.seats[0]?.reportFile).toBe("draft-backend.md");
      expect(indexB?.sessionId).toBe("session-b");
      expect(indexB?.requirement).toBe("requirement B");
      expect(indexB?.seats[0]?.reportFile).toBe("draft-frontend.md");
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("deleting one session's round leaves the other session's round intact", async () => {
    const projectPath = await tempProject();
    try {
      const writerA = new PlanDebateArtifactWriter(projectPath, undefined, "session-a");
      const writerB = new PlanDebateArtifactWriter(projectPath, undefined, "session-b");

      await writerA.record({
        round: 2,
        requirement: "req A",
        phase: "draft",
        role: "backend",
        seat: 1,
        outcome: "complete",
        delegationId: "d-a-2",
        report: "draft A",
      });
      await writerB.record({
        round: 2,
        requirement: "req B",
        phase: "draft",
        role: "frontend",
        seat: 1,
        outcome: "complete",
        delegationId: "d-b-2",
        report: "draft B",
      });

      const result = await removePlanDebateRound(projectPath, 2, "session-a");
      expect(result.ok).toBe(true);

      const dirA = planDebateSessionRoundDirectory(projectPath, "session-a", 2);
      const dirB = planDebateSessionRoundDirectory(projectPath, "session-b", 2);
      await expect(readFile(join(dirA, "round-2.json"), "utf8")).rejects.toThrow();

      const indexB = parsePlanDebateRoundIndex(await readFile(join(dirB, "round-2.json"), "utf8"), 2);
      expect(indexB?.sessionId).toBe("session-b");
      expect(indexB?.seats[0]?.reportFile).toBe("draft-frontend.md");
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("plan-debate parsed synthesis persistence", () => {
  it("round-trips parsed synthesis on an integrator seat", async () => {
    const projectPath = await tempProject();
    try {
      const writer = new PlanDebateArtifactWriter(projectPath, undefined, "session-x");
      await writer.record({
        round: 1,
        requirement: "req",
        phase: "integrate",
        role: "integrator",
        seat: 1,
        outcome: "complete",
        delegationId: "d-int",
        report: INTEGRATOR_REPORT,
        parsedSynthesis: PARSED_SYNTHESIS,
      });

      const dir = planDebateSessionRoundDirectory(projectPath, "session-x", 1);
      const index = parsePlanDebateRoundIndex(await readFile(join(dir, "round-1.json"), "utf8"), 1);

      expect(index?.sessionId).toBe("session-x");
      expect(index?.seats).toHaveLength(1);
      expect(index?.seats[0]?.parsedSynthesis).toEqual(PARSED_SYNTHESIS);
      expect(index?.mergedFile).toBe("merged.md");
      const merged = await readFile(join(dir, "merged.md"), "utf8");
      expect(merged.trim()).toBe(INTEGRATOR_REPORT);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("preserves parsed synthesis when the same seat is rewritten without it", async () => {
    const projectPath = await tempProject();
    try {
      const writer = new PlanDebateArtifactWriter(projectPath, undefined, "session-x");
      await writer.record({
        round: 1,
        requirement: "req",
        phase: "integrate",
        role: "integrator",
        seat: 1,
        outcome: "complete",
        delegationId: "d-int",
        report: INTEGRATOR_REPORT,
        parsedSynthesis: PARSED_SYNTHESIS,
      });
      await writer.record({
        round: 1,
        requirement: "req",
        phase: "integrate",
        role: "integrator",
        seat: 1,
        outcome: "complete",
        delegationId: "d-int",
        report: "updated report",
      });

      const dir = planDebateSessionRoundDirectory(projectPath, "session-x", 1);
      const index = parsePlanDebateRoundIndex(await readFile(join(dir, "round-1.json"), "utf8"), 1);

      expect(index?.seats[0]?.parsedSynthesis).toEqual(PARSED_SYNTHESIS);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("parsePlanDebateRoundIndex compatibility", () => {
  it("reads a v1 index without sessionId or parsedSynthesis", async () => {
    const projectPath = await tempProject();
    try {
      const dir = planDebateSessionRoundDirectory(projectPath, "legacy", 1);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "round-1.json"),
        JSON.stringify({
          version: 1,
          round: 1,
          requirement: "legacy requirement",
          seats: [
            {
              phase: "draft",
              role: "backend",
              seat: 1,
              status: "complete",
              delegationId: "d1",
              reportFile: "draft-backend.md",
            },
          ],
        }),
      );

      const index = parsePlanDebateRoundIndex(await readFile(join(dir, "round-1.json"), "utf8"), 1);
      expect(index).not.toBeNull();
      expect(index?.version).toBe(2);
      expect(index?.sessionId).toBeUndefined();
      expect(index?.requirement).toBe("legacy requirement");
      expect(index?.seats[0]?.parsedSynthesis).toBeUndefined();
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("reads a v2 index with all optional fields", async () => {
    const raw = JSON.stringify({
      version: 2,
      sessionId: "session-y",
      round: 3,
      requirement: "req",
      startedAt: 1000,
      completedAt: 2000,
      stoppedAt: 2500,
      roles: [{ name: "backend", brief: "api", seat: 1 }],
      seats: [
        {
          phase: "integrate",
          role: "integrator",
          seat: 1,
          status: "complete",
          delegationId: "d1",
          startedAt: 1000,
          completedAt: 2000,
          reportFile: "integrate-integrator.md",
          parsedSynthesis: {
            rulings: ["ruling"],
            unresolved: ["unresolved"],
            evidence: ["evidence"],
            confidence: ["confidence"],
            verdicts: [{ verdict: "adopted", item: "item", source: "source" }],
            plan: "plan",
          },
        },
      ],
      mergedFile: "merged.md",
      failure: { code: "F", message: "M" },
    });

    const index = parsePlanDebateRoundIndex(raw, 3);
    expect(index?.sessionId).toBe("session-y");
    expect(index?.round).toBe(3);
    expect(index?.startedAt).toBe(1000);
    expect(index?.completedAt).toBe(2000);
    expect(index?.stoppedAt).toBe(2500);
    expect(index?.roles).toEqual([{ name: "backend", brief: "api", seat: 1 }]);
    expect(index?.seats[0]?.parsedSynthesis?.plan).toBe("plan");
    expect(index?.mergedFile).toBe("merged.md");
    expect(index?.failure).toEqual({ code: "F", message: "M" });
  });
});

describe("plan-debate cancellation barrier", () => {
  it("drops a late settlement after recordCancelled stamps the round", async () => {
    const projectPath = await tempProject();
    try {
      const writer = new PlanDebateArtifactWriter(projectPath, undefined, "session-c");

      await writer.recordRoster({
        round: 1,
        requirement: "req",
        roles: [{ name: "backend", brief: "api", seat: 1 }],
      });
      await writer.record({
        round: 1,
        requirement: "req",
        phase: "draft",
        role: "backend",
        seat: 1,
        outcome: "complete",
        delegationId: "d1",
        report: "draft",
      });

      await writer.recordCancelled(1, 1234);

      // A settlement queued after cancellation must not rewrite the round.
      await writer.record({
        round: 1,
        requirement: "req",
        phase: "draft",
        role: "backend",
        seat: 1,
        outcome: "complete",
        delegationId: "d1",
        report: "late rewrite",
      });

      const dir = planDebateSessionRoundDirectory(projectPath, "session-c", 1);
      const index = parsePlanDebateRoundIndex(await readFile(join(dir, "round-1.json"), "utf8"), 1);
      expect(index?.cancelledAt).toBe(1234);
      expect(index?.seats).toHaveLength(1);
      // The late rewrite was dropped: the report file still holds the original draft.
      expect(await readFile(join(dir, "draft-backend.md"), "utf8")).toContain("draft");
      expect(await readFile(join(dir, "draft-backend.md"), "utf8")).not.toContain("late rewrite");
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("plan-debate legacy deletion safety", () => {
  it("does not delete a legacy project-wide round when a session is provided", async () => {
    const projectPath = await tempProject();
    try {
      const legacyDir = planDebateRoundDirectory(projectPath, 7);
      await mkdir(legacyDir, { recursive: true });
      await writeFile(
        join(legacyDir, "round-7.json"),
        JSON.stringify({ version: 1, round: 7, requirement: "legacy", seats: [] }),
        "utf8",
      );

      const result = await removePlanDebateRound(projectPath, 7, "session-a");
      expect(result.ok).toBe(true);

      // Legacy project-wide directory must survive session-scoped deletion.
      const legacyIndex = parsePlanDebateRoundIndex(
        await readFile(join(legacyDir, "round-7.json"), "utf8"),
        7,
      );
      expect(legacyIndex?.requirement).toBe("legacy");
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});
