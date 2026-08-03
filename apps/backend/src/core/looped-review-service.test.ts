import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionRequest,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";
import type { LoopedReviewWorkflow } from "@orkestrator/protocol/review-workflow";
import type { LoopedReviewAgent } from "@orkestrator/protocol/review-workflow";
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
  returnNull = false;
  ambiguousOnce = false;
  definiteRejectOnce = false;
  abortCount = 0;
  resolveCount = 0;
  reviewReport: StructuredReviewReport = cleanReport;
  reconciliationValue: unknown = {
    newIssues: [], issueUpdates: [], newCoverageGaps: [], coverageGapUpdates: [],
    issueOutcomes: [], coverageGapOutcomes: [],
  };
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

  async status(): Promise<ProviderStatus> { return this.statusValue; }
  async messages(): Promise<unknown[]> { return []; }

  async structured<T>(_sessionId: string, requestId: string): Promise<StructuredOutputResult<T> | null> {
    if (this.returnNull) return null;
    const send = this.sent.find((entry) => entry.requestId === requestId);
    const required = (send?.schema as { required?: string[] } | undefined)?.required ?? [];
    let value: unknown;
    if (required.includes("validation")) {
      value = { validation: [], uncommittedFiles: [], limitations: [] };
    } else if (required.includes("reviewScope")) {
      value = this.reviewReport;
    } else if (required.includes("issueOutcomes")) {
      value = this.reconciliationValue;
    } else if (required.includes("url")) {
      value = { status: "created", url: "https://github.com/acme/repo/pull/7", summary: "Created." };
    } else {
      value = { complete: true, summary: "Fixed.", filesChanged: [], commandsRun: [], notes: [], limitations: [] };
    }
    return { ok: true, provider: this.agent, requestId, value: value as T };
  }

  async abort(): Promise<void> { this.abortCount += 1; }
}

async function harness(run: (
  service: LoopedReviewService,
  storage: StorageService,
  provider: FakeProvider,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
) => Promise<void>, agent: LoopedReviewAgent = "claude", serviceOptions: {
  controllerLeaseMs?: number;
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
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
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
  const service = new LoopedReviewService(storage, invoke, {
    autoAdvance: false,
    provider: async () => provider,
    missingResultPollLimit: 3,
    ...serviceOptions,
  });
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

describe("LoopedReviewService", () => {
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
});
