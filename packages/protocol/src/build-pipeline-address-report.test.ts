import { describe, expect, test } from "bun:test";
import {
  PIPELINE_FIX_RESULT_LIMITS,
  boundPipelineFixResult,
  isPipelineFixResult,
  type PipelineFixResult,
} from "./build-pipeline-address-report.js";
import { isBuildPipeline, type BuildPipeline, type PipelineSession } from "./build-pipeline.js";

const result: PipelineFixResult = {
  complete: true,
  summary: "Fixed the inverted branch.",
  filesChanged: ["src/app.ts"],
  commandsRun: [{ command: "bun test src/app.test.ts", result: "passed", summary: "Passes." }],
  notes: [],
  limitations: [],
};

function pipelineWith(session: Partial<PipelineSession>): BuildPipeline {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "environment-1",
    environmentType: "local",
    agentType: "claude",
    phase: "addressing",
    sessions: [
      {
        phase: "address",
        iteration: 0,
        sessionKey: "address-1",
        sdkSessionId: "sdk-address-1",
        status: "idle",
        startedAt: "2026-10-29T00:00:00.000Z",
        label: "Address Issues Session",
        ...session,
      } as PipelineSession,
    ],
    currentSessionIndex: 0,
    iteration: 0,
    maxIterations: 3,
    createdAt: "2026-10-29T00:00:00.000Z",
    taskTitle: "Task",
    taskSnapshot: {
      title: "Task",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 1,
    controller: "backend",
  };
}

describe("bounded Address fix result", () => {
  test("a small result is kept as it is", () => {
    const bounded = boundPipelineFixResult(result);
    expect(bounded).toEqual(result);
    expect(isPipelineFixResult(bounded)).toBe(true);
  });

  test("long strings and lists are cut to the bounds and counted", () => {
    const limits = PIPELINE_FIX_RESULT_LIMITS;
    const bounded = boundPipelineFixResult({
      complete: false,
      summary: "s".repeat(limits.summaryLength + 10),
      filesChanged: Array.from({ length: limits.filesChanged + 3 }, (_, index) =>
        `src/${index}.ts`.padEnd(limits.pathLength + 5, "x"),
      ),
      commandsRun: [
        ...Array.from({ length: limits.commandsRun }, (_, index) => ({
          command: `passing ${index}`,
          result: "passed" as const,
          summary: "Passes.",
        })),
        { command: "failing", result: "failed" as const, summary: "f".repeat(2_000) },
      ],
      notes: Array.from({ length: limits.notes + 1 }, () => "n".repeat(limits.entryLength + 1)),
      limitations: ["Lint fails on origin/main too."],
    });
    expect(isPipelineFixResult(bounded)).toBe(true);
    expect(bounded.summary).toHaveLength(limits.summaryLength);
    expect(bounded.summary.endsWith("…")).toBe(true);
    expect(bounded.filesChanged).toHaveLength(limits.filesChanged);
    expect(bounded.filesChanged[0]).toHaveLength(limits.pathLength);
    // A failed check outranks a passing one when the list is cut, and the
    // kept entries stay in the order the stage reported them.
    expect(bounded.commandsRun).toHaveLength(limits.commandsRun);
    expect(bounded.commandsRun.at(-1)).toMatchObject({ command: "failing", result: "failed" });
    expect(bounded.commandsRun.at(-1)!.summary).toHaveLength(limits.commandSummaryLength);
    expect(bounded.commandsRun[0]!.command).toBe("passing 0");
    expect(bounded.notes).toHaveLength(limits.notes);
    expect(bounded.limitations).toEqual(["Lint fails on origin/main too."]);
    expect(bounded.omitted).toEqual({ filesChanged: 3, commandsRun: 1, notes: 1 });
  });

  test("rejects values outside the stored shape", () => {
    for (const invalid of [
      null,
      { ...result, complete: "yes" },
      { ...result, summary: "s".repeat(PIPELINE_FIX_RESULT_LIMITS.summaryLength + 1) },
      { ...result, commandsRun: [{ command: "x", result: "skipped", summary: "" }] },
      { ...result, notes: [1] },
      { ...result, extra: true },
      { ...result, omitted: { notes: 0 } },
      { ...result, omitted: { other: 1 } },
    ]) {
      expect(isPipelineFixResult(invalid)).toBe(false);
    }
  });
});

describe("Address session report fields", () => {
  test("records without the marker stay valid", () => {
    expect(isBuildPipeline(pipelineWith({}))).toBe(true);
  });

  test("an Address session carries the marker and its accepted result", () => {
    expect(isBuildPipeline(pipelineWith({ addressReportKind: "fix-result" }))).toBe(true);
    expect(
      isBuildPipeline(pipelineWith({ addressReportKind: "fix-result", fixResult: result })),
    ).toBe(true);
  });

  test("rejects the fields on another phase, without the marker, or malformed", () => {
    expect(
      isBuildPipeline(pipelineWith({ phase: "verify", addressReportKind: "fix-result" })),
    ).toBe(false);
    expect(isBuildPipeline(pipelineWith({ fixResult: result }))).toBe(false);
    expect(isBuildPipeline(pipelineWith({ addressReportKind: "text" as never }))).toBe(false);
    expect(
      isBuildPipeline(
        pipelineWith({
          addressReportKind: "fix-result",
          fixResult: { ...result, summary: 1 } as never,
        }),
      ),
    ).toBe(false);
  });
});
