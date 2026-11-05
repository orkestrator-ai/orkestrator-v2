import { describe, expect, test } from "bun:test";
import { isBuildPipeline, type BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import {
  advanceUntil,
  reportFor,
  reviewerSessionCreates,
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

describe("build pipeline restart keeps the panel", () => {
  test("restarting consolidation in the running review reruns no reviewer", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.runningConsolidation = true;
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "reviewing");
      for (let pass = 0; pass < 10; pass += 1) {
        if ((await read(started.id)).reviewFanout?.consolidation?.state === "sent") break;
        await service.advanceNow(started.id);
      }
      const first = (await read(started.id)).reviewFanout!.consolidation!;

      const restarted = await service.restartStep(started.id, first.sessionKey);

      expect(isBuildPipeline(restarted)).toBe(true);
      expect(restarted.phase).toBe("reviewing");
      expect(restarted.reviewFanout?.reviewers.every((r) => r.status === "completed")).toBe(true);
      expect(reviewerSessionCreates(provider)).toHaveLength(2);
      expect(consolidations(provider)).toHaveLength(2);
      expect(restarted.reviewFanout?.consolidation?.sessionKey).not.toBe(first.sessionKey);
      expect(provider.aborted).toContain(first.providerSessionId);
      expect(
        restarted.sessions.find((s) => s.sessionKey === first.sessionKey)?.supersededBy,
      ).toBeDefined();
      for (const model of ["opus", "sonnet"]) {
        expect(reviewerSession(restarted, model).supersededBy).toBeUndefined();
      }
    });
  });

  test("restarting consolidation after the review moved on rebuilds the panel from its sessions", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      const started = await service.start(startInput(PANEL));
      const addressing = await advanceUntil(service, read, started.id, "addressing", 30);
      expect(addressing.reviewFanout).toBeUndefined();
      const first = addressing.sessions.find((s) => s.label === "Consolidation")!;
      const address = addressing.sessions.find((s) => s.phase === "address")!;
      provider.runningConsolidation = true;

      const restarted = await service.restartStep(started.id, first.sessionKey);

      expect(isBuildPipeline(restarted)).toBe(true);
      expect(restarted.phase).toBe("reviewing");
      expect(reviewerSessionCreates(provider)).toHaveLength(2);
      expect(consolidations(provider)).toHaveLength(2);
      expect(restarted.reviewFanout?.reviewers.map((r) => r.status)).toEqual([
        "completed",
        "completed",
      ]);
      expect(restarted.reviewFanout?.reviewers[0]?.id).toBe(first.reviewPassId);
      expect(
        restarted.sessions.find((s) => s.sessionKey === address.sessionKey)?.supersededBy,
      ).toBeDefined();
      expect(restarted.structuredReview).toBeUndefined();

      provider.runningConsolidation = false;
      expect((await advanceUntil(service, read, started.id, "addressing", 10)).phase).toBe(
        "addressing",
      );
      expect(reviewerSessionCreates(provider)).toHaveLength(2);
    });
  });

  test("restarting a consolidation with a new model keeps the panel too", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      const started = await service.start(startInput(PANEL));
      const addressing = await advanceUntil(service, read, started.id, "addressing", 30);
      const first = addressing.sessions.find((s) => s.label === "Consolidation")!;

      await service.restartStep(started.id, first.sessionKey, { agent: "claude", model: "haiku" });

      expect(reviewerSessionCreates(provider)).toHaveLength(2);
      expect(consolidations(provider).at(-1)?.options?.model).toBe("haiku");
    });
  });

  test("restarting a running reviewer leaves its peer running", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      for (const { model } of PANEL) provider.runningModels.add(model);
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "reviewing");
      for (let pass = 0; pass < 5; pass += 1) await service.advanceNow(started.id);
      const before = (await read(started.id)).reviewFanout!.reviewers;

      await service.restartReviewer(started.id, before[0]!.id);
      for (let pass = 0; pass < 3; pass += 1) await service.advanceNow(started.id);

      const after = await read(started.id);
      expect(provider.aborted).toEqual([before[0]!.providerSessionId!]);
      expect(after.reviewFanout!.reviewers[0]!.status).toBe("running");
      expect(after.reviewFanout!.reviewers[0]!.providerSessionId).not.toBe(
        before[0]!.providerSessionId,
      );
      expect(after.reviewFanout!.reviewers[1]!.providerSessionId).toBe(
        before[1]!.providerSessionId,
      );
      expect(after.sessions.find((s) => s.sessionKey === before[0]!.sessionKey)).toMatchObject({
        status: "idle",
        reviewerOutcome: "cancelled",
      });
      expect(reviewerSessionCreates(provider)).toHaveLength(3);
    });
  });

  test("a stopped reviewer can be restarted, which ends the stop", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      for (const { model } of PANEL) provider.runningModels.add(model);
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "reviewing");
      for (let pass = 0; pass < 5; pass += 1) await service.advanceNow(started.id);
      const before = (await read(started.id)).reviewFanout!.reviewers;
      const stopped = await service.stopReviewer(started.id, before[0]!.id);
      expect(stopped.stoppedReviewerIds).toEqual([before[0]!.id]);

      await service.restartReviewer(started.id, before[0]!.id);
      for (let pass = 0; pass < 3; pass += 1) await service.advanceNow(started.id);

      const after = await read(started.id);
      expect(after.stoppedReviewerIds).toBeUndefined();
      expect(after.reviewFanout!.reviewers[0]!.status).toBe("running");
    });
  });

  test("restarting a completed reviewer discards consolidation, keeping its peer's report", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.runningConsolidation = true;
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "reviewing");
      for (let pass = 0; pass < 10; pass += 1) {
        if ((await read(started.id)).reviewFanout?.consolidation?.state === "sent") break;
        await service.advanceNow(started.id);
      }
      const before = (await read(started.id)).reviewFanout!;
      provider.runningModels.add("opus");

      await service.restartReviewer(started.id, before.reviewers[0]!.id);
      for (let pass = 0; pass < 3; pass += 1) await service.advanceNow(started.id);

      const after = (await read(started.id)).reviewFanout!;
      expect(after.consolidation).toBeUndefined();
      expect(after.reviewers[0]!.status).toBe("running");
      expect(after.reviewers[1]!.status).toBe("completed");
      expect(after.reviewers[1]!.report).toEqual(before.reviewers[1]!.report);
      expect(reviewerSessionCreates(provider)).toHaveLength(3);
    });
  });

  test("restarting a reviewer after the review moved on rewinds to the panel", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      const started = await service.start(startInput(PANEL));
      const addressing = await advanceUntil(service, read, started.id, "addressing", 30);
      const reviewer = reviewerSession(addressing, "opus");
      const address = addressing.sessions.find((s) => s.phase === "address")!;

      const restarted = await service.restartReviewer(started.id, reviewer.sessionKey);

      expect(isBuildPipeline(restarted)).toBe(true);
      expect(reviewerSessionCreates(provider)).toHaveLength(3);
      expect(
        restarted.sessions.find((s) => s.sessionKey === address.sessionKey)?.supersededBy,
      ).toBeDefined();
      expect(reviewerSession(restarted, "sonnet").supersededBy).toBeUndefined();

      expect((await advanceUntil(service, read, started.id, "addressing", 15)).phase).toBe(
        "addressing",
      );
      expect(reviewerSessionCreates(provider)).toHaveLength(3);
    });
  });

  test("a reviewer of an earlier round cannot restart alone", async () => {
    await withPipeline(async ({ service, read, storage, provider }) => {
      const started = await service.start(startInput(PANEL));
      const addressing = await advanceUntil(service, read, started.id, "addressing", 30);
      const reviewer = reviewerSession(addressing, "opus");
      const record = await storage.getBuildPipeline(started.id);
      const pipeline = record!.snapshot as BuildPipeline;
      pipeline.iteration = 1;
      await storage.saveBuildPipeline(
        record!.id,
        record!.projectId,
        record!.environmentId,
        record!.version,
        pipeline,
        record!.revision,
      );
      const created = provider.created.length;

      await expect(service.restartReviewer(started.id, reviewer.sessionKey)).rejects.toThrow(
        "Restart from here to run the whole review again",
      );
      expect(provider.created).toHaveLength(created);
    });
  });
});

describe("build pipeline live findings", () => {
  test("a reviewer's report_finding reaches its record and its report replaces it", async () => {
    await withPipeline(
      async ({ service, read, provider, workflowResults }) => {
        provider.runningModels.add("opus");
        provider.runningModels.add("sonnet");
        const started = await service.start(startInput(PANEL));
        await advanceUntil(service, read, started.id, "reviewing");
        for (let pass = 0; pass < 10; pass += 1) {
          const reviewers = (await read(started.id)).reviewFanout?.reviewers;
          if (reviewers?.every((reviewer) => reviewer.dispatchState === "sent")) break;
          await service.advanceNow(started.id);
        }
        const reviewer = (await read(started.id)).reviewFanout!.reviewers[0]!;
        expect(reviewer.resultTransport).toBe("tool-v1");
        const sink = service.provisionalFindingSink();
        const scope = { environmentId: "env-1", projectId: "project-1" };
        expect(sink.accepts(scope, reviewer.requestId!)).toBe(true);
        expect(sink.accepts(scope, "someone-elses-attempt")).toBe(false);

        const issue = reportFor("Partial", "Found early").issues[0]!;
        const answer = await sink.report(scope, reviewer.requestId!, {
          ...issue,
          alternativeFixes: [],
        });
        expect(answer.ok).toBe(true);
        await service.advanceNow(started.id);

        const live = (await read(started.id)).reviewFanout!.reviewers[0]!;
        expect(live.provisionalFindings?.map((finding) => finding.issue.title)).toEqual([
          "Found early",
        ]);

        await workflowResults!.submit(scope, reviewer.requestId!, reportFor("Final report"));
        provider.runningModels.delete("opus");
        await service.advanceNow(started.id);
        const done = (await read(started.id)).reviewFanout!.reviewers[0]!;
        expect(done.status).toBe("completed");
        expect(done.provisionalFindings).toBeUndefined();
      },
      { toolMode: true, toolKinds: ["review-report"] },
    );
  });
});
