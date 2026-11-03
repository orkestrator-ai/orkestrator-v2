import { describe, expect, test } from "bun:test";
import type {
  BuildPipeline,
  PipelineCriterionResult,
  PipelineValidationSummary,
} from "@orkestrator/protocol/build-pipeline";
import type { ReviewPackageReference } from "@orkestrator/protocol/review-workflow";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { ValidationFailureSummary } from "@orkestrator/protocol/validation-failure-triage";
import {
  REPEATED_FAILURES_PAUSE_MESSAGE,
  UNRELATED_FAILURES_PAUSE_MESSAGE,
  validationStallReason,
} from "./build-pipeline-validation-stall.js";
import {
  mutateStored,
  pipeline,
  startVerifying,
  withService,
} from "./build-pipeline-service-test-support.js";
import { testGeneratedReviewPackage } from "./build-pipeline-test-fixtures.js";

const A = "a".repeat(16);
const B = "b".repeat(16);

function summary(overrides: Partial<ValidationFailureSummary> = {}): ValidationFailureSummary {
  return {
    mergeBase: "c".repeat(40),
    ids: [A, B],
    relatedIds: [],
    related: 0,
    unrelated: 2,
    undetermined: 0,
    unattributedCommands: 0,
    ...overrides,
  };
}

function history(failures: ValidationFailureSummary, iteration = 0): PipelineValidationSummary {
  return {
    runId: `run-${iteration}`,
    iteration,
    status: "completed",
    headRef: "1".repeat(40),
    startedAt: "2026-11-02T00:00:00.000Z",
    commands: [],
    failures,
  };
}

function state(
  current: ValidationFailureSummary | undefined,
  validationHistory: PipelineValidationSummary[] = [],
): Pick<BuildPipeline, "reviewPackage" | "validationHistory" | "iteration"> {
  return {
    iteration: 1,
    validationHistory,
    reviewPackage: {
      ...(testGeneratedReviewPackage({
        packageId: "run-1",
        round: 2,
        targetBranch: "main",
      }) as unknown as ReviewPackageReference),
      ...(current ? { failureSummary: current } : {}),
    },
  };
}

const passed: PipelineCriterionResult[] = [{ id: "ac-1", status: "passed", evidence: "done" }];

describe("validationStallReason", () => {
  test("pauses when every failure is unrelated and every criterion passed", () => {
    expect(validationStallReason(state(summary()), passed)).toBe(UNRELATED_FAILURES_PAUSE_MESSAGE);
  });

  test("a failed criterion is work for Fix", () => {
    const failed: PipelineCriterionResult[] = [{ id: "ac-1", status: "failed", evidence: "no" }];
    expect(validationStallReason(state(summary()), failed)).toBeNull();
  });

  test("continues without a triage, or with no failing test", () => {
    expect(validationStallReason(state(undefined), passed)).toBeNull();
    expect(validationStallReason(state(summary({ ids: [], unrelated: 0 })), passed)).toBeNull();
  });

  test("continues while a related or undetermined failure is new", () => {
    expect(
      validationStallReason(state(summary({ related: 1, unrelated: 1, relatedIds: [A] })), passed),
    ).toBeNull();
    expect(
      validationStallReason(state(summary({ undetermined: 1, unrelated: 1 })), passed),
    ).toBeNull();
  });

  test("continues when the output did not account for every failure", () => {
    expect(validationStallReason(state(summary({ unattributedCommands: 1 })), passed)).toBeNull();
    expect(validationStallReason(state(summary({ truncated: true })), passed)).toBeNull();
  });

  test("pauses when the previous round failed exactly the same tests", () => {
    const current = summary({ undetermined: 2, unrelated: 0 });
    expect(validationStallReason(state(current, [history(current)]), passed)).toBe(
      REPEATED_FAILURES_PAUSE_MESSAGE,
    );
    const different = summary({ ids: [A], undetermined: 1, unrelated: 0 });
    expect(validationStallReason(state(current, [history(different)]), passed)).toBeNull();
  });
});

describe("a failed Verify the next round cannot fix", () => {
  test("pauses with the fix queued, and Resume runs it", async () => {
    await withService(async (service, storage, provider) => {
      const structured = provider.structured.bind(provider);
      provider.structured = async <T>(sessionId: string, requestId: string) =>
        provider.phases.get(sessionId) === "verify"
          ? ({
              ok: true,
              provider: "claude",
              requestId,
              value: {
                complete: false,
                rationale: "The aggregate suite failed in tests this branch does not touch.",
              },
            } as StructuredOutputResult<T>)
          : structured<T>(sessionId, requestId);
      const verifying = await startVerifying(service, storage);
      await mutateStored(storage, verifying.id, (stored) => {
        stored.reviewPackage = {
          ...(stored.reviewPackage as ReviewPackageReference),
          failureSummary: summary(),
        };
      });

      await service.advanceNow(verifying.id);

      const paused = await pipeline(storage, verifying.id);
      expect(paused).toMatchObject({
        phase: "paused",
        pausedFromPhase: "fixing",
        pauseCause: "supervisor",
        error: UNRELATED_FAILURES_PAUSE_MESSAGE,
        iteration: 1,
        verificationResult: "fail",
        restartRequest: { kind: "session", phase: "fix" },
      });
      expect(paused.reviewPackage).toBeUndefined();
      expect(provider.created.some((session) => session.phase === "fix")).toBe(false);

      await service.resume(verifying.id);
      await service.advanceNow(verifying.id);

      const fixing = await pipeline(storage, verifying.id);
      expect(fixing.phase).toBe("fixing");
      expect(fixing.restartRequest).toBeUndefined();
      expect(fixing.sessions.at(-1)).toMatchObject({ phase: "fix", iteration: 1 });
    });
  });
});
