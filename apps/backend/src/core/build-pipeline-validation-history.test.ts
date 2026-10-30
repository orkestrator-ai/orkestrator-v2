import { describe, expect, test } from "bun:test";
import {
  MAX_PIPELINE_VALIDATION_HISTORY,
  MAX_PIPELINE_VALIDATION_SUMMARY_TEXT_LENGTH,
  isBuildPipeline,
  type BuildPipeline,
} from "@orkestrator/protocol/build-pipeline";
import {
  newReviewValidationRun,
  type ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import {
  archiveValidationRun,
  summarizeValidationRun,
} from "./build-pipeline-validation-history.js";
import {
  cleanReview,
  pipeline,
  startInput,
  withService,
} from "./build-pipeline-service-test-support.js";

const HEAD = "c".repeat(40);

function run(id: string, overrides: Partial<ReviewValidationRun> = {}): ReviewValidationRun {
  const base = newReviewValidationRun(id, {
    headRef: HEAD,
    commands: ["test", "lint"].map((command) => ({
      id: command,
      command: `mise run ${command}`,
      cwd: ".",
      dependsOn: [],
      resources: [],
      weight: 1,
      timeoutMs: 60_000,
    })),
    limitations: [],
  });
  return {
    ...base,
    status: "completed",
    completedAt: "2026-07-29T00:01:00.000Z",
    results: base.results.map((result, index) => ({
      ...result,
      status: index === 0 ? "failed" : "passed",
      exitCode: index === 0 ? 1 : 0,
      stdoutPath: `/tmp/${result.id}.out`,
      durationMs: 1_234.6,
    })),
    ...overrides,
  };
}

describe("validation history", () => {
  test("a summary keeps each command's outcome and drops its output", () => {
    const summary = summarizeValidationRun(run("run-1"), 2, false)!;
    expect(summary).toMatchObject({ runId: "run-1", iteration: 2, status: "completed" });
    expect(summary.commands).toEqual([
      { id: "test", command: "mise run test", status: "failed", exitCode: 1, durationMs: 1235 },
      { id: "lint", command: "mise run lint", status: "passed", exitCode: 0, durationMs: 1235 },
    ]);
    expect(JSON.stringify(summary)).not.toContain("/tmp/");
    expect(summary.skipped).toBeUndefined();
  });

  test("a run stopped before it finished reads as cancelled with unfinished commands incomplete", () => {
    const stopped = run("run-1", { status: "running", completedAt: undefined });
    stopped.results[1] = { ...stopped.results[1]!, status: "running", exitCode: null };
    const summary = summarizeValidationRun(stopped, 0, true)!;
    expect(summary.status).toBe("cancelled");
    expect(summary.skipped).toBe(true);
    expect(summary.commands.map((command) => command.status)).toEqual(["failed", "incomplete"]);
  });

  test("long command lines and errors are bounded", () => {
    const long = run("run-1", {
      status: "failed",
      error: "e".repeat(MAX_PIPELINE_VALIDATION_SUMMARY_TEXT_LENGTH * 2),
    });
    long.results[0] = { ...long.results[0]!, command: "x".repeat(5_000) };
    const summary = summarizeValidationRun(long, 0, false)!;
    expect(summary.error!.length).toBe(MAX_PIPELINE_VALIDATION_SUMMARY_TEXT_LENGTH);
    expect(summary.commands[0]!.command.length).toBe(MAX_PIPELINE_VALIDATION_SUMMARY_TEXT_LENGTH);
  });

  test("archiving clears the live run and keeps only the newest summaries", () => {
    const record: Pick<
      BuildPipeline,
      "validationRun" | "validationHistory" | "iteration" | "skippedValidationRunId"
    > = { iteration: 0 };
    for (let index = 0; index < MAX_PIPELINE_VALIDATION_HISTORY + 3; index += 1) {
      record.validationRun = run(`run-${index}`);
      record.iteration = index;
      archiveValidationRun(record);
      expect(record.validationRun).toBeUndefined();
    }
    expect(record.validationHistory).toHaveLength(MAX_PIPELINE_VALIDATION_HISTORY);
    expect(record.validationHistory![0]!.runId).toBe("run-3");
    expect(record.validationHistory!.at(-1)!.runId).toBe(
      `run-${MAX_PIPELINE_VALIDATION_HISTORY + 2}`,
    );
    // Archiving the same run again replaces its entry rather than repeating it.
    archiveValidationRun(record, run(`run-${MAX_PIPELINE_VALIDATION_HISTORY + 2}`));
    expect(record.validationHistory).toHaveLength(MAX_PIPELINE_VALIDATION_HISTORY);
  });

  test("a failed verification keeps the round's validation summary for the next round", async () => {
    await withService(
      async (service, storage, provider, _invocations, controls) => {
        provider.structured = async <T>(
          sessionId: string,
          requestId: string,
        ): Promise<StructuredOutputResult<T>> => {
          const phase = provider.phases.get(sessionId);
          return {
            ok: true,
            provider: "claude",
            requestId,
            value: (phase === "review"
              ? cleanReview
              : phase === "build" || phase === "fix"
                ? {
                    headRef: controls.currentHead,
                    commands: [],
                    limitations: ["This fixture has no external validation commands."],
                  }
                : { complete: false, rationale: "A criterion still fails." }) as T,
          };
        };
        const started = await service.start(startInput({ maxIterations: 2 }));
        let snapshot = await pipeline(storage, started.id);
        for (let pass = 0; pass < 60; pass += 1) {
          if (snapshot.iteration === 1 && snapshot.validationRun) break;
          await service.advanceNow(started.id);
          snapshot = await pipeline(storage, started.id);
        }
        expect(snapshot.iteration).toBe(1);
        expect(snapshot.validationHistory).toHaveLength(1);
        expect(snapshot.validationHistory![0]).toMatchObject({
          iteration: 0,
          status: "completed",
          commands: [],
        });
        expect(snapshot.validationHistory![0]!.runId).not.toBe(snapshot.validationRun!.id);
        expect(isBuildPipeline(snapshot)).toBe(true);
      },
      { completeEmptyValidation: true },
    );
  });
});
