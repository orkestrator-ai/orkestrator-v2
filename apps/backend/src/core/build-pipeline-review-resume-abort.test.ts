import { expect, spyOn, test } from "bun:test";
import {
  advanceUntil,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";

test.each([false, true])(
  "resume replaces a panel after a failed pause abort (retry fails: %s)",
  async (retryFails) => {
    await withPipeline(async ({ service, read, provider, packageGeneration }) => {
      provider.runningModels.add("opus");
      provider.runningModels.add("sonnet");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);
      const reviewing = await read(started.id);
      const oldIds = reviewing.reviewFanout!.reviewers.map(
        (reviewer) => reviewer.providerSessionId!,
      );
      const failedId = oldIds[0]!;
      const packagesBefore = packageGeneration.count;
      const verificationsBefore = packageGeneration.verificationCount;
      const abortAttempts: string[] = [];
      let resuming = false;
      const originalAbort = provider.abort.bind(provider);
      const abort = spyOn(provider, "abort").mockImplementation(async (sessionId) => {
        abortAttempts.push(sessionId);
        if (sessionId === failedId && (!resuming || retryFails)) {
          throw new Error("reviewer abort unavailable");
        }
        await originalAbort(sessionId);
      });
      try {
        await expect(service.pause(started.id)).rejects.toThrow("reviewer abort unavailable");
        const paused = await read(started.id);
        expect(paused.phase).toBe("paused");
        expect(paused.error).toContain("stopping every agent could not be confirmed");
        expect(paused.reviewFanout?.reviewers.every((r) => r.status === "cancelled")).toBe(true);
        expect(paused.sessions.find((s) => s.sdkSessionId === failedId)?.status).toBe("running");
        expect(abortAttempts).toEqual(expect.arrayContaining(oldIds));

        resuming = true;
        abortAttempts.length = 0;
        const resumed = await service.resume(started.id);
        expect(abortAttempts).toEqual(expect.arrayContaining(oldIds));
        expect(resumed.phase).toBe("reviewing");
        expect(resumed.error).toBeUndefined();
        expect(resumed.reviewFanout).toBeUndefined();
        expect(resumed.structuredReview).toBeUndefined();
        expect(resumed.verificationResult).toBeUndefined();
        expect(resumed.reviewRetryRequested).toBeUndefined();
        expect(resumed.pendingPromptAttempt).toBeUndefined();
        expect(resumed.reviewPackage).toEqual(reviewing.reviewPackage);
        expect(resumed.sessions.find((s) => s.sdkSessionId === failedId)?.status).toBe(
          retryFails ? "running" : "idle",
        );

        await service.advanceNow(started.id);
        // Opening the verified panel creates pending reviewers; the next
        // supervisor pass dispatches their independent turns.
        await service.advanceNow(started.id);
        const reopened = await read(started.id);
        expect(reopened.phase).toBe("reviewing");
        expect(packageGeneration.count).toBe(packagesBefore);
        expect(packageGeneration.verificationCount).toBeGreaterThan(verificationsBefore);
        expect(reopened.reviewFanout?.reviewers).toHaveLength(2);
        for (const reviewer of reopened.reviewFanout!.reviewers) {
          expect(reviewer.status).toBe("running");
          expect(oldIds).not.toContain(reviewer.providerSessionId);
          expect(reviewer.report).toBeUndefined();
        }
        for (const id of oldIds) {
          expect(reopened.sessions.find((s) => s.sdkSessionId === id)?.reviewerOutcome).toBe(
            "cancelled",
          );
          expect(provider.sent.filter((send) => send.sessionId === id)).toHaveLength(1);
        }
      } finally {
        abort.mockRestore();
      }
    });
  },
);
