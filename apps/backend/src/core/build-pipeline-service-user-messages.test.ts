/**
 * The user talking to a running build: the durable message queue and steering
 * (`build-pipeline-service-user-messages.ts`).
 */
import { describe, expect, test } from "bun:test";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { MAX_PIPELINE_USER_MESSAGES } from "@orkestrator/protocol/build-pipeline";
import { newReviewValidationRun } from "@orkestrator/protocol/review-workflow";
import { StorageService } from "./storage.js";
import { BuildPipelineService } from "./build-pipeline-service.js";
import { AmbiguousPromptDispatchError, PromptRejectedError } from "./build-pipeline-provider.js";
import {
  ScriptedProvider,
  snapshot,
  startBuilding,
  withService,
} from "./build-pipeline-service-recovery-test-support.js";

/** A build whose agent is mid-turn, as the supervisor has observed it. */
async function startRunning(
  service: BuildPipelineService,
  storage: StorageService,
  provider: ScriptedProvider,
) {
  const built = await startBuilding(service, storage);
  const sessionId = built.sessions.at(-1)!.sdkSessionId;
  provider.markRunning(sessionId);
  await service.advanceNow(built.id);
  expect((await snapshot(storage, built.id)).sessions.at(-1)?.status).toBe("running");
  return { built, sessionId };
}

async function updateStored(
  storage: StorageService,
  id: string,
  update: (pipeline: BuildPipeline) => void,
) {
  const record = (await storage.getBuildPipeline(id))!;
  const pipeline = record.snapshot as BuildPipeline;
  update(pipeline);
  await storage.saveBuildPipeline(
    record.id,
    record.projectId,
    record.environmentId,
    record.version,
    pipeline,
    record.revision,
  );
}

describe("BuildPipelineService user messages", () => {
  test("queues a message and delivers it when the agent next goes idle", async () => {
    await withService(async ({ service, storage, provider }) => {
      const built = await startBuilding(service, storage);
      const sessionId = built.sessions.at(-1)!.sdkSessionId;
      provider.markRunning(sessionId);

      const queued = await service.sendMessage(built.id, "  also update the README  ");
      expect(queued.pendingUserMessages).toHaveLength(1);
      expect(queued.pendingUserMessages?.[0]?.text).toBe("also update the README");

      // Still mid-turn: nothing is delivered yet.
      await service.advanceNow(built.id);
      expect(provider.sent.some((entry) => entry.prompt.includes("update the README"))).toBe(false);

      provider.markIdle(sessionId);
      await service.advanceNow(built.id);

      const delivered = await snapshot(storage, built.id);
      expect(delivered.pendingUserMessages).toBeUndefined();
      expect(provider.sent.at(-1)?.prompt).toBe("also update the README");
      // The stage is unchanged: the message is answered inside the build, and
      // the phase only advances once that turn finishes.
      expect(delivered.phase).toBe("building");
    });
  });

  test("delivers queued messages one at a time in order", async () => {
    await withService(async ({ service, storage, provider }) => {
      const built = await startBuilding(service, storage);
      const sessionId = built.sessions.at(-1)!.sdkSessionId;
      // Held mid-turn so both messages are queued before either is delivered.
      provider.markRunning(sessionId);
      await service.sendMessage(built.id, "first");
      await service.sendMessage(built.id, "second");
      expect((await snapshot(storage, built.id)).pendingUserMessages).toHaveLength(2);

      provider.markIdle(sessionId);
      await service.advanceNow(built.id);
      expect(provider.sent.at(-1)?.prompt).toBe("first");
      expect((await snapshot(storage, built.id)).pendingUserMessages).toHaveLength(1);

      await service.advanceNow(built.id);
      expect(provider.sent.at(-1)?.prompt).toBe("second");
      expect((await snapshot(storage, built.id)).pendingUserMessages).toBeUndefined();
    });
  });

  test("survives a lost dispatch without dropping or duplicating the message", async () => {
    await withService(async ({ service, storage, provider }) => {
      const built = await startBuilding(service, storage);
      await service.sendMessage(built.id, "check the migration");
      provider.sendErrors = [new AmbiguousPromptDispatchError("response lost")];

      await service.advanceNow(built.id);

      const pending = await snapshot(storage, built.id);
      // Out of the queue and into the durable attempt: exactly one owner.
      expect(pending.pendingUserMessages).toBeUndefined();
      expect(pending.pendingPromptAttempt?.prompt).toBe("check the migration");

      await service.advanceNow(built.id);
      expect(provider.sent.filter((entry) => entry.prompt === "check the migration")).toHaveLength(
        1,
      );
    });
  });

  test("holds messages sent while paused until the pipeline resumes", async () => {
    await withService(async ({ service, storage, provider }) => {
      const built = await startBuilding(service, storage);
      await service.pause(built.id);
      await service.sendMessage(built.id, "rethink the approach");

      await service.advanceNow(built.id);
      expect(provider.sent.some((entry) => entry.prompt.includes("rethink"))).toBe(false);

      await service.resume(built.id);
      await service.advanceNow(built.id);
      await service.advanceNow(built.id);

      expect(provider.sent.some((entry) => entry.prompt === "rethink the approach")).toBe(true);
    });
  });

  test("rejects blank, oversized, over-queued and finished-build messages", async () => {
    await withService(async ({ service, storage }) => {
      const built = await startBuilding(service, storage);

      await expect(service.sendMessage(built.id, "   ")).rejects.toThrow("must not be blank");
      await expect(service.sendMessage(built.id, "x".repeat(16_001))).rejects.toThrow(
        "character limit",
      );

      // Paused, so the supervisor pass each send kicks cannot drain the queue.
      await service.pause(built.id);
      for (let index = 0; index < MAX_PIPELINE_USER_MESSAGES; index += 1) {
        await service.sendMessage(built.id, `message ${index}`);
      }
      await expect(service.sendMessage(built.id, "one too many")).rejects.toThrow(
        "queued messages are allowed",
      );

      await service.cancel(built.id);
      await expect(service.sendMessage(built.id, "too late")).rejects.toThrow("has finished");
    });
  });

  test("drops queued messages when the build is cancelled", async () => {
    await withService(async ({ service, storage }) => {
      const built = await startBuilding(service, storage);
      await service.sendMessage(built.id, "never delivered");

      await service.cancel(built.id);

      expect((await snapshot(storage, built.id)).pendingUserMessages).toBeUndefined();
    });
  });

  test("re-prepares after a build follow-up before generating review evidence", async () => {
    await withService(async ({ service, storage, provider, packageGeneration }) => {
      const built = await startBuilding(service, storage);
      await service.sendMessage(built.id, "also cover the resumed-session path");
      await service.advanceNow(built.id);
      expect(provider.sent.at(-1)?.prompt).toBe("also cover the resumed-session path");

      await service.advanceNow(built.id);
      const preparing = await snapshot(storage, built.id);
      expect(preparing.phase).toBe("building");
      expect(provider.sent.at(-1)?.schema).toBeDefined();
      expect(provider.sent.at(-1)?.prompt).toContain("Prepare the immutable review package");
      expect(packageGeneration.count).toBe(0);

      await service.advanceNow(built.id);
      expect(packageGeneration.count).toBe(1);
      expect((await snapshot(storage, built.id)).phase).toBe("reviewing");
    });
  });
});

describe("BuildPipelineService steer", () => {
  test("injects into the running turn without waiting for the agent to go idle", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built, sessionId } = await startRunning(service, storage, provider);
      const sentBefore = provider.sent.length;

      const result = await service.steerMessage(built.id, "  use the existing helper  ");

      expect(result.delivery).toBe("steered");
      expect(provider.steers).toEqual([
        {
          sessionId,
          text: "use the existing helper",
          requestId: expect.any(String),
          expectedRunId: `run-${sessionId}`,
        },
      ]);
      // Not queued, and not a new prompt: the turn that is running received it.
      expect(result.pipeline.pendingUserMessages).toBeUndefined();
      expect(provider.sent).toHaveLength(sentBefore);

      // Still mid-turn, so the pipeline has not moved on to review.
      await service.advanceNow(built.id);
      const after = await snapshot(storage, built.id);
      expect(after.phase).toBe("building");
      expect(after.pendingUserMessages).toBeUndefined();
      expect(provider.sent).toHaveLength(sentBefore);
    });
  });

  test("forgets the earlier preparation result after steering an implementation turn", async () => {
    await withService(async ({ service, storage, provider }) => {
      const built = await startBuilding(service, storage);
      const sessionId = built.sessions.at(-1)!.sdkSessionId;
      // A follow-up forces the build session through preparation again.
      await service.sendMessage(built.id, "also cover the resumed-session path");
      await service.advanceNow(built.id);
      await service.advanceNow(built.id);
      expect(provider.sent.at(-1)?.schema).toBeDefined();
      provider.markRunning(sessionId);
      await service.advanceNow(built.id);
      await service.advanceNow(built.id);
      const preparing = (await snapshot(storage, built.id)).sessions.at(-1)!;
      expect(preparing.status).toBe("running");
      expect(preparing.structuredRequestId).toBeDefined();

      const result = await service.steerMessage(built.id, "change the plan");

      expect(result.delivery).toBe("steered");
      const steered = (await snapshot(storage, built.id)).sessions.at(-1)!;
      expect(steered.structuredRequestId).toBeUndefined();
      expect(steered.structuredResultStatus).toBeUndefined();
    });
  });

  test("queues the instruction when no turn is running", async () => {
    await withService(async ({ service, storage, provider }) => {
      const built = await startBuilding(service, storage);
      provider.statusOverride = "blocked";
      // Paused: no running turn, and the drain pass a queued message kicks off
      // cannot deliver it.
      await service.pause(built.id);
      provider.statusOverride = null;

      const result = await service.steerMessage(built.id, "rethink the approach");

      expect(result.delivery).toBe("queued");
      expect(provider.steers).toHaveLength(0);
      expect(result.pipeline.pendingUserMessages?.map((entry) => entry.text)).toEqual([
        "rethink the approach",
      ]);
    });
  });

  test("queues the instruction when the bridge cannot steer", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built } = await startRunning(service, storage, provider);
      provider.steerQualified = false;

      const result = await service.steerMessage(built.id, "use the existing helper");

      expect(result.delivery).toBe("queued");
      expect(provider.steers).toHaveLength(0);
      expect(result.pipeline.pendingUserMessages).toHaveLength(1);
    });
  });

  test("queues the instruction when the turn ended before delivery", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built } = await startRunning(service, storage, provider);
      provider.steerOutcome = { outcome: "idle" };

      const result = await service.steerMessage(built.id, "too late for the turn");

      expect(result.delivery).toBe("queued");
      expect(result.pipeline.pendingUserMessages?.[0]?.text).toBe("too late for the turn");
    });
  });

  test("queues without targeting the previous turn while a dispatch is pending", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built, sessionId } = await startRunning(service, storage, provider);
      const sentBefore = provider.sent.length;
      await updateStored(storage, built.id, (pipeline) => {
        pipeline.pendingPromptAttempt = {
          id: "pending-attempt",
          requestId: "pending-request",
          sessionId,
          phase: "building",
          prompt: "next turn",
          useTaskImages: false,
          startedAt: new Date().toISOString(),
        };
      });
      // Keep the supervisor's follow-up dispatch parked too.
      provider.sendErrors.push(new AmbiguousPromptDispatchError("response lost"));

      const result = await service.steerMessage(built.id, "do not steer the old turn");

      expect(result.delivery).toBe("queued");
      expect(result.pipeline.pendingUserMessages?.[0]?.text).toBe("do not steer the old turn");
      expect(result.pipeline.pendingPromptAttempt?.requestId).toBe("pending-request");
      expect(provider.steers).toHaveLength(0);
      expect(provider.sent).toHaveLength(sentBefore);
    });
  });

  test("queues a run mismatch instead of steering a replacement turn", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built, sessionId } = await startRunning(service, storage, provider);
      provider.steerOutcome = { outcome: "mismatch" };

      const result = await service.steerMessage(built.id, "the old run ended");

      expect(result.delivery).toBe("queued");
      expect(result.pipeline.pendingUserMessages?.[0]?.text).toBe("the old run ended");
      expect(provider.steers).toHaveLength(1);
      expect(provider.steers[0]?.expectedRunId).toBe(`run-${sessionId}`);
    });
  });

  for (const probe of ["steerSupported", "activeSteerRun"] as const) {
    test(`queues without delivering when ${probe} fails`, async () => {
      await withService(async ({ service, storage, provider }) => {
        const { built } = await startRunning(service, storage, provider);
        provider[probe] = async () => {
          throw new Error("capability probe unavailable");
        };

        const result = await service.steerMessage(built.id, "wait for a safe turn");

        expect(result.delivery).toBe("queued");
        expect(result.pipeline.pendingUserMessages?.[0]?.text).toBe("wait for a safe turn");
        expect(provider.steers).toHaveLength(0);
      });
    });
  }

  for (const state of ["idle", "unknown", "unsupported"] as const) {
    test(`queues without delivering when the active run is ${state}`, async () => {
      await withService(async ({ service, storage, provider }) => {
        const { built } = await startRunning(service, storage, provider);
        provider.activeSteerRun = async () => ({ state });

        const result = await service.steerMessage(built.id, "wait for a steerable turn");

        expect(result.delivery).toBe("queued");
        expect(result.pipeline.pendingUserMessages).toHaveLength(1);
        expect(provider.steers).toHaveLength(0);
      });
    });
  }

  for (const phase of ["building", "fixing"] as const) {
    for (const failure of ["throw", "unknown", "refused"] as const) {
      test(`${failure} steer delivery ${failure === "refused" ? "preserves" : "invalidates"} ${phase} preparation without requeueing`, async () => {
        await withService(async ({ service, storage, provider }) => {
          const { built } = await startRunning(service, storage, provider);
          await updateStored(storage, built.id, (pipeline) => {
            pipeline.phase = phase;
            const session = pipeline.sessions.at(-1)!;
            session.phase = phase === "building" ? "build" : "fix";
            session.structuredRequestId = "old-preparation";
            session.structuredResultStatus = "accepted";
            session.structuredWaitStartedAt = new Date().toISOString();
            session.producedReviewPackagePlan = true;
          });
          const perform = provider.performSessionAction.bind(provider);
          provider.performSessionAction = async (...args) => {
            if (failure === "refused") throw new PromptRejectedError("not sent");
            await perform(...args);
            if (failure === "throw") throw new Error("response lost after delivery");
            return { outcome: "unknown", requestId: args[1].requestId! };
          };

          await expect(service.steerMessage(built.id, "change the implementation")).rejects.toThrow(
            failure === "refused" ? "not sent" : "could not be confirmed",
          );

          const after = await snapshot(storage, built.id);
          const session = after.sessions.at(-1)!;
          expect(after.pendingUserMessages).toBeUndefined();
          expect(provider.steers).toHaveLength(failure === "refused" ? 0 : 1);
          if (failure === "refused") {
            expect(session.structuredRequestId).toBe("old-preparation");
            expect(session.structuredResultStatus).toBe("accepted");
            expect(session.structuredWaitStartedAt).toBeDefined();
          } else {
            expect(session.structuredRequestId).toBeUndefined();
            expect(session.structuredResultStatus).toBeUndefined();
            expect(session.structuredWaitStartedAt).toBeUndefined();
          }
          expect(session.producedReviewPackagePlan).toBe(true);
        });
      });
    }
  }

  for (const transition of ["advance", "cancel"] as const) {
    test(`fences ${transition} while a live steer is awaiting delivery`, async () => {
      await withService(async ({ service, storage, provider }) => {
        const { built, sessionId } = await startRunning(service, storage, provider);
        const entered = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        const perform = provider.performSessionAction.bind(provider);
        provider.performSessionAction = async (...args) => {
          entered.resolve();
          await released.promise;
          return perform(...args);
        };
        let transitionSettled = false;
        const steering = service.steerMessage(built.id, "keep this stage open");
        await entered.promise;
        // The provider ends its turn while delivery is held. An unfenced
        // supervisor could now move the pipeline to preparation/review.
        provider.markIdle(sessionId);
        const changing = (
          transition === "advance" ? service.advanceNow(built.id) : service.cancel(built.id)
        ).then(() => {
          transitionSettled = true;
        });
        try {
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(transitionSettled).toBe(false);
          const during = await snapshot(storage, built.id);
          expect(during.phase).toBe("building");
          expect(during.sessions).toHaveLength(built.sessions.length);
          expect(provider.steers).toHaveLength(0);
        } finally {
          released.resolve();
          await Promise.all([steering, changing]);
        }
        expect((await steering).delivery).toBe("steered");
        expect(provider.steers).toHaveLength(1);
        const after = await snapshot(storage, built.id);
        expect(after.phase).toBe(transition === "cancel" ? "failed" : "building");
        if (transition === "advance") {
          // A coalesced tick joins the steer; the next tick advances normally.
          await service.advanceNow(built.id);
          expect(provider.sent.at(-1)?.schema).toBeDefined();
        }
      });
    });
  }

  test("a queued follow-up stays queued when a later instruction steers the live turn", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built } = await startRunning(service, storage, provider);
      await service.sendMessage(built.id, "follow up after this turn");

      const result = await service.steerMessage(built.id, "change this turn now");

      expect(result.delivery).toBe("steered");
      expect(result.pipeline.pendingUserMessages?.map((entry) => entry.text)).toEqual([
        "follow up after this turn",
      ]);
      expect(provider.steers.map((entry) => entry.text)).toEqual(["change this turn now"]);
    });
  });

  test("does not queue a steer the bridge refused", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built } = await startRunning(service, storage, provider);
      provider.steerOutcome = {
        outcome: "rejected",
        requestId: "r",
        reason: "steer-capacity-exceeded",
      };

      await expect(service.steerMessage(built.id, "no room")).rejects.toThrow(
        "cannot accept more steering",
      );

      // Not sent, so it must not be delivered later by the queue either: the
      // caller still holds the text and decides.
      expect((await snapshot(storage, built.id)).pendingUserMessages).toBeUndefined();
    });
  });

  test("does not requeue a steer whose delivery cannot be confirmed", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built } = await startRunning(service, storage, provider);
      provider.steerOutcome = { outcome: "unknown", requestId: "r" };

      await expect(service.steerMessage(built.id, "maybe delivered")).rejects.toThrow(
        "could not be confirmed",
      );

      // A second delivery through the queue could steer the turn twice.
      expect((await snapshot(storage, built.id)).pendingUserMessages).toBeUndefined();
      expect(provider.steers).toHaveLength(1);
    });
  });

  test("rejects blank, oversized and finished-build steers", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built } = await startRunning(service, storage, provider);

      await expect(service.steerMessage(built.id, "   ")).rejects.toThrow("must not be blank");
      await expect(service.steerMessage(built.id, "x".repeat(16_001))).rejects.toThrow(
        "character limit",
      );
      expect(provider.steers).toHaveLength(0);

      await service.cancel(built.id);
      await expect(service.steerMessage(built.id, "too late")).rejects.toThrow("has finished");
      expect(provider.steers).toHaveLength(0);
    });
  });
});

describe("BuildPipelineService queued steer", () => {
  /** A build whose agent is mid-turn, with `text` waiting in the queue. */
  async function startWithQueued(
    service: BuildPipelineService,
    storage: StorageService,
    provider: ScriptedProvider,
    text = "use the existing helper",
  ) {
    const { built, sessionId } = await startRunning(service, storage, provider);
    const queued = await service.sendMessage(built.id, text);
    return { built, sessionId, messageId: queued.pendingUserMessages!.at(-1)!.id };
  }

  test("moves the message into the running turn and out of the queue", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built, sessionId, messageId } = await startWithQueued(service, storage, provider);
      const sentBefore = provider.sent.length;

      const result = await service.steerQueuedMessage(built.id, messageId);

      expect(result.delivery).toBe("steered");
      expect(result.notice).toBeUndefined();
      expect(result.pipeline.pendingUserMessages).toBeUndefined();
      expect(provider.steers).toEqual([
        {
          sessionId,
          text: "use the existing helper",
          requestId: expect.any(String),
          expectedRunId: `run-${sessionId}`,
        },
      ]);

      // The queue must not deliver it a second time when the turn ends.
      provider.markIdle(sessionId);
      await service.advanceNow(built.id);
      expect(provider.sent.slice(sentBefore).map((entry) => entry.prompt)).not.toContain(
        "use the existing helper",
      );
    });
  });

  for (const outcome of ["applied", "unknown"] as const) {
    test(`retains a durable attempt after ${outcome} delivery and a failed final save`, async () => {
      await withService(async ({ service, storage, provider }) => {
        const { built, sessionId, messageId } = await startWithQueued(service, storage, provider);
        const sentBefore = provider.sent.length;
        const originalSave = storage.saveBuildPipeline.bind(storage);
        let delivered = false;
        storage.saveBuildPipeline = async (...args) => {
          if (delivered) throw new Error("injected post-delivery save failure");
          return originalSave(...args);
        };
        const originalAction = provider.performSessionAction.bind(provider);
        provider.performSessionAction = async (...args) => {
          const stored = await snapshot(storage, built.id);
          expect(stored.pendingUserMessages).toBeUndefined();
          expect(stored.pendingUserSteers?.[0]?.requestId).toBe(args[1].requestId);
          const result = await originalAction(...args);
          delivered = true;
          return result;
        };
        provider.steerOutcome = { outcome, requestId: "r" };
        try {
          await expect(service.steerQueuedMessage(built.id, messageId)).rejects.toThrow("injected");
        } finally {
          storage.saveBuildPipeline = originalSave;
        }
        const recovered = await snapshot(storage, built.id);
        expect(recovered.pendingUserMessages).toBeUndefined();
        expect(recovered.pendingUserSteers?.[0]?.text).toBe("use the existing helper");
        // A fresh service reads only persisted state, as after a backend restart.
        await service.shutdown();
        const restarted = new BuildPipelineService(storage, async <T>() => undefined as T, {
          autoAdvance: false,
          provider: async () => provider,
        });
        try {
          provider.markIdle(sessionId);
          await restarted.advanceNow(built.id);
          expect(provider.sent.slice(sentBefore).map((entry) => entry.prompt)).not.toContain(
            "use the existing helper",
          );
          expect(provider.steers).toHaveLength(1);
        } finally {
          await restarted.shutdown();
        }
      });
    });
  }

  test("does not contact the provider if the attempt cannot be persisted", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built, messageId } = await startWithQueued(service, storage, provider);
      const save = storage.saveBuildPipeline.bind(storage);
      storage.saveBuildPipeline = async () => {
        throw new Error("disk unavailable");
      };
      try {
        await expect(service.steerQueuedMessage(built.id, messageId)).rejects.toThrow(
          "disk unavailable",
        );
      } finally {
        storage.saveBuildPipeline = save;
      }
      expect(provider.steers).toHaveLength(0);
      expect((await snapshot(storage, built.id)).pendingUserMessages?.[0]?.id).toBe(messageId);
    });
  });

  test("steers only the requested message and keeps the rest in order", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built } = await startRunning(service, storage, provider);
      await service.sendMessage(built.id, "first");
      const second = await service.sendMessage(built.id, "second");
      const third = await service.sendMessage(built.id, "third");
      expect(third.pendingUserMessages).toHaveLength(3);

      const result = await service.steerQueuedMessage(
        built.id,
        second.pendingUserMessages!.at(-1)!.id,
      );

      expect(result.delivery).toBe("steered");
      expect(provider.steers.map((entry) => entry.text)).toEqual(["second"]);
      expect(result.pipeline.pendingUserMessages?.map((entry) => entry.text)).toEqual([
        "first",
        "third",
      ]);
    });
  });

  test("leaves the message queued when the bridge cannot steer", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built, messageId } = await startWithQueued(service, storage, provider);
      provider.steerQualified = false;

      const result = await service.steerQueuedMessage(built.id, messageId);

      expect(result.delivery).toBe("queued");
      expect(result.notice).toBeUndefined();
      expect(provider.steers).toHaveLength(0);
      expect(result.pipeline.pendingUserMessages?.map((entry) => entry.id)).toEqual([messageId]);
    });
  });

  for (const outcome of ["idle", "mismatch"] as const) {
    test(`keeps the message for the next turn when delivery answers ${outcome}`, async () => {
      await withService(async ({ service, storage, provider }) => {
        const { built, messageId } = await startWithQueued(service, storage, provider);
        provider.steerOutcome = { outcome };

        const result = await service.steerQueuedMessage(built.id, messageId);

        expect(result.delivery).toBe("next-turn");
        expect(result.pipeline.pendingUserMessages?.map((entry) => entry.id)).toEqual([messageId]);
      });
    });
  }

  test("keeps the message for the next turn when the bridge reports no running turn", async () => {
    await withService(async ({ service, storage, provider }) => {
      // The stage is `running` as far as the pipeline knows, as during a
      // background wait, while the bridge has no turn to steer.
      const { built, messageId } = await startWithQueued(service, storage, provider);
      provider.activeSteerRun = async () => ({ state: "idle" });

      const result = await service.steerQueuedMessage(built.id, messageId);

      expect(result.delivery).toBe("next-turn");
      expect(provider.steers).toHaveLength(0);
      expect(result.pipeline.pendingUserMessages?.map((entry) => entry.id)).toEqual([messageId]);
    });
  });

  test("keeps a refused message queued and says why", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built, sessionId, messageId } = await startWithQueued(service, storage, provider);
      provider.steerOutcome = {
        outcome: "rejected",
        requestId: "r",
        reason: "steer-capacity-exceeded",
      };

      const result = await service.steerQueuedMessage(built.id, messageId);

      expect(result.delivery).toBe("queued");
      expect(result.notice).toContain("cannot accept more steering");
      expect(result.pipeline.pendingUserSteers).toBeUndefined();
      provider.markIdle(sessionId);
      await service.advanceNow(built.id);
      expect(provider.sent.at(-1)?.prompt).toBe("use the existing helper");
      expect(result.pipeline.pendingUserMessages?.map((entry) => entry.id)).toEqual([messageId]);
    });
  });

  test("treats a provider's explicit refusal as definitive", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built, messageId } = await startWithQueued(service, storage, provider);
      provider.performSessionAction = async () => {
        throw new PromptRejectedError("The turn is not accepting steering");
      };

      const result = await service.steerQueuedMessage(built.id, messageId);

      expect(result.delivery).toBe("queued");
      expect(result.notice).toBe("The turn is not accepting steering");
      expect(result.pipeline.pendingUserMessages).toHaveLength(1);
    });
  });

  test("takes an unconfirmed message out of the queue rather than deliver it twice", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built, sessionId, messageId } = await startWithQueued(service, storage, provider);
      const sentBefore = provider.sent.length;
      provider.steerOutcome = { outcome: "unknown", requestId: "r" };

      const result = await service.steerQueuedMessage(built.id, messageId);

      expect(result.delivery).toBe("unconfirmed");
      expect(result.notice).toContain("could not be confirmed");
      expect((await snapshot(storage, built.id)).pendingUserMessages).toBeUndefined();

      provider.markIdle(sessionId);
      await service.advanceNow(built.id);
      expect(provider.sent.slice(sentBefore).map((entry) => entry.prompt)).not.toContain(
        "use the existing helper",
      );
    });
  });

  test("treats a transport failure during the steer as unconfirmed", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built, messageId } = await startWithQueued(service, storage, provider);
      provider.performSessionAction = async () => {
        throw new Error("socket hang up");
      };

      const result = await service.steerQueuedMessage(built.id, messageId);

      expect(result.delivery).toBe("unconfirmed");
      expect(result.pipeline.pendingUserMessages).toBeUndefined();
    });
  });

  test("reports a message that already left the queue without steering anything", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built, sessionId, messageId } = await startWithQueued(service, storage, provider);
      provider.markIdle(sessionId);
      await service.advanceNow(built.id);
      expect((await snapshot(storage, built.id)).pendingUserMessages).toBeUndefined();

      const result = await service.steerQueuedMessage(built.id, messageId);

      expect(result.delivery).toBe("gone");
      expect(provider.steers).toHaveLength(0);
    });
  });

  test("refuses while the build is not taking messages, and keeps the message", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built, messageId } = await startWithQueued(service, storage, provider);
      await updateStored(storage, built.id, (pipeline) => {
        pipeline.validationRun = newReviewValidationRun("validation-1", {
          headRef: "1".repeat(40),
          commands: [],
          limitations: ["No validation command is configured for this test"],
        });
      });

      await expect(service.steerQueuedMessage(built.id, messageId)).rejects.toThrow(
        "Validation is running",
      );

      expect(provider.steers).toHaveLength(0);
      expect((await snapshot(storage, built.id)).pendingUserMessages).toHaveLength(1);
    });
  });
});

describe("BuildPipelineService queued message removal", () => {
  test("takes a queued message back so it is never delivered", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built, sessionId } = await startRunning(service, storage, provider);
      await service.sendMessage(built.id, "keep me");
      const queued = await service.sendMessage(built.id, "never mind");
      const sentBefore = provider.sent.length;

      const result = await service.removeQueuedMessage(
        built.id,
        queued.pendingUserMessages!.at(-1)!.id,
      );

      expect(result.removed).toBe(true);
      expect(result.pipeline.pendingUserMessages?.map((entry) => entry.text)).toEqual(["keep me"]);

      provider.markIdle(sessionId);
      await service.advanceNow(built.id);
      expect(provider.sent.slice(sentBefore).map((entry) => entry.prompt)).toEqual(["keep me"]);
    });
  });

  test("says when the message had already left the queue", async () => {
    await withService(async ({ service, storage, provider }) => {
      const { built, sessionId } = await startRunning(service, storage, provider);
      const queued = await service.sendMessage(built.id, "already on its way");
      provider.markIdle(sessionId);
      await service.advanceNow(built.id);

      const result = await service.removeQueuedMessage(
        built.id,
        queued.pendingUserMessages!.at(-1)!.id,
      );

      expect(result.removed).toBe(false);
      expect(result.pipeline.pendingUserMessages).toBeUndefined();
    });
  });
});
