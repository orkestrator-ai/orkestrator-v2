import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BuildPipeline,
  BuildPipelineAgent,
  PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import { StorageService } from "./storage.js";
import { BuildPipelineService } from "./build-pipeline-service.js";
import type {
  BuildPipelineProvider,
  ProviderCreateSessionOptions,
  ProviderSendOptions,
  ProviderStatus,
} from "./build-pipeline-provider.js";
import { AmbiguousPromptDispatchError } from "./build-pipeline-provider.js";

const HEAD = "1".repeat(40);
const FINGERPRINT = "a".repeat(64);

function reportFor(summary: string, issueTitle?: string): StructuredReviewReport {
  return {
    reviewScope: {
      targetBranch: "main",
      baseRef: "base",
      commit: { sha: "head", subject: "feat: build" },
      filesReviewed: ["src/app.ts"],
      filesSkipped: [],
      filesLeftUncommitted: [],
      commandsRun: [],
      commandsNotRun: [],
      limitations: [],
    },
    whatChanged: {
      overview: "Implemented the task.",
      before: "Missing.",
      after: "Present.",
      keyCodeChanges: [{ file: "src/app.ts", line: 1, description: "Adds the feature." }],
      userImpact: "The feature is available.",
    },
    riskProfile: {
      changeTypes: ["feature"],
      riskAreas: [],
      overallRisk: "low",
      reasoning: "Small change.",
    },
    testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
    strengths: [],
    issues: issueTitle
      ? [
          {
            severity: "P2" as const,
            confidence: 90,
            category: "correctness" as const,
            title: issueTitle,
            file: "src/app.ts",
            line: 1,
            symbol: "render",
            description: "The branch is inverted.",
            evidence: "src/app.ts:1 returns early.",
            suggestion: "Invert the condition.",
            verification: "Run the unit test.",
          },
        ]
      : [],
    testCoverageGaps: [],
    verdict: { ready: "yes", reasoning: "Ready." },
    summaryOfChange: "Implemented the task.",
    reviewSummary: summary,
  };
}

/**
 * A provider whose answer depends on which session asked.
 *
 * The fan-out's whole point is that reviewers are independent, so the fake has
 * to be able to give each one a different report — and to give the
 * consolidation turn a merged one that cites their source IDs.
 */
class FanoutProvider implements BuildPipelineProvider {
  constructor(readonly agent: BuildPipelineAgent = "claude") {}
  readonly created: Array<{
    phase: PipelineSessionPhase;
    label: string;
    options?: ProviderCreateSessionOptions;
  }> = [];
  readonly sent: Array<{
    sessionId: string;
    prompt: string;
    requestId: string;
    model?: string;
  }> = [];
  readonly aborted: string[] = [];
  readonly statusReads: string[] = [];
  /**
   * Models whose sessions answer `error` rather than produce a report.
   *
   * Keyed by model rather than session id because a test has to arm the
   * failure before the fan-out opens the session it wants to fail.
   */
  readonly failingModels = new Set<string>();
  readonly runningModels = new Set<string>();
  readonly blockedModels = new Set<string>();
  readonly ambiguousModels = new Set<string>();
  invalidConsolidationResults = 0;
  unknownSourceConsolidationResults = 0;
  runningConsolidation = false;
  changingMessages = false;
  private consolidationResultCalls = 0;
  private messageVersion = 0;
  private readonly ambiguityRaised = new Set<string>();
  private readonly sessionModels = new Map<string, string | undefined>();
  private counter = 0;

  registerSession(): void {}

  async createSession(
    phase: PipelineSessionPhase,
    label: string,
    options?: ProviderCreateSessionOptions,
  ): Promise<string> {
    this.created.push({ phase, label, options });
    const id = `${label.replace(/\s+/g, "-").toLowerCase()}-${++this.counter}`;
    this.sessionModels.set(id, options?.model);
    return id;
  }

  async send(sessionId: string, prompt: string, options: ProviderSendOptions): Promise<void> {
    this.sent.push({ sessionId, prompt, requestId: options.requestId, model: options.model });
    const model = this.sessionModels.get(sessionId);
    if (model && this.ambiguousModels.has(model) && !this.ambiguityRaised.has(model)) {
      this.ambiguityRaised.add(model);
      throw new AmbiguousPromptDispatchError("dispatch outcome unknown");
    }
  }

  async status(sessionId: string): Promise<ProviderStatus> {
    this.statusReads.push(sessionId);
    if (sessionId.includes("consolidation") && this.runningConsolidation) return "running";
    const model = this.sessionModels.get(sessionId);
    if (model !== undefined && this.runningModels.has(model)) return "running";
    if (model !== undefined && this.blockedModels.has(model)) return "blocked";
    return model !== undefined && this.failingModels.has(model) ? "error" : "idle";
  }

  async messages(sessionId: string): Promise<unknown[]> {
    const version = this.changingMessages ? ++this.messageVersion : 1;
    return [
      {
        id: `${sessionId}-${version}`,
        role: "assistant",
        parts: [{ type: "text", content: `ok-${version}` }],
      },
    ];
  }

  async structured<T>(sessionId: string, requestId: string): Promise<StructuredOutputResult<T>> {
    const base = { ok: true as const, provider: "claude" as const, requestId };
    if (sessionId.includes("consolidation")) {
      this.consolidationResultCalls += 1;
      if (this.consolidationResultCalls <= this.invalidConsolidationResults) {
        return { ...base, value: {} as T };
      }
      const merged = reportFor("Merged review.", "Consolidated finding");
      const sourceId =
        this.consolidationResultCalls <=
        this.invalidConsolidationResults + this.unknownSourceConsolidationResults
          ? "reviewer-999/issue-1"
          : "reviewer-1/issue-1";
      return {
        ...base,
        value: {
          ...merged,
          issues: merged.issues.map((issue) => ({
            ...issue,
            reviewModels: null,
            reviewSourceIds: [sourceId],
          })),
        } as T,
      };
    }
    if (sessionId.includes("review")) {
      return { ...base, value: reportFor(`Report from ${sessionId}`, "Reviewer finding") as T };
    }
    // Address, verify, PR and resolve all answer their own contracts; none of
    // them matter to the fan-out, which ends at the consolidated report.
    return { ...base, value: { complete: true, rationale: "Done." } as T };
  }

  async abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId);
  }
}

async function withPipeline(
  run: (context: {
    service: BuildPipelineService;
    storage: StorageService;
    provider: FanoutProvider;
    providers: Map<BuildPipelineAgent, FanoutProvider>;
    read: (id: string) => Promise<BuildPipeline>;
    worktree: { head: string; fingerprint: string; fail: boolean };
  }) => Promise<void>,
  options: { transcriptPersistIntervalMs?: number } = {},
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-fanout-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "build",
    branch: "build",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/build",
    setupScriptsComplete: true,
  });
  const provider = new FanoutProvider();
  const providers = new Map<BuildPipelineAgent, FanoutProvider>([
    ["claude", provider],
    ["codex", new FanoutProvider("codex")],
    ["opencode", new FanoutProvider("opencode")],
    ["cursor", new FanoutProvider("cursor")],
    ["pi", new FanoutProvider("pi")],
  ]);
  const worktree = { head: HEAD, fingerprint: FINGERPRINT, fail: false };
  const invoke = async <T>(command: string, _args: Record<string, unknown> = {}): Promise<T> => {
    if (command === "get_environment_uncommitted_paths") {
      if (worktree.fail) throw new Error("probe failed");
      return { head: worktree.head, paths: [], fingerprint: worktree.fingerprint } as T;
    }
    if (command === "start_environment" || command === "run_environment_setup") {
      return (await storage.getEnvironment("env-1")) as T;
    }
    if (command === "update_environment_agent_settings") {
      return (await storage.getEnvironment("env-1")) as T;
    }
    if (command === "get_kanban_tasks") return [] as T;
    if (command === "update_kanban_task") return {} as T;
    if (command === "add_kanban_comment") return undefined as T;
    if (command === "detect_pr_local" || command === "detect_pr") return null as T;
    if (command === "pr_monitor_watch") return undefined as T;
    return undefined as T;
  };
  const service = new BuildPipelineService(storage, invoke, {
    autoAdvance: false,
    provider: async (_pipeline, agent) => providers.get(agent)!,
    ...options,
  });
  const read = async (id: string): Promise<BuildPipeline> => {
    const record = await storage.getBuildPipeline(id);
    if (!record) throw new Error("Pipeline disappeared");
    return record.snapshot as BuildPipeline;
  };
  try {
    await run({ service, storage, provider, providers, read, worktree });
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function startInput(reviewers?: Array<{ agent: BuildPipelineAgent; model?: string }>) {
  return {
    taskId: "task-1",
    projectId: "project-1",
    environmentType: "local" as const,
    agentType: "claude" as const,
    taskTitle: "Multi-model review",
    taskSnapshot: {
      title: "Multi-model review",
      description: "Run several reviewers",
      acceptanceCriteria: "The reports are consolidated",
      comments: [],
      images: [],
    },
    existingEnvironmentId: "env-1",
    ...(reviewers ? { reviewers } : {}),
  };
}

/** Drives ticks until the pipeline leaves `phase`, or the budget runs out. */
async function advanceUntil(
  service: BuildPipelineService,
  read: (id: string) => Promise<BuildPipeline>,
  id: string,
  phase: BuildPipeline["phase"],
  budget = 25,
): Promise<BuildPipeline> {
  let current = await read(id);
  for (let attempt = 0; attempt < budget && current.phase !== phase; attempt += 1) {
    await service.advanceNow(id);
    current = await read(id);
  }
  return current;
}

async function rewritePipeline(
  storage: StorageService,
  id: string,
  mutate: (pipeline: BuildPipeline) => void,
): Promise<void> {
  const record = await storage.getBuildPipeline(id);
  if (!record) throw new Error("Pipeline disappeared");
  const pipeline = record.snapshot as BuildPipeline;
  mutate(pipeline);
  await storage.saveBuildPipeline(
    record.id,
    record.projectId,
    record.environmentId,
    record.version,
    pipeline,
    record.revision,
  );
}

describe("build pipeline multi-model review", () => {
  test("a single reviewer keeps the classic one-session review stage", async () => {
    await withPipeline(async ({ service, read }) => {
      const started = await service.start(startInput([{ agent: "claude", model: "opus" }]));
      const stored = await read(started.id);
      // Normalised away on the way in: a one-entry panel is the stage the
      // pipeline has always run, and storing it would open a consolidation turn
      // that merges one report into itself.
      expect(stored.reviewers).toBeUndefined();
    });
  });

  test("fans out to every reviewer, consolidates, then addresses the merged report", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      const started = await service.start(
        startInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      const reviewing = await advanceUntil(service, read, started.id, "reviewing");
      expect(reviewing.phase).toBe("reviewing");
      expect(reviewing.reviewFanout?.reviewers).toHaveLength(2);
      expect(reviewing.reviewFanout?.snapshot?.head).toBe(HEAD);

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
      expect(
        addressing.sessions.filter((session) => session.label.startsWith("Review")).length,
      ).toBeGreaterThanOrEqual(2);
      // Settled reviewers must not still read as running in the build tab.
      const reviewSessions = addressing.sessions.filter((session) =>
        /^Review \d+$/.test(session.label),
      );
      expect(reviewSessions).toHaveLength(2);
      expect(reviewSessions.every((session) => session.status === "idle")).toBe(true);
      // Everything downstream reads one report, and the fan-out record is gone.
      expect(addressing.structuredReview?.reviewSummary).toBe("Merged review.");
      expect(addressing.reviewFanout).toBeUndefined();
      // Provenance is derived by the backend from the cited source IDs, never
      // taken from what the consolidation model claimed.
      expect(addressing.structuredReview?.issues[0]?.reviewModels).toEqual(["claude/opus"]);
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

  test("review retry abandons the old panel before opening a new one", async () => {
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
      const firstPanel = (await read(started.id)).reviewFanout!.reviewers.map(
        (reviewer) => reviewer.providerSessionId!,
      );
      await rewritePipeline(storage, started.id, (pipeline) => {
        pipeline.structuredReview = reportFor("Previous review");
        pipeline.verificationResult = "fail";
        pipeline.verificationFeedback = "Previous verification";
      });

      await service.retryReview(started.id);
      const retried = await read(started.id);

      expect(provider.aborted).toEqual(expect.arrayContaining(firstPanel));
      expect(retried.reviewRetryRequested).toBeUndefined();
      expect(retried.structuredReview).toBeUndefined();
      expect(retried.verificationResult).toBeUndefined();
      expect(retried.verificationFeedback).toBeUndefined();
      expect(
        retried.reviewFanout?.reviewers.map((reviewer) => reviewer.providerSessionId),
      ).not.toEqual(firstPanel);
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

        await service.advanceNow(started.id);
        const after = (await storage.getBuildPipeline(started.id))!.revision;

        expect(after).toBe(before);
      },
      { transcriptPersistIntervalMs: 60_000 },
    );
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

  test("fails closed and abandons live reviewers when the worktree snapshot drifts", async () => {
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
      const failed = await read(started.id);

      expect(failed.phase).toBe("failed");
      expect(failed.error).toContain("worktree changed");
      expect(failed.sessions.every((session) => session.status !== "running")).toBe(true);
      expect(provider.aborted.length).toBeGreaterThan(0);
    });
  });

  test("fails closed when the pinned snapshot can no longer be verified", async () => {
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
      const failed = await read(started.id);

      expect(failed.phase).toBe("failed");
      expect(failed.error).toContain("cannot verify its worktree snapshot");
      expect(failed.sessions.every((session) => session.status !== "running")).toBe(true);
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
