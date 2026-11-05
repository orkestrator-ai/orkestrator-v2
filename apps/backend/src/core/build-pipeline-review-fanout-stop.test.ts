import { describe, expect, test } from "bun:test";
import { isBuildPipeline, type BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import {
  advanceUntil,
  fourReviewers,
  reportFor,
  rewritePipeline,
  reviewerSessionCreates,
  startInput,
  withPipeline,
  type FanoutProvider,
} from "./build-pipeline-review-fanout-test-support.js";
import type { BuildPipelineService } from "./build-pipeline-service.js";

const PANEL = [
  { agent: "claude" as const, model: "opus" },
  { agent: "claude" as const, model: "sonnet" },
  { agent: "claude" as const, model: "haiku" },
];

/** Reaches the review with every reviewer of the panel running. */
async function runningPanel(
  service: BuildPipelineService,
  read: (id: string) => Promise<BuildPipeline>,
  provider: FanoutProvider,
): Promise<BuildPipeline> {
  for (const { model } of PANEL) provider.runningModels.add(model);
  const started = await service.start(startInput(PANEL));
  await advanceUntil(service, read, started.id, "reviewing");
  let current = await read(started.id);
  for (
    let pass = 0;
    pass < 10 && current.reviewFanout?.reviewers.some((r) => r.status !== "running");
    pass += 1
  ) {
    await service.advanceNow(started.id);
    current = await read(started.id);
  }
  expect(current.reviewFanout?.reviewers.map((r) => r.status)).toEqual([
    "running",
    "running",
    "running",
  ]);
  return current;
}

function reviewerOf(pipeline: BuildPipeline, model: string) {
  return pipeline.reviewFanout!.reviewers.find((reviewer) => reviewer.model === model)!;
}

describe("build pipeline stop reviewer", () => {
  test("stops one reviewer and consolidates from the rest of the panel", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      const running = await runningPanel(service, read, provider);
      const stopping = reviewerOf(running, "sonnet");

      const stopped = await service.stopReviewer(running.id, stopping.id);

      expect(isBuildPipeline(stopped)).toBe(true);
      expect(stopped.phase).toBe("reviewing");
      expect(provider.aborted).toEqual([stopping.providerSessionId!]);
      expect(reviewerOf(stopped, "sonnet").status).toBe("cancelled");
      expect(reviewerOf(stopped, "sonnet").completedAt).toBeDefined();
      expect(reviewerOf(stopped, "opus").status).toBe("running");
      expect(reviewerOf(stopped, "haiku").status).toBe("running");
      const session = stopped.sessions.find((s) => s.sessionKey === stopping.sessionKey)!;
      expect(session.reviewerOutcome).toBe("cancelled");
      expect(session.status).toBe("idle");
      expect(session.completedAt).toBeDefined();

      provider.runningModels.clear();
      const after = await advanceUntil(service, read, running.id, "addressing", 30);

      expect(after.phase).toBe("addressing");
      expect(after.structuredReview?.reviewSummary).toBe("Merged review.");
      const consolidationPrompt = provider.sent.find((entry) =>
        entry.sessionId.includes("consolidation"),
      )!.prompt;
      expect(consolidationPrompt).toContain("haiku");
      expect(consolidationPrompt).not.toContain(`Report from ${stopping.providerSessionId}`);
      expect(reviewerSessionCreates(provider)).toHaveLength(3);
    });
  });

  test("a queued reviewer leaves the queue and never opens a session", async () => {
    await withPipeline(async ({ service, read, storage, provider }) => {
      for (const { model } of fourReviewers()) provider.runningModels.add(model);
      const started = await service.start(startInput(fourReviewers()));
      await advanceUntil(service, read, started.id, "reviewing");
      // The pass has not admitted anyone yet. Project the queue a pass would show.
      await rewritePipeline(storage, started.id, (pipeline) => {
        pipeline.reviewFanout!.reviewers.forEach((reviewer, index) => {
          expect(reviewer.status).toBe("pending");
          reviewer.admissionState = "queued";
          reviewer.queuePosition = index + 1;
        });
      });
      const queued = (await read(started.id)).reviewFanout!.reviewers;

      const stopped = await service.stopReviewer(started.id, queued[0]!.id);

      const first = stopped.reviewFanout!.reviewers.find((r) => r.id === queued[0]!.id)!;
      const second = stopped.reviewFanout!.reviewers.find((r) => r.id === queued[1]!.id)!;
      expect(first.status).toBe("cancelled");
      expect(first.admissionState).toBeUndefined();
      expect(first.queuePosition).toBeUndefined();
      expect(second.queuePosition).toBe(1);
      expect(provider.aborted).toEqual([]);

      for (let pass = 0; pass < 5; pass += 1) await service.advanceNow(started.id);
      expect(reviewerSessionCreates(provider)).toHaveLength(3);
    });
  });

  test("stopping twice, or a settled reviewer, rewrites nothing", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      const running = await runningPanel(service, read, provider);
      const id = reviewerOf(running, "opus").id;
      const first = await service.stopReviewer(running.id, id);
      const stoppedAt = reviewerOf(first, "opus").completedAt;

      const second = await service.stopReviewer(running.id, id);

      expect(reviewerOf(second, "opus").completedAt).toBe(stoppedAt);
      expect(provider.aborted).toHaveLength(1);

      provider.runningModels.delete("sonnet");
      await advanceUntil(service, read, running.id, "reviewing");
      let settled = await read(running.id);
      for (
        let pass = 0;
        pass < 10 && reviewerOf(settled, "sonnet").status === "running";
        pass += 1
      ) {
        await service.advanceNow(running.id);
        settled = await read(running.id);
      }
      expect(reviewerOf(settled, "sonnet").status).toBe("completed");
      const untouched = await service.stopReviewer(running.id, reviewerOf(settled, "sonnet").id);
      expect(reviewerOf(untouched, "sonnet").status).toBe("completed");
      expect(reviewerOf(untouched, "sonnet").report).toBeDefined();
    });
  });

  test("refuses a reviewer outside the current review", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      const running = await runningPanel(service, read, provider);
      await expect(service.stopReviewer(running.id, "missing")).rejects.toThrow(
        "no longer part of the current review",
      );
      expect(provider.aborted).toEqual([]);
    });
  });

  test("a paused or failed pipeline cannot stop a reviewer it still lists as running", async () => {
    await withPipeline(async ({ service, read, storage, provider }) => {
      const running = await runningPanel(service, read, provider);
      await rewritePipeline(storage, running.id, (pipeline) => {
        pipeline.phase = "paused";
        pipeline.pausedFromPhase = "reviewing";
        pipeline.pauseCause = "requested";
      });
      await expect(
        service.stopReviewer(running.id, reviewerOf(running, "opus").id),
      ).rejects.toThrow("while the review is running");
      expect(provider.aborted).toEqual([]);
    });
  });

  test("stopping the whole panel fails the stage and says the reviewers were stopped", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      const running = await runningPanel(service, read, provider);
      for (const { id } of running.reviewFanout!.reviewers) {
        await service.stopReviewer(running.id, id);
      }

      const failed = await advanceUntil(service, read, running.id, "failed");

      expect(failed.phase).toBe("failed");
      expect(failed.error).toContain("3 reviewers were stopped");
      expect(failed.failureContext?.phase).toBe("reviewing");

      // Nothing usable survives, so a stage retry runs the stopped reviewers again.
      provider.runningModels.clear();
      await service.retryStage(running.id);
      expect(reviewerSessionCreates(provider)).toHaveLength(6);
    });
  });

  test("retrying a failed peer leaves the stopped reviewer stopped", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      const running = await runningPanel(service, read, provider);
      const stopped = reviewerOf(running, "sonnet");
      await service.stopReviewer(running.id, stopped.id);

      provider.runningModels.delete("opus");
      provider.failingModels.add("opus");
      let current = await read(running.id);
      for (let pass = 0; pass < 10 && reviewerOf(current, "opus").status !== "failed"; pass += 1) {
        await service.advanceNow(running.id);
        current = await read(running.id);
      }
      expect(reviewerOf(current, "opus").status).toBe("failed");
      expect(current.phase).toBe("reviewing");

      provider.failingModels.clear();
      const retried = await service.retryReviewer(running.id, reviewerOf(current, "opus").id);

      expect(reviewerOf(retried, "sonnet").status).toBe("cancelled");
      expect(reviewerOf(retried, "sonnet").providerSessionId).toBe(stopped.providerSessionId!);
      expect(
        reviewerSessionCreates(provider).filter((c) => c.options?.model === "sonnet"),
      ).toHaveLength(1);
    });
  });

  test("retrying a failed consolidation keeps the panel a stop reduced", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      const running = await runningPanel(service, read, provider);
      await service.stopReviewer(running.id, reviewerOf(running, "sonnet").id);
      provider.runningModels.clear();
      provider.failingConsolidation = true;

      const failed = await advanceUntil(service, read, running.id, "failed", 30);
      expect(failed.phase).toBe("failed");
      expect(failed.reviewFanout?.consolidation).toBeDefined();
      const reviewersBefore = reviewerSessionCreates(provider).length;

      provider.failingConsolidation = false;
      const retried = await service.retryStage(running.id);

      // No reviewer ran again: only consolidation did, and the review moved on.
      expect(reviewerSessionCreates(provider)).toHaveLength(reviewersBefore);
      expect(
        provider.created.filter((entry) => entry.label === "Review · Consolidation"),
      ).toHaveLength(2);
      expect(retried.phase).toBe("addressing");
      expect(retried.structuredReview?.reviewSummary).toBe("Merged review.");
      expect(
        retried.sessions.filter((s) => s.reviewerOutcome === "cancelled").map((s) => s.model),
      ).toEqual(["sonnet"]);
    });
  });

  test("a stop holds across a pause: resume reruns only what the pause interrupted", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      const running = await runningPanel(service, read, provider);
      const stopped = reviewerOf(running, "sonnet");
      await service.stopReviewer(running.id, stopped.id);
      const paused = await service.pause(running.id);
      expect(reviewerOf(paused, "haiku").status).toBe("cancelled");

      await service.resume(running.id);
      for (let pass = 0; pass < 3; pass += 1) await service.advanceNow(running.id);

      const after = await read(running.id);
      expect(reviewerOf(after, "sonnet").status).toBe("cancelled");
      expect(reviewerOf(after, "sonnet").providerSessionId).toBe(stopped.providerSessionId!);
      expect(reviewerOf(after, "opus").status).toBe("running");
      expect(reviewerOf(after, "haiku").status).toBe("running");
      expect(
        reviewerSessionCreates(provider).filter((c) => c.options?.model === "sonnet"),
      ).toHaveLength(1);
      expect(after.stoppedReviewerIds).toEqual([stopped.id]);
    });
  });

  test("a stop holds when a paused pipeline retries a peer", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      const running = await runningPanel(service, read, provider);
      await service.stopReviewer(running.id, reviewerOf(running, "sonnet").id);
      provider.runningModels.delete("opus");
      provider.failingModels.add("opus");
      let current = await read(running.id);
      for (let pass = 0; pass < 10 && reviewerOf(current, "opus").status !== "failed"; pass += 1) {
        await service.advanceNow(running.id);
        current = await read(running.id);
      }
      const paused = await service.pause(running.id);
      expect(reviewerOf(paused, "haiku").status).toBe("cancelled");

      provider.failingModels.clear();
      const retried = await service.retryReviewer(running.id, reviewerOf(paused, "opus").id);

      expect(retried.phase).toBe("reviewing");
      expect(reviewerOf(retried, "sonnet").status).toBe("cancelled");
      expect(reviewerOf(retried, "haiku").status).not.toBe("cancelled");
      expect(reviewerOf(retried, "opus").status).not.toBe("failed");
    });
  });

  test("a late tool submission from the stopped turn is denied", async () => {
    await withPipeline(
      async ({ service, read, provider, workflowResults }) => {
        const running = await runningPanel(service, read, provider);
        const stopping = reviewerOf(running, "sonnet");
        expect(stopping.resultTransport).toBe("tool-v1");

        await service.stopReviewer(running.id, stopping.id);

        const scope = { environmentId: "env-1", projectId: "project-1" };
        expect(await workflowResults!.status(scope, stopping.requestId!)).toMatchObject({
          lifecycle: "superseded",
        });
        const late = await workflowResults!.validate(
          scope,
          stopping.requestId!,
          reportFor("Late report"),
        );
        expect(late.ok).toBe(false);
      },
      { toolMode: true, toolKinds: ["review-report"] },
    );
  });
});
