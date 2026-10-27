import { describe, expect, test } from "bun:test";
import { pipelineIndependentReviewLabel } from "@orkestrator/protocol/build-pipeline";
import {
  advanceUntil,
  reportFor,
  reviewerSessionCreates,
  rewritePipeline,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";
import { reviewerSessionKey } from "./build-pipeline-review-fanout.js";

const PANEL = [
  { agent: "claude" as const, model: "opus" },
  { agent: "claude" as const, model: "sonnet" },
];

describe("build pipeline reviewer retry", () => {
  test("records each reviewer's outcome, error and issue counts on its session", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.failingModels.add("sonnet");
      const started = await service.start(startInput(PANEL));
      const addressing = await advanceUntil(service, read, started.id, "addressing");

      const completed = addressing.sessions.find(
        (session) => session.label === pipelineIndependentReviewLabel(0),
      );
      const failed = addressing.sessions.find(
        (session) => session.label === pipelineIndependentReviewLabel(1),
      );
      expect(completed?.reviewerOutcome).toBe("completed");
      expect(completed?.reviewIssueCounts).toEqual({ P0: 0, P1: 0, P2: 1 });
      expect(failed?.reviewerOutcome).toBe("failed");
      expect(failed?.error).toBeTruthy();
      expect(failed?.reviewIssueCounts).toBeUndefined();
      const consolidation = addressing.sessions.find((session) =>
        session.label.includes("Consolidation"),
      );
      expect(consolidation?.reviewIssueCounts).toBeDefined();
    });
  });

  test("reruns only the failed reviewer while the rest of the panel keeps running", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.failingModels.add("sonnet");
      provider.runningModels.add("opus");
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "reviewing");
      let reviewing = await read(started.id);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (reviewing.reviewFanout?.reviewers[1]?.status === "failed") break;
        await service.advanceNow(started.id);
        reviewing = await read(started.id);
      }
      const [running, failedReviewer] = reviewing.reviewFanout!.reviewers;
      expect(failedReviewer?.status).toBe("failed");
      const failedSessionKey = failedReviewer!.sessionKey!;
      const runningSession = running!.providerSessionId;

      provider.failingModels.delete("sonnet");
      const retried = await service.retryReviewer(started.id, failedReviewer!.id);

      expect(retried.phase).toBe("reviewing");
      const retriedReviewer = retried.reviewFanout!.reviewers[1]!;
      expect(retriedReviewer.status).not.toBe("failed");
      expect(retriedReviewer.error).toBeUndefined();
      // The other reviewer was not touched.
      expect(retried.reviewFanout!.reviewers[0]!.providerSessionId).toBe(runningSession);
      expect(provider.aborted).not.toContain(runningSession);

      provider.runningModels.delete("opus");
      const addressing = await advanceUntil(service, read, started.id, "addressing", 20);
      expect(addressing.phase).toBe("addressing");
      // Two attempts in the second slot: the failed one stays as history.
      const slotSessions = addressing.sessions.filter(
        (session) => session.label === pipelineIndependentReviewLabel(1),
      );
      expect(slotSessions).toHaveLength(2);
      expect(slotSessions[0]!.sessionKey).toBe(failedSessionKey);
      expect(slotSessions[0]!.reviewerOutcome).toBe("failed");
      expect(slotSessions[1]!.sessionKey).toBe(`${failedSessionKey}:attempt-2`);
      expect(slotSessions[1]!.reviewerOutcome).toBe("completed");
      // Opus and sonnet once each, plus the retried sonnet.
      expect(reviewerSessionCreates(provider)).toHaveLength(3);
    });
  });

  test("resumes a review that failed because no reviewer produced a report", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.failingModels.add("opus");
      provider.failingModels.add("sonnet");
      const started = await service.start(startInput(PANEL));
      const failed = await advanceUntil(service, read, started.id, "failed");
      expect(failed.failureContext?.phase).toBe("reviewing");

      provider.failingModels.delete("opus");
      const retried = await service.retryReviewer(
        started.id,
        failed.reviewFanout!.reviewers[0]!.id,
      );
      expect(retried.phase).not.toBe("failed");
      expect(retried.error).toBeUndefined();
      expect(retried.failureContext).toBeUndefined();

      const addressing = await advanceUntil(service, read, started.id, "addressing", 20);
      expect(addressing.error ?? addressing.phase).toBe("addressing");
      expect(addressing.reviewFanout?.reviewers[0]?.status ?? "settled").not.toBe("pending");
    });
  });

  test("discards a started consolidation when a failed reviewer is retried", async () => {
    await withPipeline(async ({ service, read, provider, storage }) => {
      provider.failingModels.add("sonnet");
      provider.runningConsolidation = true;
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "reviewing");
      let reviewing = await read(started.id);
      for (let attempt = 0; attempt < 10 && !reviewing.reviewFanout?.consolidation; attempt += 1) {
        await service.advanceNow(started.id);
        reviewing = await read(started.id);
      }
      const consolidation = reviewing.reviewFanout!.consolidation!;
      expect(consolidation).toBeDefined();
      // Keep the consolidation session visible as a mirror, as the tab sees it.
      await rewritePipeline(storage, started.id, () => {});

      provider.failingModels.delete("sonnet");
      const retried = await service.retryReviewer(
        started.id,
        reviewing.reviewFanout!.reviewers[1]!.id,
      );
      expect(retried.reviewFanout?.consolidation?.providerSessionId).not.toBe(
        consolidation.providerSessionId,
      );
      expect(provider.aborted).toContain(consolidation.providerSessionId);
      expect(retried.structuredReview).toBeUndefined();
    });
  });

  test("refuses a reviewer that has not failed, and one whose review was consolidated", async () => {
    await withPipeline(async ({ service, read, provider, storage }) => {
      provider.runningModels.add("opus");
      provider.runningModels.add("sonnet");
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);
      const reviewing = await read(started.id);
      const reviewerId = reviewing.reviewFanout!.reviewers[0]!.id;
      await expect(service.retryReviewer(started.id, reviewerId)).rejects.toThrow(
        "Only a failed reviewer can be retried",
      );
      await expect(service.retryReviewer(started.id, "missing")).rejects.toThrow(
        "no longer part of the current review",
      );

      await rewritePipeline(storage, started.id, (pipeline) => {
        const reviewer = pipeline.reviewFanout!.reviewers[0]!;
        reviewer.status = "failed";
        reviewer.error = "boom";
        pipeline.reviewFanout!.report = reportFor("Merged review.");
      });
      await expect(service.retryReviewer(started.id, reviewerId)).rejects.toThrow(
        "has been consolidated",
      );
    });
  });

  test("retrying a paused review dispatches without restarting its completed peer", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.failingModels.add("sonnet");
      provider.runningConsolidation = true;
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "reviewing");
      let reviewing = await read(started.id);
      for (let attempt = 0; attempt < 10 && !reviewing.reviewFanout?.consolidation; attempt += 1) {
        await service.advanceNow(started.id);
        reviewing = await read(started.id);
      }
      const [completed, failed] = reviewing.reviewFanout!.reviewers;
      expect(completed!.status).toBe("completed");
      expect(failed!.status).toBe("failed");
      const paused = await service.pause(started.id);
      expect(paused.phase).toBe("paused");
      provider.failingModels.delete("sonnet");
      const retried = await service.retryReviewer(started.id, failed!.id);
      expect(retried.phase).toBe("reviewing");
      expect(retried.pausedFromPhase).toBeUndefined();
      expect(retried.pauseCause).toBeUndefined();
      expect(retried.reviewFanout!.reviewers[0]).toEqual(completed);
      expect(retried.reviewFanout!.reviewers[1]!.providerSessionId).toBeDefined();
      expect(retried.reviewFanout!.reviewers[1]!.providerSessionId).not.toBe(
        failed!.providerSessionId,
      );
      expect(reviewerSessionCreates(provider)).toHaveLength(3);
    });
  });

  test("supersedes the failed tool-v1 reviewer slot and allocates a fresh request", async () => {
    await withPipeline(
      async ({ service, read, provider, workflowResults }) => {
        provider.failingModels.add("sonnet");
        provider.runningModels.add("opus");
        const started = await service.start(startInput(PANEL));
        await advanceUntil(service, read, started.id, "reviewing");
        let reviewing = await read(started.id);
        for (
          let attempt = 0;
          attempt < 10 && reviewing.reviewFanout?.reviewers[1]?.status !== "failed";
          attempt += 1
        ) {
          await service.advanceNow(started.id);
          reviewing = await read(started.id);
        }
        const failed = reviewing.reviewFanout!.reviewers[1]!;
        expect(failed.resultTransport).toBe("tool-v1");
        expect(failed.requestId).toBeDefined();
        provider.failingModels.delete("sonnet");
        provider.runningModels.add("sonnet");
        const retried = await service.retryReviewer(started.id, failed.id);
        const fresh = retried.reviewFanout!.reviewers[1]!;
        expect(fresh.resultTransport).toBe("tool-v1");
        expect(fresh.requestId).toBeDefined();
        expect(fresh.requestId).not.toBe(failed.requestId);
        expect(
          await workflowResults!.status(
            { environmentId: "env-1", projectId: "project-1" },
            failed.requestId!,
          ),
        ).toMatchObject({ lifecycle: "superseded", completion: "blocked" });
        const late = await workflowResults!.validate(
          { environmentId: "env-1", projectId: "project-1" },
          failed.requestId!,
          reportFor("Late report"),
        );
        expect(late.ok).toBe(false);
      },
      { toolMode: true, toolKinds: ["review-report"] },
    );
  });

  test("a retried reviewer's session key never collides with an earlier attempt", () => {
    const pipeline = {
      id: "pipeline-1",
      iteration: 0,
      sessions: [] as Array<{ sessionKey: string }>,
    };
    const reviewer = { id: "reviewer-1" };
    const first = reviewerSessionKey(pipeline as never, reviewer);
    expect(first).toBe("pipeline-1:review:0:reviewer-1");
    pipeline.sessions.push({ sessionKey: first });
    const second = reviewerSessionKey(pipeline as never, reviewer);
    expect(second).toBe(`${first}:attempt-2`);
    pipeline.sessions.push({ sessionKey: second });
    expect(reviewerSessionKey(pipeline as never, reviewer)).toBe(`${first}:attempt-3`);
  });
});
