import { describe, expect, test } from "bun:test";
import { isBuildPipeline, type BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import {
  advanceUntil,
  reviewerSessionCreates,
  rewritePipeline,
  startInput,
  withPipeline,
  type FanoutProvider,
} from "./build-pipeline-review-fanout-test-support.js";

const PANEL = [
  { agent: "claude" as const, model: "opus" },
  { agent: "claude" as const, model: "sonnet" },
];

const consolidations = (provider: FanoutProvider) =>
  provider.created.filter((entry) => entry.label === "Review · Consolidation");

function reviewerSession(pipeline: BuildPipeline, model: string) {
  return pipeline.sessions.findLast(
    (session) => session.phase === "review" && session.model === model,
  )!;
}

function consolidationSessions(pipeline: BuildPipeline) {
  return pipeline.sessions.filter((session) => session.label === "Consolidation");
}

describe("rerunning one reviewer after consolidation", () => {
  test("keeps the other report, supersedes Consolidation and Address, and consolidates again", async () => {
    await withPipeline(async ({ service, createService, read, provider }) => {
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "addressing", 30);
      const paused = await service.pause(started.id);
      expect(paused.phase).toBe("paused");
      const rerunSlot = reviewerSession(paused, "opus");
      const kept = reviewerSession(paused, "sonnet");
      const [consolidation] = consolidationSessions(paused);
      const address = paused.sessions.find((session) => session.phase === "address")!;
      expect(kept.reviewReport).toBeDefined();
      // Holds the rerun in flight, so the state between the rewind and the
      // re-consolidation can be read.
      provider.runningModels.add("opus");

      const restarted = await service.restartReviewer(started.id, rerunSlot.sessionKey);

      expect(isBuildPipeline(restarted)).toBe(true);
      expect(restarted.phase).toBe("reviewing");
      const rewind = restarted.rewinds!.at(-1)!;
      expect(rewind).toMatchObject({
        fromPhase: "paused",
        iteration: 0,
        step: { kind: "session", phase: "review" },
        sessionKey: rerunSlot.sessionKey,
        supersededSessions: 2,
      });
      const byKey = (key: string) => restarted.sessions.find((s) => s.sessionKey === key)!;
      // Consolidation and every later step of the round are a previous attempt.
      expect(byKey(consolidation!.sessionKey).supersededBy).toBe(rewind.id);
      expect(byKey(address.sessionKey).supersededBy).toBe(rewind.id);
      // The other slot's report stays current; the rerun slot's first attempt
      // stays as its earlier attempt, as a live retry leaves it.
      expect(byKey(kept.sessionKey).supersededBy).toBeUndefined();
      expect(byKey(kept.sessionKey).reviewReport).toEqual(kept.reviewReport);
      expect(byKey(rerunSlot.sessionKey).supersededBy).toBeUndefined();
      expect(restarted.structuredReview).toBeUndefined();
      expect(restarted.reviewFanout?.report).toBeUndefined();
      expect(restarted.reviewFanout?.workspaceBaseline).toEqual(
        consolidation!.reviewWorkspaceBaseline,
      );
      expect(restarted.reviewFanout?.reviewers.map((reviewer) => reviewer.status)).toEqual([
        "running",
        "completed",
      ]);
      expect(restarted.reviewFanout?.reviewers[1]?.report).toEqual(kept.reviewReport);
      expect(consolidations(provider)).toHaveLength(1);
      provider.runningModels.delete("opus");

      // A fresh service (a backend restart, or a window that reloads) picks the
      // rerun up from the stored record alone.
      const reloaded = createService();
      try {
        const addressing = await advanceUntil(reloaded, read, started.id, "addressing", 30);
        expect(addressing.phase).toBe("addressing");
      } finally {
        await reloaded.shutdown();
      }
      const after = await read(started.id);
      // Only the rerun slot ran again; the pass consolidated a second time.
      expect(reviewerSessionCreates(provider)).toHaveLength(3);
      expect(consolidations(provider)).toHaveLength(2);
      const rerun = reviewerSession(after, "opus");
      expect(rerun.sessionKey).toBe(`${rerunSlot.sessionKey}:attempt-2`);
      expect(rerun.reviewPassId).toBe(rerunSlot.reviewPassId);
      const current = consolidationSessions(after).filter((s) => s.supersededBy === undefined);
      expect(current).toHaveLength(1);
      expect(current[0]!.reviewPassId).toBe(consolidation!.reviewPassId);
      // The re-consolidation read the kept report alongside the new one.
      const prompt = provider.sent.find(
        (entry) => entry.sessionId === current[0]!.sdkSessionId,
      )!.prompt;
      expect(prompt).toContain(`Report from ${kept.sdkSessionId}`);
      expect(prompt).toContain(`Report from ${rerun.sdkSessionId}`);
      expect(prompt).not.toContain(`Report from ${rerunSlot.sdkSessionId}`);
      const newAddress = after.sessions.filter(
        (session) => session.phase === "address" && session.supersededBy === undefined,
      );
      expect(newAddress).toHaveLength(1);
      expect(newAddress[0]!.sessionKey).not.toBe(address.sessionKey);
    });
  });

  test("is refused while a step after the review runs, changing nothing", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      const started = await service.start(startInput(PANEL));
      const addressing = await advanceUntil(service, read, started.id, "addressing", 30);
      expect(addressing.phase).toBe("addressing");
      const created = provider.created.length;

      await expect(
        service.restartReviewer(started.id, reviewerSession(addressing, "opus").sessionKey),
      ).rejects.toThrow("Pause the pipeline, then restart the reviewer");

      const after = await read(started.id);
      expect(after.phase).toBe("addressing");
      expect(after.rewinds).toBeUndefined();
      expect(after.sessions.some((session) => session.supersededBy)).toBe(false);
      expect(provider.created).toHaveLength(created);
    });
  });

  test("Restart reviewer reruns a slot of a consolidated pass whose next step failed to open", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.failingCreateLabels.add("Address Findings Session");
      const started = await service.start(startInput(PANEL));
      const failed = await advanceUntil(service, read, started.id, "failed", 30);
      // The pass consolidated; opening Address failed, so it is still live.
      expect(failed.failureContext?.phase).toBe("addressing");
      expect(failed.reviewFanout?.report).toBeDefined();
      provider.failingCreateLabels.clear();
      provider.runningModels.add("sonnet");

      const restarted = await service.restartReviewer(
        started.id,
        failed.reviewFanout!.reviewers[1]!.id,
      );

      expect(restarted.phase).toBe("reviewing");
      expect(restarted.reviewFanout?.report).toBeUndefined();
      expect(consolidationSessions(restarted)[0]!.supersededBy).toBe(restarted.rewinds!.at(-1)!.id);
      expect(restarted.reviewFanout?.reviewers.map((reviewer) => reviewer.status)).toEqual([
        "completed",
        "running",
      ]);
      provider.runningModels.delete("sonnet");
      const addressing = await advanceUntil(service, read, started.id, "addressing", 30);
      expect(addressing.phase).toBe("addressing");
      expect(reviewerSessionCreates(provider)).toHaveLength(3);
      expect(consolidations(provider)).toHaveLength(2);
    });
  });

  test("Retry reviewer reruns a failed slot of a pass that consolidated without it", async () => {
    await withPipeline(async ({ service, read, storage, provider }) => {
      provider.failingModels.add("sonnet");
      provider.failingCreateLabels.add("Address Findings Session");
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "failed", 30);
      // A consolidated pass still in review, as while Address waits for the
      // workspace: the record holds the report and the phase is still Review.
      await rewritePipeline(storage, started.id, (pipeline) => {
        pipeline.phase = "reviewing";
        delete pipeline.failureContext;
        delete pipeline.error;
      });
      const consolidated = await read(started.id);
      expect(consolidated.reviewFanout?.report).toBeDefined();
      const failedReviewer = consolidated.reviewFanout!.reviewers[1]!;
      expect(failedReviewer.status).toBe("failed");
      await expect(
        service.retryReviewer(started.id, consolidated.reviewFanout!.reviewers[0]!.id),
      ).rejects.toThrow("Only a failed reviewer can be retried");
      provider.failingModels.delete("sonnet");
      provider.failingCreateLabels.clear();
      provider.runningModels.add("sonnet");

      const retried = await service.retryReviewer(started.id, failedReviewer.id);

      expect(retried.phase).toBe("reviewing");
      expect(retried.reviewFanout?.report).toBeUndefined();
      expect(retried.structuredReview).toBeUndefined();
      expect(consolidationSessions(retried)[0]!.supersededBy).toBe(retried.rewinds!.at(-1)!.id);
      expect(reviewerSession(retried, "opus").supersededBy).toBeUndefined();

      provider.runningModels.delete("sonnet");
      const addressing = await advanceUntil(service, read, started.id, "addressing", 30);
      expect(addressing.phase).toBe("addressing");
      expect(reviewerSessionCreates(provider)).toHaveLength(3);
      expect(consolidations(provider)).toHaveLength(2);
      expect(
        addressing.sessions.filter((s) => s.phase === "address" && s.supersededBy === undefined),
      ).toHaveLength(1);
    });
  });

  test("a slot that never started reruns after the pipeline moved on, anchored on its Consolidation", async () => {
    await withPipeline(async ({ service, read, providers, unstartable }) => {
      unstartable.set("cursor", "cursor bridge directory not found");
      providers.get("cursor")!.runningModels.add("auto");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "cursor", model: "auto" },
        ]),
      );
      await advanceUntil(service, read, started.id, "addressing", 30);
      const paused = await service.pause(started.id);
      const [consolidation] = consolidationSessions(paused);
      const sessionless = consolidation!.sessionlessReviewers![0]!;
      expect(sessionless.slot).toBe(1);
      unstartable.delete("cursor");

      const restarted = await service.restartReviewer(started.id, sessionless.id);

      expect(restarted.phase).toBe("reviewing");
      expect(restarted.rewinds!.at(-1)!.sessionKey).toBe(consolidation!.sessionKey);
      expect(restarted.reviewFanout?.reviewers.map((reviewer) => reviewer.status)).toEqual([
        "completed",
        "running",
      ]);
      providers.get("cursor")!.runningModels.delete("auto");
      const addressing = await advanceUntil(service, read, started.id, "addressing", 30);
      expect(addressing.phase).toBe("addressing");
      expect(
        providers.get("cursor")!.created.filter((entry) => entry.phase === "review"),
      ).toHaveLength(1);
      expect(
        providers.get("claude")!.created.filter((entry) => entry.label === "Review 1"),
      ).toHaveLength(1);
    });
  });

  test("an unknown reviewer is refused", async () => {
    await withPipeline(async ({ service, read }) => {
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "addressing", 30);
      await service.pause(started.id);
      await expect(service.restartReviewer(started.id, "missing")).rejects.toThrow(
        "no longer part of the current review",
      );
    });
  });
});
