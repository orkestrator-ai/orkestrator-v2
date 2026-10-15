/**
 * How often the multi-model review stage reads its sessions' whole transcripts.
 *
 * Reviewers and the consolidation session mirror their transcripts into the
 * pipeline at persist boundaries. With the provider's bounded conditional
 * snapshot, an unchanged transcript costs one probe answered `unchanged`, not
 * a whole read, and no save.
 */
import { describe, expect, test } from "bun:test";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type { BuildPipelineService } from "./build-pipeline-service.js";
import {
  advanceUntil,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";

const TWO_REVIEWERS = [
  { agent: "claude" as const, model: "opus" },
  { agent: "claude" as const, model: "sonnet" },
];

/** Drives the review stage until its consolidation session exists. */
async function untilConsolidation(
  service: BuildPipelineService,
  read: (id: string) => Promise<BuildPipeline>,
  id: string,
): Promise<void> {
  await advanceUntil(service, read, id, "reviewing");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await service.advanceNow(id);
    if ((await read(id)).reviewFanout?.consolidation) break;
  }
  expect((await read(id)).reviewFanout?.consolidation).toBeDefined();
}

describe("build pipeline multi-model review transcript reads", () => {
  test("an unchanged running consolidation costs no whole read and no save at a boundary", async () => {
    await withPipeline(
      async ({ service, storage, read, provider }) => {
        provider.enableTranscriptSnapshot();
        provider.runningConsolidation = true;
        const started = await service.start(startInput(TWO_REVIEWERS));
        await untilConsolidation(service, read, started.id);
        // The first boundary reads the whole transcript once for a baseline.
        await service.advanceNow(started.id);
        await service.advanceNow(started.id);
        const before = (await storage.getBuildPipeline(started.id))!.revision;
        const reads = provider.wholeReads("consolidation");

        for (let pass = 0; pass < 3; pass += 1) await service.advanceNow(started.id);

        expect(provider.wholeReads("consolidation")).toBe(reads);
        expect((await storage.getBuildPipeline(started.id))!.revision).toBe(before);
        const consolidationProbes = provider.snapshotReads.filter(
          (entry) => entry.sessionId.includes("consolidation") && entry.knownSourceToken,
        );
        expect(consolidationProbes.length).toBeGreaterThanOrEqual(3);

        provider.contentVersion += 1;
        await service.advanceNow(started.id);
        expect(provider.wholeReads("consolidation")).toBe(reads + 1);
        expect((await storage.getBuildPipeline(started.id))!.revision).toBeGreaterThan(before);
      },
      { transcriptPersistIntervalMs: 0 },
    );
  });

  test("a quiet running reviewer is probed, not re-read, at each boundary", async () => {
    await withPipeline(
      async ({ service, read, provider }) => {
        provider.enableTranscriptSnapshot();
        provider.runningModels.add("opus");
        provider.runningModels.add("sonnet");
        const started = await service.start(startInput(TWO_REVIEWERS));
        await advanceUntil(service, read, started.id, "reviewing");
        await service.advanceNow(started.id);
        await service.advanceNow(started.id);
        const reads = provider.wholeReads("review");

        for (let pass = 0; pass < 3; pass += 1) await service.advanceNow(started.id);
        expect(provider.wholeReads("review")).toBe(reads);

        provider.contentVersion += 1;
        await service.advanceNow(started.id);
        // Both reviewers moved, so each is read once.
        expect(provider.wholeReads("review")).toBe(reads + 2);
      },
      { transcriptPersistIntervalMs: 0 },
    );
  });

  test("a reviewer that finishes keeps its final transcript", async () => {
    await withPipeline(
      async ({ service, read, provider, storage }) => {
        provider.enableTranscriptSnapshot();
        provider.runningModels.add("opus");
        provider.runningModels.add("sonnet");
        const started = await service.start(startInput(TWO_REVIEWERS));
        await advanceUntil(service, read, started.id, "reviewing");
        await service.advanceNow(started.id);
        await service.advanceNow(started.id);

        provider.contentVersion += 1;
        provider.runningModels.delete("opus");
        await service.advanceNow(started.id);

        const after = await read(started.id);
        const reviewer = after.reviewFanout!.reviewers[0]!;
        expect(reviewer.status).toBe("completed");
        const session = after.sessions.find((entry) => entry.sessionKey === reviewer.sessionKey)!;
        const stored = await storage.readBuildPipelineTranscript(started.id, session);
        expect(stored.status === "found" ? stored.messages : []).toEqual([
          await provider.messages(session.sdkSessionId, { limit: 1 }).then((tail) => tail[0]),
        ]);
      },
      { transcriptPersistIntervalMs: 60_000 },
    );
  });
});
