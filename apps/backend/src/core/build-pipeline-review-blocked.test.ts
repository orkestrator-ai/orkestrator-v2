import { describe, expect, spyOn, test } from "bun:test";
import { pipelineIndependentReviewLabel } from "@orkestrator/protocol/build-pipeline";
import { reviewerBlockedReason } from "@orkestrator/protocol/review-fanout";
import { REVIEW_BLOCKED_ERROR_PREFIX } from "@orkestrator/protocol/structured-review";
import {
  BLOCKED_REVIEW_REASON,
  advanceUntil,
  reportFor,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";

const scope = { environmentId: "env-1", projectId: "project-1" };
const BLOCKED_ERROR = `${REVIEW_BLOCKED_ERROR_PREFIX}${BLOCKED_REVIEW_REASON}`;

/** A strict-schema report from a reviewer that could not review. */
function blockedReport() {
  const clean = reportFor("The change could not be reviewed.");
  return {
    ...clean,
    reviewScope: {
      ...clean.reviewScope,
      filesReviewed: [],
      outcome: "blocked" as const,
      blockedReason: BLOCKED_REVIEW_REASON,
    },
  };
}

describe("build pipeline review that could not review", () => {
  test("a reviewer that could not review is a failed reviewer, not a clean report", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.couldNotReviewModels.add("sonnet");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      const addressing = await advanceUntil(service, read, started.id, "addressing");
      expect(addressing.error ?? addressing.phase).toBe("addressing");
      // The retired fan-out leaves each reviewer's outcome on its session.
      const [reviewed, blocked] = [0, 1].map((slot) =>
        addressing.sessions.find(
          (session) => session.label === pipelineIndependentReviewLabel(slot),
        ),
      );
      expect(reviewed?.reviewerOutcome).toBe("completed");
      expect(reviewed?.reviewReport).toBeDefined();
      expect(blocked?.reviewerOutcome).toBe("failed");
      expect(blocked?.reviewReport).toBeUndefined();
      expect(
        reviewerBlockedReason({ status: blocked!.reviewerOutcome!, error: blocked!.error }),
      ).toBe(BLOCKED_REVIEW_REASON);
      // Only the reviewer that reviewed reached consolidation.
      expect(addressing.structuredReview?.reviewSummary).toBe("Merged review.");
    });
  });

  test("fails the stage when every reviewer could not review", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.couldNotReviewModels.add("opus");
      provider.couldNotReviewModels.add("sonnet");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      const failed = await advanceUntil(service, read, started.id, "failed");
      expect(failed.error).toContain("No reviewer produced a valid report");
      expect(failed.structuredReview).toBeUndefined();
    });
  });

  test("fails the stage when the consolidator could not review", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.blockedConsolidationResults = 1;
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      const failed = await advanceUntil(service, read, started.id, "failed");
      // A valid blocked report with no findings is a failed consolidation: it
      // must not send the build straight to Verify as a clean review.
      expect(failed.phase).toBe("failed");
      expect(failed.error).toContain(BLOCKED_ERROR);
      expect(failed.structuredReview).toBeUndefined();
      expect(failed.failureContext).toMatchObject({ phase: "reviewing", kind: "stage-transition" });
      expect(failed.sessions.some((session) => session.phase === "verify")).toBe(false);
      const consolidation = failed.sessions.find((session) => session.label === "Consolidation");
      expect(consolidation).toBeDefined();
      expect(consolidation?.reviewReport).toBeUndefined();

      // The ordinary stage retry consolidates again.
      await service.retryStage(started.id);
      const addressing = await advanceUntil(service, read, started.id, "addressing");
      expect(addressing.error ?? addressing.phase).toBe("addressing");
      expect(addressing.structuredReview?.reviewSummary).toBe("Merged review.");
    });
  });

  for (const interruption of ["none", "restart"] as const) {
    test(`a single reviewer's blocked tool result fails the stage before it is consumed (${interruption})`, async () => {
      await withPipeline(
        async ({ service, createService, read, workflowResults }) => {
          const started = await service.start(startInput());
          await advanceUntil(service, read, started.id, "reviewing");
          await service.advanceNow(started.id);
          const reviewing = await read(started.id);
          expect(reviewing.phase).toBe("reviewing");
          const session = reviewing.sessions[reviewing.currentSessionIndex]!;
          expect(session.resultTransport).toBe("tool-v1");
          const requestId = reviewing.structuredReviewRequestId!;
          await workflowResults!.submit(scope, requestId, blockedReport());

          // What a restart would find at the moment the slot is consumed.
          const durableAtConsume: Array<Awaited<ReturnType<typeof read>>> = [];
          const realConsume = workflowResults!.consume.bind(workflowResults!);
          const consume = spyOn(workflowResults!, "consume").mockImplementation(
            async (resultKey: string) => {
              durableAtConsume.push(await read(started.id));
              // A crash in the consumption window: the process never gets past it.
              if (interruption === "restart") throw new Error("backend stopped");
              return realConsume(resultKey);
            },
          );
          try {
            await service.advanceNow(started.id);
          } finally {
            consume.mockRestore();
          }

          // The failure, its reason and the outbox marker were durable first.
          expect(durableAtConsume).toHaveLength(1);
          expect(durableAtConsume[0]!.phase).toBe("failed");
          expect(durableAtConsume[0]!.error).toContain(BLOCKED_ERROR);
          expect(durableAtConsume[0]!.pendingResultConsumptions).toEqual([requestId]);

          if (interruption === "restart") {
            await service.shutdown();
            const restored = createService();
            try {
              await restored.init();
              await restored.advanceNow(started.id);
            } finally {
              await restored.shutdown();
            }
          }
          const failed = await read(started.id);
          expect(failed.phase).toBe("failed");
          expect(failed.error).toContain(BLOCKED_ERROR);
          expect(failed.failureContext).toMatchObject({
            phase: "reviewing",
            kind: "stage-transition",
          });
          expect(failed.structuredReview).toBeUndefined();
          expect(failed.pendingResultConsumptions).toBeUndefined();
          expect((await workflowResults!.status(scope, requestId))?.lifecycle).toBe("consumed");
        },
        { toolMode: true, toolKinds: ["review-report"] },
      );
    });
  }
});
