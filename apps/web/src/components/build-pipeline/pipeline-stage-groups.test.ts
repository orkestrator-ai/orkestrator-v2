import { describe, expect, test } from "bun:test";
import {
  REVIEW_PACKAGE_SESSION_LABEL,
  pipelineIndependentReviewLabel,
} from "@orkestrator/protocol/build-pipeline";
import type { BuildPipeline, PipelineSession } from "@/stores/buildPipelineStore";
import {
  formatStageSpan,
  pipelineStageGroups,
  pipelineStageItems,
  stageGroupKeyByItemId,
  type ValidationRun,
} from "./pipeline-stage-groups";

const CREATED = "2026-07-29T00:00:00.000Z";

/** A session starting `startSeconds` after the pipeline was created. */
function session(
  phase: PipelineSession["phase"],
  key: string,
  startSeconds: number,
  overrides: Partial<PipelineSession> = {},
): PipelineSession {
  const startedAt = new Date(Date.parse(CREATED) + startSeconds * 1_000).toISOString();
  return {
    phase,
    iteration: 0,
    sessionKey: key,
    sdkSessionId: `${key}-session`,
    status: "idle",
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + 50_000).toISOString(),
    label: `${key} label`,
    ...overrides,
  };
}

function build(overrides: Partial<BuildPipeline>): BuildPipeline {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "env-1",
    environmentType: "local",
    agentType: "codex",
    phase: "building",
    sessions: [],
    currentSessionIndex: 0,
    iteration: 0,
    maxIterations: 3,
    createdAt: CREATED,
    taskTitle: "Grouped",
    taskSnapshot: {
      title: "Grouped",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 1,
    controller: "backend",
    ...overrides,
  };
}

function validationRun(overrides: Partial<ValidationRun> = {}): ValidationRun {
  const command = {
    id: "test",
    command: "mise run test",
    cwd: ".",
    dependsOn: [] as string[],
    resources: ["turbo"],
    weight: 2 as const,
    timeoutMs: 1_200_000,
  };
  return {
    id: "validation-1",
    status: "completed",
    startedAt: "2026-07-29T00:03:00.000Z",
    completedAt: "2026-07-29T00:03:30.000Z",
    plan: {
      headRef: "a".repeat(40),
      commands: [command, { ...command, id: "lint" }],
      limitations: [],
    },
    results: ["test", "lint"].map((id) => ({
      id,
      command: "mise run test",
      status: "passed" as const,
      exitCode: 0,
      stdoutPath: ".orkestrator/test.stdout",
      stderrPath: ".orkestrator/test.stderr",
      stdoutBytes: 24,
      stderrBytes: 0,
      durationMs: 3_000,
      limitation: null,
    })),
    ...overrides,
  };
}

function shape(pipeline: BuildPipeline) {
  return pipelineStageGroups(pipeline).groups.map((group) => ({
    name: group.name,
    status: group.status,
    items: group.items.map((item) => item.key),
  }));
}

describe("pipelineStageGroups", () => {
  test("shows only a running Setup phase before the first session exists", () => {
    const timeline = pipelineStageGroups(build({ phase: "creating-environment" }));

    expect(shape(build({ phase: "creating-environment" }))).toEqual([
      { name: "Setup", status: "running", items: [] },
    ]);
    expect(timeline.groups[0]!.current).toBe(true);
    expect(timeline.upcoming.map((group) => [group.name, group.conditional])).toEqual([
      ["Build", false],
      ["Review", false],
      ["Address", true],
      ["Verify", false],
      ["Ship", false],
    ]);
    // Address is skipped after a clean review, so it is not counted as a phase to come.
    expect([timeline.phasesReached, timeline.phaseTotal]).toEqual([1, 5]);
    expect(timeline.running).toBe(true);
  });

  test("groups a single-review pipeline by phase and closes Setup at the first session", () => {
    const pipeline = build({
      phase: "creating-pr",
      sessions: [
        session("build", "build", 60),
        session("review", "review", 120, { label: "Review Session" }),
        session("address", "address", 180),
        session("verify", "verify", 240),
        session("pr", "pr", 300, { status: "running", completedAt: undefined }),
      ],
      currentSessionIndex: 4,
      verificationResult: "pass",
    });
    const timeline = pipelineStageGroups(pipeline, undefined, {
      reportIssueCount: (candidate) => (candidate.sessionKey === "review" ? 3 : undefined),
    });

    expect(shape(pipeline)).toEqual([
      { name: "Setup", status: "done", items: [] },
      { name: "Build", status: "done", items: ["build"] },
      { name: "Review", status: "done", items: ["review"] },
      { name: "Address", status: "done", items: ["address"] },
      { name: "Verify", status: "done", items: ["verify"] },
      { name: "Ship", status: "running", items: ["pr"] },
    ]);
    const [setup, , review, address, verify, ship] = timeline.groups;
    expect(formatStageSpan(setup!.startMs, setup!.endMs, false, 0)).toBe("1m 0s");
    expect(review!.issueCount).toBe(3);
    expect(address!.summary).toBe("Addressed 3 issues");
    expect(verify!.summary).toBe("Verdict: passed");
    expect(ship!.current).toBe(true);
    expect(ship!.endMs).toBeUndefined();
    expect(ship!.pending.map((pending) => pending.label)).toEqual(["Conflict check", "Complete"]);
    expect(timeline.upcoming).toEqual([]);
    expect([timeline.phasesReached, timeline.phaseTotal]).toEqual([6, 6]);
  });

  test("folds package preparation and Tests into Build, and fan-out reviewers into Review", () => {
    const pipeline = build({
      phase: "reviewing",
      reviewers: [{ agent: "codex" }, { agent: "claude" }],
      sessions: [
        session("build", "build", 60, { label: "Build Session" }),
        // The backend runs package preparation as a fix-phase turn.
        session("fix", "package", 120, { label: REVIEW_PACKAGE_SESSION_LABEL }),
        session("review", "review-a", 240, { label: pipelineIndependentReviewLabel(0) }),
        session("review", "review-b", 240, { label: pipelineIndependentReviewLabel(1) }),
        session("review", "consolidation", 360, {
          label: "Consolidation",
          status: "running",
          completedAt: undefined,
        }),
      ],
      currentSessionIndex: 4,
      validationRun: validationRun(),
    });
    const timeline = pipelineStageGroups(pipeline);

    expect(shape(pipeline)).toEqual([
      { name: "Setup", status: "done", items: [] },
      {
        name: "Build",
        status: "done",
        items: ["build", "package", "validation-validation-1"],
      },
      { name: "Review", status: "running", items: ["review-a", "review-b", "consolidation"] },
    ]);
    expect(timeline.groups[1]!.summary).toBe("Build · Package prep · Tests 2/2 passed");
    expect(timeline.groups[2]!.summary).toBe("2 reviewers · consolidated");
    expect(timeline.groups[2]!.pending).toEqual([]);
    expect(stageGroupKeyByItemId(timeline).get("validation:validation-1")).toBe("build-1");
  });

  test("gives a fix loop's second pass its own groups rather than merging iterations", () => {
    const pipeline = build({
      phase: "reviewing",
      iteration: 1,
      sessions: [
        session("build", "build", 60),
        session("review", "review", 120, { label: "Review Session" }),
        session("verify", "verify", 180),
        session("fix", "fix", 240, { iteration: 1 }),
        session("review", "review-2", 300, {
          iteration: 1,
          label: "Review Session",
          status: "running",
          completedAt: undefined,
        }),
      ],
      currentSessionIndex: 4,
      verificationResult: "fail",
    });
    const timeline = pipelineStageGroups(pipeline);

    expect(timeline.groups.map((group) => group.name)).toEqual([
      "Setup",
      "Build",
      "Review",
      "Verify",
      "Fix · 2",
      "Review · 2",
    ]);
    expect(timeline.groups.map((group) => group.key)).toEqual([
      "setup",
      "build-1",
      "review-1",
      "verify-1",
      "fix-2",
      "review-2",
    ]);
    expect(timeline.groups[3]!.summary).toBe("Verdict: failed");
    expect(timeline.groups[5]!.current).toBe(true);
    expect(timeline.upcoming.map((group) => group.name)).toEqual([
      "Address · 2",
      "Verify · 2",
      "Ship",
    ]);
  });

  test("places Tests without a preparation session before the first review", () => {
    const pipeline = build({
      phase: "reviewing",
      sessions: [
        session("build", "build", 60),
        session("review", "review", 120, { status: "running", completedAt: undefined }),
      ],
      currentSessionIndex: 1,
      validationRun: validationRun({ status: "running", completedAt: undefined, results: [] }),
    });
    const timeline = pipelineStageGroups(pipeline);

    expect(pipelineStageItems(pipeline).map((item) => item.key)).toEqual([
      "build",
      "validation-validation-1",
      "review",
    ]);
    // A running member keeps its group running even when the pipeline has moved on.
    expect(timeline.groups[1]!.status).toBe("running");
    expect(timeline.groups[1]!.summary).toBe("build label · Tests running");
  });

  test("falls back to the next group's start when an old snapshot has no end time", () => {
    const pipeline = build({
      phase: "verifying",
      sessions: [
        session("build", "build", 60, { completedAt: undefined }),
        session("verify", "verify", 200, { status: "running", completedAt: undefined }),
      ],
      currentSessionIndex: 1,
    });
    const [, buildGroup, verifyGroup] = pipelineStageGroups(pipeline).groups;

    expect(formatStageSpan(buildGroup!.startMs, buildGroup!.endMs, false, 0)).toBe("2m 20s");
    // Running groups count up to `now`.
    const now = Date.parse(CREATED) + 230_000;
    expect(formatStageSpan(verifyGroup!.startMs, verifyGroup!.endMs, true, now)).toBe("30s");
  });

  test("shows nothing rather than a guess when the last settled group has no end", () => {
    const pipeline = build({
      phase: "complete",
      sessions: [session("build", "build", 60, { completedAt: undefined })],
    });
    const timeline = pipelineStageGroups(pipeline);

    expect(timeline.groups[1]!.endMs).toBeUndefined();
    expect(formatStageSpan(timeline.groups[1]!.startMs, undefined, false, 0)).toBeNull();
    expect(timeline.groups.some((group) => group.current)).toBe(false);
  });

  test("marks the group a failed pipeline stopped in and stops predicting what follows", () => {
    const pipeline = build({
      phase: "failed",
      error: "Verification crashed",
      sessions: [
        session("build", "build", 60),
        session("verify", "verify", 120, { status: "error" }),
      ],
      currentSessionIndex: 1,
      verificationResult: undefined,
    });
    const timeline = pipelineStageGroups(pipeline);

    expect(shape(pipeline).map((group) => group.status)).toEqual(["done", "done", "error"]);
    expect(timeline.upcoming).toEqual([]);
    expect(timeline.running).toBe(false);
    expect(formatStageSpan(timeline.startMs, timeline.endMs, false, 0)).toBe("2m 50s");
  });

  test("shows a failed Tests run as an error in its Build group summary", () => {
    const run = validationRun();
    const pipeline = build({
      phase: "paused",
      pausedFromPhase: "building",
      sessions: [session("build", "build", 60, { producedReviewPackagePlan: true })],
      validationRun: {
        ...run,
        results: [{ ...run.results[0]!, status: "failed", exitCode: 1 }, run.results[1]!],
      },
    });
    const [, buildGroup] = pipelineStageGroups(pipeline).groups;

    expect(buildGroup!.status).toBe("paused");
    expect(buildGroup!.summary).toBe("build label · Tests: 1 of 2 checks failed");
  });
});
