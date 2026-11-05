import { describe, expect, spyOn, test } from "bun:test";
import {
  advanceUntil,
  reviewerSessionCreates,
  rewritePipeline,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";

const PANEL = [
  { agent: "claude" as const, model: "opus" },
  { agent: "claude" as const, model: "sonnet" },
];

describe("build pipeline review pause/resume", () => {
  test("pause stops the panel and resume reruns only what it interrupted", async () => {
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
      const firstPanel = (await read(started.id)).reviewFanout!.reviewers.map(
        (reviewer) => reviewer.providerSessionId!,
      );

      const paused = await service.pause(started.id);
      expect(paused.phase).toBe("paused");
      expect(
        paused.reviewFanout?.reviewers.every((reviewer) => reviewer.status === "cancelled"),
      ).toBe(true);
      expect(provider.aborted).toEqual(expect.arrayContaining(firstPanel));

      const generated = packageGeneration.count;
      const verified = packageGeneration.verificationCount;
      const sentBefore = provider.sent.length;
      await service.resume(started.id);
      for (let pass = 0; pass < 4 && provider.sent.length < sentBefore + 2; pass += 1) {
        await service.advanceNow(started.id);
      }
      expect(provider.sent).toHaveLength(sentBefore + 2);
      const resumed = await read(started.id);
      expect(resumed.phase).toBe("reviewing");
      expect(resumed.pendingPromptAttempt).toBeUndefined();
      // The panel carries on over the package it was reviewing: verified again,
      // not rebuilt through another preparation round.
      expect(packageGeneration.count).toBe(generated);
      expect(packageGeneration.verificationCount).toBe(verified + 1);
      expect(
        resumed.reviewFanout?.reviewers.map((reviewer) => reviewer.providerSessionId),
      ).not.toEqual(firstPanel);
    });
  });

  test("resume keeps the reports the panel already has", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.runningModels.add("sonnet");
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "reviewing");
      for (let pass = 0; pass < 5; pass += 1) await service.advanceNow(started.id);
      const before = (await read(started.id)).reviewFanout!.reviewers;
      expect(before.map((reviewer) => reviewer.status)).toEqual(["completed", "running"]);

      await service.pause(started.id);
      await service.resume(started.id);
      for (let pass = 0; pass < 3; pass += 1) await service.advanceNow(started.id);

      const after = (await read(started.id)).reviewFanout!.reviewers;
      expect(after[0]).toMatchObject({
        id: before[0]!.id,
        status: "completed",
        providerSessionId: before[0]!.providerSessionId,
      });
      expect(after[0]!.report).toEqual(before[0]!.report);
      expect(after[1]!.status).toBe("running");
      expect(after[1]!.providerSessionId).not.toBe(before[1]!.providerSessionId);
      // One reviewer ran again; its completed peer did not.
      expect(reviewerSessionCreates(provider)).toHaveLength(3);
    });
  });

  test("resume continues an interrupted consolidation in its own session", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.runningConsolidation = true;
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "reviewing");
      for (let pass = 0; pass < 10; pass += 1) {
        if ((await read(started.id)).reviewFanout?.consolidation?.state === "sent") break;
        await service.advanceNow(started.id);
      }
      const before = (await read(started.id)).reviewFanout!.consolidation!;
      expect(before.state).toBe("sent");

      await service.pause(started.id);
      await service.resume(started.id);
      for (let pass = 0; pass < 3; pass += 1) await service.advanceNow(started.id);

      const state = (await read(started.id)).reviewFanout!;
      expect(state.reviewers.every((reviewer) => reviewer.status === "completed")).toBe(true);
      expect(reviewerSessionCreates(provider)).toHaveLength(2);
      expect(state.consolidation?.providerSessionId).toBe(before.providerSessionId);
      expect(state.consolidation?.requestId).not.toBe(before.requestId);
      const turns = provider.sent.filter((s) => s.sessionId === before.providerSessionId);
      expect(turns).toHaveLength(2);
      expect(turns[1]!.prompt).toContain("This work was paused and has now resumed");

      provider.runningConsolidation = false;
      expect((await advanceUntil(service, read, started.id, "addressing", 5)).phase).toBe(
        "addressing",
      );
    });
  });

  test("resume rebuilds a missing package before reopening fan-out", async () => {
    await withPipeline(async ({ service, storage, read, packageGeneration }) => {
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      await service.pause(started.id);
      await rewritePipeline(storage, started.id, (pipeline) => {
        delete pipeline.reviewPackage;
      });

      await service.resume(started.id);
      for (let pass = 0; pass < 4 && packageGeneration.count < 2; pass += 1) {
        await service.advanceNow(started.id);
      }

      const resumed = await read(started.id);
      expect({
        count: packageGeneration.count,
        phase: resumed.phase,
        error: resumed.error,
      }).toEqual({ count: 2, phase: "reviewing", error: undefined });
      expect(resumed.reviewPackage?.headRef).toBe("2".repeat(40));
      expect(resumed.reviewFanout).toBeDefined();
    });
  });

  test.each([
    ["invalidated", "failVerification", "worktree changed"],
    ["unavailable", "failUnexpectedly", "verification service unavailable"],
  ] as const)(
    "resume refuses dispatch when retained evidence is %s",
    async (_scenario, failure, message) => {
      await withPipeline(async ({ service, read, provider, packageGeneration }) => {
        provider.runningModels.add("opus");
        provider.runningModels.add("sonnet");
        const started = await service.start(startInput(PANEL));
        await advanceUntil(service, read, started.id, "reviewing");
        await service.advanceNow(started.id);
        const reviewing = await read(started.id);
        expect(reviewing.reviewFanout?.reviewers.map((reviewer) => reviewer.status)).toEqual([
          "running",
          "running",
        ]);
        await service.pause(started.id);
        const sentBefore = [...provider.sent];
        const createdBefore = [...provider.created];
        const verifiedBefore = packageGeneration.verificationCount;
        const generatedBefore = packageGeneration.count;
        packageGeneration[failure] = true;

        await service.resume(started.id);
        const failed = await advanceUntil(service, read, started.id, "failed");

        expect(failed.phase).toBe("failed");
        expect(failed.failureContext?.phase).toBe("reviewing");
        expect(failed.error).toContain(message);
        expect(packageGeneration.verificationCount).toBe(verifiedBefore + 1);
        expect(packageGeneration.count).toBe(generatedBefore);
        expect(failed.reviewPackage).toEqual(reviewing.reviewPackage);
        expect(provider.created).toEqual(createdBefore);
        expect(provider.sent).toEqual(sentBefore);
        expect(failed.structuredReview).toBeUndefined();

        // A later tick must not bypass the failed evidence check.
        await service.advanceNow(started.id);
        expect(provider.sent).toEqual(sentBefore);
      });
    },
  );

  test("resume retries a reviewer abort that failed during pause before rerunning it", async () => {
    await withPipeline(async ({ service, read, provider, packageGeneration }) => {
      provider.runningModels.add("opus");
      provider.runningModels.add("sonnet");
      let failedId = "";
      let failAbort = true;
      const abortDispatchCounts: number[] = [];
      const originalAbort = provider.abort.bind(provider);
      const abort = spyOn(provider, "abort").mockImplementation(async (sessionId) => {
        if (sessionId === failedId) abortDispatchCounts.push(provider.sent.length);
        if (sessionId === failedId && failAbort) throw new Error("reviewer abort unavailable");
        await originalAbort(sessionId);
      });
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);
      const firstPanel = (await read(started.id)).reviewFanout!.reviewers.map(
        (reviewer) => reviewer.providerSessionId!,
      );
      expect(firstPanel).toHaveLength(2);
      failedId = firstPanel[0]!;
      try {
        await expect(service.pause(started.id)).rejects.toThrow("reviewer abort unavailable");
        const paused = await read(started.id);
        expect(paused.phase).toBe("paused");
        expect(paused.error).toContain("stopping every agent could not be confirmed");
        const unconfirmed = paused.sessions.find((session) => session.sdkSessionId === failedId);
        expect(unconfirmed?.status).toBe("running");
        expect(unconfirmed?.completedAt).toBeUndefined();
        expect(
          paused.reviewFanout?.reviewers.every((reviewer) => reviewer.status === "cancelled"),
        ).toBe(true);
        const sentBefore = provider.sent.length;
        const verifiedBefore = packageGeneration.verificationCount;
        const generatedBefore = packageGeneration.count;
        await service.advanceNow(started.id);
        expect(provider.sent).toHaveLength(sentBefore);

        failAbort = false;
        await service.resume(started.id);
        for (let pass = 0; pass < 4 && provider.sent.length < sentBefore + 2; pass += 1) {
          await service.advanceNow(started.id);
        }

        const resumed = await read(started.id);
        expect(resumed.phase).toBe("reviewing");
        expect(resumed.error).toBeUndefined();
        expect(abort.mock.calls.filter(([id]) => id === failedId)).toHaveLength(2);
        expect(provider.aborted).toEqual(expect.arrayContaining(firstPanel));
        for (const id of firstPanel) {
          expect(resumed.sessions.find((session) => session.sdkSessionId === id)).toMatchObject({
            status: "idle",
            reviewerOutcome: "cancelled",
            completedAt: expect.any(String),
          });
        }
        const nextPanel = resumed.reviewFanout!.reviewers.map(
          (reviewer) => reviewer.providerSessionId!,
        );
        expect(nextPanel).toHaveLength(2);
        expect(nextPanel.every((id) => Boolean(id) && !firstPanel.includes(id))).toBe(true);
        expect(provider.sent).toHaveLength(sentBefore + 2);
        expect(provider.sent.slice(sentBefore).map((entry) => entry.sessionId)).toEqual(nextPanel);
        expect(abortDispatchCounts).toEqual([sentBefore, sentBefore]);
        expect(reviewerSessionCreates(provider)).toHaveLength(4);
        expect(packageGeneration.count).toBe(generatedBefore);
        expect(packageGeneration.verificationCount).toBe(verifiedBefore + 1);
      } finally {
        abort.mockRestore();
      }
    });
  });
});
