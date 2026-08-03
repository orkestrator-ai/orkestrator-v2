import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  type AgentInteractionRequest,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";
import {
  LOOPED_REVIEW_WORKFLOW_VERSION,
  type LoopedReviewWorkflow,
  type LoopedReviewAgent,
} from "@orkestrator/protocol/review-workflow";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import { StorageService } from "./storage.js";
import { LoopedReviewService } from "./looped-review-service.js";
import type {
  BuildPipelineProvider,
  ProviderCreateSessionOptions,
  ProviderSendOptions,
  ProviderSessionRegistration,
  ProviderStatus,
} from "./build-pipeline-provider.js";

const cleanReport: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "origin/main...HEAD",
    commit: null,
    filesReviewed: [],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "No relevant changes.",
    before: "Unchanged.",
    after: "Unchanged.",
    keyCodeChanges: [],
    userImpact: "None.",
  },
  riskProfile: { changeTypes: [], riskAreas: [], overallRisk: "low", reasoning: "No change." },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Ready." },
  summaryOfChange: "No change.",
  reviewSummary: "No high-confidence issues were found in the reviewed scope.",
};

const reviewIssue: StructuredReviewReport["issues"][number] = {
  severity: "P1",
  confidence: 95,
  category: "correctness",
  title: "Persist the authoritative transition",
  file: "src/controller.ts",
  line: 42,
  symbol: "advance",
  description: "The transition must be persisted before provider I/O.",
  evidence: "The call currently precedes the save.",
  suggestion: "Save the transition first.",
  verification: "Restart between the save and provider call.",
};

const issueReport: StructuredReviewReport = {
  ...cleanReport,
  issues: [reviewIssue],
  verdict: { ready: "with-fixes", reasoning: "One issue needs a fix." },
  reviewSummary: "One high-confidence issue was found.",
};

function inputRequest(id = "question-1", provider: LoopedReviewAgent = "claude"): AgentInteractionRequest {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    id,
    provider,
    kind: "question",
    origin: "looped-review",
    sessionId: "review-session",
    state: "pending",
    revision: 1,
    presentation: {
      title: "Choose an implementation",
      questions: [{
        id: "choice",
        prompt: "Which safe default should be used?",
        required: true,
        multiple: false,
        secret: false,
        allowFreeText: false,
        options: [{ id: "safe", label: "Safest", providerValue: "never-persist-this" }],
      }],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

class FakeProvider implements BuildPipelineProvider {
  readonly agent: LoopedReviewAgent;
  readonly sent: Array<{ sessionId: string; requestId: string; schema?: JsonSchema }> = [];
  readonly registrations: Array<{ sessionId: string; interaction?: ProviderSessionRegistration }> = [];
  readonly sessions = new Map<string, string>();
  readonly pending = new Map<string, AgentInteractionRequest[]>();
  statusValue: ProviderStatus = "idle";
  statusRejectCount = 0;
  returnNull = false;
  ambiguousOnce = false;
  definiteRejectOnce = false;
  abortRejectCount = 0;
  abortCount = 0;
  resolveCount = 0;
  structuredCount = 0;
  structuredRejectCount = 0;
  structuredValueOverride: unknown = undefined;
  sendBarrier: Promise<void> | null = null;
  reviewReport: StructuredReviewReport = cleanReport;
  reviewReports: StructuredReviewReport[] = [];
  reconciliationValue: unknown = {
    newIssues: [], issueUpdates: [], newCoverageGaps: [], coverageGapUpdates: [],
    issueOutcomes: [], coverageGapOutcomes: [],
  };
  reconciliationValues: unknown[] = [];
  private ambiguousThrown = false;
  private definiteThrown = false;

  readonly interactions: NonNullable<BuildPipelineProvider["interactions"]>;

  constructor(agent: LoopedReviewAgent = "claude") {
    this.agent = agent;
    this.interactions = {
      listPendingInteractions: async (sessionId: string): Promise<AgentInteractionSnapshot> => ({
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        revision: 1,
        requests: this.pending.get(sessionId) ?? [],
      }),
      resolveInteraction: async (sessionId, interactionId) => {
        this.resolveCount += 1;
        if (this.statusValue === "blocked") this.statusValue = "running";
        this.pending.set(sessionId, (this.pending.get(sessionId) ?? [])
          .filter((request) => request.id !== interactionId));
        return { result: "applied" as const, revision: 2, sessionId, interactionId };
      },
      watchInteractions: () => () => undefined,
    };
  }

  registerSession(sessionId: string, interaction?: ProviderSessionRegistration): void {
    this.registrations.push({ sessionId, interaction });
  }

  async createSession(
    phase: "build" | "review" | "verify" | "fix" | "pr" | "resolve-conflicts",
    _label: string,
    options?: ProviderCreateSessionOptions,
  ): Promise<string> {
    const key = options?.clientSessionKey ?? `${phase}:${this.sessions.size}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const id = `${phase}-session-${this.sessions.size + 1}`;
    this.sessions.set(key, id);
    return id;
  }

  async send(sessionId: string, _prompt: string, options: ProviderSendOptions): Promise<void> {
    this.sent.push({ sessionId, requestId: options.requestId, schema: options.schema });
    if (this.sendBarrier) await this.sendBarrier;
    if (this.ambiguousOnce && !this.ambiguousThrown) {
      this.ambiguousThrown = true;
      const { AmbiguousPromptDispatchError } = await import("./build-pipeline-provider.js");
      throw new AmbiguousPromptDispatchError("response lost after acceptance");
    }
    if (this.definiteRejectOnce && !this.definiteThrown) {
      this.definiteThrown = true;
      const { ProviderUnavailableError } = await import("./build-pipeline-provider.js");
      throw new ProviderUnavailableError("preflight rejected before dispatch");
    }
  }

  async status(): Promise<ProviderStatus> {
    if (this.statusRejectCount > 0) {
      this.statusRejectCount -= 1;
      throw new Error("status transport unavailable");
    }
    return this.statusValue;
  }
  async messages(): Promise<unknown[]> { return []; }

  async structured<T>(_sessionId: string, requestId: string): Promise<StructuredOutputResult<T> | null> {
    this.structuredCount += 1;
    if (this.structuredRejectCount > 0) {
      this.structuredRejectCount -= 1;
      throw new Error("structured result session read failed");
    }
    if (this.returnNull) return null;
    const send = this.sent.find((entry) => entry.requestId === requestId);
    const required = (send?.schema as { required?: string[] } | undefined)?.required ?? [];
    let value: unknown;
    if (this.structuredValueOverride !== undefined) {
      value = this.structuredValueOverride;
      this.structuredValueOverride = undefined;
    } else if (required.includes("validation")) {
      value = { validation: [], uncommittedFiles: [], limitations: [] };
    } else if (required.includes("reviewScope")) {
      value = this.reviewReports.shift() ?? this.reviewReport;
    } else if (required.includes("issueOutcomes")) {
      value = this.reconciliationValues.shift() ?? this.reconciliationValue;
    } else if (required.includes("url")) {
      value = { status: "created", url: "https://github.com/acme/repo/pull/7", summary: "Created." };
    } else {
      value = { complete: true, summary: "Fixed.", filesChanged: [], commandsRun: [], notes: [], limitations: [] };
    }
    return { ok: true, provider: this.agent, requestId, value: value as T };
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    if (this.abortRejectCount > 0) {
      this.abortRejectCount -= 1;
      throw new Error("abort transport unavailable");
    }
  }
}

async function harness(run: (
  service: LoopedReviewService,
  storage: StorageService,
  provider: FakeProvider,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
) => Promise<void>, agent: LoopedReviewAgent = "claude", serviceOptions: {
  controllerLeaseMs?: number;
  cancellationDeadlineMs?: number;
  useProductionProvider?: boolean;
  bridgeAuthToken?: string;
} = {}): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-looped-review-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(),
    networkAccessMode: "full", order: 0, environmentType: "local",
    worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const provider = new FakeProvider(agent);
  const bridgeCalls: string[] = [];
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (command.startsWith("start_local_") || command.startsWith("start_") && command.endsWith("_server")) {
      bridgeCalls.push(command);
      return {
        ...(command.startsWith("start_local_") ? { port: 4312 } : { hostPort: 4313 }),
        ...(serviceOptions.bridgeAuthToken === undefined
          ? { authToken: "test-bridge-token" }
          : serviceOptions.bridgeAuthToken
            ? { authToken: serviceOptions.bridgeAuthToken }
            : {}),
      } as T;
    }
    if (command === "generate_looped_review_package") {
      return {
        id: args.packageId, round: args.round, preparedAt: new Date().toISOString(),
        targetBranch: args.targetBranch, baseRef: "aaaaaaa", headRef: "bbbbbbb",
        commit: null, completeDiff: "", changedFiles: [], validation: [],
        skippedFiles: [], uncommittedFiles: [], limitations: [],
      } as T;
    }
    if (command === "verify_environment_pr") {
      return { url: args.prUrl } as T;
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  const { useProductionProvider, bridgeAuthToken: _bridgeAuthToken, ...controllerOptions } = serviceOptions;
  const service = new LoopedReviewService(storage, invoke, {
    autoAdvance: false,
    ...(useProductionProvider ? {} : { provider: async () => provider }),
    missingResultPollLimit: 3,
    ...controllerOptions,
  });
  Object.assign(invoke, { bridgeCalls });
  await service.init();
  try { await run(service, storage, provider, invoke); }
  finally { await service.shutdown(); await fs.rm(dataDir, { recursive: true, force: true }); }
}

async function snapshot(storage: StorageService, id: string): Promise<LoopedReviewWorkflow> {
  const record = await storage.getLoopedReviewWorkflow(id);
  if (!record) throw new Error("workflow missing");
  return { ...(record.snapshot as LoopedReviewWorkflow), backendRevision: record.revision };
}

async function pump(service: LoopedReviewService, id: string, passes = 20): Promise<void> {
  for (let index = 0; index < passes; index += 1) await service.advanceNow(id);
}

function workflowFixture(overrides: Partial<LoopedReviewWorkflow> = {}): LoopedReviewWorkflow {
  const now = "2026-08-03T00:00:00.000Z";
  return {
    version: LOOPED_REVIEW_WORKFLOW_VERSION,
    controller: "backend",
    id: "workflow-1",
    environmentId: "env-1",
    projectId: "project-1",
    agent: "claude",
    model: "model",
    targetBranch: "main",
    startingAllowance: 1,
    currentAllowance: 1,
    currentRound: 1,
    currentPass: 0,
    phase: "preparing",
    rounds: [{ round: 1, allowance: 1, status: "preparing", passes: [], startedAt: now }],
    activePool: { issues: [], coverageGaps: [] },
    archivedPools: [],
    sessions: [],
    interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
    pr: { status: "pending" },
    createdAt: now,
    updatedAt: now,
    backendRevision: 1,
    ...overrides,
  };
}

describe("LoopedReviewService", () => {
  test("rejects invalid, missing, wrong-project, and deleting review environments", async () => {
    await harness(async (service, storage) => {
      await expect(service.start({} as never)).rejects.toThrow("Invalid looped review start request");
      const base = {
        environmentId: "missing", projectId: "project-1", agent: "claude" as const,
        model: "model", targetBranch: "main", allowance: 1,
      };
      await expect(service.start(base)).rejects.toThrow("review environment is unavailable");
      await expect(service.start({ ...base, environmentId: "env-1", projectId: "wrong" }))
        .rejects.toThrow("review environment is unavailable");
      await storage.updateEnvironment("env-1", { deletionRequestedAt: new Date().toISOString() });
      await expect(service.start({ ...base, environmentId: "env-1" }))
        .rejects.toThrow("review environment is unavailable");
    });
  });

  test("selects, caches, authenticates, and disposes the production local bridge provider", async () => {
    await harness(async (service, _storage, _fakeProvider, invoke) => {
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "review-model", targetBranch: "main", allowance: 1,
      });
      const internal = service as unknown as {
        provider(workflow: LoopedReviewWorkflow): Promise<BuildPipelineProvider>;
      };

      const first = await internal.provider(started);
      const second = await internal.provider(started);
      expect(second).toBe(first);
      expect((first as unknown as { connection: unknown }).connection).toMatchObject({
        agent: "claude",
        baseUrl: "http://127.0.0.1:4312",
        authToken: "test-bridge-token",
        directory: "/tmp/review",
        model: "review-model",
      });
      expect((invoke as typeof invoke & { bridgeCalls: string[] }).bridgeCalls)
        .toEqual(["start_local_claude_server_cmd"]);

      const dispose = mock(async () => undefined);
      first.dispose = dispose;
      await service.shutdown();
      expect(dispose).toHaveBeenCalledTimes(1);
    }, "claude", { useProductionProvider: true });
  });

  test("selects the production container bridge command", async () => {
    await harness(async (service, storage, _fakeProvider, invoke) => {
      await storage.updateEnvironment("env-1", {
        environmentType: "containerized", containerId: "container-1", worktreePath: null,
      });
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "codex",
        model: "default", targetBranch: "main", allowance: 1,
      });
      const internal = service as unknown as {
        provider(workflow: LoopedReviewWorkflow): Promise<BuildPipelineProvider>;
      };

      const provider = await internal.provider(started);
      expect((provider as unknown as { connection: unknown }).connection).toMatchObject({
        agent: "codex",
        baseUrl: "http://127.0.0.1:4313",
        authToken: "test-bridge-token",
      });
      expect((invoke as typeof invoke & { bridgeCalls: string[] }).bridgeCalls)
        .toEqual(["start_codex_server"]);
    }, "codex", { useProductionProvider: true });
  });

  test("refuses to construct a production provider without bridge authentication", async () => {
    await harness(async (service) => {
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "default", targetBranch: "main", allowance: 1,
      });
      const internal = service as unknown as {
        provider(workflow: LoopedReviewWorkflow): Promise<BuildPipelineProvider>;
      };
      await expect(internal.provider(started)).rejects
        .toThrow("claude bridge authentication is unavailable");
    }, "claude", { useProductionProvider: true, bridgeAuthToken: "" });
  });

  test("advances to PR completion without a renderer and marks every session unattended", async () => {
    await harness(async (service, storage, provider) => {
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 2,
      });
      await pump(service, started.id);
      const finished = await snapshot(storage, started.id);
      expect(finished.phase).toBe("completed");
      expect(finished.pr.url).toBe("https://github.com/acme/repo/pull/7");
      expect(provider.sent).toHaveLength(4);
      expect(await service.providerSession(started.id)).toEqual({
        providerSessionId: finished.sessions.at(-1)!.providerSessionId,
      });
      expect(await service.providerSession(started.id, finished.sessions[0]!.id)).toEqual({
        providerSessionId: finished.sessions[0]!.providerSessionId,
      });
      expect(await service.providerSession("missing")).toBeNull();
      expect(provider.registrations.length).toBeGreaterThan(0);
      for (const registration of provider.registrations) {
        expect(registration.interaction).toMatchObject({
          origin: "looped-review",
          workflowId: started.id,
          interactionPolicy: { mode: "unattended" },
        });
        expect(typeof registration.interaction?.fence).toBe("string");
      }
    });
  });

  test("applies new, updated, existing, and coverage-gap reconciliation across allowance rounds", async () => {
    await harness(async (service, storage, provider) => {
      const initialGap = { file: "src/controller.test.ts", untestedBehavior: "restart recovery" };
      const updatedIssue = { ...reviewIssue, description: "The transition and fence must persist." };
      const updatedGap = { ...initialGap, untestedBehavior: "restart and lease-loss recovery" };
      provider.reviewReports = [
        { ...issueReport, testCoverageGaps: [initialGap] },
        { ...issueReport, issues: [updatedIssue, reviewIssue], testCoverageGaps: [updatedGap] },
        cleanReport,
      ];
      provider.reconciliationValues = [
        {
          newIssues: [reviewIssue], issueUpdates: [], newCoverageGaps: [initialGap], coverageGapUpdates: [],
          issueOutcomes: [{ reportIndex: 0, outcome: "new", poolId: null }],
          coverageGapOutcomes: [{ reportIndex: 0, outcome: "new", poolId: null }],
        },
      ];
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 2,
      });
      // Complete the first pass so its generated pool IDs can be used by the
      // provider's second authoritative reconciliation.
      for (let index = 0; index < 12; index += 1) {
        await service.advanceNow(started.id);
        const current = await snapshot(storage, started.id);
        if (current.currentPass === 2 && current.phase === "reconciling" && !current.dispatch) {
          const issueId = current.activePool.issues[0]!.poolId;
          const gapId = current.activePool.coverageGaps[0]!.poolId;
          provider.reconciliationValues.push({
            newIssues: [], issueUpdates: [{ poolId: issueId, finding: updatedIssue }],
            newCoverageGaps: [], coverageGapUpdates: [{ poolId: gapId, finding: updatedGap }],
            issueOutcomes: [
              { reportIndex: 0, outcome: "updated", poolId: issueId },
              { reportIndex: 1, outcome: "existing", poolId: issueId },
            ],
            coverageGapOutcomes: [{ reportIndex: 0, outcome: "updated", poolId: gapId }],
          });
          break;
        }
      }
      await pump(service, started.id, 30);
      const finished = await snapshot(storage, started.id);
      expect(finished.phase).toBe("completed");
      expect(finished.rounds.map((round) => round.allowance)).toEqual([2, 1]);
      expect(finished.archivedPools[0]?.pool.issues[0]).toMatchObject(updatedIssue);
      expect(finished.archivedPools[0]?.pool.coverageGaps[0]).toMatchObject(updatedGap);
    });
  });

  test("terminal workflows ignore lifecycle commands", async () => {
    await harness(async (service, storage, provider) => {
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      await pump(service, started.id);
      expect((await snapshot(storage, started.id)).phase).toBe("completed");
      expect((await service.pause(started.id)).phase).toBe("completed");
      expect((await service.resume(started.id)).phase).toBe("completed");
      expect((await service.retry(started.id)).phase).toBe("completed");
      expect((await service.cancel(started.id)).phase).toBe("completed");
      expect(provider.abortCount).toBe(0);
    });
  });

  test("does not redispatch after ambiguous provider acceptance", async () => {
    await harness(async (service, storage, provider) => {
      provider.ambiguousOnce = true;
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      await service.advanceNow(started.id);
      expect(provider.sent).toHaveLength(1);
      expect((await snapshot(storage, started.id)).dispatch?.state).toBe("dispatching");
      await service.advanceNow(started.id);
      expect(provider.sent).toHaveLength(1);
      expect((await snapshot(storage, started.id)).phase).toBe("discovering");
    });
  });

  test("retries a definitely rejected dispatch with one fresh request", async () => {
    await harness(async (service, storage, provider) => {
      provider.definiteRejectOnce = true;
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      await service.advanceNow(started.id);
      const failed = await snapshot(storage, started.id);
      expect(failed.phase).toBe("failed");
      expect(failed.dispatch).toBeUndefined();
      expect(provider.sent).toHaveLength(1);

      await service.retry(started.id);
      await service.advanceNow(started.id);
      expect(provider.sent).toHaveLength(2);
      expect(provider.sent[1]?.requestId).not.toBe(provider.sent[0]?.requestId);
      expect((await snapshot(storage, started.id)).sessions).toHaveLength(1);
    });
  });

  for (const status of ["blocked", "error"] as const) {
    test(`retries a terminal ${status} provider result with a fresh request`, async () => {
      await harness(async (service, storage, provider) => {
        provider.returnNull = true;
        const started = await service.start({
          environmentId: "env-1", projectId: "project-1", agent: "claude",
          model: "model", targetBranch: "main", allowance: 1,
        });
        await service.advanceNow(started.id);
        provider.statusValue = status;
        await service.advanceNow(started.id);
        const failed = await snapshot(storage, started.id);
        const firstRequestId = provider.sent[0]?.requestId;
        expect(failed.phase).toBe("failed");
        expect(failed.dispatch).toBeUndefined();

        provider.returnNull = false;
        provider.statusValue = "running";
        await service.retry(started.id);
        await pump(service, started.id, 2);
        expect(provider.sent.some((entry) => entry.requestId !== firstRequestId)).toBe(true);
      });
    });
  }

  test("retries malformed structured output with a fresh request", async () => {
    await harness(async (service, storage, provider) => {
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      await service.advanceNow(started.id);
      const firstRequestId = provider.sent[0]!.requestId;
      provider.structuredValueOverride = { malformed: true };
      await service.advanceNow(started.id);
      expect((await snapshot(storage, started.id)).dispatch).toBeUndefined();

      await service.retry(started.id);
      await pump(service, started.id, 2);
      expect(provider.sent.some((entry) => entry.requestId !== firstRequestId)).toBe(true);
    });
  });

  test("replaces a provider session that authoritatively disappeared", async () => {
    await harness(async (service, storage, provider) => {
      provider.returnNull = true;
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      await service.advanceNow(started.id);
      const original = (await snapshot(storage, started.id)).sessions[0]!;
      provider.statusValue = "missing";
      await service.advanceNow(started.id);
      expect((await snapshot(storage, started.id)).phase).toBe("failed");

      provider.returnNull = false;
      provider.statusValue = "running";
      await service.retry(started.id);
      await service.advanceNow(started.id);
      const retried = await snapshot(storage, started.id);
      expect(retried.sessions).toHaveLength(2);
      expect(retried.sessions[1]?.providerSessionId).not.toBe(original.providerSessionId);
      expect(retried.sessions[1]?.sessionKey).toContain(":replacement-1");
    });
  });

  test("replaces a missing provider session when the structured read fails first", async () => {
    await harness(async (service, storage, provider) => {
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      await service.advanceNow(started.id);
      const original = (await snapshot(storage, started.id)).sessions[0]!;
      provider.structuredRejectCount = 1;
      provider.statusValue = "missing";
      await service.advanceNow(started.id);
      const failed = await snapshot(storage, started.id);
      expect(failed.phase).toBe("failed");
      expect(failed.dispatch).toBeUndefined();
      expect(failed.sessions[0]?.error).toContain("retry creates a replacement");

      provider.statusValue = "running";
      await service.retry(started.id);
      await service.advanceNow(started.id);
      const retried = await snapshot(storage, started.id);
      expect(retried.sessions).toHaveLength(2);
      expect(retried.sessions[1]?.providerSessionId).not.toBe(original.providerSessionId);
      expect(retried.sessions[1]?.sessionKey).toContain(":replacement-1");
    });
  });

  test("replaces a missing discovery session before retrying reconciliation", async () => {
    await harness(async (service, storage, provider) => {
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      for (let index = 0; index < 12; index += 1) {
        await service.advanceNow(started.id);
        const current = await snapshot(storage, started.id);
        if (current.phase === "reconciling" && current.dispatch?.state === "sent") break;
      }
      const before = await snapshot(storage, started.id);
      const originalSession = before.sessions.find((entry) => entry.id === before.activeSessionId)!;
      expect(before.phase).toBe("reconciling");
      provider.returnNull = true;
      provider.statusValue = "missing";
      await service.advanceNow(started.id);
      expect((await snapshot(storage, started.id)).phase).toBe("failed");

      provider.returnNull = false;
      provider.statusValue = "running";
      await service.retry(started.id);
      await service.advanceNow(started.id);
      const retried = await snapshot(storage, started.id);
      const replacement = retried.sessions.find((entry) =>
        entry.sessionKey.includes(":replacement-"));
      expect(replacement?.providerSessionId).not.toBe(originalSession.providerSessionId);
      expect(retried.rounds[0]?.passes[0]?.sessionId).toBe(replacement?.id);
      expect(retried.dispatch?.kind).toBe("reconcile");
    });
  });

  test("persists and bounds an idle structured-result wait", async () => {
    await harness(async (service, storage, provider) => {
      provider.returnNull = true;
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main",
      });
      await pump(service, started.id, 8);
      const failed = await snapshot(storage, started.id);
      expect(failed.phase).toBe("failed");
      expect(failed.failure?.message).toContain("without a structured result");
      const firstRequestId = provider.sent[0]!.requestId;
      provider.returnNull = false;
      await service.retry(started.id);
      await pump(service, started.id, 2);
      expect(provider.sent.some((entry) => entry.requestId !== firstRequestId)).toBe(true);
    });
  });

  test("auto-declines input, continues, records bounded history, and increments counts", async () => {
    await harness(async (service, storage, provider) => {
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main",
      });
      await service.advanceNow(started.id);
      const running = await snapshot(storage, started.id);
      const session = running.sessions[0]!;
      provider.pending.set(session.providerSessionId, [
        { ...inputRequest(), sessionId: session.providerSessionId },
      ]);
      await service.advanceNow(started.id);
      const resolved = await snapshot(storage, started.id);
      expect(resolved.phase).not.toBe("failed");
      expect(resolved.autoDeclineCount).toBe(1);
      expect(resolved.sessions[0]?.interactionTranscript?.[0]).toMatchObject({
        id: "question-1",
        outcome: "auto-declined-headless",
      });
      expect(JSON.stringify(resolved)).not.toContain("never-persist-this");
    });
  });

  test("does not double-count an interaction recovered after workflow save", async () => {
    await harness(async (initial, storage, provider, invoke) => {
      let service = initial;
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main",
      });
      await service.advanceNow(started.id);
      const running = await snapshot(storage, started.id);
      const session = running.sessions[0]!;
      const request = { ...inputRequest(), sessionId: session.providerSessionId };
      provider.pending.set(session.providerSessionId, [request]);
      await service.advanceNow(started.id);
      const resolved = await snapshot(storage, started.id);
      const journal = await storage.getAgentInteractionResolutionJournal();
      const journalEntry = journal.entries.find((entry) => entry.interactionId === request.id)!;
      expect(resolved.interactionSummary?.entries[0]?.count).toBe(1);
      await service.shutdown();

      const record = (await storage.getLoopedReviewWorkflow(started.id))!;
      const replay = structuredClone(record.snapshot as LoopedReviewWorkflow);
      replay.pendingInteractionResolution = {
        journalId: journalEntry.id,
        sessionKey: session.sessionKey,
        sessionId: session.providerSessionId,
        interactionId: request.id,
        provider: "claude",
        kind: "question",
        phase: "preparation",
        requestedAt: request.createdAt,
        claimedAt: journalEntry.claim.claimedAt,
        action: "decline-and-continue",
        title: request.presentation.title,
        questions: [],
      };
      await storage.saveLoopedReviewWorkflow(
        started.id, "env-1", 2, replay, record.revision,
      );
      await storage.updateAgentInteractionResolutionJournal((current) => ({
        ...current,
        entries: current.entries.map((entry) => entry.id === journalEntry.id
          ? { ...entry, state: "provider-resolved" as const, outcome: "auto-declined" as const,
              providerResolvedAt: Date.now(), workflowRecordedAt: undefined }
          : entry),
      }));

      service = new LoopedReviewService(storage, invoke, {
        autoAdvance: false,
        provider: async () => provider,
      });
      await service.init();
      await service.advanceNow(started.id);
      const recovered = await snapshot(storage, started.id);
      expect(recovered.autoDeclineCount).toBe(1);
      expect(recovered.interactionSummary?.entries[0]?.count).toBe(1);
      expect(recovered.sessions[0]?.interactionSummary?.entries[0]?.count).toBe(1);
      expect(recovered.sessions[0]?.interactionTranscript).toHaveLength(1);
      await service.shutdown();
    });
  });

  test("denies authorization and fails visibly with content-free context", async () => {
    await harness(async (service, storage, provider) => {
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main",
      });
      await service.advanceNow(started.id);
      const running = await snapshot(storage, started.id);
      const session = running.sessions[0]!;
      provider.pending.set(session.providerSessionId, [{
        ...inputRequest("approval-1"),
        sessionId: session.providerSessionId,
        kind: "command-approval",
        presentation: { title: "Run secret command", questions: [] },
      }]);
      await service.advanceNow(started.id);
      const failed = await snapshot(storage, started.id);
      expect(failed.phase).toBe("failed");
      expect(failed.failure).toMatchObject({
        code: "interactive-request",
        interaction: { requestId: "approval-1", kind: "command-approval" },
      });
      expect(JSON.stringify(failed.failure)).not.toContain("Run secret command");
    });
  });

  test("recovers across repeated backend restarts at persisted phase boundaries", async () => {
    await harness(async (initial, storage, provider, invoke) => {
      let service = initial;
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      for (let boundary = 0; boundary < 24; boundary += 1) {
        await service.advanceNow(started.id);
        if ((await snapshot(storage, started.id)).phase === "completed") break;
        await service.shutdown();
        service = new LoopedReviewService(storage, invoke, {
          autoAdvance: false,
          provider: async () => provider,
          missingResultPollLimit: 3,
        });
        await service.init();
      }
      const finished = await snapshot(storage, started.id);
      expect(finished.phase).toBe("completed");
      expect(new Set(provider.sent.map((entry) => entry.requestId)).size).toBe(provider.sent.length);
      expect(provider.sent).toHaveLength(4);
      await service.shutdown();
    });
  });

  test("two backend controllers produce one transition and one provider dispatch", async () => {
    await harness(async (first, storage, provider, invoke) => {
      const second = new LoopedReviewService(storage, invoke, {
        autoAdvance: false,
        provider: async () => provider,
      });
      await second.init();
      const started = await first.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      await Promise.all([first.advanceNow(started.id), second.advanceNow(started.id)]);
      expect(provider.sent).toHaveLength(1);
      expect((await snapshot(storage, started.id)).backendRevision).toBeGreaterThan(1);
      await second.shutdown();
    });
  });

  test("expired lease takeover reconciles an ambiguous dispatch without sending twice", async () => {
    await harness(async (first, storage, provider, invoke) => {
      provider.ambiguousOnce = true;
      const started = await first.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      await first.advanceNow(started.id);
      expect(provider.sent).toHaveLength(1);
      expect((await snapshot(storage, started.id)).dispatch?.state).toBe("dispatching");

      await new Promise((resolve) => setTimeout(resolve, 2_050));
      const takeover = new LoopedReviewService(storage, invoke, {
        autoAdvance: false,
        controllerLeaseMs: 2_000,
        provider: async () => provider,
      });
      await takeover.init();
      await Promise.all([takeover.advanceNow(started.id), first.advanceNow(started.id)]);
      expect(provider.sent).toHaveLength(1);
      expect((await snapshot(storage, started.id)).phase).toBe("discovering");
      await takeover.shutdown();
    }, "claude", { controllerLeaseMs: 2_000 });
  });

  test("input declines and continues in preparation, discovery, fix, and PR sessions", async () => {
    await harness(async (service, storage, provider) => {
      provider.reviewReport = issueReport;
      provider.reconciliationValue = {
        newIssues: [reviewIssue], issueUpdates: [], newCoverageGaps: [], coverageGapUpdates: [],
        issueOutcomes: [{ reportIndex: 0, outcome: "new", poolId: null }],
        coverageGapOutcomes: [],
      };
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });

      const resolveInPhase = async (phase: "preparation" | "discovery" | "fix" | "pr") => {
        let active: LoopedReviewWorkflow["sessions"][number] | undefined;
        for (let index = 0; index < 20 && !active; index += 1) {
          await service.advanceNow(started.id);
          const current = await snapshot(storage, started.id);
          active = current.sessions.find((session) => session.phase === phase && session.status === "running");
        }
        expect(active).toBeDefined();
        provider.pending.set(active!.providerSessionId, [{
          ...inputRequest(`question-${phase}`), sessionId: active!.providerSessionId,
        }]);
        await service.advanceNow(started.id);
      };

      await resolveInPhase("preparation");
      await resolveInPhase("discovery");
      await resolveInPhase("fix");
      await resolveInPhase("pr");
      await pump(service, started.id, 4);

      const finished = await snapshot(storage, started.id);
      expect(finished.phase).toBe("completed");
      expect(finished.autoDeclineCount).toBe(4);
      expect(provider.resolveCount).toBe(4);
      expect(finished.sessions.flatMap((session) => session.interactionTranscript ?? [])
        .map((entry) => entry.phase)).toEqual(["preparation", "discovery", "fix", "pr"]);
    });
  });

  for (const agent of ["claude", "codex", "opencode"] as const) {
    test(`${agent} applies the same unattended input policy`, async () => {
      await harness(async (service, storage, provider) => {
        const started = await service.start({
          environmentId: "env-1", projectId: "project-1", agent,
          model: "model", targetBranch: "main", allowance: 1,
        });
        await service.advanceNow(started.id);
        const running = await snapshot(storage, started.id);
        const session = running.sessions[0]!;
        provider.pending.set(session.providerSessionId, [{
          ...inputRequest(`${agent}-question`, agent), sessionId: session.providerSessionId,
        }]);
        provider.statusValue = agent === "opencode" ? "blocked" : "running";
        await service.advanceNow(started.id);
        if (agent === "opencode") await service.advanceNow(started.id);
        const resolved = await snapshot(storage, started.id);
        expect(resolved.autoDeclineCount).toBe(1);
        expect(resolved.phase).not.toBe("failed");
        expect(provider.pending.get(session.providerSessionId)).toEqual([]);
      }, agent);
    });
  }

  test("pause, resume, cancellation, and retry stay at backend boundaries", async () => {
    await harness(async (service, storage, provider) => {
      provider.returnNull = true;
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      await service.advanceNow(started.id);
      const sentBeforePause = provider.sent.length;
      expect((await service.pause(started.id)).phase).toBe("paused");
      await service.advanceNow(started.id);
      expect(provider.sent).toHaveLength(sentBeforePause);
      expect((await service.resume(started.id)).phase).not.toBe("paused");
      await pump(service, started.id, 5);
      expect((await snapshot(storage, started.id)).phase).toBe("failed");

      provider.returnNull = false;
      expect((await service.retry(started.id)).phase).toBe("preparing");
      await service.advanceNow(started.id);
      expect((await service.cancel(started.id)).phase).toBe("cancelled");
      expect(provider.abortCount).toBeGreaterThan(0);
    });
  });

  test("persists cancellation intent and retries abort after restart", async () => {
    await harness(async (initial, storage, provider, invoke) => {
      let service = initial;
      provider.returnNull = true;
      provider.statusValue = "running";
      provider.abortRejectCount = 1;
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      await service.advanceNow(started.id);
      const cancelling = await service.cancel(started.id);
      expect(cancelling.phase).toBe("cancelling");
      expect(cancelling.dispatch).toBeDefined();
      expect(cancelling.sessions[0]?.status).toBe("running");

      await service.shutdown();
      service = new LoopedReviewService(storage, invoke, {
        autoAdvance: false,
        provider: async () => provider,
      });
      await service.init();
      await service.advanceNow(started.id);
      const cancelled = await snapshot(storage, started.id);
      expect(cancelled.phase).toBe("cancelled");
      expect(cancelled.dispatch).toBeUndefined();
      expect(cancelled.sessions[0]?.status).toBe("cancelled");
      expect(provider.abortCount).toBe(2);
      await service.shutdown();
    });
  });

  test("finalizes cancellation immediately when no provider session is active", async () => {
    await harness(async (service, storage) => {
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      await service.advanceNow(started.id);
      const current = await snapshot(storage, started.id);
      expect(current.sessions).toHaveLength(1);
      await storage.saveLoopedReviewWorkflow(started.id, "env-1", 2, {
        ...current,
        phase: "cancelling",
        cancellingFromPhase: "preparing",
        cancellingSince: new Date().toISOString(),
        activeSessionId: undefined,
      }, current.backendRevision);

      await service.advanceNow(started.id);
      const cancelled = await snapshot(storage, started.id);
      expect(cancelled.phase).toBe("cancelled");
      expect(cancelled.sessions[0]?.status).toBe("cancelled");
      expect(cancelled.cancellingSince).toBeUndefined();
    });
  });

  test("keeps cancellation waiting when the provider cannot be reached", async () => {
    await harness(async (service, storage, provider) => {
      const now = new Date().toISOString();
      await storage.saveLoopedReviewWorkflow(
        "workflow-1", "env-1", LOOPED_REVIEW_WORKFLOW_VERSION, workflowFixture({
          phase: "cancelling",
          cancellingFromPhase: "preparing",
          cancellingSince: now,
          activeSessionId: "session-1",
          sessions: [{
            id: "session-1", phase: "preparation", round: 1,
            sessionKey: "session-key", providerSessionId: "provider-1",
            requestIds: [], origin: "looped-review",
            interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
            status: "running", startedAt: now,
          }],
        }), 0,
      );

      await service.advanceNow("workflow-1");
      const cancelling = await snapshot(storage, "workflow-1");
      expect(cancelling.phase).toBe("cancelling");
      expect(cancelling.sessions[0]?.error).toContain("Cancellation is waiting for the provider");
      expect(provider.abortCount).toBe(0);
    }, "claude", { useProductionProvider: true, bridgeAuthToken: "" });
  });

  test("force-finalizes a cancellation that exceeds the abort deadline", async () => {
    await harness(async (service, storage, provider) => {
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      await service.advanceNow(started.id);
      const current = await snapshot(storage, started.id);
      provider.abortRejectCount = 10;
      await storage.saveLoopedReviewWorkflow(started.id, "env-1", 2, {
        ...current,
        phase: "cancelling",
        cancellingFromPhase: "discovering",
        cancellingSince: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }, current.backendRevision);

      await service.advanceNow(started.id);
      const cancelled = await snapshot(storage, started.id);
      expect(cancelled.phase).toBe("cancelled");
      expect(cancelled.sessions[0]?.error).toContain("Cancellation timed out");
      expect(provider.abortCount).toBe(0);
    }, "claude", { cancellationDeadlineMs: 0 });
  });

  test("preserves the dispatch when the structured read and status probe both fail", async () => {
    await harness(async (service, storage, provider) => {
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      await service.advanceNow(started.id);
      const firstRequestId = provider.sent[0]!.requestId;
      provider.structuredRejectCount = 1;
      provider.statusRejectCount = 1;
      await service.advanceNow(started.id);
      const failed = await snapshot(storage, started.id);
      expect(failed.phase).toBe("failed");
      expect(failed.dispatch).toBeDefined();
      expect(failed.failure?.preserveDispatch).toBe(true);

      await service.retry(started.id);
      await pump(service, started.id, 2);
      expect((await snapshot(storage, started.id)).phase).toBe("discovering");
      expect(provider.structuredCount).toBeGreaterThan(1);
      expect(provider.sent.some((entry) => entry.requestId === firstRequestId)).toBe(true);
    });
  });

  test("coalesces repeated supervisor wakeups while provider I/O is in flight", async () => {
    await harness(async (service, storage, provider) => {
      let release!: () => void;
      provider.sendBarrier = new Promise<void>((resolve) => { release = resolve; });
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      // The start wakeup prepares the first dispatch. This wakeup blocks in send.
      const inFlight = service.advanceNow(started.id);
      while (provider.sent.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      const repeated = Array.from({ length: 50 }, () => service.advanceNow(started.id));
      release();
      await Promise.all([inFlight, ...repeated]);

      expect(provider.sent).toHaveLength(1);
      expect(provider.structuredCount).toBe(1);
      expect((await snapshot(storage, started.id)).phase).toBe("discovering");
    });
  });

  test("adopts legacy workflows only at safe phase boundaries", async () => {
    await harness(async (service, storage, provider, invoke) => {
      const safeStarted = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      const unsafeStarted = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      await Promise.all([
        service.advanceNow(safeStarted.id),
        service.advanceNow(unsafeStarted.id),
      ]);
      await service.shutdown();

      const safeRecord = (await storage.getLoopedReviewWorkflow(safeStarted.id))!;
      const unsafeRecord = (await storage.getLoopedReviewWorkflow(unsafeStarted.id))!;
      const safeLegacy = {
        ...(safeRecord.snapshot as LoopedReviewWorkflow),
        version: 1,
        controller: undefined,
        phase: "preparing",
        dispatch: undefined,
      };
      const unsafeLegacy = {
        ...(unsafeRecord.snapshot as LoopedReviewWorkflow),
        version: 1,
        controller: undefined,
      };
      await storage.saveLoopedReviewWorkflow(
        safeStarted.id, "env-1", 1, safeLegacy, safeRecord.revision,
      );
      await storage.saveLoopedReviewWorkflow(
        unsafeStarted.id, "env-1", 1, unsafeLegacy, unsafeRecord.revision,
      );

      const recovering = new LoopedReviewService(storage, invoke, {
        autoAdvance: false,
        provider: async () => provider,
      });
      await recovering.init();
      expect((await storage.getLoopedReviewWorkflow(safeStarted.id))?.version).toBe(2);
      expect((await storage.getLoopedReviewWorkflow(unsafeStarted.id))?.version).toBe(1);
      await recovering.shutdown();
    });
  });

  test("retries safe legacy adoption after a foreign controller lease expires", async () => {
    await harness(async (service, storage, provider, invoke) => {
      const started = await service.start({
        environmentId: "env-1", projectId: "project-1", agent: "claude",
        model: "model", targetBranch: "main", allowance: 1,
      });
      await service.shutdown();
      const record = (await storage.getLoopedReviewWorkflow(started.id))!;
      const legacy = {
        ...(record.snapshot as LoopedReviewWorkflow),
        version: 1,
        controller: undefined,
        phase: "preparing",
        dispatch: undefined,
      };
      await storage.saveLoopedReviewWorkflow(started.id, "env-1", 1, legacy, record.revision);
      await storage.claimLoopedReviewController(started.id, "renderer", 2_000);

      const recovering = new LoopedReviewService(storage, invoke, {
        autoAdvance: true,
        pollIntervalMs: 25,
        controllerLeaseMs: 2_000,
        controllerRenewMs: 2_000,
        provider: async () => provider,
      });
      await recovering.init();
      expect((await storage.getLoopedReviewWorkflow(started.id))?.version).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      expect((await storage.getLoopedReviewWorkflow(started.id))?.version).toBe(2);
      await recovering.shutdown();
    });
  });
});
