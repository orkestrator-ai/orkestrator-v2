import { expect, test } from "bun:test";
import {
  isBuildPipeline,
  REVIEW_PACKAGE_SESSION_LABEL,
} from "@orkestrator/protocol/build-pipeline";
import {
  advanceUntil,
  reportFor,
  rewritePipeline,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";

const PANEL = [
  { agent: "claude" as const, model: "opus" },
  { agent: "claude" as const, model: "sonnet" },
];

test.each(["build", "fix"] as const)(
  "skipping %s starts fresh review package preparation and refuses to skip it",
  async (phase) => {
    await withPipeline(async ({ service, read, storage, provider }) => {
      const queued = await service.start(startInput());
      const started = await advanceUntil(service, read, queued.id, "building");
      const work = started.sessions[started.currentSessionIndex]!;
      if (phase === "fix") {
        await rewritePipeline(storage, started.id, (pipeline) => {
          pipeline.phase = "fixing";
          pipeline.sessions[pipeline.currentSessionIndex]!.phase = "fix";
          pipeline.verificationFeedback = "Fix the regression";
        });
      }
      const skipped = await service.skipStep(started.id, work.sdkSessionId);
      expect(skipped.phase).toBe("fixing");
      expect(skipped.sessions.find((s) => s.sdkSessionId === work.sdkSessionId)).toMatchObject({
        skipped: true,
        status: "idle",
        completedAt: expect.any(String),
      });
      expect(provider.aborted).toContain(work.sdkSessionId);
      const preparation = skipped.sessions.at(-1)!;
      expect(preparation).toMatchObject({ label: REVIEW_PACKAGE_SESSION_LABEL, status: "running" });
      expect(preparation.sdkSessionId).not.toBe(work.sdkSessionId);
      await expect(service.skipStep(started.id, preparation.sdkSessionId)).rejects.toThrow(
        "Review preparation cannot be skipped",
      );
      expect((await read(started.id)).sessions).toEqual(skipped.sessions);
    });
  },
);

test("skipping a paused address stage clears pause state and starts verification", async () => {
  await withPipeline(async ({ service, read }) => {
    const started = await service.start(startInput(PANEL));
    const addressing = await advanceUntil(service, read, started.id, "addressing");
    const address = addressing.sessions[addressing.currentSessionIndex]!;
    const paused = await service.pause(started.id);
    expect(paused).toMatchObject({ phase: "paused", pausedFromPhase: "addressing" });
    const skipped = await service.skipStep(started.id, address.sessionKey!);
    expect(skipped.phase).toBe("verifying");
    expect(skipped.pausedFromPhase).toBeUndefined();
    expect(skipped.pauseCause).toBeUndefined();
    expect(skipped.sessions.find((s) => s.sessionKey === address.sessionKey)?.skipped).toBe(true);
    expect(skipped.sessions.at(-1)).toMatchObject({ phase: "verify", status: "running" });
  });
});

test("conflict resolution refuses skip with the correct stage name", async () => {
  await withPipeline(async ({ service, storage, read }) => {
    const queued = await service.start(startInput());
    const started = await advanceUntil(service, read, queued.id, "building");
    const session = started.sessions[started.currentSessionIndex]!;
    await rewritePipeline(storage, started.id, (pipeline) => {
      pipeline.phase = "resolving-conflicts";
      pipeline.sessions[pipeline.currentSessionIndex]!.phase = "resolve-conflicts";
    });
    await expect(service.skipStep(started.id, session.sdkSessionId)).rejects.toThrow(
      "Conflict resolution cannot be skipped",
    );
  });
});

test("a failed best-effort provider abort still advances the skipped stage", async () => {
  await withPipeline(async ({ service, provider, read }) => {
    const queued = await service.start(startInput());
    const started = await advanceUntil(service, read, queued.id, "building");
    provider.abort = async () => {
      throw new Error("Provider disconnected");
    };
    const skipped = await service.skipStep(started.id, started.sessions[0]!.sdkSessionId);
    expect(skipped.sessions[0]?.skipped).toBe(true);
    expect(skipped.sessions.at(-1)).toMatchObject({ label: REVIEW_PACKAGE_SESSION_LABEL });
    expect(skipped.skipRequest).toBeUndefined();
  });
});

test("skipping a single review fences its late tool submission", async () => {
  await withPipeline(
    async ({ service, read, workflowResults }) => {
      const started = await service.start(startInput());
      const reviewing = await advanceUntil(service, read, started.id, "reviewing");
      expect(reviewing.reviewFanout).toBeUndefined();
      const review = reviewing.sessions[reviewing.currentSessionIndex]!;
      expect(review.resultTransport).toBe("tool-v1");
      expect(review.structuredRequestId).toBeTruthy();
      const skipped = await service.skipStep(started.id, review.sdkSessionId);
      expect(skipped.phase).toBe("verifying");
      expect(
        await workflowResults!.status(
          { environmentId: "env-1", projectId: "project-1" },
          review.structuredRequestId!,
        ),
      ).toMatchObject({ lifecycle: "superseded", completion: "blocked" });
      expect(
        (
          await workflowResults!.submit(
            { environmentId: "env-1", projectId: "project-1" },
            review.structuredRequestId!,
            reportFor("Late single review"),
          )
        ).ok,
      ).toBe(false);
      expect((await read(started.id)).structuredReview).toBeUndefined();
    },
    { toolMode: true, toolKinds: ["review-report"] },
  );
});

test.each(["restart", "pause-resume"] as const)(
  "%s rejects skip from an old panel in the same iteration",
  async (action) => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.runningModels.add("opus");
      provider.runningModels.add("sonnet");
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);
      const old = await read(started.id);
      const oldReviewer = old.reviewFanout!.reviewers[0]!;
      if (action === "restart") await service.restartCurrentStep(started.id);
      else {
        await service.pause(started.id);
        await service.resume(started.id);
      }
      for (let i = 0; i < 15; i++) {
        const current = await read(started.id);
        if (
          current.reviewFanout?.reviewers.every((r) => r.providerSessionId) &&
          current.reviewFanout.reviewers[0]!.sessionKey !== oldReviewer.sessionKey
        )
          break;
        await service.advanceNow(started.id);
      }
      const replacement = await read(started.id);
      expect(replacement.iteration).toBe(old.iteration);
      expect(replacement.reviewFanout!.reviewers[0]!.sessionKey).not.toBe(oldReviewer.sessionKey);
      const aborted = [...provider.aborted];
      for (const id of [oldReviewer.providerSessionId!, oldReviewer.sessionKey!]) {
        await expect(service.skipStep(started.id, id)).rejects.toThrow("already finished");
      }
      expect((await read(started.id)).reviewFanout).toEqual(replacement.reviewFanout);
      expect(provider.aborted).toEqual(aborted);
      expect((await read(started.id)).phase).toBe("reviewing");
    });
  },
);

test("a superseded reviewer and consolidation cannot skip the replacement attempts", async () => {
  await withPipeline(async ({ service, read, provider }) => {
    provider.failingModels.add("sonnet");
    provider.runningConsolidation = true;
    const started = await service.start(startInput(PANEL));
    await advanceUntil(service, read, started.id, "reviewing");
    for (let i = 0; i < 15 && !(await read(started.id)).reviewFanout?.consolidation; i++) {
      await service.advanceNow(started.id);
    }
    const old = (await read(started.id)).reviewFanout!;
    expect(old.consolidation).toBeDefined();
    provider.failingModels.clear();
    provider.runningModels.add("sonnet");
    await service.retryReviewer(started.id, old.reviewers[1]!.id);
    const replacement = await read(started.id);
    // Also exercises the old consolidation that can remain currentSessionIndex.
    for (const id of [
      old.reviewers[1]!.providerSessionId!,
      old.consolidation!.providerSessionId,
      old.consolidation!.sessionKey,
    ]) {
      await expect(service.skipStep(started.id, id)).rejects.toThrow("already finished");
    }
    expect((await read(started.id)).reviewFanout).toEqual(replacement.reviewFanout);
    expect((await read(started.id)).phase).toBe("reviewing");
  });
});

test("skipping an unfinished panel marks its already completed reviewers skipped too", async () => {
  await withPipeline(async ({ service, read, provider }) => {
    provider.runningModels.add("sonnet");
    const started = await service.start(startInput(PANEL));
    await advanceUntil(service, read, started.id, "reviewing");
    for (let i = 0; i < 15; i++) {
      const fanout = (await read(started.id)).reviewFanout!;
      if (fanout.reviewers[0]!.status === "completed" && fanout.reviewers[1]!.providerSessionId)
        break;
      await service.advanceNow(started.id);
    }
    const fanout = (await read(started.id)).reviewFanout!;
    expect(fanout.reviewers[0]!.status).toBe("completed");
    expect(fanout.consolidation).toBeUndefined();
    const skipped = await service.skipStep(started.id, fanout.reviewers[1]!.providerSessionId!);
    for (const reviewer of fanout.reviewers) {
      expect(skipped.sessions.find((s) => s.sessionKey === reviewer.sessionKey)?.skipped).toBe(
        true,
      );
    }
    expect(skipped.phase).toBe("verifying");
    expect(skipped.reviewFanout).toBeUndefined();
  });
});

test.each(["reviewers", "consolidation"] as const)(
  "skipping during %s persists skipped history and fences late tool results",
  async (stage) => {
    await withPipeline(
      async ({ service, read, provider, createService, workflowResults }) => {
        if (stage === "reviewers") {
          provider.runningModels.add("opus");
          provider.runningModels.add("sonnet");
        } else provider.runningConsolidation = true;
        const started = await service.start(startInput(PANEL));
        await advanceUntil(service, read, started.id, "reviewing");
        for (let i = 0; i < 15; i++) {
          const fanout = (await read(started.id)).reviewFanout!;
          if (stage === "reviewers" && fanout.reviewers.every((r) => r.providerSessionId)) break;
          if (stage === "consolidation" && fanout.consolidation) break;
          // Tool reviewers must submit before consolidation can start.
          if (stage === "consolidation") {
            for (const reviewer of fanout.reviewers) {
              if (reviewer.requestId && reviewer.status === "running") {
                expect(
                  await workflowResults!.submit(
                    { environmentId: "env-1", projectId: "project-1" },
                    reviewer.requestId,
                    reportFor("Completed reviewer"),
                  ),
                ).toMatchObject({ ok: true });
              }
            }
          }
          await service.advanceNow(started.id);
        }
        const reviewing = await read(started.id);
        const fanout = reviewing.reviewFanout!;
        const target = stage === "reviewers" ? fanout.reviewers[0]! : fanout.consolidation!;
        expect(target.providerSessionId).toBeTruthy();
        expect(target.requestId).toBeTruthy();
        const completed = reviewing.sessions.filter((s) => s.reviewerOutcome === "completed");
        if (stage === "consolidation") expect(completed).toHaveLength(2);
        const skipped = await service.skipStep(started.id, target.providerSessionId!);
        expect(skipped.phase).toBe("verifying");
        expect(skipped.reviewFanout).toBeUndefined();
        expect(skipped.structuredReview).toBeUndefined();
        const affected = reviewing.sessions.filter((s) =>
          stage === "reviewers"
            ? fanout.reviewers.some((r) => r.sessionKey === s.sessionKey)
            : s.sessionKey === fanout.consolidation!.sessionKey,
        );
        expect(affected.length).toBeGreaterThan(0);
        for (const previous of affected) {
          expect(skipped.sessions.find((s) => s.sessionKey === previous.sessionKey)).toMatchObject({
            skipped: true,
            completedAt: expect.any(String),
          });
        }
        for (const previous of completed) {
          expect(skipped.sessions.find((s) => s.sessionKey === previous.sessionKey)).toEqual(
            previous,
          );
        }
        expect(
          await workflowResults!.status(
            { environmentId: "env-1", projectId: "project-1" },
            target.requestId!,
          ),
        ).toMatchObject({ lifecycle: "superseded" });
        expect(
          (
            await workflowResults!.submit(
              { environmentId: "env-1", projectId: "project-1" },
              target.requestId!,
              reportFor("Late result"),
            )
          ).ok,
        ).toBe(false);
        await service.shutdown();
        const restored = createService();
        try {
          await restored.init();
          const snapshot = await read(started.id);
          expect(isBuildPipeline(snapshot)).toBe(true);
          expect(snapshot.sessions).toEqual(skipped.sessions);
          expect(snapshot.reviewFanout).toBeUndefined();
        } finally {
          await restored.shutdown();
        }
      },
      { toolMode: true, toolKinds: ["review-report", "consolidated-review"] },
    );
  },
);

test.each(["build", "fix", "review", "address", "verify"] as const)(
  "a replacement controller consumes the persisted %s skip request once",
  async (phase) => {
    await withPipeline(async ({ service, read, storage, createService }) => {
      const queued = await service.start(startInput());
      const started = await advanceUntil(service, read, queued.id, "building");
      await service.shutdown();
      await rewritePipeline(storage, started.id, (pipeline) => {
        pipeline.phase =
          phase === "build"
            ? "building"
            : phase === "fix"
              ? "fixing"
              : phase === "review"
                ? "reviewing"
                : phase === "address"
                  ? "addressing"
                  : "verifying";
        const current = pipeline.sessions[pipeline.currentSessionIndex]!;
        current.phase = phase;
        current.status = "idle";
        current.skipped = true;
        current.completedAt = new Date().toISOString();
        pipeline.skipRequest = { phase };
      });
      const restored = createService();
      try {
        await restored.init();
        await restored.advanceNow(started.id);
        const snapshot = await read(started.id);
        expect(isBuildPipeline(snapshot)).toBe(true);
        expect(snapshot.skipRequest).toBeUndefined();
        expect(snapshot.sessions).toHaveLength(2);
        expect(snapshot.sessions[1]).toMatchObject(
          phase === "build" || phase === "fix"
            ? { label: REVIEW_PACKAGE_SESSION_LABEL, status: "running" }
            : { phase: phase === "verify" ? "pr" : "verify", status: "running" },
        );
      } finally {
        await restored.shutdown();
      }
    });
  },
);
