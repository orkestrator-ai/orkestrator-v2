import { ProviderUnreachableError } from "./agent-provider-contract.js";
import { describe, expect, spyOn, test } from "bun:test";
import { RecordingEfficiencyObserver } from "./multi-review-efficiency.js";
import type { PipelineSession } from "@orkestrator/protocol/build-pipeline";
import {
  MAX_BUILD_PIPELINE_REVIEWERS,
  REVIEW_PACKAGE_SESSION_LABEL,
  pipelineIndependentReviewLabel,
} from "@orkestrator/protocol/build-pipeline";
import { REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS } from "@orkestrator/protocol/review-fanout";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import {
  REVIEW_RESULT_COMMIT_NUDGE_MS,
  deriveConsolidatedProvenance,
  parseStructuredReportResult,
} from "./review-fanout.js";
import {
  HEAD,
  advanceUntil,
  fourReviewers,
  reportFor,
  reviewerSessionCreates,
  rewritePipeline,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";

test("consolidation accepts more than 100 distinct source findings without a drop repair", () => {
  const source = reportFor("source", "Finding").issues[0]!;
  const issues = Array.from({ length: 101 }, (_, index) => ({
    ...source,
    title: `Finding ${index + 1}`,
  }));
  const reviewers: ReviewerRecord[] = [issues.slice(0, 51), issues.slice(51)].map(
    (sourceIssues, index) => ({
      id: `reviewer-${index + 1}`,
      agent: "claude",
      model: "opus",
      status: "completed",
      report: { ...reportFor("source"), issues: sourceIssues },
    }),
  );
  const consolidated = {
    ...reportFor("consolidated"),
    issues: issues.map((issue, index) => ({
      ...issue,
      reviewSourceIds: [
        index < 51 ? `reviewer-1/issue-${index + 1}` : `reviewer-2/issue-${index - 50}`,
      ],
    })),
  };
  const result = parseStructuredReportResult(
    { ok: true, provider: "claude", requestId: "consolidate", value: consolidated },
    reviewers,
  );
  expect(result.success).toBe(true);
  if (result.success) {
    expect(deriveConsolidatedProvenance(result.data, reviewers).issues).toEqual([]);
  }
  const overflow = parseStructuredReportResult(
    {
      ok: true,
      provider: "claude",
      requestId: "overflow",
      value: { ...consolidated, issues: [...consolidated.issues, consolidated.issues[0]!] },
    },
    reviewers,
  );
  expect(overflow.success).toBe(false);
  if (!overflow.success) expect(overflow.error.message).not.toContain("drop");
});

describe("build pipeline multi-model review", () => {
  test("reads the shared model catalogue once for the whole reviewer panel", async () => {
    await withPipeline(async ({ service, storage, read, commands }) => {
      const config = await storage.loadConfig();
      config.global.agentSettings = {
        platforms: { claude: { fastMode: true } },
      };
      await storage.saveConfig(config);
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );

      const reviewing = await advanceUntil(service, read, started.id, "reviewing");
      expect(reviewing.reviewFanout?.reviewers.map((reviewer) => reviewer.fastMode)).toEqual([
        true,
        true,
      ]);

      // Every reviewer resolves against the same environment, and the command
      // behind this can wait on live bridge catalogue fetches. One read for the
      // panel, not one per reviewer.
      expect(commands.filter((command) => command === "get_native_agent_model_catalog")).toEqual([
        "get_native_agent_model_catalog",
      ]);
    });
  });

  test("applies each reviewer's Fast or Normal platform default", async () => {
    await withPipeline(async ({ service, storage, read, provider, providers }) => {
      const config = await storage.loadConfig();
      config.global.agentSettings = {
        platforms: {
          claude: { fastMode: true },
          codex: { fastMode: false },
        },
      };
      await storage.saveConfig(config);
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "codex", model: "gpt-5.4" },
        ]),
      );

      const reviewing = await advanceUntil(service, read, started.id, "reviewing");
      expect(reviewing.reviewFanout?.reviewers.map((reviewer) => reviewer.fastMode)).toEqual([
        true,
        false,
      ]);
      await service.advanceNow(started.id);

      expect(provider.created.find((entry) => entry.label === "Review 1")?.options?.fastMode).toBe(
        true,
      );
      expect(providers.get("codex")?.created[0]?.options?.fastMode).toBe(false);
      expect(provider.sent.find((entry) => entry.sessionId.includes("review-1"))?.fastMode).toBe(
        true,
      );
      expect(providers.get("codex")?.sent[0]?.fastMode).toBe(false);
    });
  });

  test("a single reviewer keeps the classic one-session review stage", async () => {
    await withPipeline(async ({ service, read, providers }) => {
      const started = await service.start(startInput([{ agent: "claude", model: "opus" }]));
      const stored = await read(started.id);
      // Normalised away on the way in: a one-entry panel is the stage the
      // pipeline has always run, and storing it would open a consolidation turn
      // that merges one report into itself.
      expect(stored.reviewers).toBeUndefined();
      expect(stored.reviewPreparation).toBeUndefined();

      await advanceUntil(service, read, started.id, "reviewing");
      expect(
        [...providers.values()].flatMap((provider) =>
          provider.created.filter((entry) => entry.label === REVIEW_PACKAGE_SESSION_LABEL),
        ),
      ).toEqual([]);
    });
  });

  test("uses a configured preparation model before a single-reviewer stage", async () => {
    await withPipeline(async ({ service, read, providers }) => {
      const started = await service.start({
        ...startInput([{ agent: "claude", model: "opus" }]),
        reviewPreparation: {
          agent: "codex",
          model: "review-coordinator",
          reasoningEffort: "medium",
        },
      });

      const reviewing = await advanceUntil(service, read, started.id, "reviewing");

      expect(reviewing.phase).toBe("reviewing");
      expect(reviewing.reviewers).toBeUndefined();
      expect(providers.get("codex")!.created).toContainEqual(
        expect.objectContaining({
          phase: "fix",
          label: REVIEW_PACKAGE_SESSION_LABEL,
          options: expect.objectContaining({
            model: "review-coordinator",
            effort: "medium",
          }),
        }),
      );
      expect(providers.get("claude")!.created).toContainEqual(
        expect.objectContaining({ phase: "review" }),
      );
    });
  });

  test("fans out to every reviewer, consolidates, then addresses the merged report", async () => {
    await withPipeline(async ({ service, read, provider, packageGeneration }) => {
      provider.usageFromMessages = () => ({
        usedTokens: 12_345,
        sessionTokens: 12_345,
        cacheReadTokens: 9_000,
      });
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      const reviewing = await advanceUntil(service, read, started.id, "reviewing");
      expect(reviewing.phase).toBe("reviewing");
      expect(reviewing.reviewFanout?.reviewers).toHaveLength(2);
      expect(reviewing.reviewFanout?.snapshot).toBeUndefined();
      expect(reviewing.reviewPackage?.headRef).toBe(HEAD);

      const addressing = await advanceUntil(service, read, started.id, "addressing");
      expect(addressing.error ?? addressing.phase).toBe("addressing");
      // Both reviewers ran, and each is visible as its own pipeline session so
      // a user watching the build can read them.
      const reviewLabels = provider.created
        .filter((entry) => entry.phase === "review")
        .map((entry) => entry.label);
      expect(reviewLabels).toContain("Review 1");
      expect(reviewLabels).toContain("Review 2");
      expect(reviewLabels).toContain("Review · Consolidation");
      const reviewCreates = provider.created.filter((entry) => entry.phase === "review");
      expect(reviewCreates).not.toHaveLength(0);
      for (const created of reviewCreates) {
        expect(created.options?.policy).toMatchObject({
          id: "pipeline",
          sandbox: "none",
          networkAccess: "full",
        });
      }
      expect(
        reviewCreates.find((entry) => entry.label === "Review · Consolidation")?.options?.policy,
      ).toMatchObject({ id: "pipeline" });
      const reviewerPrompts = provider.sent.filter(
        (entry) =>
          entry.sessionId.includes("review-") && !entry.sessionId.includes("consolidation"),
      );
      expect(reviewerPrompts).toHaveLength(2);
      expect(reviewerPrompts.every((entry) => entry.prompt.includes("review-package-"))).toBe(true);
      // One check admits the reviewer wave, and address rechecks the evidence;
      // admission is still not repeated inside each reviewer's prompt.
      expect(packageGeneration.verificationCount).toBe(2);
      expect(
        reviewerPrompts.every((entry) =>
          entry.prompt.includes("Do not modify, create, or delete files"),
        ),
      ).toBe(true);
      expect(
        addressing.sessions.filter((session) => session.label.startsWith("Review")).length,
      ).toBeGreaterThanOrEqual(2);
      // Settled reviewers must not still read as running in the build tab.
      const reviewSessions = addressing.sessions.filter((session) =>
        /^Review \d+$/.test(session.label),
      );
      expect(reviewSessions).toHaveLength(2);
      expect(reviewSessions.every((session) => session.status === "idle")).toBe(true);
      expect(reviewSessions.every((session) => session.reviewReport !== undefined)).toBe(true);
      // Reviewers run concurrently and each session is mirrored when its
      // reviewer is first observed, so array order is admission order. The
      // panel slot lives in the label, which is what binds a model to it.
      expect(
        Object.fromEntries(reviewSessions.map((session) => [session.label, session.model])),
      ).toEqual({ "Review 1": "opus", "Review 2": "sonnet" });
      expect(reviewSessions.every((session) => session.completedAt !== undefined)).toBe(true);
      expect(reviewSessions.map((session) => session.tokenCount)).toEqual([12_345, 12_345]);
      expect(reviewSessions.map((session) => session.cacheReadTokens)).toEqual([9_000, 9_000]);
      expect(reviewSessions.every((session) => session.structuredResultStatus === "accepted")).toBe(
        true,
      );
      const consolidationSession = addressing.sessions.find(
        (session) => session.label === "Consolidation",
      );
      expect(consolidationSession?.reviewReport?.reviewSummary).toBe("Merged review.");
      // Overlap is counted from the cited source IDs before they are replaced
      // by model labels, and kept on the session the fan-out record outlives.
      expect(consolidationSession?.reviewOverlap).toMatchObject({ version: 1, reviewers: 2 });
      expect(consolidationSession?.reviewOverlap?.positions.map((entry) => entry.position)).toEqual(
        [1, 2],
      );
      expect(consolidationSession?.structuredResultStatus).toBe("accepted");
      // Consolidation and the stages before it meter like the reviewers do.
      expect(consolidationSession?.tokenCount).toBe(12_345);
      expect(
        addressing.sessions
          .filter((session) => session.phase === "build")
          .map((session) => session.tokenCount),
      ).toEqual([12_345]);
      expect(addressing.structuredReviewRequestId).toBe(consolidationSession?.structuredRequestId);
      // Everything downstream reads one report, and the fan-out record is gone.
      expect(addressing.structuredReview?.reviewSummary).toBe("Merged review.");
      expect(addressing.reviewFanout).toBeUndefined();
      // Provenance is derived by the backend from the cited source IDs, never
      // taken from what the consolidation model claimed.
      expect(addressing.structuredReview?.issues[0]?.reviewModels).toEqual(["claude/opus"]);
      const verifying = await advanceUntil(service, read, started.id, "verifying");
      expect(verifying.error ?? verifying.phase).toBe("verifying");
      expect(packageGeneration.verificationCount).toBe(3);
    });
  });

  test("a clean consolidated report skips Address and goes straight to Verify", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.consolidationFindings = "clean";
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      const verifying = await advanceUntil(service, read, started.id, "verifying");
      expect(verifying.error ?? verifying.phase).toBe("verifying");
      expect(verifying.structuredReview).toMatchObject({
        reviewSummary: "Merged review.",
        issues: [],
        testCoverageGaps: [],
      });
      // The single-review path's rule: nothing to address, so no Address turn.
      expect(verifying.sessions.some((session) => session.phase === "address")).toBe(false);
      expect(provider.created.some((entry) => entry.phase === "address")).toBe(false);
      expect(verifying.sessions[verifying.currentSessionIndex]?.phase).toBe("verify");
      // The next stage opened before the fan-out record was dropped, as on the
      // Address route.
      expect(verifying.reviewFanout).toBeUndefined();
    });
  });

  test("a consolidated report with only coverage gaps goes to Address", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.consolidationFindings = "coverage-gap";
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      const addressing = await advanceUntil(service, read, started.id, "addressing");
      expect(addressing.error ?? addressing.phase).toBe("addressing");
      expect(addressing.structuredReview?.issues).toEqual([]);
      expect(addressing.structuredReview?.testCoverageGaps).toHaveLength(1);
      expect(addressing.structuredReview?.testCoverageGaps[0]?.reviewModels).toEqual([
        "claude/opus",
      ]);
      expect(addressing.sessions[addressing.currentSessionIndex]?.phase).toBe("address");
      expect(addressing.reviewFanout).toBeUndefined();
    });
  });

  test("uses the review preparation model for package creation and consolidation, not fixing", async () => {
    await withPipeline(async ({ service, read, providers }) => {
      const started = await service.start({
        ...startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
        reviewPreparation: {
          agent: "codex",
          model: "review-coordinator",
          reasoningEffort: "medium",
        },
        steps: {
          address: {
            agent: "opencode",
            model: "fixer",
            reasoningEffort: "high",
          },
        },
      });

      const addressing = await advanceUntil(service, read, started.id, "addressing");
      expect(addressing.error ?? addressing.phase).toBe("addressing");
      for (
        let attempt = 0;
        attempt < 3 && providers.get("opencode")!.created.length === 0;
        attempt += 1
      ) {
        await service.advanceNow(started.id);
      }

      const coordinator = providers.get("codex")!;
      expect(coordinator.created).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "fix",
            label: REVIEW_PACKAGE_SESSION_LABEL,
            options: expect.objectContaining({
              model: "review-coordinator",
              effort: "medium",
            }),
          }),
          expect.objectContaining({
            phase: "review",
            label: "Review · Consolidation",
            options: expect.objectContaining({
              model: "review-coordinator",
              effort: "medium",
            }),
          }),
        ]),
      );
      expect(
        coordinator.sent
          .filter(
            (entry) =>
              entry.prompt.includes("review package") ||
              entry.prompt.includes("<multi-review-reports-json>"),
          )
          .every((entry) => entry.model === "review-coordinator"),
      ).toBe(true);

      const fixer = providers.get("opencode")!;
      expect(fixer.created).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "address",
            options: expect.objectContaining({
              model: "fixer",
              effort: "high",
            }),
          }),
        ]),
      );
      expect(fixer.created.some((entry) => entry.label.includes("Preparation"))).toBe(false);
      expect(fixer.created.some((entry) => entry.label.includes("Consolidation"))).toBe(false);
    });
  });

  test("a failed reviewer does not stop the panel", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      // Armed before the fan-out opens its sessions: a reviewer is one
      // independent input, so losing it must not lose the review.
      provider.failingModels.add("sonnet");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      const addressing = await advanceUntil(service, read, started.id, "addressing");
      expect(addressing.error ?? addressing.phase).toBe("addressing");
      // The surviving reviewer's report is what got consolidated.
      expect(addressing.structuredReview?.reviewSummary).toBe("Merged review.");
      const failedSession = addressing.sessions.find(
        (session) => session.label === pipelineIndependentReviewLabel(1),
      );
      expect(failedSession?.status).toBe("idle");
      expect(failedSession?.completedAt).toBeDefined();
      expect(failedSession?.model).toBe("sonnet");
    });
  });

  test("a reviewer that fails before mirroring does not shift the surviving Review N label", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.failingCreateLabels.add(pipelineIndependentReviewLabel(0));
      provider.runningModels.add("sonnet");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await service.advanceNow(started.id);
        const current = await read(started.id);
        if (
          current.sessions.some((session) => session.label === pipelineIndependentReviewLabel(1))
        ) {
          break;
        }
      }
      const reviewing = await read(started.id);
      expect(reviewing.reviewFanout?.reviewers[0]?.status).toBe("failed");
      expect(reviewing.reviewFanout?.reviewers[0]?.sessionKey).toBeUndefined();
      const reviewSessions = reviewing.sessions.filter((session) =>
        /^Review \d+$/.test(session.label),
      );
      expect(reviewSessions.map((session) => session.label)).toEqual([
        pipelineIndependentReviewLabel(1),
      ]);
      expect(reviewSessions[0]?.model).toBe("sonnet");
    });
  });

  test("settlement tolerates a missing mirror and does not overwrite an accepted session report", async () => {
    await withPipeline(async ({ service, storage, read, provider }) => {
      provider.runningModels.add("opus");
      provider.runningModels.add("sonnet");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);

      let missingSessionKey = "";
      let retainedSessionKey = "";
      await rewritePipeline(storage, started.id, (pipeline) => {
        const [missing, retained] = pipeline.reviewFanout!.reviewers;
        if (!missing?.sessionKey || !retained?.sessionKey) {
          throw new Error("Reviewer mirrors were not created");
        }
        missingSessionKey = missing.sessionKey;
        retainedSessionKey = retained.sessionKey;
        missing.status = "completed";
        missing.report = reportFor("The missing mirror still contributed evidence.");
        missing.completedAt = new Date().toISOString();
        retained.status = "completed";
        retained.report = reportFor("A later settlement result that must not replace the session.");
        retained.completedAt = new Date().toISOString();
        pipeline.sessions = pipeline.sessions.filter(
          (session) => session.sessionKey !== missingSessionKey,
        );
        const retainedSession = pipeline.sessions.find(
          (session) => session.sessionKey === retainedSessionKey,
        );
        if (!retainedSession) throw new Error("Retained reviewer mirror disappeared");
        retainedSession.reviewReport = reportFor("Already accepted on the session.");
        retainedSession.structuredResultStatus = "accepted";
      });

      await service.advanceNow(started.id);
      const settled = await read(started.id);

      expect(settled.sessions.some((session) => session.sessionKey === missingSessionKey)).toBe(
        false,
      );
      expect(
        settled.sessions.find((session) => session.sessionKey === retainedSessionKey)?.reviewReport
          ?.reviewSummary,
      ).toBe("Already accepted on the session.");
    });
  });

  test("fails the stage when no reviewer produced a report", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.failingModels.add("opus");
      provider.failingModels.add("sonnet");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      const failed = await advanceUntil(service, read, started.id, "failed");
      expect(failed.phase).toBe("failed");
      expect(failed.error).toContain("No reviewer produced a valid report");
    });
  });

  test("cancel stops every live reviewer and settles every mirrored session", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.runningModels.add("opus");
      provider.runningModels.add("sonnet");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);
      const liveIds = (await read(started.id)).reviewFanout!.reviewers.map(
        (reviewer) => reviewer.providerSessionId!,
      );

      const cancelled = await service.cancel(started.id);

      expect(provider.aborted).toEqual(expect.arrayContaining(liveIds));
      expect(cancelled.sessions.every((session) => session.status !== "running")).toBe(true);
      const cancelledReviews = cancelled.sessions.filter((session) =>
        /^Review \d+$/.test(session.label),
      );
      expect(cancelledReviews.every((session) => session.completedAt !== undefined)).toBe(true);
      expect(cancelledReviews.map((session) => session.model).sort()).toEqual(["opus", "sonnet"]);
      expect(
        cancelled.reviewFanout?.reviewers.every((reviewer) => reviewer.status === "cancelled"),
      ).toBe(true);
    });
  });

  test("pause stops the panel and resume starts a fresh fan-out", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.runningModels.add("opus");
      provider.runningModels.add("sonnet");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);
      const firstPanel = (await read(started.id)).reviewFanout!.reviewers.map(
        (reviewer) => reviewer.providerSessionId!,
      );

      const paused = await service.pause(started.id);
      expect(paused.phase).toBe("paused");
      expect(
        paused.reviewFanout?.reviewers.every((reviewer) => reviewer.status === "cancelled"),
      ).toBe(true);
      expect(provider.aborted).toEqual(expect.arrayContaining(firstPanel));

      await service.resume(started.id);
      await service.advanceNow(started.id);
      const resumed = await read(started.id);
      expect(resumed.phase).toBe("reviewing");
      expect(resumed.pendingPromptAttempt).toBeUndefined();
      expect(
        resumed.reviewFanout?.reviewers.map((reviewer) => reviewer.providerSessionId),
      ).not.toEqual(firstPanel);
    });
  });

  test("resume rebuilds a missing package before reopening fan-out", async () => {
    await withPipeline(async ({ service, storage, read, packageGeneration }) => {
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      await service.pause(started.id);
      await rewritePipeline(storage, started.id, (pipeline) => {
        delete pipeline.reviewPackage;
      });

      await service.resume(started.id);
      for (let pass = 0; pass < 4 && packageGeneration.count < 2; pass += 1) {
        await service.advanceNow(started.id);
      }

      const resumed = await read(started.id);
      expect({
        count: packageGeneration.count,
        phase: resumed.phase,
        error: resumed.error,
      }).toEqual({ count: 2, phase: "reviewing", error: undefined });
      expect(resumed.reviewPackage?.headRef).toBe("2".repeat(40));
      expect(resumed.reviewFanout).toBeDefined();
    });
  });

  test("review retry abandons the old panel before opening a new one", async () => {
    await withPipeline(async ({ service, storage, read, provider, packageGeneration }) => {
      provider.runningModels.add("opus");
      provider.runningModels.add("sonnet");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);
      const firstPanel = (await read(started.id)).reviewFanout!.reviewers.map(
        (reviewer) => reviewer.providerSessionId!,
      );
      let retainedSnapshotBytes = 0;
      await rewritePipeline(storage, started.id, (pipeline) => {
        pipeline.structuredReview = reportFor("Previous review");
        pipeline.structuredReviewRequestId = "previous-review-request";
        pipeline.verificationResult = "fail";
        pipeline.verificationFeedback = "Previous verification";
        const largeReport = reportFor("x".repeat(16 * 1024));
        for (let iteration = 0; iteration < 2; iteration += 1) {
          for (let reviewer = 0; reviewer < MAX_BUILD_PIPELINE_REVIEWERS; reviewer += 1) {
            pipeline.sessions.push({
              phase: "review",
              iteration,
              sessionKey: `historical-review-${iteration}-${reviewer}`,
              sdkSessionId: `historical-session-${iteration}-${reviewer}`,
              status: "idle",
              startedAt: new Date().toISOString(),
              label: `Historical Review ${iteration + 1}.${reviewer + 1}`,
              reviewReport: largeReport,
            });
          }
        }
        retainedSnapshotBytes = Buffer.byteLength(JSON.stringify(pipeline), "utf8");
      });

      await service.retryReview(started.id);
      await service.advanceNow(started.id);
      const retried = await read(started.id);

      expect(provider.aborted).toEqual(expect.arrayContaining(firstPanel));
      expect(retried.reviewRetryRequested).toBeUndefined();
      expect(retried.structuredReview).toBeUndefined();
      expect(retried.structuredReviewRequestId).toBeUndefined();
      expect(retried.sessions.filter((session) => session.reviewReport).length).toBe(0);
      expect(Buffer.byteLength(JSON.stringify(retried), "utf8")).toBeLessThan(
        retainedSnapshotBytes,
      );
      expect(Buffer.byteLength(JSON.stringify(retried), "utf8")).toBeLessThan(32 * 1024 * 1024);
      expect(retried.verificationResult).toBeUndefined();
      expect(retried.verificationFeedback).toBeUndefined();
      expect(packageGeneration.count).toBe(2);
      expect(retried.reviewPackage?.headRef).toBe("2".repeat(40));
      expect(
        retried.reviewFanout?.reviewers.map((reviewer) => reviewer.providerSessionId),
      ).not.toEqual(firstPanel);
    });
  });

  test("review retry opens distinct sessions that do not inherit the previous runtime", async () => {
    await withPipeline(async ({ service, storage, read, provider }) => {
      provider.runningModels.add("opus");
      provider.runningModels.add("sonnet");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);
      const firstKeys = (await read(started.id)).reviewFanout!.reviewers.map(
        (reviewer) => reviewer.sessionKey,
      );
      expect(firstKeys.every((key) => typeof key === "string")).toBe(true);
      await rewritePipeline(storage, started.id, (pipeline) => {
        for (const session of pipeline.sessions) {
          if (!session.label.startsWith("Review ")) continue;
          session.completedAt = "2026-07-29T00:01:00.000Z";
          session.tokenCount = 9_001;
        }
      });

      await service.retryReview(started.id);
      let retried = await read(started.id);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const liveKeys = (retried.reviewFanout?.reviewers ?? [])
          .map((reviewer) => reviewer.sessionKey)
          .filter((key): key is string => typeof key === "string");
        if (liveKeys.length === 2 && liveKeys.every((key) => !firstKeys.includes(key))) break;
        await service.advanceNow(started.id);
        retried = await read(started.id);
      }
      const liveKeys = (retried.reviewFanout?.reviewers ?? [])
        .map((reviewer) => reviewer.sessionKey)
        .filter((key): key is string => typeof key === "string");
      expect(liveKeys).toHaveLength(2);
      expect(liveKeys.every((key) => !firstKeys.includes(key))).toBe(true);
      const liveSessions = retried.sessions.filter((session) =>
        liveKeys.includes(session.sessionKey),
      );
      expect(liveSessions).toHaveLength(2);
      expect(liveSessions.every((session) => session.completedAt === undefined)).toBe(true);
      expect(liveSessions.every((session) => session.tokenCount === undefined)).toBe(true);
      expect(
        firstKeys.every((key) => retried.sessions.some((session) => session.sessionKey === key)),
      ).toBe(true);
    });
  });

  test("rejects user messages while fan-out owns the review phase", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.runningModels.add("opus");
      provider.runningModels.add("sonnet");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");

      await expect(service.sendMessage(started.id, "send this later")).rejects.toThrow(
        "multi-model review",
      );
      expect((await read(started.id)).pendingUserMessages).toBeUndefined();

      await service.advanceNow(started.id);
      await service.pause(started.id);
      await expect(service.sendMessage(started.id, "send this after resume")).rejects.toThrow(
        "multi-model review",
      );
      expect((await read(started.id)).pendingUserMessages).toBeUndefined();
    });
  });

  test("preserves Claude default while omitting placeholder defaults for other agents", async () => {
    await withPipeline(async ({ service, read, provider, providers }) => {
      const started = await service.start(
        startInput([
          { agent: "claude", model: "default" },
          { agent: "codex", model: "default" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);

      const codex = providers.get("codex")!;
      expect(provider.created.find((entry) => entry.label === "Review 1")?.options?.model).toBe(
        "default",
      );
      expect(provider.sent.find((entry) => entry.sessionId.includes("review-1"))?.model).toBe(
        "default",
      );
      expect(
        codex.created.find((entry) => entry.label === "Review 2")?.options?.model,
      ).toBeUndefined();
      expect(codex.sent[0]?.model).toBeUndefined();
    });
  });

  test("a reviewer that pinned no model dispatches without one, on every harness", async () => {
    await withPipeline(async ({ service, read, provider, providers }) => {
      const started = await service.start(startInput([{ agent: "claude" }, { agent: "codex" }]));
      const stored = await read(started.id);
      // The placeholder is a label, not a selection. Claude's `"default"` is a
      // real catalog id, so the record has to say which of the two it is.
      expect(stored.reviewers).toEqual([{ agent: "claude" }, { agent: "codex" }]);

      const reviewing = await advanceUntil(service, read, started.id, "reviewing");
      expect(reviewing.reviewFanout?.reviewers.map((entry) => entry.modelUnpinned)).toEqual([
        true,
        true,
      ]);
      await service.advanceNow(started.id);

      const codex = providers.get("codex")!;
      expect(
        provider.created.find((entry) => entry.label === "Review 1")?.options?.model,
      ).toBeUndefined();
      expect(
        provider.sent.find((entry) => entry.sessionId.includes("review-1"))?.model,
      ).toBeUndefined();
      expect(
        codex.created.find((entry) => entry.label === "Review 2")?.options?.model,
      ).toBeUndefined();
      expect(codex.sent[0]?.model).toBeUndefined();
    });
  });

  test("emits the same content-free fan-out measurements as standalone Multi Review", async () => {
    const efficiency = new RecordingEfficiencyObserver();
    await withPipeline(
      async ({ service, read, packageGeneration }) => {
        const started = await service.start(
          startInput([
            { agent: "claude", model: "opus" },
            { agent: "claude", model: "sonnet" },
            { agent: "claude", model: "haiku" },
          ]),
        );
        const addressing = await advanceUntil(service, read, started.id, "addressing");
        expect(addressing.error ?? addressing.phase).toBe("addressing");
        // One check for the whole three-reviewer wave, plus address's check.
        expect(packageGeneration.verificationCount).toBe(2);
      },
      { efficiency },
    );
    const events = efficiency.events.filter((event) => event.owner === "build-pipeline");
    expect(efficiency.count("reviewer.send", { owner: "build-pipeline", outcome: "success" })).toBe(
      3,
    );
    expect(efficiency.count("evidence.verify", { owner: "build-pipeline" })).toBe(1);
    expect(efficiency.count("consolidation.input", { owner: "build-pipeline" })).toBe(1);
    expect(efficiency.count("launch.duplicate_reviewers", { owner: "build-pipeline" })).toBe(1);
    // Content-free by construction: nothing but enums and numbers.
    for (const event of events) {
      for (const value of Object.values(event)) {
        expect(["string", "number"]).toContain(typeof value);
        if (typeof value === "string") expect(value.length).toBeLessThan(40);
      }
    }
  });

  test("throttles token-count-only reviewer persistence", async () => {
    await withPipeline(
      async ({ service, storage, read, provider }) => {
        provider.runningModels.add("opus");
        provider.runningModels.add("sonnet");
        let tokens = 1_000;
        provider.usageFromMessages = () => {
          tokens += 250;
          return { usedTokens: 10, sessionTokens: tokens };
        };
        const started = await service.start(
          startInput([
            { agent: "claude", model: "opus" },
            { agent: "claude", model: "sonnet" },
          ]),
        );
        await advanceUntil(service, read, started.id, "reviewing");
        await service.advanceNow(started.id);
        const before = (await storage.getBuildPipeline(started.id))!.revision;
        const tokensAtPersist = tokens;

        await service.advanceNow(started.id);
        const after = (await storage.getBuildPipeline(started.id))!.revision;

        expect(after).toBe(before);
        // Inside the progress-probe and transcript-persist intervals a running
        // reviewer's transcript is not read at all, so the message-derived
        // meter is not consulted either.
        expect(tokens).toBe(tokensAtPersist);
      },
      { transcriptPersistIntervalMs: 60_000 },
    );
  });

  test("defers completion while a provider still reports usagePending", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.usagePending = true;
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await service.advanceNow(started.id);
      }
      const pending = await read(started.id);
      expect(pending.phase).toBe("reviewing");
      expect(
        pending.reviewFanout?.reviewers.every((reviewer) => reviewer.status === "running"),
      ).toBe(true);
      expect(
        pending.reviewFanout?.reviewers.some(
          (reviewer) => (reviewer.usageFinalizationPolls ?? 0) > 0,
        ),
      ).toBe(true);

      provider.usagePending = false;
      const addressing = await advanceUntil(service, read, started.id, "addressing");
      expect(addressing.error ?? addressing.phase).toBe("addressing");
    });
  });

  test.each([false, true])(
    "bounds delayed consolidation usage (never finalizes: %s)",
    async (neverFinalizes) => {
      await withPipeline(async ({ service, read, provider }) => {
        const originalObserve = provider.observeSession.bind(provider);
        let pending = true;
        let polls = 0;
        provider.observeSession = async (sessionId) => {
          const observation = await originalObserve(sessionId);
          if (!sessionId.includes("consolidation")) return observation;
          polls++;
          return {
            ...observation,
            usagePending: pending,
            ...(!pending ? { contextUsage: { usedTokens: 20, sessionTokens: 8_000 } } : {}),
          };
        };
        const started = await service.start(
          startInput([
            { agent: "claude", model: "opus" },
            { agent: "claude", model: "sonnet" },
          ]),
        );
        await advanceUntil(service, read, started.id, "reviewing");
        for (let attempt = 0; polls === 0 && attempt < 20; attempt++)
          await service.advanceNow(started.id);
        const waiting = await read(started.id);
        expect(waiting.phase).toBe("reviewing");
        const session = waiting.sessions.find((entry) => entry.label === "Consolidation")!;
        expect(session.usageFinalizationPolls).toBe(1);
        expect(session.completedAt).toBeDefined();
        if (neverFinalizes) {
          for (let poll = 2; poll <= REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS; poll++) {
            await service.advanceNow(started.id);
            expect((await read(started.id)).phase).toBe("reviewing");
          }
        } else {
          pending = false;
        }
        await service.advanceNow(started.id);
        const addressed = await read(started.id);
        expect(addressed.phase).toBe("addressing");
        const settled = addressed.sessions.find(
          (entry) => entry.sessionKey === session.sessionKey,
        )!;
        expect(settled.completedAt).toBe(session.completedAt);
        expect(settled.tokenCount).toBe(neverFinalizes ? undefined : 8_000);
        expect(polls).toBe(neverFinalizes ? REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS + 1 : 2);
      });
    },
  );

  test("throttles pure streaming transcript persistence", async () => {
    await withPipeline(
      async ({ service, storage, read, provider }) => {
        provider.runningModels.add("opus");
        provider.runningModels.add("sonnet");
        provider.changingMessages = true;
        const started = await service.start(
          startInput([
            { agent: "claude", model: "opus" },
            { agent: "claude", model: "sonnet" },
          ]),
        );
        await advanceUntil(service, read, started.id, "reviewing");
        await service.advanceNow(started.id);
        const before = (await storage.getBuildPipeline(started.id))!.revision;

        await service.advanceNow(started.id);
        const after = (await storage.getBuildPipeline(started.id))!.revision;

        expect(after).toBe(before);
      },
      { transcriptPersistIntervalMs: 60_000 },
    );
  });

  test("throttles pure consolidation transcript persistence", async () => {
    await withPipeline(
      async ({ service, storage, read, provider }) => {
        provider.runningConsolidation = true;
        provider.changingMessages = true;
        const started = await service.start(
          startInput([
            { agent: "claude", model: "opus" },
            { agent: "claude", model: "sonnet" },
          ]),
        );
        await advanceUntil(service, read, started.id, "reviewing");
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await service.advanceNow(started.id);
          if ((await read(started.id)).reviewFanout?.consolidation) break;
        }
        const before = (await storage.getBuildPipeline(started.id))!.revision;
        const readsBefore = provider.messageReads.filter(
          (entry) => entry.sessionId.includes("consolidation") && entry.limit === undefined,
        ).length;

        await service.advanceNow(started.id);
        const after = (await storage.getBuildPipeline(started.id))!.revision;
        const readsAfter = provider.messageReads.filter(
          (entry) => entry.sessionId.includes("consolidation") && entry.limit === undefined,
        ).length;

        expect(after).toBe(before);
        expect(readsAfter).toBe(readsBefore);
      },
      { transcriptPersistIntervalMs: 60_000 },
    );
  });

  test("persists a reviewer's final transcript even inside the persist interval", async () => {
    await withPipeline(
      async ({ service, read, provider, storage }) => {
        const transcriptOf = async (pipelineId: string, session: PipelineSession) => {
          const stored = await storage.readBuildPipelineTranscript(pipelineId, session);
          return stored.status === "found" ? JSON.stringify(stored.messages) : stored.status;
        };
        provider.runningModels.add("opus");
        provider.runningModels.add("sonnet");
        provider.changingMessages = true;
        const started = await service.start(
          startInput([
            { agent: "claude", model: "opus" },
            { agent: "claude", model: "sonnet" },
          ]),
        );
        await advanceUntil(service, read, started.id, "reviewing");
        await service.advanceNow(started.id);
        const before = await read(started.id);
        const reviewer = before.reviewFanout!.reviewers[0]!;
        const sessionBefore = before.sessions.find(
          (entry) => entry.sessionKey === reviewer.sessionKey,
        )!;
        const priorMessages = await transcriptOf(started.id, sessionBefore);
        provider.runningModels.delete("opus");
        await service.advanceNow(started.id);
        const after = await read(started.id);
        const sessionAfter = after.sessions.find(
          (entry) => entry.sessionKey === reviewer.sessionKey,
        )!;
        expect(after.reviewFanout!.reviewers[0]!.status).toBe("completed");
        expect(sessionAfter.status).toBe("idle");
        // The body lives in the transcript store; the control record only references it.
        expect(sessionAfter.messages).toBeUndefined();
        expect(sessionAfter.transcript?.revision).toBe(sessionAfter.messageRevision);
        expect(await transcriptOf(started.id, sessionAfter)).not.toBe(priorMessages);
      },
      { transcriptPersistIntervalMs: 60_000 },
    );
  });

  test("keeps consolidation open for background work and resumes the idle bound afterward", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      provider.missingConsolidationResult = true;
      provider.backgroundWorkLive = true;
      for (let attempt = 0; attempt < 16; attempt++) await service.advanceNow(started.id);
      expect((await read(started.id)).reviewFanout?.consolidation?.idleResultPolls).toBeUndefined();
      provider.backgroundWorkLive = false;
      for (let attempt = 0; attempt < 6; attempt++) await service.advanceNow(started.id);
      expect((await read(started.id)).phase).toBe("failed");
    });
  });

  test("keeps consolidation on the provider that created its durable session", async () => {
    await withPipeline(async ({ service, storage, read, provider, providers }) => {
      provider.runningConsolidation = true;
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await service.advanceNow(started.id);
        if ((await read(started.id)).reviewFanout?.consolidation) break;
      }
      const consolidation = (await read(started.id)).reviewFanout!.consolidation!;
      const readsBefore = provider.statusReads.length;
      await rewritePipeline(storage, started.id, (pipeline) => {
        pipeline.agentType = "codex";
      });

      await service.advanceNow(started.id);

      expect(provider.statusReads.slice(readsBefore)).toContain(consolidation.providerSessionId);
      expect(providers.get("codex")!.statusReads).not.toContain(consolidation.providerSessionId);
    });
  });

  test("repairs invalid consolidation output and unknown provenance", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.invalidConsolidationResults = 1;
      provider.unknownSourceConsolidationResults = 1;
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );

      const addressed = await advanceUntil(service, read, started.id, "addressing", 40);

      expect(addressed.phase).toBe("addressing");
      expect(
        provider.sent.filter((entry) => entry.sessionId.includes("consolidation")),
      ).toHaveLength(3);
    });
  });

  test("fails after the consolidation repair budget is exhausted", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.invalidConsolidationResults = 10;
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );

      const failed = await advanceUntil(service, read, started.id, "failed", 50);

      expect(failed.error).toContain("3 repair attempts");
    });
  });

  test("retries only consolidation after consolidation fails", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.invalidConsolidationResults = 10;
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
          { agent: "claude", model: "haiku" },
          { agent: "claude", model: "compact" },
        ]),
      );

      const failed = await advanceUntil(service, read, started.id, "failed", 60);
      const firstReviewerSessions = failed.reviewFanout!.reviewers.map(
        (reviewer) => reviewer.providerSessionId,
      );
      const firstReviewerReports = failed.reviewFanout!.reviewers.map(
        (reviewer) => reviewer.report,
      );
      const firstConsolidation = failed.reviewFanout!.consolidation!;

      provider.invalidConsolidationResults = 0;
      provider.runningConsolidation = true;
      const retried = await service.retryStage(started.id);

      expect(retried.phase).toBe("reviewing");
      expect(retried.error).toBeUndefined();
      expect(retried.failureContext).toBeUndefined();
      expect(retried.stageRetryRequested).toBeUndefined();
      expect(retried.reviewFanout?.reviewers.map((reviewer) => reviewer.providerSessionId)).toEqual(
        firstReviewerSessions,
      );
      expect(retried.reviewFanout?.reviewers.map((reviewer) => reviewer.report)).toEqual(
        firstReviewerReports,
      );
      expect(retried.reviewFanout?.consolidation?.providerSessionId).not.toBe(
        firstConsolidation.providerSessionId,
      );
      expect(
        provider.created.filter(
          (entry) => entry.label.startsWith("Review ") && entry.label !== "Review · Consolidation",
        ),
      ).toHaveLength(4);
      expect(
        provider.created.filter((entry) => entry.label === "Review · Consolidation"),
      ).toHaveLength(2);
      expect(provider.aborted).toContain(firstConsolidation.providerSessionId);

      provider.runningConsolidation = false;
      const addressing = await advanceUntil(service, read, started.id, "addressing", 10);
      expect(addressing.phase).toBe("addressing");
    });
  });

  test("retries the full panel after a mid-review snapshot error cancels unfinished reviewers", async () => {
    await withPipeline(async ({ service, storage, read, provider, packageGeneration }) => {
      provider.runningModels.add("haiku");
      provider.runningModels.add("compact");
      const started = await service.start(startInput(fourReviewers()));

      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);
      const midPanel = await read(started.id);
      expect(midPanel.reviewFanout?.reviewers.map((reviewer) => reviewer.status)).toEqual([
        "completed",
        "completed",
        "running",
        "running",
      ]);
      expect(reviewerSessionCreates(provider)).toHaveLength(4);
      expect(midPanel.reviewFanout?.consolidation).toBeUndefined();

      await rewritePipeline(storage, started.id, (pipeline) => {
        for (const reviewer of pipeline.reviewFanout!.reviewers) {
          if (reviewer.status === "running") reviewer.dispatchState = "prepared";
        }
      });
      packageGeneration.failVerification = true;
      const failed = await advanceUntil(service, read, started.id, "failed", 10);

      expect(failed.reviewFanout?.consolidation).toBeUndefined();
      expect(failed.reviewFanout?.reviewers.map((reviewer) => reviewer.status)).toEqual([
        "completed",
        "completed",
        "cancelled",
        "cancelled",
      ]);
      expect(failed.failureContext?.phase).toBe("reviewing");

      packageGeneration.failVerification = false;
      provider.runningModels.clear();
      const retried = await service.retryStage(started.id);

      expect(retried.phase).toBe("reviewing");
      expect(retried.reviewFanout?.reviewers).toHaveLength(4);
      expect(
        retried.reviewFanout?.reviewers.every((reviewer) => reviewer.status === "pending"),
      ).toBe(true);
      expect(retried.reviewFanout?.consolidation).toBeUndefined();

      await service.advanceNow(started.id);
      expect(reviewerSessionCreates(provider)).toHaveLength(8);
    });
  });

  test("an unexpected admission failure fails the pass and stops existing reviewers", async () => {
    await withPipeline(async ({ service, storage, read, provider, packageGeneration }) => {
      provider.runningModels.add("haiku");
      provider.runningModels.add("compact");
      const started = await service.start(startInput(fourReviewers()));
      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);
      const midPanel = await read(started.id);
      const running = midPanel.reviewFanout!.reviewers.filter(
        (reviewer) => reviewer.status === "running",
      );
      expect(running).toHaveLength(2);
      await rewritePipeline(storage, started.id, (pipeline) => {
        for (const reviewer of pipeline.reviewFanout!.reviewers) {
          if (reviewer.status === "running") reviewer.dispatchState = "prepared";
        }
      });
      packageGeneration.failUnexpectedly = true;
      const failed = await advanceUntil(service, read, started.id, "failed", 10);
      expect(failed.failureContext?.phase).toBe("reviewing");
      expect(
        failed.reviewFanout!.reviewers.filter((reviewer) => reviewer.status === "cancelled"),
      ).toHaveLength(2);
      for (const reviewer of running) {
        expect(provider.aborted).toContain(reviewer.providerSessionId!);
      }
    });
  });

  test("retries the full panel when consolidation createSession fails before a record exists", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.failingCreateLabels.add("Review · Consolidation");
      const started = await service.start(startInput(fourReviewers()));

      const failed = await advanceUntil(service, read, started.id, "failed", 20);
      expect(
        failed.reviewFanout?.reviewers.every((reviewer) => reviewer.status === "completed"),
      ).toBe(true);
      expect(failed.reviewFanout?.consolidation).toBeUndefined();
      expect(reviewerSessionCreates(provider)).toHaveLength(4);

      provider.failingCreateLabels.clear();
      const retried = await service.retryStage(started.id);

      expect(
        retried.reviewFanout?.reviewers.every((reviewer) => reviewer.status === "pending"),
      ).toBe(true);
      expect(retried.reviewFanout?.consolidation).toBeUndefined();

      await service.advanceNow(started.id);
      expect(reviewerSessionCreates(provider)).toHaveLength(8);
    });
  });

  test("retries the full panel when no reviewer produced a usable report", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      for (const model of ["opus", "sonnet", "haiku", "compact"]) {
        provider.failingModels.add(model);
      }
      const started = await service.start(startInput(fourReviewers()));

      const failed = await advanceUntil(service, read, started.id, "failed", 20);
      expect(failed.reviewFanout?.reviewers.every((reviewer) => reviewer.status === "failed")).toBe(
        true,
      );
      expect(failed.reviewFanout?.consolidation).toBeUndefined();
      expect(reviewerSessionCreates(provider)).toHaveLength(4);

      provider.failingModels.clear();
      const retried = await service.retryStage(started.id);

      expect(
        retried.reviewFanout?.reviewers.every((reviewer) => reviewer.status === "pending"),
      ).toBe(true);

      await service.advanceNow(started.id);
      expect(reviewerSessionCreates(provider)).toHaveLength(8);
    });
  });

  test("closes the failed tool-v1 consolidation slot and retries with a new requestId", async () => {
    await withPipeline(
      async ({ service, read, provider, workflowResults }) => {
        provider.failingConsolidation = true;
        const started = await service.start(startInput(fourReviewers()));

        const failed = await advanceUntil(service, read, started.id, "failed", 20);
        const firstConsolidation = failed.reviewFanout!.consolidation!;
        expect(firstConsolidation.resultTransport).toBe("tool-v1");
        expect(reviewerSessionCreates(provider)).toHaveLength(4);

        provider.failingConsolidation = false;
        provider.runningConsolidation = true;
        const retried = await service.retryStage(started.id);

        expect(
          retried.reviewFanout?.reviewers.map((reviewer) => reviewer.providerSessionId),
        ).toEqual(failed.reviewFanout!.reviewers.map((reviewer) => reviewer.providerSessionId));
        expect(retried.reviewFanout?.consolidation?.providerSessionId).not.toBe(
          firstConsolidation.providerSessionId,
        );
        expect(retried.reviewFanout?.consolidation?.requestId).not.toBe(
          firstConsolidation.requestId,
        );
        expect(retried.reviewFanout?.consolidation?.resultTransport).toBe("tool-v1");
        expect(
          await workflowResults!.status(
            { environmentId: "env-1", projectId: "project-1" },
            firstConsolidation.requestId,
          ),
        ).toMatchObject({ lifecycle: "superseded", completion: "blocked" });
        expect(reviewerSessionCreates(provider)).toHaveLength(4);
        expect(
          provider.created.filter((entry) => entry.label === "Review · Consolidation"),
        ).toHaveLength(2);
      },
      { toolMode: true },
    );
  });

  test("a tool-v1 consolidation that never submits says which call was missing", async () => {
    await withPipeline(
      async ({ service, read }) => {
        const started = await service.start(startInput(fourReviewers()));
        const failed = await advanceUntil(service, read, started.id, "failed", 30);
        expect(failed.reviewFanout?.consolidation?.resultTransport).toBe("tool-v1");
        expect(failed.error).toContain(
          "The consolidation session finished without calling submit_consolidated_review to submit its consolidated report",
        );
      },
      { toolMode: true },
    );
  });

  test("a container reviewer whose agent tools are unreachable fails instead of dispatching", async () => {
    const unreachable = "The container can't reach the agent tools server.";
    const preflights: Array<{ environmentId: string; stage: string }> = [];
    await withPipeline(
      async ({ service, read, provider }) => {
        const started = await service.start(
          startInput([
            { agent: "claude", model: "opus" },
            { agent: "claude", model: "sonnet" },
          ]),
        );
        const failed = await advanceUntil(service, read, started.id, "failed");
        expect(failed.phase).toBe("failed");
        expect(failed.error).toContain(unreachable);
        expect(
          failed.reviewFanout?.reviewers.map((reviewer) => [reviewer.status, reviewer.error]),
        ).toEqual([
          ["failed", unreachable],
          ["failed", unreachable],
        ]);
        // Reviewer sessions were opened but no reviewer prompt was ever sent.
        expect(reviewerSessionCreates(provider)).toHaveLength(2);
        expect(provider.sent.filter((entry) => /^review-\d+-/.test(entry.sessionId))).toEqual([]);
        expect(preflights.filter((entry) => entry.stage === "build pipeline reviewer")).toEqual([
          { environmentId: "env-1", stage: "build pipeline reviewer" },
          { environmentId: "env-1", stage: "build pipeline reviewer" },
        ]);
        expect(preflights.every((entry) => entry.stage === "build pipeline reviewer")).toBe(true);
      },
      {
        toolMode: true,
        toolKinds: ["review-report"],
        environmentType: "containerized",
        assertAgentToolsReachable: async (environmentId, stage) => {
          preflights.push({ environmentId, stage });
          throw new Error(unreachable);
        },
      },
    );
  });

  test("a container consolidation whose agent tools are unreachable fails before dispatch", async () => {
    const unreachable = "The container can't reach the agent tools server.";
    const preflights: Array<{ environmentId: string; stage: string }> = [];
    await withPipeline(
      async ({ service, read, provider }) => {
        const started = await service.start(
          startInput([
            { agent: "claude", model: "opus" },
            { agent: "claude", model: "sonnet" },
          ]),
        );
        const failed = await advanceUntil(service, read, started.id, "failed");
        expect(failed.phase).toBe("failed");
        expect(failed.error).toContain(unreachable);
        // Both reviewers ran on structured output; only consolidation needed tools.
        expect(
          provider.sent.filter(
            (entry) =>
              entry.sessionId.includes("review-") && !entry.sessionId.includes("consolidation"),
          ),
        ).toHaveLength(2);
        expect(provider.sent.filter((entry) => entry.sessionId.includes("consolidation"))).toEqual(
          [],
        );
        expect(failed.reviewFanout?.consolidation?.resultTransport).toBe("tool-v1");
        expect(preflights).toEqual([
          { environmentId: "env-1", stage: "build pipeline consolidation step" },
        ]);
      },
      {
        toolMode: true,
        environmentType: "containerized",
        assertAgentToolsReachable: async (environmentId, stage) => {
          preflights.push({ environmentId, stage });
          throw new Error(unreachable);
        },
      },
    );
  });

  test("nudges a real held tool report once across pipeline supervisor passes", async () => {
    await withPipeline(
      async ({ service, read, provider, workflowResults }) => {
        provider.runningModels.add("opus");
        provider.runningModels.add("sonnet");
        const started = await service.start(
          startInput([
            { agent: "claude", model: "opus" },
            { agent: "claude", model: "sonnet" },
          ]),
        );
        await advanceUntil(service, read, started.id, "reviewing");
        for (let pass = 0; pass < 10; pass += 1) {
          if (
            (await read(started.id)).reviewFanout?.reviewers.every(
              (reviewer) => reviewer.dispatchState === "sent",
            )
          )
            break;
          await service.advanceNow(started.id);
        }
        const reviewer = (await read(started.id)).reviewFanout!.reviewers[0]!;
        expect(reviewer.resultTransport).toBe("tool-v1");
        expect(reviewer.dispatchState).toBe("sent");
        const validation = await workflowResults!.validate(
          { environmentId: "env-1", projectId: "project-1" },
          reviewer.requestId!,
          reportFor("Final report"),
        );
        if (!validation.ok) throw new Error("report validation failed");
        await service.advanceNow(started.id);
        expect(provider.steers).toHaveLength(0);
        const realNow = Date.now;
        const now = spyOn(Date, "now").mockImplementation(
          () => realNow() + REVIEW_RESULT_COMMIT_NUDGE_MS,
        );
        try {
          await service.advanceNow(started.id);
          await service.advanceNow(started.id);
          await service.advanceNow(started.id);
        } finally {
          now.mockRestore();
        }
        expect(provider.steers).toHaveLength(1);
        expect(provider.steers[0]).toMatchObject({
          sessionId: reviewer.providerSessionId,
          action: { kind: "steer", expectedRunId: `${reviewer.providerSessionId}-run` },
        });
        expect(JSON.stringify(provider.steers[0])).toContain(validation.validatedDigest!);
        expect((await read(started.id)).reviewFanout!.reviewers[0]!.status).toBe("running");
        expect(workflowResults!.heldValidation(reviewer.requestId!)).toBeDefined();
      },
      { toolMode: true, toolKinds: ["review-report"] },
    );
  });

  test("a local review panel never runs the agent tools preflight", async () => {
    let preflights = 0;
    await withPipeline(
      async ({ service, read, provider }) => {
        provider.runningModels.add("opus");
        provider.runningModels.add("sonnet");
        const started = await service.start(
          startInput([
            { agent: "claude", model: "opus" },
            { agent: "claude", model: "sonnet" },
          ]),
        );
        await advanceUntil(service, read, started.id, "reviewing");
        const reviewerPrompts = () =>
          provider.sent.filter((entry) => /^review-\d+-/.test(entry.sessionId));
        for (let pass = 0; pass < 10 && reviewerPrompts().length < 2; pass += 1) {
          await service.advanceNow(started.id);
        }
        const reviewing = await read(started.id);
        expect(reviewing.error ?? reviewing.phase).toBe("reviewing");
        // Both tool-mode reviewers were dispatched with their agent tools.
        expect(reviewerPrompts()).toHaveLength(2);
        expect(
          reviewing.reviewFanout?.reviewers.map((reviewer) => reviewer.resultTransport),
        ).toEqual(["tool-v1", "tool-v1"]);
        expect(preflights).toBe(0);
      },
      {
        toolMode: true,
        toolKinds: ["review-report"],
        assertAgentToolsReachable: async () => {
          preflights += 1;
        },
      },
    );
  });

  test("continues from the immutable package when the live worktree HEAD moves", async () => {
    await withPipeline(async ({ service, read, provider, worktree }) => {
      provider.ambiguousModels.add("opus");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);
      worktree.head = "2".repeat(40);

      await service.advanceNow(started.id);
      const advanced = await read(started.id);

      expect(advanced.phase).toBe("addressing");
      expect(advanced.error).toBeUndefined();
      expect(provider.aborted).toHaveLength(0);
    });
  });

  test("does not probe the live worktree after the package is prepared", async () => {
    await withPipeline(async ({ service, read, provider, worktree }) => {
      provider.ambiguousModels.add("opus");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);
      worktree.fail = true;

      await service.advanceNow(started.id);
      const advanced = await read(started.id);

      expect(advanced.phase).toBe("addressing");
      expect(advanced.error).toBeUndefined();
    });
  });

  test("bounds blocked reviewer polling and aborts the parked sessions", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.blockedModels.add("opus");
      provider.blockedModels.add("sonnet");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      const failed = await advanceUntil(service, read, started.id, "failed", 20);

      expect(failed.error).toContain("stayed blocked");
      expect(provider.aborted).toHaveLength(2);
    });
  });

  test("abandons running reviewers whose durable progress clock is stale", async () => {
    await withPipeline(async ({ service, storage, read, provider }) => {
      provider.runningModels.add("opus");
      provider.runningModels.add("sonnet");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);
      await rewritePipeline(storage, started.id, (pipeline) => {
        for (const reviewer of pipeline.reviewFanout!.reviewers) {
          const warningAge = new Date(Date.now() - 11 * 60_000).toISOString();
          reviewer.progressAt = warningAge;
          reviewer.startedAt = warningAge;
        }
      });
      await service.advanceNow(started.id);
      expect(
        (await read(started.id)).reviewFanout?.reviewers.every(
          (reviewer) => reviewer.stalledSince !== undefined,
        ),
      ).toBe(true);
      expect(provider.aborted).toHaveLength(0);
      await rewritePipeline(storage, started.id, (pipeline) => {
        for (const reviewer of pipeline.reviewFanout!.reviewers) {
          reviewer.progressAt = new Date(0).toISOString();
          reviewer.startedAt = new Date(0).toISOString();
        }
      });

      const failed = await advanceUntil(service, read, started.id, "failed", 10);

      expect(failed.error).toContain("produced no activity");
      expect(provider.aborted).toHaveLength(2);
    });
  });

  test("cancel also stops a live consolidation session", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.runningConsolidation = true;
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await service.advanceNow(started.id);
        if ((await read(started.id)).reviewFanout?.consolidation) break;
      }
      const consolidationId = (await read(started.id)).reviewFanout!.consolidation!
        .providerSessionId;

      const cancelled = await service.cancel(started.id);

      expect(provider.aborted).toContain(consolidationId);
      expect(cancelled.sessions.every((session) => session.status !== "running")).toBe(true);
    });
  });

  test("removal stops every reviewer before deleting the pipeline", async () => {
    await withPipeline(async ({ service, storage, read, provider }) => {
      provider.runningModels.add("opus");
      provider.runningModels.add("sonnet");
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      await advanceUntil(service, read, started.id, "reviewing");
      await service.advanceNow(started.id);
      const liveIds = (await read(started.id)).reviewFanout!.reviewers.map(
        (reviewer) => reviewer.providerSessionId!,
      );

      await service.remove(started.id);

      expect(provider.aborted).toEqual(expect.arrayContaining(liveIds));
      expect(await storage.getBuildPipeline(started.id)).toBeNull();
    });
  });
});

test("pipeline fan-out evicts an unreachable generation and completes on reconnection", async () => {
  await withPipeline(async ({ service, read, provider, providers }) => {
    provider.runningModels.add("opus");
    provider.runningModels.add("sonnet");
    const started = await service.start(
      startInput([
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "sonnet" },
      ]),
    );
    const running = await advanceUntil(service, read, started.id, "reviewing");
    await service.advanceNow(started.id);
    const before = (await read(started.id)).reviewFanout!.reviewers;
    expect(before.every((reviewer) => reviewer.dispatchState === "sent")).toBe(true);
    const dead = providers.get("claude")!;
    const cache = (service as unknown as { providers: Map<string, unknown> }).providers;
    const cached = cache.get("env-1:claude");
    expect(cached).toBeDefined();
    // A fresh wrapper around the same fixture state models a reconnected
    // transport with the original session/report journal intact.
    const status = dead.status.bind(dead);
    const failure = spyOn(dead, "status").mockImplementation(async () => {
      throw new ProviderUnreachableError("Connection refused");
    });
    let disposals = 0;
    Object.assign(dead, {
      dispose: async () => {
        disposals += 1;
      },
    });
    await service.advanceNow(started.id);
    const interrupted = await read(started.id);
    expect(interrupted.phase).toBe("reviewing");
    expect(
      interrupted.reviewFanout!.reviewers.every((reviewer) => reviewer.status === "running"),
    ).toBe(true);
    expect(disposals).toBe(1);
    expect(cache.has("env-1:claude")).toBe(false);
    failure.mockRestore();
    const replacement = new Proxy(dead, {
      get(target, key) {
        return key === "status" ? status : Reflect.get(target, key);
      },
    });
    providers.set("claude", replacement);
    dead.runningModels.clear();
    dead.runningConsolidation = true;
    await service.advanceNow(started.id);
    const recovered = await read(started.id);
    expect(cache.get("env-1:claude")).toBeDefined();
    expect(cache.get("env-1:claude")).not.toBe(cached);
    expect(
      recovered.reviewFanout!.reviewers.every((reviewer) => reviewer.status === "completed"),
    ).toBe(true);
    expect(
      recovered.reviewFanout!.reviewers.map((reviewer) => [
        reviewer.providerSessionId,
        reviewer.requestId,
      ]),
    ).toEqual(before.map((reviewer) => [reviewer.providerSessionId, reviewer.requestId]));
    dead.runningConsolidation = false;
    const finished = await advanceUntil(service, read, started.id, "addressing");
    expect(finished.phase).toBe("addressing");
    expect(dead.aborted).toEqual([]);
    expect(
      dead.sent.filter((sent) => before.some((reviewer) => reviewer.requestId === sent.requestId)),
    ).toHaveLength(2);
    expect(running.reviewFanout).toBeDefined();
  });
});
