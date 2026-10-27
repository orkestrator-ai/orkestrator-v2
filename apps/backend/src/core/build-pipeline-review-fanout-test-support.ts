/**
 * Shared fixture for the build pipeline multi-model review suites: a provider
 * whose answers depend on which session asked, and a service wired to it.
 */
import type { RecordingEfficiencyObserver } from "./multi-review-efficiency.js";
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
import type { WorkflowResultKind } from "@orkestrator/protocol/workflow-results";
import { StorageService } from "./storage.js";
import {
  BuildPipelineService,
  type BuildPipelineServiceOptions,
} from "./build-pipeline-service.js";
import { ReviewSnapshotChangedError } from "./review-fanout.js";
import { WorkflowResultRollout } from "./workflow-result-rollout.js";
import { WorkflowResultService } from "./workflow-result-service.js";
import type {
  BuildPipelineProvider,
  ProviderCreateSessionOptions,
  ProviderSendOptions,
  ProviderStatus,
} from "./build-pipeline-provider.js";
import type {
  NativeAgentRuntimeProvider,
  ProviderDispatchStatus,
} from "./agent-provider-contract.js";
import { AmbiguousPromptDispatchError } from "./build-pipeline-provider.js";
import {
  TEST_REVIEW_PREPARATION,
  testGeneratedReviewPackage,
} from "./build-pipeline-test-fixtures.js";

export const HEAD = "1".repeat(40);
const FINGERPRINT = "a".repeat(64);

export function reportFor(summary: string, issueTitle?: string): StructuredReviewReport {
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
export class FanoutProvider implements BuildPipelineProvider {
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
    fastMode?: boolean;
    agentMcp?: ProviderSendOptions["agentMcp"];
    artifactGrant?: string;
  }> = [];
  readonly aborted: string[] = [];
  readonly steers: Array<{ sessionId: string; action: unknown }> = [];
  async steerSupported() {
    return true;
  }
  async activeSteerRun(sessionId: string) {
    return { state: "running" as const, runId: `${sessionId}-run` };
  }
  async performSessionAction(
    sessionId: string,
    action: Parameters<NonNullable<BuildPipelineProvider["performSessionAction"]>>[1],
  ) {
    this.steers.push({ sessionId, action });
    return { outcome: "applied" as const };
  }
  readonly statusReads: string[] = [];
  readonly messageReads: Array<{ sessionId: string; limit?: number }> = [];
  /**
   * Models whose sessions answer `error` rather than produce a report.
   *
   * Keyed by model rather than session id because a test has to arm the
   * failure before the fan-out opens the session it wants to fail.
   */
  readonly failingModels = new Set<string>();
  readonly failingCreateLabels = new Set<string>();
  readonly runningModels = new Set<string>();
  readonly blockedModels = new Set<string>();
  readonly ambiguousModels = new Set<string>();
  usageFromMessages?: BuildPipelineProvider["usageFromMessages"];
  usagePending = false;
  invalidConsolidationResults = 0;
  unknownSourceConsolidationResults = 0;
  runningConsolidation = false;
  missingConsolidationResult = false;
  backgroundWorkLive = false;
  failingConsolidation = false;
  changingMessages = false;
  /** Every session's transcript content while `changingMessages` is off. */
  contentVersion = 1;
  readonly transcriptOverrides = new Map<string, unknown[]>();
  readonly snapshotReads: Array<{ sessionId: string; knownSourceToken?: string }> = [];
  /**
   * The bounded conditional snapshot surface the progress probe prefers.
   * Absent unless a test calls {@link enableTranscriptSnapshot}, so the other
   * suites keep the whole-read path they were written against.
   */
  transcriptSnapshot?: NonNullable<NativeAgentRuntimeProvider["transcriptSnapshot"]>;
  private consolidationResultCalls = 0;
  private messageVersion = 0;
  private readonly ambiguityRaised = new Set<string>();
  private readonly sessionModels = new Map<string, string | undefined>();
  private readonly sessionPhases = new Map<string, PipelineSessionPhase>();
  private counter = 0;

  registerSession(): void {}

  /**
   * `send` deduplicates every id for good, so the fake's journal is complete:
   * an id it never took is provably `absent`. A test models a bridge that
   * lost completeness (a restart, an eviction) by setting this.
   */
  journalIncomplete = false;

  async dispatchStatus(_sessionId: string, requestId: string): Promise<ProviderDispatchStatus> {
    if (this.sent.some((entry) => entry.requestId === requestId)) return "dispatched";
    return this.journalIncomplete ? "unknown" : "absent";
  }

  async createSession(
    phase: PipelineSessionPhase,
    label: string,
    options?: ProviderCreateSessionOptions,
  ): Promise<string> {
    if (this.failingCreateLabels.has(label)) {
      throw new Error(`Refusing to create ${label}`);
    }
    this.created.push({ phase, label, options });
    const id = `${label.replace(/\s+/g, "-").toLowerCase()}-${++this.counter}`;
    this.sessionModels.set(id, options?.model);
    this.sessionPhases.set(id, phase);
    return id;
  }

  async send(sessionId: string, prompt: string, options: ProviderSendOptions): Promise<void> {
    // Model the provider's request-ID deduplication across lost acknowledgements.
    if (this.sent.some((entry) => entry.requestId === options.requestId)) return;
    this.sent.push({
      sessionId,
      prompt,
      requestId: options.requestId,
      model: options.model,
      fastMode: options.fastMode,
      ...(options.agentMcp ? { agentMcp: options.agentMcp } : {}),
      ...(options.artifactGrant ? { artifactGrant: options.artifactGrant } : {}),
    });
    const model = this.sessionModels.get(sessionId);
    if (model && this.ambiguousModels.has(model) && !this.ambiguityRaised.has(model)) {
      this.ambiguityRaised.add(model);
      throw new AmbiguousPromptDispatchError("dispatch outcome unknown");
    }
  }

  async status(sessionId: string): Promise<ProviderStatus> {
    this.statusReads.push(sessionId);
    if (sessionId.includes("consolidation") && this.failingConsolidation) return "error";
    if (sessionId.includes("consolidation") && this.runningConsolidation) return "running";
    const model = this.sessionModels.get(sessionId);
    if (model !== undefined && this.runningModels.has(model)) return "running";
    if (model !== undefined && this.blockedModels.has(model)) return "blocked";
    return model !== undefined && this.failingModels.has(model) ? "error" : "idle";
  }

  async observeSession(sessionId: string) {
    return {
      status: await this.status(sessionId),
      ...(this.usagePending ? { usagePending: true } : {}),
      ...(this.backgroundWorkLive ? { backgroundWorkLive: true } : {}),
    };
  }

  async messages(sessionId: string, options: { limit?: number } = {}): Promise<unknown[]> {
    this.messageReads.push({ sessionId, ...options });
    const version = this.changingMessages ? ++this.messageVersion : this.contentVersion;
    const messages = this.transcriptOverrides.get(sessionId) ?? [
      transcriptMessage(sessionId, version),
    ];
    return options.limit === undefined ? messages : messages.slice(-options.limit);
  }

  /** Answers `unchanged` for the token of the current `contentVersion`. */
  enableTranscriptSnapshot(): void {
    this.transcriptSnapshot = async (sessionId, options) => {
      this.snapshotReads.push({
        sessionId,
        ...(options.knownSourceToken ? { knownSourceToken: options.knownSourceToken } : {}),
      });
      const sourceToken = `${sessionId}:${this.contentVersion}`;
      if (options.knownSourceToken === sourceToken) return { unchanged: true, sourceToken };
      const all = this.transcriptOverrides.get(sessionId) ?? [
        transcriptMessage(sessionId, this.contentVersion),
      ];
      const messages = all.slice(-options.limit);
      return {
        messages,
        representation: "summary",
        revisedMessages: [],
        sourceToken,
        historyStartIndex: all.length - messages.length,
        complete: all.length === messages.length,
        freshness: "current",
      };
    };
  }

  /** Whole-transcript reads of the sessions whose id contains `fragment`. */
  wholeReads(fragment: string): number {
    return this.messageReads.filter(
      (entry) => entry.sessionId.includes(fragment) && entry.limit === undefined,
    ).length;
  }

  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null> {
    if (!this.sent.some((entry) => entry.requestId === requestId)) return null;
    const base = { ok: true as const, provider: "claude" as const, requestId };
    if (sessionId.includes("consolidation")) {
      if (this.missingConsolidationResult) return null;
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
      return {
        ...base,
        value: reportFor(`Report from ${sessionId}`, "Reviewer finding") as T,
      };
    }
    const phase = this.sessionPhases.get(sessionId);
    if (phase === "build" || phase === "fix") {
      return { ...base, value: TEST_REVIEW_PREPARATION as T };
    }
    // Address, verify, PR and resolve all answer their own contracts; none of
    // them matter to the fan-out, which ends at the consolidated report.
    return { ...base, value: { complete: true, rationale: "Done." } as T };
  }

  async abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId);
  }
}

function transcriptMessage(sessionId: string, version: number) {
  return {
    id: `${sessionId}-${version}`,
    role: "assistant",
    parts: [{ type: "text", content: `ok-${version}` }],
  };
}

export async function withPipeline(
  run: (context: {
    service: BuildPipelineService;
    createService: () => BuildPipelineService;
    storage: StorageService;
    provider: FanoutProvider;
    providers: Map<BuildPipelineAgent, FanoutProvider>;
    read: (id: string) => Promise<BuildPipeline>;
    worktree: { head: string; fingerprint: string; fail: boolean };
    packageGeneration: {
      count: number;
      verificationCount: number;
      failVerification: boolean;
      failUnexpectedly: boolean;
    };
    commands: string[];
    workflowResults?: WorkflowResultService;
  }) => Promise<void>,
  options: {
    transcriptPersistIntervalMs?: number;
    toolMode?: boolean;
    /** Result kinds admitted to tool mode; defaults to consolidation only. */
    toolKinds?: WorkflowResultKind[];
    /** Defaults to a local worktree environment. */
    environmentType?: "local" | "containerized";
    assertAgentToolsReachable?: (environmentId: string, stage: string) => Promise<void>;
    efficiency?: RecordingEfficiencyObserver;
    artifactDispatch?: BuildPipelineServiceOptions["artifactDispatch"];
    structuredResultDeadlineMs?: number;
  } = {},
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-fanout-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "build",
    branch: "build",
    containerId: options.environmentType === "containerized" ? "container-1" : null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: options.environmentType ?? "local",
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
  const packageGeneration = {
    count: 0,
    verificationCount: 0,
    failVerification: false,
    failUnexpectedly: false,
  };
  const commands: string[] = [];
  const invoke = async <T>(command: string, _args: Record<string, unknown> = {}): Promise<T> => {
    commands.push(command);
    if (command === "get_environment_uncommitted_paths") {
      if (worktree.fail) throw new Error("probe failed");
      return {
        head: worktree.head,
        paths: [],
        fingerprint: worktree.fingerprint,
      } as T;
    }
    if (command === "generate_looped_review_package") {
      packageGeneration.count += 1;
      const generated = testGeneratedReviewPackage(_args);
      const head = String(packageGeneration.count).repeat(40);
      generated.headRef = head;
      return generated as T;
    }
    if (command === "verify_looped_review_package") {
      packageGeneration.verificationCount += 1;
      if (packageGeneration.failUnexpectedly) throw new Error("verification service unavailable");
      if (packageGeneration.failVerification) {
        throw new ReviewSnapshotChangedError(
          "Multi-model review stopped because the environment worktree changed after the review started.",
        );
      }
      return { valid: true } as T;
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
  const workflowResults = options.toolMode ? new WorkflowResultService(dataDir) : undefined;
  const createService = () =>
    new BuildPipelineService(storage, invoke, {
      autoAdvance: false,
      provider: async (_pipeline, agent) => providers.get(agent)!,
      transcriptPersistIntervalMs: options.transcriptPersistIntervalMs,
      ...(options.structuredResultDeadlineMs !== undefined
        ? { structuredResultDeadlineMs: options.structuredResultDeadlineMs }
        : {}),
      ...(options.efficiency ? { efficiency: options.efficiency } : {}),
      ...(options.artifactDispatch ? { artifactDispatch: options.artifactDispatch } : {}),
      ...(workflowResults
        ? {
            workflowResults,
            resolveAgentToolConnection: () => ({
              url: "http://127.0.0.1:1234/mcp",
              token: "test-token",
            }),
            workflowResultRollout: new WorkflowResultRollout(async () => ({
              enabled: true,
              providers: ["claude"],
              kinds: options.toolKinds ?? ["consolidated-review"],
            })),
          }
        : {}),
      ...(options.assertAgentToolsReachable
        ? { assertAgentToolsReachable: options.assertAgentToolsReachable }
        : {}),
    });
  const service = createService();
  const read = async (id: string): Promise<BuildPipeline> => {
    const record = await storage.getBuildPipeline(id);
    if (!record) throw new Error("Pipeline disappeared");
    return record.snapshot as BuildPipeline;
  };
  try {
    await run({
      service,
      createService,
      storage,
      provider,
      providers,
      read,
      worktree,
      packageGeneration,
      commands,
      workflowResults,
    });
  } finally {
    await service.shutdown();
    workflowResults?.closeStorage();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

export function reviewerSessionCreates(provider: FanoutProvider) {
  return provider.created.filter(
    (entry) => entry.label.startsWith("Review ") && entry.label !== "Review · Consolidation",
  );
}

export function fourReviewers() {
  return [
    { agent: "claude" as const, model: "opus" },
    { agent: "claude" as const, model: "sonnet" },
    { agent: "claude" as const, model: "haiku" },
    { agent: "claude" as const, model: "compact" },
  ];
}

export function startInput(reviewers?: Array<{ agent: BuildPipelineAgent; model?: string }>) {
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
export async function advanceUntil(
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

export async function rewritePipeline(
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
