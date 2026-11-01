import { describe, expect, test } from "bun:test";
import { isBuildPipeline, type BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { reviewerCouldNotStart } from "@orkestrator/protocol/review-fanout";
import {
  advanceUntil,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";

const PANEL = [
  { agent: "claude" as const, model: "opus" },
  { agent: "cursor" as const, model: "auto" },
];
const BRIDGE_MISSING =
  "cursor bridge directory not found: /data/backend/releases/2.34.4-beta/resources/cursor-bridge";

/** Ticks until the reviewer in `slot` has settled, returning that snapshot. */
async function untilReviewerSettles(
  service: Parameters<typeof advanceUntil>[0],
  read: (id: string) => Promise<BuildPipeline>,
  id: string,
  slot: number,
): Promise<BuildPipeline> {
  let current = await advanceUntil(service, read, id, "reviewing");
  for (let pass = 0; pass < 20; pass += 1) {
    const status = current.reviewFanout?.reviewers[slot]?.status;
    if (status === "failed" || status === "completed") return current;
    await service.advanceNow(id);
    current = await read(id);
  }
  return current;
}

describe("a pipeline reviewer whose agent cannot start", () => {
  test("is recorded as unable to start, with the reason, while the rest of the panel reviews", async () => {
    await withPipeline(async ({ service, read, provider, providers, unstartable }) => {
      unstartable.set("cursor", BRIDGE_MISSING);
      provider.runningModels.add("opus");
      const started = await service.start(startInput(PANEL));
      const reviewing = await untilReviewerSettles(service, read, started.id, 1);

      const cursor = reviewing.reviewFanout?.reviewers[1];
      expect(cursor?.status).toBe("failed");
      expect(cursor?.startFailed).toBe(true);
      expect(cursor?.error).toBe(BRIDGE_MISSING);
      expect(cursor?.providerSessionId).toBeUndefined();
      expect(reviewerCouldNotStart(cursor!)).toBe(true);
      // The other reviewer is still reviewing; the pipeline did not stop.
      expect(reviewing.phase).toBe("reviewing");
      expect(reviewing.reviewFanout?.reviewers[0]?.status).toBe("running");
      expect(isBuildPipeline(reviewing)).toBe(true);
      expect(providers.get("cursor")!.created).toEqual([]);

      provider.runningModels.delete("opus");
      const addressing = await advanceUntil(service, read, started.id, "addressing");
      expect(addressing.error ?? addressing.phase).toBe("addressing");
      // The surviving reviewer's report was consolidated without the missing one.
      expect(addressing.structuredReview?.reviewSummary).toBe("Merged review.");
      expect(
        addressing.sessions.find((session) => session.label === "Consolidation")
          ?.sessionlessReviewers,
      ).toEqual([expect.objectContaining({ slot: 1, agent: "cursor", error: BRIDGE_MISSING })]);
    });
  });

  test("a reviewer that fails after its session started is not reported as unable to start", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.failingModels.add("sonnet");
      provider.runningModels.add("opus");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      const reviewing = await untilReviewerSettles(service, read, started.id, 1);
      const sonnet = reviewing.reviewFanout?.reviewers[1];
      expect(sonnet?.status).toBe("failed");
      expect(sonnet?.providerSessionId).toBeDefined();
      expect(sonnet?.startFailed).toBeUndefined();
      expect(reviewerCouldNotStart(sonnet!)).toBe(false);
    });
  });

  test("a retry clears the record once the agent can start", async () => {
    await withPipeline(async ({ service, read, provider, unstartable }) => {
      unstartable.set("cursor", BRIDGE_MISSING);
      provider.runningModels.add("opus");
      const started = await service.start(startInput(PANEL));
      const reviewing = await untilReviewerSettles(service, read, started.id, 1);
      const failed = reviewing.reviewFanout!.reviewers[1]!;
      expect(failed.startFailed).toBe(true);

      unstartable.delete("cursor");
      // The retry starts the reviewer again straight away.
      await service.retryReviewer(started.id, failed.id);
      const retried = (await read(started.id)).reviewFanout!.reviewers[1]!;
      expect(retried.status).not.toBe("failed");
      expect(retried.startFailed).toBeUndefined();
      expect(retried.error).toBeUndefined();

      const settled = await untilReviewerSettles(service, read, started.id, 1);
      const cursor = settled.reviewFanout!.reviewers[1]!;
      expect(cursor.status).toBe("completed");
      expect(cursor.startFailed).toBeUndefined();
    });
  });
});
