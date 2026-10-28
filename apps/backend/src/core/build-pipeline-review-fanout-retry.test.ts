import { describe, expect, test } from "bun:test";
import {
  isBuildPipeline,
  pipelineIndependentReviewLabel,
  type BuildPipeline,
} from "@orkestrator/protocol/build-pipeline";
import {
  advanceUntil,
  reportFor,
  reviewerSessionCreates,
  rewritePipeline,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";
import { reviewerSessionKey } from "./build-pipeline-review-fanout.js";

const PANEL = [
  { agent: "claude" as const, model: "opus" },
  { agent: "claude" as const, model: "sonnet" },
];

describe("build pipeline reviewer retry", () => {
  for (const retry of [false, true]) {
    test(`earlier Address ${retry ? "rejects a stale consolidation after reviewer retry" : "reuses its own consolidation"}`, async () => {
      await withPipeline(async ({ service, storage, read, provider }) => {
        const structured = provider.structured.bind(provider);
        provider.structured = async <T>(id: string, requestId: string) => {
          if (id.includes("verif"))
            return {
              ok: true,
              provider: "claude",
              requestId,
              value: { complete: false, rationale: "Another round needed" } as T,
            };
          return structured<T>(id, requestId);
        };
        provider.runningConsolidation = true;
        const started = await service.start({ ...startInput(PANEL), maxIterations: 1 });
        let firstFanout: BuildPipeline["reviewFanout"];
        let firstPackage: BuildPipeline["reviewPackage"];
        let later = await read(started.id);
        for (let pass = 0; pass < 60 && later.iteration === 0; pass += 1) {
          if (later.iteration === 0 && later.reviewFanout?.consolidation) {
            firstFanout = structuredClone(later.reviewFanout);
            firstPackage = structuredClone(later.reviewPackage);
            provider.runningConsolidation = false;
          }
          await service.advanceNow(started.id);
          later = await read(started.id);
        }
        expect(later.iteration).toBe(1);
        const firstAddress = later.sessions.find(
          (s) => s.phase === "address" && s.iteration === 0,
        )!;
        const firstConsolidation = later.sessions.find(
          (s) => s.label === "Consolidation" && s.iteration === 0,
        )!;
        expect(later.roundReviewReports?.find((r) => r.iteration === 0)?.sessionKey).toBe(
          firstConsolidation.sessionKey,
        );
        if (retry) {
          // Model a retained copy surviving an interrupted reviewer retry of the earlier pass.
          expect(firstFanout).toBeDefined();
          await rewritePipeline(storage, started.id, (p) => {
            p.iteration = 0;
            p.phase = "reviewing";
            p.reviewFanout = firstFanout;
            p.reviewPackage = firstPackage;
            p.reviewFanout!.reviewers[0]!.status = "failed";
            p.reviewFanout!.reviewers[0]!.error = "retry required";
            delete p.reviewFanout!.report;
          });
          provider.runningModels.add("opus");
          await service.retryReviewer(started.id, firstFanout!.reviewers[0]!.id);
          expect(
            (await read(started.id)).sessions.find(
              (s) => s.sessionKey === firstConsolidation.sessionKey,
            )?.superseded,
          ).toBe(true);
          const created = provider.created.length;
          const restarted = await service.restartStep(started.id, firstAddress.sessionKey);
          expect(restarted.structuredReview).toBeUndefined();
          expect(provider.created.slice(created).some((s) => s.phase === "address")).toBe(false);
        } else {
          const created = provider.created.length;
          const restarted = await service.restartStep(started.id, firstAddress.sessionKey);
          expect(restarted.iteration).toBe(0);
          expect(restarted.structuredReview?.reviewSummary).toBe("Merged review.");
          expect(provider.created.slice(created).map((s) => s.phase)).toEqual(["address"]);
          expect(provider.sent.at(-1)?.prompt).toContain("Consolidated finding");
        }
      });
    });
  }

  test("failed fanout pause keeps unconfirmed writers visible to rewind admission", async () => {
    const gitCalls: string[][] = [];
    await withPipeline(
      async ({ service, read, provider }) => {
        provider.runningModels.add("opus");
        const started = await service.start(startInput(PANEL));
        let reviewing = await advanceUntil(service, read, started.id, "reviewing");
        for (
          let pass = 0;
          pass < 10 && !reviewing.reviewFanout?.reviewers.some((r) => r.providerSessionId);
          pass += 1
        ) {
          await service.advanceNow(started.id);
          reviewing = await read(started.id);
        }
        provider.abort = async () => {
          throw new Error("fanout abort failed");
        };
        await expect(service.pause(started.id)).rejects.toThrow("fanout abort failed");
        const paused = await read(started.id);
        expect(paused.sessions.some((s) => s.status === "running")).toBe(true);
        await expect(
          service.rewindCode(started.id, reviewing.sessions[0]!.sessionKey, "1".repeat(40)),
        ).rejects.toThrow("confirmed");
        expect(gitCalls).toEqual([]);
      },
      {
        environmentGit: async (_id, args) => {
          gitCalls.push(args);
          return "";
        },
      },
    );
  });

  test("fanout stopping failure leaves Git and the restart record untouched", async () => {
    const gitCalls: string[][] = [];
    await withPipeline(
      async ({ service, read, provider }) => {
        provider.runningModels.add("opus");
        const started = await service.start(startInput(PANEL));
        let reviewing = await advanceUntil(service, read, started.id, "reviewing");
        for (
          let pass = 0;
          pass < 10 && !reviewing.reviewFanout?.reviewers.some((r) => r.providerSessionId);
          pass += 1
        ) {
          await service.advanceNow(started.id);
          reviewing = await read(started.id);
        }
        await service.pause(started.id);
        provider.abort = async () => {
          throw new Error("stop failed");
        };
        await expect(
          service.rewindCode(started.id, reviewing.sessions[0]!.sessionKey, "1".repeat(40)),
        ).rejects.toThrow("stop failed");
        expect(gitCalls.some((args) => args[0] === "update-ref" || args[0] === "reset")).toBe(
          false,
        );
        expect((await read(started.id)).rewinds).toBeUndefined();
        expect((await read(started.id)).phase).toBe("paused");
      },
      {
        environmentGit: async (_id, args) => {
          gitCalls.push(args);
          if (args[0] === "rev-list") return "0";
          if (args[0] === "rev-parse" && args[1] === "HEAD") return "1".repeat(40);
          if (args[0] === "rev-parse") throw new Error("no upstream");
          return "";
        },
      },
    );
  });

  test.each(["", " \n\t"])(
    "persists blank provider errors (%j) on a single stage",
    async (message) => {
      await withPipeline(async ({ service, read, provider }) => {
        provider.send = async () => {
          throw new Error(message);
        };
        const started = await service.start(startInput(PANEL));
        const failed = await advanceUntil(service, read, started.id, "failed");
        expect(failed.phase).toBe("failed");
        expect(isBuildPipeline(failed)).toBe(true);
        expect(failed.sessions[failed.currentSessionIndex]?.status).toBe("error");
        expect(failed.sessions[failed.currentSessionIndex]?.error).toBeTruthy();
      });
    },
  );

  test.each(["", " \n\t"])("persists blank consolidation errors (%j)", async (message) => {
    await withPipeline(async ({ service, read, provider }) => {
      const send = provider.send.bind(provider);
      provider.send = async (...args) => {
        if (args[0].includes("consolidation")) throw new Error(message);
        return send(...args);
      };
      const started = await service.start(startInput(PANEL));
      const failed = await advanceUntil(service, read, started.id, "failed");
      expect(failed.phase).toBe("failed");
      expect(isBuildPipeline(failed)).toBe(true);
      const consolidation = failed.sessions.find((session) => session.label === "Consolidation");
      expect(consolidation?.status).toBe("error");
      expect(consolidation?.error).toBeTruthy();
      expect(failed.failureContext?.sessionId).toBe(consolidation?.sdkSessionId);
    });
  });

  test("an initial Address send failure belongs to Address during fan-out handoff", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      const send = provider.send.bind(provider);
      provider.send = async (...args) => {
        if (args[0].includes("address")) throw new Error("Address dispatch rejected");
        return send(...args);
      };
      const started = await service.start(startInput(PANEL));
      const failed = await advanceUntil(service, read, started.id, "failed");
      expect(failed.phase).toBe("failed");
      expect(isBuildPipeline(failed)).toBe(true);
      const address = failed.sessions.find((session) => session.phase === "address");
      const consolidation = failed.sessions.find((session) => session.label === "Consolidation");
      expect(address?.status).toBe("error");
      expect(address?.error).toBe("Address dispatch rejected");
      expect(failed.failureContext?.sessionId).toBe(address?.sdkSessionId);
      expect(failed.failureContext?.phase).toBe("addressing");
      expect(consolidation?.status).toBe("idle");
      expect(consolidation?.error).toBeUndefined();
    });
  });

  test("retains a sessionless reviewer failure after Address handoff and reload", async () => {
    await withPipeline(async ({ service, read, provider, createService }) => {
      provider.failingCreateLabels.add(pipelineIndependentReviewLabel(1));
      const started = await service.start(startInput(PANEL));
      const addressing = await advanceUntil(service, read, started.id, "addressing");
      expect(addressing.phase).toBe("addressing");
      const reloaded = createService();
      try {
        await reloaded.init();
        const record = await read(started.id);
        expect(record.reviewFanout).toBeUndefined();
        expect(isBuildPipeline(record)).toBe(true);
        expect(
          record.sessions.find((session) => session.label === "Consolidation")
            ?.sessionlessReviewers,
        ).toEqual([
          expect.objectContaining({
            slot: 1,
            agent: "claude",
            model: "sonnet",
            error: expect.stringContaining("Refusing to create"),
          }),
        ]);
      } finally {
        await reloaded.shutdown();
      }
    });
  });

  test("records each reviewer's outcome, error and issue counts on its session", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.failingModels.add("sonnet");
      const started = await service.start({
        ...startInput(PANEL),
        reviewPreparation: { agent: "claude", model: "opus", reasoningEffort: "high" },
      });
      const addressing = await advanceUntil(service, read, started.id, "addressing");

      const completed = addressing.sessions.find(
        (session) => session.label === pipelineIndependentReviewLabel(0),
      );
      const failed = addressing.sessions.find(
        (session) => session.label === pipelineIndependentReviewLabel(1),
      );
      expect(completed?.reviewerOutcome).toBe("completed");
      expect(completed?.reviewIssueCounts).toEqual({ P0: 0, P1: 0, P2: 1 });
      expect(failed?.reviewerOutcome).toBe("failed");
      expect(failed?.error).toBeTruthy();
      expect(failed?.reviewIssueCounts).toBeUndefined();
      const consolidation = addressing.sessions.find((session) =>
        session.label.includes("Consolidation"),
      );
      expect(consolidation?.reviewIssueCounts).toBeDefined();
      expect(consolidation?.model).toBe("opus");
      expect(consolidation?.reasoningEffort).toBe("high");
      expect(consolidation?.reviewPassId).toBe(completed?.reviewPassId);
      expect(consolidation?.reviewPassId).toBeTruthy();
    });
  });

  test("reruns only the failed reviewer while the rest of the panel keeps running", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.failingModels.add("sonnet");
      provider.runningModels.add("opus");
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "reviewing");
      let reviewing = await read(started.id);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (reviewing.reviewFanout?.reviewers[1]?.status === "failed") break;
        await service.advanceNow(started.id);
        reviewing = await read(started.id);
      }
      const [running, failedReviewer] = reviewing.reviewFanout!.reviewers;
      expect(failedReviewer?.status).toBe("failed");
      const failedSessionKey = failedReviewer!.sessionKey!;
      const runningSession = running!.providerSessionId;

      provider.failingModels.delete("sonnet");
      const retried = await service.retryReviewer(started.id, failedReviewer!.id);

      expect(retried.phase).toBe("reviewing");
      const retriedReviewer = retried.reviewFanout!.reviewers[1]!;
      expect(retriedReviewer.status).not.toBe("failed");
      expect(retriedReviewer.error).toBeUndefined();
      // The other reviewer was not touched.
      expect(retried.reviewFanout!.reviewers[0]!.providerSessionId).toBe(runningSession);
      expect(provider.aborted).not.toContain(runningSession);

      provider.runningModels.delete("opus");
      const addressing = await advanceUntil(service, read, started.id, "addressing", 20);
      expect(addressing.phase).toBe("addressing");
      // Two attempts in the second slot: the failed one stays as history.
      const slotSessions = addressing.sessions.filter(
        (session) => session.label === pipelineIndependentReviewLabel(1),
      );
      expect(slotSessions).toHaveLength(2);
      expect(slotSessions[0]!.sessionKey).toBe(failedSessionKey);
      expect(slotSessions[0]!.reviewerOutcome).toBe("failed");
      expect(slotSessions[1]!.sessionKey).toBe(`${failedSessionKey}:attempt-2`);
      expect(slotSessions[1]!.reviewerOutcome).toBe("completed");
      // Opus and sonnet once each, plus the retried sonnet.
      expect(reviewerSessionCreates(provider)).toHaveLength(3);
    });
  });

  test("resumes a review that failed because no reviewer produced a report", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.failingModels.add("opus");
      provider.failingModels.add("sonnet");
      const started = await service.start(startInput(PANEL));
      const failed = await advanceUntil(service, read, started.id, "failed");
      expect(failed.failureContext?.phase).toBe("reviewing");

      provider.failingModels.delete("opus");
      const retried = await service.retryReviewer(
        started.id,
        failed.reviewFanout!.reviewers[0]!.id,
      );
      expect(retried.phase).not.toBe("failed");
      expect(retried.error).toBeUndefined();
      expect(retried.failureContext).toBeUndefined();

      const addressing = await advanceUntil(service, read, started.id, "addressing", 20);
      expect(addressing.error ?? addressing.phase).toBe("addressing");
      expect(addressing.reviewFanout?.reviewers[0]?.status ?? "settled").not.toBe("pending");
    });
  });

  test("discards a started consolidation when a failed reviewer is retried", async () => {
    await withPipeline(async ({ service, read, provider, storage }) => {
      provider.failingModels.add("sonnet");
      provider.runningConsolidation = true;
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "reviewing");
      let reviewing = await read(started.id);
      for (let attempt = 0; attempt < 10 && !reviewing.reviewFanout?.consolidation; attempt += 1) {
        await service.advanceNow(started.id);
        reviewing = await read(started.id);
      }
      const consolidation = reviewing.reviewFanout!.consolidation!;
      expect(consolidation).toBeDefined();
      // Keep the consolidation session visible as a mirror, as the tab sees it.
      await rewritePipeline(storage, started.id, () => {});

      provider.failingModels.delete("sonnet");
      const retried = await service.retryReviewer(
        started.id,
        reviewing.reviewFanout!.reviewers[1]!.id,
      );
      expect(retried.reviewFanout?.consolidation?.providerSessionId).not.toBe(
        consolidation.providerSessionId,
      );
      expect(provider.aborted).toContain(consolidation.providerSessionId);
      expect(retried.structuredReview).toBeUndefined();
      const discarded = retried.sessions.find(
        (session) => session.sessionKey === consolidation.sessionKey,
      );
      expect(discarded?.superseded).toBe(true);
      expect(discarded?.reviewReport).toBeUndefined();
      expect(discarded?.reviewIssueCounts).toBeUndefined();
      expect(discarded?.reviewOverlap).toBeUndefined();
    });
  });

  test("refuses a reviewer that has not failed, and one whose review was consolidated", async () => {
    await withPipeline(async ({ service, read, provider, storage }) => {
      provider.runningModels.add("opus");
      provider.runningModels.add("sonnet");
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);
      const reviewing = await read(started.id);
      const reviewerId = reviewing.reviewFanout!.reviewers[0]!.id;
      await expect(service.retryReviewer(started.id, reviewerId)).rejects.toThrow(
        "Only a failed reviewer can be retried",
      );
      await expect(service.retryReviewer(started.id, "missing")).rejects.toThrow(
        "no longer part of the current review",
      );

      await rewritePipeline(storage, started.id, (pipeline) => {
        const reviewer = pipeline.reviewFanout!.reviewers[0]!;
        reviewer.status = "failed";
        reviewer.error = "boom";
        pipeline.reviewFanout!.report = reportFor("Merged review.");
      });
      await expect(service.retryReviewer(started.id, reviewerId)).rejects.toThrow(
        "has been consolidated",
      );
    });
  });

  test("retrying a paused review dispatches without restarting its completed peer", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.failingModels.add("sonnet");
      provider.runningConsolidation = true;
      const started = await service.start(startInput(PANEL));
      await advanceUntil(service, read, started.id, "reviewing");
      let reviewing = await read(started.id);
      for (let attempt = 0; attempt < 10 && !reviewing.reviewFanout?.consolidation; attempt += 1) {
        await service.advanceNow(started.id);
        reviewing = await read(started.id);
      }
      const [completed, failed] = reviewing.reviewFanout!.reviewers;
      expect(completed!.status).toBe("completed");
      expect(failed!.status).toBe("failed");
      const paused = await service.pause(started.id);
      expect(paused.phase).toBe("paused");
      provider.failingModels.delete("sonnet");
      const retried = await service.retryReviewer(started.id, failed!.id);
      expect(retried.phase).toBe("reviewing");
      expect(retried.pausedFromPhase).toBeUndefined();
      expect(retried.pauseCause).toBeUndefined();
      expect(retried.reviewFanout!.reviewers[0]).toEqual(completed);
      expect(retried.reviewFanout!.reviewers[1]!.providerSessionId).toBeDefined();
      expect(retried.reviewFanout!.reviewers[1]!.providerSessionId).not.toBe(
        failed!.providerSessionId,
      );
      expect(reviewerSessionCreates(provider)).toHaveLength(3);
    });
  });

  test("retry from pause reruns interrupted peers with fresh tool result slots", async () => {
    await withPipeline(
      async ({ service, read, provider, workflowResults }) => {
        provider.runningModels.add("opus");
        provider.failingModels.add("sonnet");
        const started = await service.start(startInput(PANEL));
        await advanceUntil(service, read, started.id, "reviewing");
        let reviewing = await read(started.id);
        for (
          let attempt = 0;
          attempt < 10 && reviewing.reviewFanout?.reviewers[1]?.status !== "failed";
          attempt++
        ) {
          await service.advanceNow(started.id);
          reviewing = await read(started.id);
        }
        const [interrupted, failed] = reviewing.reviewFanout!.reviewers;
        expect(interrupted!.status).toBe("running");
        expect(failed!.status).toBe("failed");
        const paused = await service.pause(started.id);
        expect(paused.reviewFanout!.reviewers[0]!.status).toBe("cancelled");
        provider.runningModels.clear();
        provider.failingModels.clear();
        const retried = await service.retryReviewer(started.id, failed!.id);
        for (const reviewer of retried.reviewFanout!.reviewers) {
          expect(reviewer.requestId).toBeTruthy();
          expect(
            await workflowResults!.submit(
              { environmentId: "env-1", projectId: "project-1" },
              reviewer.requestId!,
              reportFor("Fresh review"),
            ),
          ).toMatchObject({ ok: true });
        }
        const addressing = await advanceUntil(service, read, started.id, "addressing", 24);
        const attempts = addressing.sessions.filter(
          (session) => session.label === pipelineIndependentReviewLabel(0),
        );
        expect(attempts).toHaveLength(2);
        expect(attempts[0]!.reviewerOutcome).toBe("cancelled");
        expect(attempts[1]!.reviewerOutcome).toBe("completed");
        expect(
          new Set(
            addressing.sessions.filter((s) => s.phase === "review").map((s) => s.reviewPassId),
          ).size,
        ).toBe(1);
        expect(
          await workflowResults!.status(
            { environmentId: "env-1", projectId: "project-1" },
            interrupted!.requestId!,
          ),
        ).toMatchObject({ lifecycle: "superseded" });
        expect(reviewerSessionCreates(provider)).toHaveLength(4);
      },
      { toolMode: true, toolKinds: ["review-report"] },
    );
  });

  test.each(["restart", "pause-resume"] as const)(
    "%s gives the next full panel a distinct persisted identity",
    async (action) => {
      await withPipeline(async ({ service, read, provider }) => {
        provider.runningModels.add("opus");
        provider.runningModels.add("sonnet");
        const started = await service.start(startInput(PANEL));
        await advanceUntil(service, read, started.id, "reviewing");
        await service.advanceNow(started.id);
        const first = await read(started.id);
        const firstSessions = first.sessions.filter((session) => session.phase === "review");
        expect(firstSessions).toHaveLength(2);
        const firstId = firstSessions[0]!.reviewPassId;
        expect(firstId).toBeTruthy();
        if (action === "restart") await service.restartCurrentStep(started.id);
        else {
          await service.pause(started.id);
          await service.resume(started.id);
        }
        let next = await read(started.id);
        for (
          let attempt = 0;
          attempt < 15 && next.sessions.filter((s) => s.phase === "review").length < 4;
          attempt++
        ) {
          await service.advanceNow(started.id);
          next = await read(started.id);
        }
        expect(next.iteration).toBe(first.iteration);
        const panels = next.sessions.filter((session) => session.phase === "review");
        expect(panels).toHaveLength(4);
        expect(panels.slice(0, 2).map((s) => s.sessionKey)).toEqual(
          firstSessions.map((s) => s.sessionKey),
        );
        expect(new Set(panels.slice(2).map((s) => s.reviewPassId)).size).toBe(1);
        expect(panels[2]!.reviewPassId).toBeTruthy();
        expect(panels[2]!.reviewPassId).not.toBe(firstId);
      });
    },
  );

  test("supersedes the failed tool-v1 reviewer slot and allocates a fresh request", async () => {
    await withPipeline(
      async ({ service, read, provider, workflowResults }) => {
        provider.failingModels.add("sonnet");
        provider.runningModels.add("opus");
        const started = await service.start(startInput(PANEL));
        await advanceUntil(service, read, started.id, "reviewing");
        let reviewing = await read(started.id);
        for (
          let attempt = 0;
          attempt < 10 && reviewing.reviewFanout?.reviewers[1]?.status !== "failed";
          attempt += 1
        ) {
          await service.advanceNow(started.id);
          reviewing = await read(started.id);
        }
        const failed = reviewing.reviewFanout!.reviewers[1]!;
        expect(failed.resultTransport).toBe("tool-v1");
        expect(failed.requestId).toBeDefined();
        provider.failingModels.delete("sonnet");
        provider.runningModels.add("sonnet");
        const retried = await service.retryReviewer(started.id, failed.id);
        const fresh = retried.reviewFanout!.reviewers[1]!;
        expect(fresh.resultTransport).toBe("tool-v1");
        expect(fresh.requestId).toBeDefined();
        expect(fresh.requestId).not.toBe(failed.requestId);
        expect(
          await workflowResults!.status(
            { environmentId: "env-1", projectId: "project-1" },
            failed.requestId!,
          ),
        ).toMatchObject({ lifecycle: "superseded", completion: "blocked" });
        const late = await workflowResults!.validate(
          { environmentId: "env-1", projectId: "project-1" },
          failed.requestId!,
          reportFor("Late report"),
        );
        expect(late.ok).toBe(false);
      },
      { toolMode: true, toolKinds: ["review-report"] },
    );
  });

  test("a retried reviewer's session key never collides with an earlier attempt", () => {
    const pipeline = {
      id: "pipeline-1",
      iteration: 0,
      sessions: [] as Array<{ sessionKey: string }>,
    };
    const reviewer = { id: "reviewer-1" };
    const first = reviewerSessionKey(pipeline as never, reviewer);
    expect(first).toBe("pipeline-1:review:0:reviewer-1");
    pipeline.sessions.push({ sessionKey: first });
    const second = reviewerSessionKey(pipeline as never, reviewer);
    expect(second).toBe(`${first}:attempt-2`);
    pipeline.sessions.push({ sessionKey: second });
    expect(reviewerSessionKey(pipeline as never, reviewer)).toBe(`${first}:attempt-3`);
  });
});
