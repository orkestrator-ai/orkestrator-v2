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

        const baseline = await read(started.id);
        const id = baseline.reviewFanout!.reviewers[0]!.providerSessionId!;
        const reads = provider.wholeReads(id);
        const final = [{ id: "final", role: "assistant", text: "terminal reviewer output" }];
        expect(
          (
            await storage.readBuildPipelineTranscript(
              started.id,
              baseline.sessions.find((s) => s.sdkSessionId === id)!,
            )
          ).status,
        ).toBe("found");
        provider.transcriptOverrides.set(id, final);
        provider.runningModels.delete("opus");
        await service.advanceNow(started.id);

        const after = await read(started.id);
        const reviewer = after.reviewFanout!.reviewers[0]!;
        expect(reviewer.status).toBe("completed");
        const session = after.sessions.find((entry) => entry.sessionKey === reviewer.sessionKey)!;
        const stored = await storage.readBuildPipelineTranscript(started.id, session);
        expect(provider.wholeReads(id)).toBe(reads + 1);
        expect(stored.status === "found" ? stored.messages : []).toEqual(final);
      },
      { transcriptPersistIntervalMs: 60_000 },
    );
  });

  test("reviewer idle polls stay conditional while final usage is pending", async () => {
    await withPipeline(
      async ({ service, read, provider }) => {
        provider.enableTranscriptSnapshot();
        provider.runningModels.add("opus");
        provider.runningModels.add("sonnet");
        const started = await service.start(startInput(TWO_REVIEWERS));
        await advanceUntil(service, read, started.id, "reviewing");
        await service.advanceNow(started.id);
        const id = (await read(started.id)).reviewFanout!.reviewers[0]!.providerSessionId!;
        const reads = provider.wholeReads(id);
        provider.usagePending = true;
        provider.runningModels.delete("opus");
        await service.advanceNow(started.id);
        expect(provider.wholeReads(id)).toBe(reads + 1);
        expect((await read(started.id)).reviewFanout!.reviewers[0]!.status).toBe("running");
        await service.advanceNow(started.id);
        expect(provider.wholeReads(id)).toBe(reads + 1);
      },
      { transcriptPersistIntervalMs: 0 },
    );
  });

  test("consolidation completion forces a final read when its probe is unchanged", async () => {
    await withPipeline(
      async ({ service, storage, read, provider }) => {
        provider.enableTranscriptSnapshot();
        provider.runningConsolidation = true;
        const started = await service.start(startInput(TWO_REVIEWERS));
        await untilConsolidation(service, read, started.id);
        await service.advanceNow(started.id);
        const baseline = await read(started.id);
        const id = baseline.reviewFanout!.consolidation!.providerSessionId;
        const session = baseline.sessions.find((entry) => entry.sdkSessionId === id)!;
        expect((await storage.readBuildPipelineTranscript(started.id, session)).status).toBe(
          "found",
        );
        const reads = provider.wholeReads(id);
        const final = [{ id: "final", role: "assistant", text: "terminal consolidation output" }];
        provider.transcriptOverrides.set(id, final);
        provider.runningConsolidation = false;
        await service.advanceNow(started.id);
        const after = await read(started.id);
        const stored = await storage.readBuildPipelineTranscript(
          started.id,
          after.sessions.find((entry) => entry.sdkSessionId === id)!,
        );
        expect(provider.wholeReads(id)).toBe(reads + 1);
        expect(stored.status === "found" ? stored.messages : []).toEqual(final);
        expect(
          after.sessions.find((entry) => entry.sdkSessionId === id)!.structuredResultStatus,
        ).toBe("accepted");
      },
      { transcriptPersistIntervalMs: 60_000 },
    );
  });

  test("idle consolidation polls stay conditional after the final read", async () => {
    await withPipeline(
      async ({ service, read, provider }) => {
        provider.enableTranscriptSnapshot();
        provider.runningConsolidation = true;
        provider.missingConsolidationResult = true;
        const started = await service.start(startInput(TWO_REVIEWERS));
        await untilConsolidation(service, read, started.id);
        await service.advanceNow(started.id);
        const id = (await read(started.id)).reviewFanout!.consolidation!.providerSessionId;
        const reads = provider.wholeReads(id);
        provider.runningConsolidation = false;
        await service.advanceNow(started.id);
        expect(provider.wholeReads(id)).toBe(reads + 1);
        await service.advanceNow(started.id);
        expect(provider.wholeReads(id)).toBe(reads + 1);
      },
      { transcriptPersistIntervalMs: 0 },
    );
  });

  for (const kind of ["reviewer", "consolidation"] as const) {
    test(`${kind} checkpoints retain pre-window changes from a legacy snapshot`, async () => {
      await withPipeline(
        async ({ service, storage, read, provider }) => {
          provider.enableTranscriptSnapshot();
          const snapshot = provider.transcriptSnapshot!;
          provider.transcriptSnapshot = async (id, options) => {
            const result = await snapshot(id, options);
            if ("unchanged" in result) return result;
            const {
              representation: _representation,
              revisedMessages: _revised,
              sourceToken: _token,
              ...legacy
            } = result;
            return legacy;
          };
          provider.runningConsolidation = true;
          if (kind === "reviewer") {
            provider.runningModels.add("opus");
            provider.runningModels.add("sonnet");
          }
          const started = await service.start(startInput(TWO_REVIEWERS));
          await advanceUntil(service, read, started.id, "reviewing");
          if (kind === "consolidation") await untilConsolidation(service, read, started.id);
          else await service.advanceNow(started.id);
          const baseline = await read(started.id);
          const id =
            kind === "reviewer"
              ? baseline.reviewFanout!.reviewers[0]!.providerSessionId!
              : baseline.reviewFanout!.consolidation!.providerSessionId;
          const messages = Array.from({ length: 12 }, (_, index) => ({
            id: `row-${index}`,
            role: "assistant",
            text: `row ${index}`,
          }));
          provider.transcriptOverrides.set(id, messages);
          await service.advanceNow(started.id);
          const reads = provider.wholeReads(id);
          const final = messages.map((row, index) =>
            index === 0 ? { ...row, text: "late tool result" } : row,
          );
          provider.transcriptOverrides.set(id, final);
          await service.advanceNow(started.id);
          expect(provider.wholeReads(id)).toBe(reads + 1);
          const after = await read(started.id);
          const stored = await storage.readBuildPipelineTranscript(
            started.id,
            after.sessions.find((entry) => entry.sdkSessionId === id)!,
          );
          expect(stored.status === "found" ? stored.messages : []).toEqual(final);
        },
        { transcriptPersistIntervalMs: 0 },
      );
    });
  }
});
