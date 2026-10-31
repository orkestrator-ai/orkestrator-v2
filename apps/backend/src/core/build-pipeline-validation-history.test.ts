import { describe, expect, test } from "bun:test";
import {
  MAX_PIPELINE_VALIDATION_HISTORY,
  MAX_PIPELINE_VALIDATION_SUMMARY_TEXT_LENGTH,
  isBuildPipeline,
  type BuildPipeline,
} from "@orkestrator/protocol/build-pipeline";
import {
  newReviewValidationRun,
  isPersistedReviewPackage,
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
  mutateStored,
  startBuilding,
  startInput,
  withService,
} from "./build-pipeline-service-test-support.js";

import { testGeneratedReviewPackage } from "./build-pipeline-test-fixtures.js";

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

  for (const status of ["planned", "running"] as const) {
    test.each([true, false])(
      `re-preparation archives ${status} validation (valid cancellation: %s)`,
      async (valid) => {
        const original = run("old-run", { status, completedAt: undefined });
        original.results = original.results.map((result) => ({ ...result, durationMs: 1235 }));
        original.results[0] = { ...original.results[0]!, status: "running", exitCode: null };
        const cancelled = {
          ...original,
          status: "cancelled" as const,
          error: "Cancellation snapshot adopted",
          completedAt: "2026-07-29T00:02:00.000Z",
          results: original.results.map((result) => ({
            ...result,
            status: "passed" as const,
            exitCode: 0,
          })),
        };
        await withService(
          async (service, storage, _provider, invocations) => {
            const { started } = await startBuilding(service, storage);
            await mutateStored(storage, started.id, (snapshot) => {
              snapshot.validationRun = original;
            });
            const snapshot = await service.retryReview(started.id);
            expect(
              invocations.filter((entry) => entry.command === "cancel_review_validation"),
            ).toEqual([
              {
                command: "cancel_review_validation",
                args: { environmentId: "env-1", run: original },
              },
            ]);
            expect(snapshot.validationRun).toBeUndefined();
            expect(snapshot.sessions.at(-1)?.label).toBe("Package Preparation Session");
            expect(snapshot.validationHistory).toEqual([
              summarizeValidationRun(valid ? cancelled : original, 0, false)!,
            ]);
            expect(snapshot.validationHistory![0]!.commands[0]!.status).toBe(
              valid ? "passed" : "incomplete",
            );
            expect(isBuildPipeline(snapshot)).toBe(true);
          },
          { cancelValidationResult: () => (valid ? cancelled : { status: "invalid" }) },
        );
      },
    );
  }

  test("accepting a new plan archives a leftover validation run", async () => {
    await withService(async (service, storage, provider) => {
      const { started } = await startBuilding(service, storage);
      const leftover = run("leftover");
      leftover.results = leftover.results.map((result) => ({ ...result, durationMs: 1235 }));
      const reviewPackage = testGeneratedReviewPackage({
        packageId: "old-package",
        round: 1,
        targetBranch: "main",
      });
      if (!isPersistedReviewPackage(reviewPackage)) throw new Error("Invalid fixture package");
      provider.structured = async <T>(_sessionId: string, requestId: string) => ({
        ok: true as const,
        provider: "claude" as const,
        requestId,
        value: {
          headRef: HEAD,
          commands: [],
          limitations: ["No external checks for this fixture."],
        } as T,
      });
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.validationRun = leftover;
        snapshot.reviewPackage = reviewPackage;
        snapshot.skippedValidationRunId = leftover.id;
      });
      let snapshot = await pipeline(storage, started.id);
      for (let pass = 0; pass < 5 && !snapshot.validationHistory?.length; pass++) {
        await service.advanceNow(started.id);
        snapshot = await pipeline(storage, started.id);
      }
      expect(snapshot.phase).toBe("building");
      expect(snapshot.validationHistory).toEqual([summarizeValidationRun(leftover, 0, true)!]);
      expect(snapshot.validationRun?.id).not.toBe(leftover.id);
      expect(snapshot.validationRun?.status).toBe("planned");

      expect(isBuildPipeline(snapshot)).toBe(true);
    });
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
