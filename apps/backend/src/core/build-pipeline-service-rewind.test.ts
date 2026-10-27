import { describe, expect, spyOn, test } from "bun:test";
import type { BuildPipeline, PipelineSession } from "@orkestrator/protocol/build-pipeline";
import {
  isBuildPipeline,
  REVIEW_PACKAGE_SESSION_LABEL,
} from "@orkestrator/protocol/build-pipeline";
import { newReviewValidationRun } from "@orkestrator/protocol/review-workflow";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import { BuildPipelineService } from "./build-pipeline-service.js";
import { BuildPipelineSupervisor } from "./build-pipeline-service-supervisor.js";
import type { StorageService } from "./storage.js";
import { TEST_REVIEW_PREPARATION } from "./build-pipeline-test-fixtures.js";
import {
  cleanReview,
  type FakeProvider,
  withService,
  pipeline,
  startInput,
  startBuilding,
  mutateStored,
} from "./build-pipeline-service-test-support.js";

describe("rewinding to an earlier step", () => {
  /** Verification fails every time, naming the session that judged it. */
  const failEveryVerification = (provider: FakeProvider) => {
    provider.structured = async <T>(
      sessionId: string,
      requestId: string,
    ): Promise<StructuredOutputResult<T>> => ({
      ok: true,
      provider: "claude",
      requestId,
      value: (provider.phases.get(sessionId) === "review"
        ? cleanReview
        : provider.phases.get(sessionId) === "build" || provider.phases.get(sessionId) === "fix"
          ? TEST_REVIEW_PREPARATION
          : { complete: false, rationale: `Still failing (${sessionId}).` }) as T,
    });
  };

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
    throw new Error("The pipeline did not reach the expected state");
  };

  const live = (snapshot: BuildPipeline) =>
    snapshot.sessions.filter((session) => session.supersededBy === undefined);
  const shape = (sessions: PipelineSession[]) =>
    sessions.map((session) => `${session.phase}:${session.iteration}`);

  test("restarting round 1's Verify after the last round failed rewinds and loops again", async () => {
    await withService(async (service, storage, provider) => {
      failEveryVerification(provider);
      const started = await service.start(startInput({ maxIterations: 3 }));
      const failed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "failed",
      );
      expect(failed).toMatchObject({
        iteration: 3,
        error: expect.stringContaining("failed after 3 iterations"),
      });
      const firstVerify = failed.sessions.find(
        (session) => session.phase === "verify" && session.iteration === 0,
      )!;
      const supersededKeys = failed.sessions
        .slice(failed.sessions.indexOf(firstVerify))
        .map((session) => session.sessionKey);
      expect(supersededKeys).toHaveLength(10);

      const restarted = await service.restartStep(started.id, firstVerify.sdkSessionId);

      expect(restarted).toMatchObject({ phase: "verifying", iteration: 0 });
      expect(restarted.error).toBeUndefined();
      expect(restarted.failureContext).toBeUndefined();
      expect(restarted.rewinds).toEqual([
        {
          id: expect.any(String),
          at: expect.any(String),
          fromPhase: "failed",
          fromIteration: 3,
          iteration: 0,
          step: { kind: "session", phase: "verify" },
          sessionKey: firstVerify.sessionKey,
          supersededSessions: 10,
        },
      ]);
      const rewindId = restarted.rewinds![0]!.id;
      for (const key of supersededKeys) {
        const session = restarted.sessions.find((candidate) => candidate.sessionKey === key)!;
        // Kept, transcript reference and all, but out of the live run.
        expect(session.supersededBy).toBe(rewindId);
        expect(session.supersededAt).toBeDefined();
      }
      expect(shape(live(restarted))).toEqual(["build:0", "review:0", "verify:0"]);
      expect(restarted.sessions.at(-1)).toMatchObject({
        phase: "verify",
        iteration: 0,
        status: "running",
      });

      // Verify 1 fails again, and the rounds after it are available again.
      const refailed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "failed",
      );
      expect(refailed.iteration).toBe(3);
      expect(shape(live(refailed))).toEqual([
        "build:0",
        "review:0",
        "verify:0",
        "fix:1",
        "review:1",
        "verify:1",
        "fix:2",
        "review:2",
        "verify:2",
        "fix:3",
        "review:3",
        "verify:3",
      ]);
      // Every later step ran again, none of them reused.
      expect(
        live(refailed)
          .slice(2)
          .every((session) => !supersededKeys.includes(session.sessionKey)),
      ).toBe(true);
      // The new Fix 2 answers the new Verify 1, not the superseded run's.
      const rerunVerify = live(refailed)[2]!;
      const rerunFix = live(refailed)[3]!;
      const fixPrompt = provider.sent.find((sent) => sent.sessionId === rerunFix.sdkSessionId);
      expect(fixPrompt?.prompt).toContain(`Still failing (${rerunVerify.sdkSessionId}).`);
      expect(rerunVerify.verificationFeedback).toBe(`Still failing (${rerunVerify.sdkSessionId}).`);
    });
  });

  test("restarting a fix rewinds to its round and hands it that round's verdict", async () => {
    await withService(async (service, storage, provider) => {
      failEveryVerification(provider);
      const started = await service.start(startInput({ maxIterations: 3 }));
      const failed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "failed",
      );
      const firstVerify = failed.sessions.find(
        (session) => session.phase === "verify" && session.iteration === 0,
      )!;
      const firstFix = failed.sessions.find((session) => session.phase === "fix")!;
      expect(firstFix.iteration).toBe(1);

      const restarted = await service.restartStep(started.id, firstFix.sessionKey);

      expect(restarted).toMatchObject({ phase: "fixing", iteration: 1 });
      expect(restarted.verificationFeedback).toBe(`Still failing (${firstVerify.sdkSessionId}).`);
      expect(shape(live(restarted))).toEqual(["build:0", "review:0", "verify:0", "fix:1"]);
      const replacement = restarted.sessions.at(-1)!;
      expect(replacement.sessionKey).not.toBe(firstFix.sessionKey);
      const sent = provider.sent.find((entry) => entry.sessionId === replacement.sdkSessionId);
      expect(sent?.prompt).toContain(`Still failing (${firstVerify.sdkSessionId}).`);
    });
  });

  test("restarting an earlier review rebuilds that round's evidence on the current code", async () => {
    await withService(async (service, storage, provider) => {
      failEveryVerification(provider);
      const started = await service.start(startInput({ maxIterations: 2 }));
      const failed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "failed",
      );
      const firstReview = failed.sessions.find((session) => session.phase === "review")!;

      const restarted = await service.restartStep(started.id, firstReview.sdkSessionId);

      // The package the last round prepared describes older code, so the
      // rewound round prepares a new one before its review runs again.
      expect(restarted.iteration).toBe(0);
      expect(restarted.reviewPackage).toBeUndefined();
      expect(restarted.structuredReview).toBeUndefined();
      expect(restarted.verificationResult).toBeUndefined();
      expect(restarted.verificationFeedback).toBeUndefined();
      expect(restarted.sessions.at(-1)).toMatchObject({
        label: REVIEW_PACKAGE_SESSION_LABEL,
        iteration: 0,
        status: "running",
      });
      expect(restarted.rewinds?.[0]).toMatchObject({
        iteration: 0,
        step: { kind: "review-package" },
        sessionKey: firstReview.sessionKey,
      });
      // The later rounds' retained report copy is discarded with them.
      expect(restarted.sessions.filter((session) => session.reviewReport)).toEqual([]);

      const refailed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "failed",
      );
      expect(shape(live(refailed))).toEqual([
        "build:0",
        "fix:0",
        "review:0",
        "verify:0",
        "fix:1",
        "review:1",
        "verify:1",
        "fix:2",
        "review:2",
        "verify:2",
      ]);
    });
  });

  test("restarting a step of a completed build reships into the same pull request", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      const started = await service.start(
        startInput({ source: { type: "kanban", taskId: "task-default" } }),
      );
      const completed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "complete",
      );
      expect(controls.kanbanTasks.get("task-default")?.status).toBe("review");
      const verify = completed.sessions.find((session) => session.phase === "verify")!;
      const ship = completed.sessions.find((session) => session.phase === "pr")!;

      const restarted = await service.restartStep(started.id, verify.sdkSessionId);

      expect(restarted.phase).toBe("verifying");
      expect(controls.kanbanTasks.get("task-default")?.status).toBe("in-progress");
      expect(
        restarted.sessions.find((session) => session.sessionKey === ship.sessionKey)?.supersededBy,
      ).toBe(restarted.rewinds?.[0]?.id);

      const recompleted = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "complete",
      );
      const ships = recompleted.sessions.filter((session) => session.phase === "pr");
      expect(ships).toHaveLength(2);
      const reship = provider.sent.find((sent) => sent.sessionId === ships[1]!.sdkSessionId);
      expect(reship?.prompt).toContain("https://github.com/acme/repo/pull/1");
      expect(reship?.prompt).toContain("Do not create another one");
      expect(reship?.prompt).not.toContain("gh pr create");
      const task = controls.kanbanTasks.get("task-default")!;
      expect(task.status).toBe("review");
      expect(task.prUrl).toBe("https://github.com/acme/repo/pull/1");
      expect(
        task.comments.filter((comment) => comment.text.startsWith("🔗 PR raised")),
      ).toHaveLength(1);
    });
  });

  test("refuses to restart a build whose pull request has merged", async () => {
    await withService(async (service, storage) => {
      const started = await service.start(startInput());
      const completed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "complete",
      );
      await storage.updateEnvironment("env-1", { prState: "merged" });
      const verify = completed.sessions.find((session) => session.phase === "verify")!;

      await expect(service.restartStep(started.id, verify.sdkSessionId)).rejects.toThrow(
        "pull request has been merged",
      );
      const unchanged = await pipeline(storage, started.id);
      expect(unchanged.phase).toBe("complete");
      expect(unchanged.rewinds).toBeUndefined();
    });
  });

  test("a repeated restart is a no-op and a superseded step cannot be restarted", async () => {
    await withService(async (service, storage) => {
      const started = await service.start(startInput());
      const completed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "complete",
      );
      const review = completed.sessions.find((session) => session.phase === "review")!;
      const verify = completed.sessions.find((session) => session.phase === "verify")!;

      const first = await service.restartStep(started.id, review.sdkSessionId);
      const again = await service.restartStep(started.id, review.sdkSessionId);

      expect(first.rewinds).toHaveLength(1);
      // No second rewind and no second review: the pipeline only moved on.
      expect(again.rewinds).toEqual(first.rewinds);
      expect(live(again).filter((session) => session.phase === "review")).toHaveLength(1);
      await expect(service.restartStep(started.id, verify.sdkSessionId)).rejects.toThrow(
        "previous attempt",
      );
    });
  });

  test("restarting the current step supersedes only that step", async () => {
    await withService(async (service, storage, provider) => {
      provider.runningPhases.add("build");
      const { started, session } = await startBuilding(service, storage);

      const restarted = await service.restartCurrentStep(started.id);

      expect(restarted.iteration).toBe(0);
      expect(restarted.sessions).toHaveLength(2);
      expect(restarted.sessions[0]).toMatchObject({
        sessionKey: session.sessionKey,
        supersededBy: restarted.rewinds?.[0]?.id,
        status: "idle",
      });
      expect(restarted.sessions[1]?.supersededBy).toBeUndefined();
      expect(restarted.rewinds?.[0]).toMatchObject({
        fromPhase: "building",
        iteration: 0,
        step: { kind: "session", phase: "build" },
        supersededSessions: 1,
      });
    });
  });

  test("a tool submission from a superseded session is denied", async () => {
    await withService(
      async (service, storage, _provider, _invocations, controls) => {
        const { started, session } = await startBuilding(service, storage);
        const oldKey = session.structuredRequestId!;

        const restarted = await service.restartStep(started.id, session.sdkSessionId);

        expect(restarted.sessions[0]?.supersededBy).toBeDefined();
        expect(
          await controls.workflowResults!.status(
            { environmentId: "env-1", projectId: "project-1" },
            oldKey,
          ),
        ).toMatchObject({ lifecycle: "superseded", completion: "blocked" });
        expect(
          await controls.workflowResults!.submit(
            { environmentId: "env-1", projectId: "project-1" },
            oldKey,
            TEST_REVIEW_PREPARATION,
          ),
        ).toMatchObject({ ok: false });
        expect(restarted.sessions.at(-1)?.structuredRequestId).not.toBe(oldKey);
      },
      { toolMode: true },
    );
  });

  test("a legacy earlier Fix never receives the final round's rationale", async () => {
    await withService(async (service, storage, provider) => {
      failEveryVerification(provider);
      const started = await service.start(startInput({ maxIterations: 3 }));
      const failed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "failed",
      );
      const firstFix = failed.sessions.find((entry) => entry.phase === "fix")!;
      const latestFeedback = failed.verificationFeedback!;
      await mutateStored(storage, started.id, (snapshot) => {
        for (const entry of snapshot.sessions) {
          delete entry.verificationFeedback;
          delete entry.verificationResult;
        }
      });
      const restarted = await service.restartStep(started.id, firstFix.sessionKey);
      expect(restarted.verificationFeedback).toBeUndefined();
      const sent = provider.sent.find(
        (entry) => entry.sessionId === restarted.sessions.at(-1)!.sdkSessionId,
      )!;
      expect(sent.prompt).not.toContain(latestFeedback);
      expect(restarted.iteration).toBe(1);
    });
  });

  test.each(["complete", "failed"] as const)(
    "a %s restart retries Kanban reactivation without duplicate dispatch",
    async (terminal) => {
      await withService(async (service, storage, provider, _invocations, controls) => {
        const started = await service.start(
          startInput({ source: { type: "kanban", taskId: "task-default" } }),
        );
        const completed = await advanceUntil(
          service,
          storage,
          started.id,
          (snapshot) => snapshot.phase === "complete",
        );
        const verify = completed.sessions.find((entry) => entry.phase === "verify")!;
        await mutateStored(storage, started.id, (snapshot) => {
          snapshot.phase = terminal;
        });
        controls.kanbanTasks.get("task-default")!.status =
          terminal === "failed" ? "backlog" : "review";
        controls.failCommandsOnce.set("update_kanban_task", 1);
        provider.runningPhases.add("verify");
        const restarted = await service.restartStep(started.id, verify.sessionKey);
        expect(restarted.pendingKanbanReactivation).toBe(true);
        expect(restarted.sessions.at(-1)!.phase).toBe("verify");
        const created = provider.created.length;
        // Reconstruct from storage: no in-memory retry state is required.
        const reloaded = new BuildPipelineService(
          storage,
          async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
            if (command === "get_kanban_tasks") return [...controls.kanbanTasks.values()] as T;
            if (command !== "update_kanban_task")
              throw new Error(`Unexpected retry command: ${command}`);
            controls.kanbanTasks.get(String(args.taskId))!.status = String(args.status);
            return controls.kanbanTasks.get(String(args.taskId)) as T;
          },
          { autoAdvance: false, provider: async () => provider },
        );
        try {
          await reloaded.advanceNow(started.id);
          expect(controls.kanbanTasks.get("task-default")!.status).toBe("in-progress");
          expect((await pipeline(storage, started.id)).pendingKanbanReactivation).toBeUndefined();
          expect(provider.created).toHaveLength(created);
        } finally {
          await reloaded.shutdown();
        }
      });
    },
  );

  test("cross-round rewind retains later validation evidence", async () => {
    await withService(async (service, storage, provider) => {
      failEveryVerification(provider);
      const started = await service.start(startInput({ maxIterations: 2 }));
      const failed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "failed",
      );
      const run = newReviewValidationRun("later-validation", {
        headRef: "a".repeat(40),
        commands: [],
        limitations: ["No commands available"],
      });
      run.status = "completed";
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.validationRun = run;
      });
      const firstVerify = failed.sessions.find((entry) => entry.phase === "verify")!;
      const restarted = await service.restartStep(started.id, firstVerify.sessionKey);
      expect(restarted.validationRun).toBeUndefined();
      expect(restarted.rewinds?.at(-1)?.validationRun).toEqual(run);
      expect(isBuildPipeline(restarted)).toBe(true);
    });
  });

  test.each(["address", "pr", "resolve-conflicts"] as const)(
    "an earlier %s restart restores its round and correct downstream boundary",
    async (phase) => {
      await withService(async (service, storage, provider) => {
        const started = await service.start(startInput());
        const completed = await advanceUntil(
          service,
          storage,
          started.id,
          (snapshot) => snapshot.phase === "complete",
        );
        const old = completed.sessions.at(-1)!;
        await mutateStored(storage, started.id, (snapshot) => {
          snapshot.iteration = 2;
          snapshot.sessions.push({
            ...old,
            phase,
            iteration: 0,
            sessionKey: "target",
            sdkSessionId: "target",
            label: "Earlier target",
          });
          snapshot.sessions.push({
            ...old,
            phase: "fix",
            iteration: 2,
            sessionKey: "later-fix",
            sdkSessionId: "later-fix",
          });
        });
        const restarted = await service.restartStep(started.id, "target");
        expect(restarted.iteration).toBe(0);
        expect(
          restarted.sessions.find((entry) => entry.sessionKey === "later-fix")?.supersededBy,
        ).toBeDefined();
        expect(
          restarted.sessions.find((entry) => entry.sessionKey === "target")?.supersededBy,
        ).toBeDefined();
        expect(
          restarted.sessions.find((entry) => entry.phase === "verify")?.supersededBy !== undefined,
        ).toBe(phase === "address");
        expect(
          restarted.sessions.find((entry) => entry.sessionKey === old.sessionKey)?.supersededBy !==
            undefined,
        ).toBe(phase !== "resolve-conflicts");
        if (phase === "address") {
          expect(restarted.restartRequest).toBeUndefined();
          expect(restarted.sessions.at(-1)?.label).toBe(REVIEW_PACKAGE_SESSION_LABEL);
          expect(restarted.reviewPackage).toBeUndefined();
        } else {
          expect(restarted.sessions.at(-1)?.phase).toBe(phase);
          expect(provider.sent.at(-1)?.sessionId).toBe(restarted.sessions.at(-1)?.sdkSessionId);
        }
      });
    },
  );

  test("all discarded tool slots reject late submissions and a stored restart dispatches once after reload", async () => {
    await withService(
      async (service, storage, provider, _invocations, controls) => {
        const { started, session } = await startBuilding(service, storage);
        const scope = { environmentId: "env-1", projectId: "project-1" };
        const slots = [
          ["later-fix", "review-preparation"],
          ["later-reviewer", "review-report"],
          ["later-consolidation", "consolidated-review"],
          ["later-verify", "verification-result"],
          ["fanout-reviewer", "review-report"],
          ["fanout-consolidation", "consolidated-review"],
        ] as const;
        for (const [resultKey, kind] of slots)
          await controls.workflowResults!.prepare({
            ...scope,
            provider: "claude",
            resultKey,
            kind,
          });
        await mutateStored(storage, started.id, (snapshot) => {
          snapshot.iteration = 2;
          for (const [key, phase, label] of [
            ["later-fix", "fix", "Fix Session"],
            ["later-reviewer", "review", "Review 1"],
            ["later-consolidation", "review", "Consolidation"],
            ["later-verify", "verify", "Verification Session"],
          ] as const)
            snapshot.sessions.push({
              ...session,
              iteration: 2,
              sessionKey: key,
              sdkSessionId: key,
              phase,
              label,
              structuredRequestId: key,
              resultTransport: "tool-v1",
            });
          snapshot.reviewFanout = {
            reviewers: [
              {
                id: "r1",
                agent: "claude",
                model: "opus",
                status: "running",
                requestId: "fanout-reviewer",
                resultTransport: "tool-v1",
              },
            ],
            consolidation: {
              sessionKey: "later-consolidation",
              providerSessionId: "later-consolidation",
              requestId: "fanout-consolidation",
              resultTransport: "tool-v1",
              state: "sent",
              createdAt: new Date().toISOString(),
              agent: "claude",
            },
          };
        });
        const dispatch = spyOn(
          BuildPipelineSupervisor.prototype,
          "runLocked",
        ).mockResolvedValueOnce(undefined);
        try {
          await service.restartStep(started.id, session.sessionKey);
        } finally {
          dispatch.mockRestore();
        }
        const stored = await pipeline(storage, started.id);
        expect(stored.restartRequest).toEqual({ kind: "session", phase: "build" });
        expect(stored.sessions.every((entry) => entry.supersededBy)).toBe(true);
        for (const key of [session.structuredRequestId!, ...slots.map(([key]) => key)]) {
          expect(await controls.workflowResults!.status(scope, key)).toMatchObject({
            lifecycle: "superseded",
            completion: "blocked",
          });
          expect(await controls.workflowResults!.submit(scope, key, cleanReview)).toMatchObject({
            ok: false,
          });
        }
        const reloaded = new BuildPipelineService(storage, async <T>() => undefined as T, {
          autoAdvance: false,
          provider: async () => provider,
          workflowResults: controls.workflowResults,
          resolveAgentToolConnection: () => ({
            url: "http://127.0.0.1:1234/mcp",
            token: "test-token",
          }),
        });
        try {
          await reloaded.advanceNow(started.id);
          const dispatched = await pipeline(storage, started.id);
          expect(dispatched.restartRequest).toBeUndefined();
          expect(dispatched.iteration).toBe(0);
          expect(dispatched.sessions.filter((entry) => !entry.supersededBy)).toHaveLength(1);
          const count = provider.created.length;
          provider.runningPhases.add("build");
          await reloaded.advanceNow(started.id);
          expect(provider.created).toHaveLength(count);
        } finally {
          await reloaded.shutdown();
        }
      },
      { toolMode: true },
    );
  });

  test("a record written before rewinds existed restarts as before", async () => {
    await withService(async (service, storage) => {
      const started = await service.start(startInput());
      const completed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "complete",
      );
      // Older records carry no rewind fields and no per-session verdicts.
      const legacy = await mutateStored(storage, started.id, (snapshot) => {
        delete snapshot.rewinds;
        for (const entry of snapshot.sessions) {
          delete entry.verificationResult;
          delete entry.verificationFeedback;
        }
      });
      expect(isBuildPipeline(legacy)).toBe(true);
      const verify = completed.sessions.find((session) => session.phase === "verify")!;

      const restarted = await service.restartStep(started.id, verify.sdkSessionId);

      expect(restarted.phase).toBe("verifying");
      expect(shape(live(restarted))).toEqual(["build:0", "review:0", "verify:0"]);
      const recompleted = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "complete",
      );
      expect(shape(live(recompleted))).toEqual(["build:0", "review:0", "verify:0", "pr:0"]);
    });
  });
});
