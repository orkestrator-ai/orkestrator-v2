/**
 * D3 across engines (`workspace-writers.ts`): how a Build Pipeline and a
 * bespoke Multi Review use a checkout, the projection graph runs read, and
 * the claim a pipeline stage takes against graph runs.
 */
import { describe, expect, test } from "bun:test";
import { BUILD_PIPELINE_VERSION, type BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { MULTI_REVIEW_WORKFLOW_VERSION } from "@orkestrator/protocol/multi-review";
import { startBuilding, withService } from "./build-pipeline-service-test-support.js";
import type { StorageService } from "./storage.js";
import {
  WorkspaceBusyError,
  WorkspaceWriters,
  buildPipelineWorkspaceUse,
  multiReviewWorkspaceUse,
} from "./workspace-writers.js";

/** A bespoke Multi Review record as `isMultiReviewWorkflow` accepts it. */
function bespokeReview(id: string, phase: string): Record<string, unknown> {
  return {
    version: MULTI_REVIEW_WORKFLOW_VERSION,
    controller: "backend",
    id,
    environmentId: "env-1",
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [{ id: "reviewer-1", agent: "claude", model: "opus", status: "pending" }],
    fixModel: { agent: "claude", model: "opus" },
    phase,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    backendRevision: 1,
  };
}

const graphReview = (id: string) => ({
  ...bespokeReview(id, "reviewing"),
  engine: "graph",
  graphRun: { runId: `multi-review-${id}`, projectedRevision: 1 },
});

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function savePipeline(storage: StorageService, snapshot: BuildPipeline): Promise<void> {
  const current = await storage.getBuildPipeline(snapshot.id);
  await storage.saveBuildPipeline(
    snapshot.id,
    snapshot.projectId,
    snapshot.environmentId,
    BUILD_PIPELINE_VERSION,
    { ...snapshot, backendRevision: (current?.revision ?? 0) + 1 },
    current?.revision,
  );
}

describe("how another engine uses a checkout", () => {
  test("a Build Pipeline writes in its writing stages and setup, reads while reviewing", async () => {
    await withService(async (service, storage) => {
      const { started } = await startBuilding(service, storage);
      const building = (await storage.getBuildPipeline(started.id))!.snapshot as BuildPipeline;
      expect(buildPipelineWorkspaceUse(building)).toBe("write");
      const at = (phase: BuildPipeline["phase"], sessions = building.sessions) =>
        buildPipelineWorkspaceUse({ ...building, phase, sessions });
      const idle = building.sessions.map((session) => ({ ...session, status: "idle" as const }));
      expect(at("reviewing", idle)).toBe("read");
      for (const phase of ["fixing", "addressing", "verifying", "creating-pr"] as const) {
        expect(at(phase, idle)).toBe("write");
      }
      expect(at("waiting-for-setup", idle)).toBe("write");
      expect(at("starting-environment", idle)).toBeNull();
      expect(at("paused", idle)).toBeNull();
      expect(at("complete", idle)).toBeNull();
      // A session still running counts by its own stage, whatever the phase says.
      expect(at("paused", building.sessions)).toBe("write");
      expect(buildPipelineWorkspaceUse({ not: "a pipeline" })).toBeNull();
    });
  });

  test("a bespoke Multi Review writes while preparing or fixing; a graph-engine one is the graph's", () => {
    expect(multiReviewWorkspaceUse(bespokeReview("w1", "reviewing"))).toBe("read");
    expect(multiReviewWorkspaceUse(bespokeReview("w1", "cancelled"))).toBeNull();
    expect(multiReviewWorkspaceUse(graphReview("w2"))).toBeNull();
    expect(multiReviewWorkspaceUse({ phase: "fixing" })).toBeNull();
  });
});

describe("the shared projection", () => {
  test("seeds once, follows saves, and never lets a stale read win", async () => {
    await withService(async (service, storage) => {
      const { started } = await startBuilding(service, storage);
      await storage.saveMultiReviewWorkflow(
        "w1",
        "env-1",
        MULTI_REVIEW_WORKFLOW_VERSION,
        bespokeReview("w1", "reviewing"),
      );
      await storage.saveMultiReviewWorkflow(
        "w2",
        "env-1",
        MULTI_REVIEW_WORKFLOW_VERSION,
        graphReview("w2"),
      );
      const writers = new WorkspaceWriters(storage);
      expect(writers.externalHold("env-1")).toBeNull();
      expect(await writers.ready()).toBe(true);
      expect(writers.externalHold("env-1")).toEqual({
        writers: 1,
        readers: 1,
        holder: "build-pipeline",
        holderAccess: "write",
      });
      expect(writers.externalHold("env-2")).toEqual({ writers: 0, readers: 0 });
      expect(writers.holders("env-1").map((holder) => `${holder.kind}:${holder.id}`)).toEqual([
        `build-pipeline:${started.id}`,
        "multi-review:w1",
      ]);

      // A save elsewhere reaches the projection through the resource change.
      const building = (await storage.getBuildPipeline(started.id))!.snapshot as BuildPipeline;
      const paused = {
        ...building,
        phase: "paused" as const,
        sessions: building.sessions.map((session) => ({ ...session, status: "idle" as const })),
      };
      await savePipeline(storage, paused);
      await settle();
      expect(writers.externalHold("env-1")).toEqual({
        writers: 0,
        readers: 1,
        holder: "multi-review",
        holderAccess: "read",
      });

      // A note older than what the projection holds is ignored.
      writers.notePipeline(started.id, building, 1);
      expect(writers.externalHold("env-1")?.writers).toBe(0);

      // A deleted workflow leaves the projection.
      await storage.deleteBuildPipelinesByEnvironment("env-1");
      await settle();
      expect(writers.holders("env-1").map((holder) => holder.kind)).toEqual(["multi-review"]);
      writers.dispose();
    });
  });

  test("a stage claim checks graph holds, shows to graph runs, and goes on release", async () => {
    await withService(async (_service, storage) => {
      const writers = new WorkspaceWriters(storage);
      await writers.ready();
      let graph: { writers: number; readers: number } | null = null;
      writers.setGraphHoldProbe(() => graph);
      const holder = { kind: "build-pipeline" as const, id: "pipeline-1" };

      // Before the run service seeded its locks, a stage waits rather than guess.
      expect(() => writers.claim(holder, "env-1", "read")).toThrow(WorkspaceBusyError);

      graph = { writers: 1, readers: 0 };
      try {
        writers.claim(holder, "env-1", "read");
        throw new Error("the claim should wait");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceBusyError);
        expect((error as WorkspaceBusyError).reason).toBe("writing");
        expect((error as Error).message).toBe("Waiting: a graph run is writing this environment");
      }

      // Graph readers keep out a writing stage, not a reviewing one.
      graph = { writers: 0, readers: 2 };
      expect(() => writers.claim(holder, "env-1", "write")).toThrow(/reading this environment/);
      const review = writers.claim(holder, "env-1", "read");
      expect(writers.externalHold("env-1")).toEqual({
        writers: 0,
        readers: 1,
        holder: "build-pipeline",
        holderAccess: "read",
      });
      review.release();
      expect(writers.externalHold("env-1")).toEqual({ writers: 0, readers: 0 });

      graph = { writers: 0, readers: 0 };
      const build = writers.claim(holder, "env-1", "write");
      expect(writers.externalHold("env-1")?.writers).toBe(1);
      expect(writers.externalHold("env-2")?.writers).toBe(0);
      build.release();
      expect(writers.externalHold("env-1")?.writers).toBe(0);
      writers.dispose();
    });
  });
});
