import { describe, expect, test } from "bun:test";
import { failedStepTarget } from "./build-pipeline-restart-targets.js";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { BuildPipelineService } from "./build-pipeline-service.js";
import type { StorageService } from "./storage.js";
import { TEST_FIX_RESULT, TEST_REVIEW_PREPARATION } from "./build-pipeline-test-fixtures.js";
import {
  cleanReview,
  mutateStored,
  pipeline,
  startBuilding,
  startInput,
  withService,
  type FakeProvider,
} from "./build-pipeline-service-test-support.js";

// The coordinator's restart_build_pipeline_step at the service: which step it
// resolves, what it keeps, and what it refuses. Fake providers only.

const advanceUntil = async (
  service: BuildPipelineService,
  storage: StorageService,
  id: string,
  done: (snapshot: BuildPipeline) => boolean,
): Promise<BuildPipeline> => {
  for (let pass = 0; pass < 60; pass += 1) {
    const snapshot = await pipeline(storage, id);
    if (done(snapshot)) return snapshot;
    await service.advanceNow(id);
  }
  throw new Error(
    `The pipeline did not reach the expected state: ${(await pipeline(storage, id)).phase}`,
  );
};

/** Every verification fails, so a round ends in a Fix. */
const failVerification = (provider: FakeProvider) => {
  provider.structured = async <T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T>> => {
    const phase = provider.phases.get(sessionId);
    return {
      ok: true,
      provider: "claude",
      requestId,
      value: (phase === "review"
        ? cleanReview
        : phase === "build" || phase === "fix"
          ? TEST_REVIEW_PREPARATION
          : phase === "address"
            ? TEST_FIX_RESULT
            : { complete: false, rationale: "Still failing." }) as T,
    };
  };
};

/** The stored state `fail()` leaves when the running step's turn errors. */
const failCurrentStep = (storage: StorageService, id: string, error: string) =>
  mutateStored(storage, id, (snapshot) => {
    const session = snapshot.sessions[snapshot.currentSessionIndex]!;
    snapshot.failureContext = {
      phase: snapshot.phase as "building",
      kind: "stage-transition",
      sessionId: session.sdkSessionId,
    };
    session.status = "error";
    snapshot.error = error;
    snapshot.phase = "failed";
  });

describe("restart_build_pipeline_step at the service", () => {
  test("restarts the Fix a pipeline failed in and keeps the earlier round", async () => {
    await withService(async (service, storage, provider) => {
      failVerification(provider);
      const started = await service.start(startInput({ maxIterations: 2 }));
      const fixing = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "fixing",
      );
      expect(fixing.iteration).toBe(1);
      const failedFix = fixing.sessions[fixing.currentSessionIndex]!;
      expect(failedFix.phase).toBe("fix");
      const roundOne = fixing.sessions.filter((session) => session.iteration === 0);
      await failCurrentStep(storage, started.id, "Claude usage limit reached");
      const created = provider.created.length;
      // The new Fix keeps running, so later sessions come only from restarts.
      provider.runningPhases.add("fix");

      const {
        pipeline: restarted,
        step,
        alreadyRestarted,
      } = await service.restartForCoordinator(started.id, undefined);

      expect(alreadyRestarted).toBe(false);
      expect(step).toMatchObject({ phase: "fix", round: 2, sessionKey: failedFix.sessionKey });
      expect(restarted.phase).toBe("fixing");
      expect(restarted.iteration).toBe(1);
      expect(restarted.error).toBeUndefined();
      expect(restarted.failureContext).toBeUndefined();
      // Round one is untouched; only the failed Fix became a previous attempt.
      for (const session of roundOne) {
        expect(
          restarted.sessions.find((item) => item.sessionKey === session.sessionKey)?.supersededBy,
        ).toBeUndefined();
      }
      expect(
        restarted.sessions.find((item) => item.sessionKey === failedFix.sessionKey)?.supersededBy,
      ).toBeDefined();
      expect(provider.created.slice(created).map((entry) => entry.phase)).toEqual(["fix"]);

      // The same named step again is the restart already done: nothing reruns.
      const repeated = await service.restartForCoordinator(started.id, failedFix.sessionKey);
      expect(repeated.alreadyRestarted).toBe(true);
      expect(provider.created.length).toBe(created + 1);
      expect(repeated.pipeline.rewinds).toHaveLength(restarted.rewinds!.length);
    });
  });

  test("restarts the failed step on another agent or model", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage, {
        steps: { build: { agent: "claude", model: "opus" } },
      });
      await failCurrentStep(storage, started.id, "Claude usage limit reached");

      const { pipeline: restarted, step } = await service.restartForCoordinator(
        started.id,
        undefined,
        { agent: "claude", model: "sonnet", reasoningEffort: "high" },
      );

      expect(step).toMatchObject({ phase: "build", round: 1, sessionKey: session.sessionKey });
      expect(restarted.steps?.build).toMatchObject({ model: "sonnet", reasoningEffort: "high" });
      expect(restarted.sessions.at(-1)).toMatchObject({ phase: "build", model: "sonnet" });
      expect(provider.created.at(-1)?.options).toMatchObject({ model: "sonnet" });
    });
  });

  test("restarts a named step and the current step of a paused pipeline", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage);
      await service.pause(started.id);
      const created = provider.created.length;

      const current = await service.restartForCoordinator(started.id, undefined);
      expect(current.step).toMatchObject({ phase: "build", sessionKey: session.sessionKey });
      expect(current.pipeline.phase).toBe("building");
      expect(provider.created.length).toBe(created + 1);

      const live = current.pipeline.sessions.at(-1)!;
      const named = await service.restartForCoordinator(started.id, live.sessionKey);
      expect(named.step.sessionKey).toBe(live.sessionKey);
      expect(provider.created.length).toBe(created + 2);
    });
  });

  test("refuses an unknown step without changing the pipeline", async () => {
    await withService(async (service, storage) => {
      const { started } = await startBuilding(service, storage);
      const before = await pipeline(storage, started.id);
      await expect(service.restartForCoordinator(started.id, "no-such-step")).rejects.toThrow(
        'no step "no-such-step"',
      );
      expect((await pipeline(storage, started.id)).sessions).toEqual(before.sessions);
    });
  });

  test("refuses a cancelled pipeline", async () => {
    await withService(async (service, storage) => {
      const { started } = await startBuilding(service, storage);
      await failCurrentStep(storage, started.id, "usage limit");
      await service.cancel(started.id);
      const before = await pipeline(storage, started.id);
      expect(before.failureContext).toBeDefined();
      await expect(service.restartForCoordinator(started.id, undefined)).rejects.toThrow(
        "was cancelled",
      );
      expect((await pipeline(storage, started.id)).sessions).toEqual(before.sessions);
      expect((await pipeline(storage, started.id)).phase).toBe("failed");
    });
  });

  test("refuses a completed pipeline and a failure before any step", async () => {
    await withService(async (service, storage) => {
      const { started } = await startBuilding(service, storage);
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.phase = "complete";
      });
      await expect(service.restartForCoordinator(started.id, undefined)).rejects.toThrow(
        "has completed",
      );
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.phase = "failed";
        snapshot.error = "The worktree could not be created";
        snapshot.failureContext = { phase: "creating-environment", kind: "stage-transition" };
      });
      await expect(service.restartForCoordinator(started.id, undefined)).rejects.toThrow(
        "before any step started",
      );
      await mutateStored(storage, started.id, (snapshot) => {
        delete snapshot.failureContext;
      });
      await expect(service.restartForCoordinator(started.id, undefined)).rejects.toThrow(
        "outside any step",
      );
    });
  });
});

test.each(["building", "fixing"] as const)(
  "changes selection after a pre-session %s failure and deduplicates saved restarts",
  async (phase) => {
    await withService(async (service, storage, provider) => {
      const { started } = await startBuilding(service, storage);
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.sessions.forEach((session) => {
          session.status = "idle";
        });
        snapshot.iteration = 1;
        snapshot.phase = "failed";
        snapshot.failureContext = { phase, kind: "stage-transition" };
      });
      const earlier = (await pipeline(storage, started.id)).sessions;
      provider.runningPhases.add(phase === "building" ? "build" : "fix");
      const selection = { agent: "claude" as const, model: "sonnet" };
      const first = await service.restartForCoordinator(
        started.id,
        undefined,
        selection,
        "durable-request",
      );
      expect(first.pipeline.sessions.at(-1)?.model).toBe("sonnet");
      expect(provider.created.at(-1)?.options).toMatchObject({ model: "sonnet" });
      for (const session of earlier)
        expect(first.pipeline.sessions.find((s) => s.sessionKey === session.sessionKey)).toEqual(
          session,
        );
      const created = provider.created.length;
      // Discard in-memory state as at a restart between the pipeline save and receipt completion.
      await service.shutdown();
      await service.init();
      const retry = await service.restartForCoordinator(
        started.id,
        undefined,
        selection,
        "durable-request",
      );
      expect(retry.alreadyRestarted).toBe(true);
      expect(retry.step).toEqual(first.step);
      expect(provider.created.length).toBe(created);
      await expect(
        service.restartForCoordinator(
          started.id,
          undefined,
          { ...selection, model: "opus" },
          "durable-request",
        ),
      ).rejects.toThrow("different intent");
    });
  },
);

test("failed targets ignore a session from another phase and distinguish validation/package preparation", async () => {
  await withService(async (service, storage) => {
    const { started, session } = await startBuilding(service, storage);
    const snapshot = await pipeline(storage, started.id);
    snapshot.phase = "failed";
    snapshot.failureContext = {
      phase: "fixing",
      kind: "stage-transition",
      sessionId: session.sdkSessionId,
    };
    expect(failedStepTarget(snapshot)).toEqual({ kind: "session", phase: "fix" });
    snapshot.failureContext = { phase: "building", kind: "stage-transition" };
    snapshot.validationRun = {
      id: "validation",
      status: "failed",
    } as BuildPipeline["validationRun"];
    delete snapshot.reviewPackage;
    expect(failedStepTarget(snapshot)).toEqual({ kind: "validation" });
    snapshot.reviewRetryRequested = true;
    expect(failedStepTarget(snapshot)).toEqual({
      kind: "review-package",
      implementationPhase: "build",
    });
  });
});
