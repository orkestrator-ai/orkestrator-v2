import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import type {
  StructuredOutputFailureCode,
  StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import {
  MULTI_REVIEW_MAX_SNAPSHOT_PATHS,
  MULTI_REVIEW_WORKFLOW_VERSION,
  type MultiReviewModelSelection,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type {
  BuildPipelineProvider,
  ProviderCreateSessionOptions,
  ProviderSendOptions,
  ProviderStatus,
} from "./build-pipeline-provider.js";
import {
  AmbiguousPromptDispatchError,
  ProviderSessionFailedError,
} from "./build-pipeline-provider.js";
import { REVIEW_FIX_RESULT_JSON_SCHEMA } from "./looped-review-prompts.js";
import { MissingMultiReviewAddressSessionError } from "./multi-review-address-dispatch.js";
import { StorageService } from "./storage.js";
import { MultiReviewService, type MultiReviewServiceOptions } from "./multi-review-service.js";

const REVIEW_HEAD = "1111111111111111111111111111111111111111";
const REVIEW_FINGERPRINT = "a".repeat(64);

async function stableReviewInvoker<T>(command: string): Promise<T> {
  if (command !== "get_environment_uncommitted_paths") throw new Error("unexpected command");
  return {
    head: REVIEW_HEAD,
    paths: [],
    fingerprint: REVIEW_FINGERPRINT,
  } as T;
}

const cleanReport: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "origin/main...HEAD",
    commit: null,
    filesReviewed: ["src/a.ts"],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "Change",
    before: "Before",
    after: "After",
    keyCodeChanges: [],
    userImpact: "Impact",
  },
  riskProfile: {
    changeTypes: ["feature"],
    riskAreas: [],
    overallRisk: "medium",
    reasoning: "Changed",
  },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Ready" },
  summaryOfChange: "Change",
  reviewSummary: "Clean",
};

const consolidatedReport: StructuredReviewReport = {
  ...cleanReport,
  issues: [
    {
      reviewSourceIds: ["reviewer-1/issue-1"],
      severity: "P1",
      confidence: 92,
      category: "correctness",
      title: "Broken branch",
      file: "src/a.ts",
      line: 10,
      symbol: "run",
      description: "Wrong branch",
      evidence: "Returns false",
      suggestion: "Correct it",
      verification: "Add a regression test",
    },
  ],
  testCoverageGaps: [
    {
      reviewSourceIds: ["reviewer-1/coverage-gap-1"],
      file: "src/a.test.ts",
      untestedBehavior: "Failure branch",
    },
  ],
  verdict: { ready: "with-fixes", reasoning: "One fix remains" },
  reviewSummary: "One consolidated issue and one coverage gap.",
};

class Provider implements BuildPipelineProvider {
  readonly agent = "claude" as const;
  readonly sends = new Map<string, { prompt: string; options: ProviderSendOptions }>();
  readonly aborted: string[] = [];
  readonly closed: string[] = [];
  /** Per-session status, overriding `statusValue`; keeps tests pass-count independent. */
  readonly statusOverrides = new Map<string, ProviderStatus>();
  /**
   * Per-session terminal turn detail. Reported the way the HTTP bridge reports
   * one — as a `ProviderSessionFailedError` throw rather than an `"error"`
   * status — and, unlike `statusError`, on every call, because a failed turn
   * stays failed until the next turn runs.
   */
  readonly sessionFailures = new Map<string, string>();
  readonly attached: string[] = [];
  readonly consolidationSessions = new Set<string>();
  readonly consolidationSessionsWithFindings = new Set<string>();
  sessions = 0;
  statusValue: ProviderStatus = "idle";
  statusCalls = 0;
  abortError: Error | null = null;
  closeError: Error | null = null;
  /** Thrown by the next `status` call, then cleared. */
  statusError: Error | null = null;
  ambiguousFixOnce = false;
  fixSends = 0;
  fixComplete = true;
  invalidReviewerReports = 0;
  invalidConsolidatedReports = 0;
  missingConsolidatedProvenanceReports = 0;
  invalidConsolidatedProvenanceReports = 0;
  missingCoverageGapProvenanceReports = 0;
  providerAuthoredConsolidatedModels = 0;
  schemaFailureReports = 0;
  invalidFixResults = 0;
  fixStructuredFailure: StructuredOutputFailureCode | null = null;
  messagesValue: unknown[] = [];
  reviewerReport: StructuredReviewReport = cleanReport;
  consolidationReport: StructuredReviewReport = consolidatedReport;
  messagesCalls = 0;
  readonly messageOptions: Array<{ limit?: number } | undefined> = [];
  readonly createdSessionKeys: string[] = [];
  disposeCalls = 0;
  idempotentSessionKeys = false;
  /** Throws from `createSession` once this many sessions already exist. */
  failCreateSessionAfter: number | null = null;
  private statusGate: Promise<void> | null = null;
  private releaseStatusGate: (() => void) | null = null;
  private messagesGate: Promise<void> | null = null;
  private releaseMessagesGate: (() => void) | null = null;
  private readonly sessionIdsByClientKey = new Map<string, string>();
  constructor(private readonly returnStructured = true) {}
  async createSession(
    _phase: "build" | "review" | "verify" | "fix" | "pr" | "resolve-conflicts",
    _label: string,
    options?: ProviderCreateSessionOptions,
  ) {
    const clientSessionKey = options?.clientSessionKey;
    if (clientSessionKey) {
      this.createdSessionKeys.push(clientSessionKey);
      if (this.idempotentSessionKeys) {
        const existing = this.sessionIdsByClientKey.get(clientSessionKey);
        if (existing) return existing;
      }
    }
    if (this.failCreateSessionAfter !== null && this.sessions >= this.failCreateSessionAfter) {
      throw new Error("claude bridge authentication is unavailable");
    }
    this.sessions += 1;
    const sessionId = `session-${this.sessions}`;
    if (clientSessionKey) this.sessionIdsByClientKey.set(clientSessionKey, sessionId);
    return sessionId;
  }
  async prepareDispatch(sessionId: string) {
    this.attached.push(sessionId);
  }
  async send(sessionId: string, prompt: string, options: ProviderSendOptions) {
    this.sends.set(options.requestId, { prompt, options });
    if (prompt.includes("<multi-review-reports-json>")) {
      this.consolidationSessions.add(sessionId);
      if (prompt.includes('"reviewSourceIds":["reviewer-')) {
        this.consolidationSessionsWithFindings.add(sessionId);
      }
    }
    if (prompt.includes("<structured-review-findings-json>")) {
      this.fixSends += 1;
      if (this.ambiguousFixOnce) {
        this.ambiguousFixOnce = false;
        throw new AmbiguousPromptDispatchError("response lost after acceptance");
      }
    }
  }
  async status(sessionId: string): Promise<ProviderStatus> {
    this.statusCalls += 1;
    if (this.statusGate) await this.statusGate;
    if (this.statusError) {
      const error = this.statusError;
      this.statusError = null;
      throw error;
    }
    const failure = this.sessionFailures.get(sessionId);
    if (failure) throw new ProviderSessionFailedError(this.agent, failure);
    return this.statusOverrides.get(sessionId) ?? this.statusValue;
  }
  async messages(_sessionId: string, options?: { limit?: number }): Promise<unknown[]> {
    this.messagesCalls += 1;
    this.messageOptions.push(options);
    if (this.messagesGate) await this.messagesGate;
    return this.messagesValue;
  }
  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null> {
    if (!this.returnStructured) return null;
    const sent = this.sends.get(requestId)!;
    const isConsolidation = this.consolidationSessions.has(sessionId);
    if (sent.options.schema === REVIEW_FIX_RESULT_JSON_SCHEMA) {
      if (this.fixStructuredFailure) {
        const code = this.fixStructuredFailure;
        this.fixStructuredFailure = null;
        return {
          ok: false,
          provider: "claude",
          requestId,
          error: {
            code,
            message: `Fix result failed with ${code}`,
            provider: "claude",
            retryable: code !== "interrupted",
          },
        };
      }
      if (this.invalidFixResults > 0) {
        this.invalidFixResults -= 1;
        return {
          ok: true,
          provider: "claude",
          requestId,
          value: {
            complete: true,
            summary: "Addressed every finding",
            filesChanged: ["src/a.ts"],
            commandsRun: [],
            notes: [],
            limitations: ["A blocker remains"],
          } as T,
        };
      }
      return {
        ok: true,
        provider: "claude",
        requestId,
        value: {
          complete: this.fixComplete,
          summary: this.fixComplete ? "Addressed every finding" : "Two findings remain unresolved",
          filesChanged: ["src/a.ts", "src/a.test.ts"],
          commandsRun: [],
          notes: [],
          limitations: this.fixComplete ? [] : ["Two findings need product input"],
        } as T,
      };
    }
    if (sent.options.schema === STRUCTURED_REVIEW_REPORT_JSON_SCHEMA) {
      if (this.schemaFailureReports > 0) {
        this.schemaFailureReports -= 1;
        return {
          ok: false,
          provider: "claude",
          requestId,
          error: {
            code: "schema_retry_exhausted",
            message: "Output did not satisfy the provider schema.",
            provider: "claude",
            retryable: true,
            details: { path: "$.verdict.ready", reason: "Expected an enum value." },
          },
        };
      }
      if (isConsolidation && this.invalidConsolidatedReports > 0) {
        this.invalidConsolidatedReports -= 1;
        return {
          ok: true,
          provider: "claude",
          requestId,
          value: { ...consolidatedReport, ready: true } as T,
        };
      }
      if (isConsolidation && this.missingConsolidatedProvenanceReports > 0) {
        this.missingConsolidatedProvenanceReports -= 1;
        return {
          ok: true,
          provider: "claude",
          requestId,
          value: {
            ...consolidatedReport,
            issues: consolidatedReport.issues.map(
              ({ reviewSourceIds: _sourceIds, ...issue }) => issue,
            ),
            testCoverageGaps: consolidatedReport.testCoverageGaps.map(
              ({ reviewSourceIds: _sourceIds, ...gap }) => gap,
            ),
          } as T,
        };
      }
      if (isConsolidation && this.invalidConsolidatedProvenanceReports > 0) {
        this.invalidConsolidatedProvenanceReports -= 1;
        return {
          ok: true,
          provider: "claude",
          requestId,
          value: {
            ...this.consolidationReport,
            issues: this.consolidationReport.issues.map((issue) => ({
              ...issue,
              reviewSourceIds: ["reviewer-1/coverage-gap-1"],
            })),
          } as T,
        };
      }
      if (isConsolidation && this.providerAuthoredConsolidatedModels > 0) {
        this.providerAuthoredConsolidatedModels -= 1;
        return {
          ok: true,
          provider: "claude",
          requestId,
          value: {
            ...this.consolidationReport,
            issues: this.consolidationReport.issues.map((issue) => ({
              ...issue,
              reviewModels: ["codex/default"],
            })),
          } as T,
        };
      }
      if (isConsolidation && this.missingCoverageGapProvenanceReports > 0) {
        this.missingCoverageGapProvenanceReports -= 1;
        return {
          ok: true,
          provider: "claude",
          requestId,
          value: {
            ...this.consolidationReport,
            testCoverageGaps: this.consolidationReport.testCoverageGaps.map(
              ({ reviewSourceIds: _sourceIds, ...gap }) => gap,
            ),
          } as T,
        };
      }
      if (sessionId === "session-1" && this.invalidReviewerReports > 0) {
        this.invalidReviewerReports -= 1;
        return {
          ok: true,
          provider: "claude",
          requestId,
          value: { ...cleanReport, ready: true } as T,
        };
      }
    }
    const value = isConsolidation
      ? this.consolidationSessionsWithFindings.has(sessionId)
        ? this.consolidationReport
        : cleanReport
      : sent.prompt.includes("<structured-review-findings-json>")
        ? {
            complete: this.fixComplete,
            summary: this.fixComplete
              ? "Addressed every finding"
              : "Two findings remain unresolved",
            filesChanged: ["src/a.ts", "src/a.test.ts"],
            commandsRun: [],
            notes: [],
            // An incomplete result is only valid alongside a failed validation
            // or an explicit limitation.
            limitations: this.fixComplete ? [] : ["Two findings need product input"],
          }
        : this.reviewerReport;
    return { ok: true, provider: "claude", requestId, value: value as T };
  }
  async abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId);
    if (this.abortError) throw this.abortError;
  }
  async closeSession(sessionId: string): Promise<void> {
    this.closed.push(sessionId);
    if (this.closeError) throw this.closeError;
  }
  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }

  blockStatus(): () => void {
    this.statusGate = new Promise<void>((resolve) => {
      this.releaseStatusGate = resolve;
    });
    return () => {
      this.releaseStatusGate?.();
      this.releaseStatusGate = null;
      this.statusGate = null;
    };
  }

  blockMessages(): () => void {
    this.messagesGate = new Promise<void>((resolve) => {
      this.releaseMessagesGate = resolve;
    });
    return () => {
      this.releaseMessagesGate?.();
      this.releaseMessagesGate = null;
      this.messagesGate = null;
    };
  }
}

test("MultiReviewService exposes an authoritative reviewer transcript read model", async () => {
  const provider = new Provider(false);
  provider.statusValue = "running";
  provider.messagesValue = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "Inspecting the changed files",
      parts: [{ type: "tool-invocation", toolName: "Read", content: "Read" }],
    },
  ];

  await withService("env-transcript", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () =>
      Boolean((await snapshot(started.id))?.reviewers[0]?.providerSessionId),
    );
    const reviewer = (await snapshot(started.id))!.reviewers[0]!;

    await expect(service.reviewerTranscript(started.id, reviewer.id)).resolves.toMatchObject({
      workflowId: started.id,
      reviewerId: reviewer.id,
      agent: "claude",
      model: "opus",
      status: "running",
      messages: provider.messagesValue,
    });
  });
});

test("MultiReviewService hands the idle consolidation session to interactive addressing", async () => {
  const provider = new Provider();
  await withService(
    "env-transcript-provider-race",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const ready = (await snapshot(started.id))!;
      const reviewer = ready.reviewers[0]!;
      const disposalsAfterReady = provider.disposeCalls;
      const statusCallsAfterReady = provider.statusCalls;
      const sendsAfterReady = provider.sends.size;

      const releaseMessages = provider.blockMessages();
      const transcript = service.reviewerTranscript(started.id, reviewer.id);
      await waitUntil(() => provider.messagesCalls > 0);

      const addressed = await service.address(started.id);
      expect(addressed).toMatchObject({
        phase: "interactive",
        addressPromptPending: true,
        fixSession: { status: "idle", providerSessionId: ready.fixSession?.providerSessionId },
      });
      expect(addressed.activeRequest).toBeUndefined();
      // Recording the intent performs no provider I/O. A backend dispatcher
      // owns adoption and delivery after the durable save.
      expect(provider.statusCalls).toBe(statusCallsAfterReady);
      expect(provider.sends.size).toBe(sendsAfterReady);
      expect(provider.disposeCalls).toBe(disposalsAfterReady);

      releaseMessages();
      await transcript;
      // Address released its own lease, so the transcript reader is the last one
      // and finishing that read is what disposes the provider.
      expect(provider.disposeCalls).toBe(disposalsAfterReady + 1);
      expect(provider.aborted).toEqual([]);
    },
  );
});

test("MultiReviewService releases the controller lease when it hands off", async () => {
  const provider = new Provider();
  await withService(
    "env-address-lease",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      await service.address(started.id);
      // `interactive` is terminal, so nothing advances this workflow again. A
      // retained lease would be renewed — and rewrite the workflow store — for the
      // life of the process, and would fence every other controller out meanwhile.
      const claimed = await storage.claimMultiReviewController(started.id, "other-owner", 15_000);
      expect(claimed.granted).toBe(true);
    },
  );
});

test("MultiReviewService resumes an interrupted address dispatch through the supervisor", async () => {
  const provider = new Provider();
  let dispatches = 0;
  await withService(
    "env-address-resume",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      const statusCallsBeforeAddress = provider.statusCalls;
      const handedOff = await service.address(started.id);
      expect(handedOff.addressPromptPending).toBe(true);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptAttempts === 1);

      // Repeating the command is idempotent and never asks a renderer to resume
      // the durable dispatch half.
      const resumed = await service.address(started.id);
      expect(resumed.addressPromptPending).toBe(true);
      expect(provider.statusCalls).toBe(statusCallsBeforeAddress);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);
      expect(dispatches).toBe(2);
      await expect(service.address(started.id)).rejects.toThrow("not ready to address");

      // Both terminal operations release their short-lived controller claims.
      const claimed = await storage.claimMultiReviewController(started.id, "other-owner", 15_000);
      expect(claimed.granted).toBe(true);
    },
    {
      serviceOptions: {
        addressDispatchRetryMs: 60_000,
        dispatchAddressPrompt: async () => {
          dispatches += 1;
          if (dispatches === 1) throw new Error("interrupted");
        },
      },
    },
  );
});

test("MultiReviewService fails recoverably when the consolidation session is missing", async () => {
  const provider = new Provider();
  await withService(
    "env-address-missing",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      await service.address(started.id);
      await waitUntil(async () => {
        const [workflow, environment] = await Promise.all([
          snapshot(started.id),
          storage.getEnvironment("env-address-missing"),
        ]);
        return (
          workflow?.phase === "failed" &&
          environment?.agentActivitySources?.["multi-review"]?.state === "idle"
        );
      });
      const failed = (await snapshot(started.id))!;
      expect(failed).toMatchObject({
        phase: "failed",
        error: "The consolidation session is no longer available",
      });
      expect(failed.addressPromptPending).toBeUndefined();
      expect(failed.addressPromptAttempts).toBeUndefined();
      expect(failed.fixSession).toBeUndefined();
      expect(await storage.getEnvironment("env-address-missing")).toMatchObject({
        agentActivitySources: { "multi-review": { state: "idle" } },
      });

      const retried = await service.retry(started.id);
      expect(retried.phase).toBe("consolidating");
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      expect((await snapshot(started.id))?.fixSession?.providerSessionId).toBeDefined();
    },
    {
      serviceOptions: {
        dispatchAddressPrompt: async () => {
          throw new MissingMultiReviewAddressSessionError();
        },
      },
    },
  );
});

test("MultiReviewService dispatches a durable address intent without a renderer", async () => {
  const provider = new Provider();
  let releaseDispatch!: () => void;
  const dispatchGate = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  let dispatchStarted!: () => void;
  const startedDispatch = new Promise<void>((resolve) => {
    dispatchStarted = resolve;
  });
  const dispatched: MultiReviewWorkflow[] = [];
  await withService(
    "env-address-backend",
    provider,
    async ({ service, start, snapshot, storage }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      const addressed = await service.address(started.id);
      expect(addressed).toMatchObject({ phase: "interactive", addressPromptPending: true });
      await startedDispatch;
      // The backend callback is already running, while the command has returned
      // and the authoritative intent remains recoverable.
      expect((await snapshot(started.id))?.addressPromptPending).toBe(true);
      expect(await storage.getEnvironment("env-address-backend")).toMatchObject({
        agentActivitySources: { "multi-review": { state: "working" } },
      });

      releaseDispatch();
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);
      expect(dispatched).toHaveLength(1);
      expect(await storage.getEnvironment("env-address-backend")).toMatchObject({
        agentActivitySources: { "multi-review": { state: "idle" } },
      });
    },
    {
      serviceOptions: {
        dispatchAddressPrompt: async (workflow) => {
          dispatched.push(workflow);
          dispatchStarted();
          await dispatchGate;
        },
      },
    },
  );
});

test("MultiReviewService honors address backoff and resumes a transient failure on demand", async () => {
  const provider = new Provider();
  let dispatches = 0;
  await withService(
    "env-address-transient",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      await service.address(started.id);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptAttempts === 1);
      expect((await snapshot(started.id))?.error).toBe("bridge is restarting");
      await service.advanceNow(started.id);
      expect(dispatches).toBe(1);

      // Repeating the idempotent command is an explicit request to bypass the
      // timer while preserving the same workflow/request identity.
      await service.address(started.id);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);
      expect(dispatches).toBe(2);
      expect((await snapshot(started.id))?.error).toBeUndefined();
    },
    {
      serviceOptions: {
        addressDispatchRetryMs: 60_000,
        dispatchAddressPrompt: async () => {
          dispatches += 1;
          if (dispatches === 1) throw new Error("bridge is restarting");
        },
      },
    },
  );
});

test("MultiReviewService bounds permanent address failures and retires activity", async () => {
  const provider = new Provider();
  let dispatches = 0;
  await withService(
    "env-address-permanent",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      await service.address(started.id);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "failed";
      });
      expect(dispatches).toBe(3);
      expect(await snapshot(started.id)).toMatchObject({
        phase: "failed",
        error: "credentials are invalid",
      });
      expect((await snapshot(started.id))?.addressPromptPending).toBeUndefined();
      expect(await storage.getEnvironment("env-address-permanent")).toMatchObject({
        agentActivitySources: { "multi-review": { state: "idle" } },
      });
    },
    {
      serviceOptions: {
        addressDispatchRetryMs: 0,
        maxAddressDispatchAttempts: 3,
        dispatchAddressPrompt: async () => {
          dispatches += 1;
          throw new Error("credentials are invalid");
        },
      },
    },
  );
});

test("MultiReviewService resumes a persisted address attempt after restart", async () => {
  const provider = new Provider();
  let dispatches = 0;
  await withService(
    "env-address-restart",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      await service.address(started.id);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptAttempts === 1);
      await service.shutdown();

      const restarted = new MultiReviewService(storage, stableReviewInvoker, {
        autoAdvance: true,
        pollIntervalMs: 5,
        provider: async () => provider,
        dispatchAddressPrompt: async () => {
          dispatches += 1;
        },
      });
      try {
        await restarted.init();
        await waitUntil(async () => {
          const [workflow, environment] = await Promise.all([
            snapshot(started.id),
            storage.getEnvironment("env-address-restart"),
          ]);
          return (
            workflow?.addressPromptPending !== true &&
            environment?.agentActivitySources?.["multi-review"]?.state === "idle"
          );
        });
        expect((await snapshot(started.id))?.addressPromptPending).toBeUndefined();
        expect(dispatches).toBe(2);
        expect(await storage.getEnvironment("env-address-restart")).toMatchObject({
          agentActivitySources: { "multi-review": { state: "idle" } },
        });
      } finally {
        await restarted.shutdown();
      }
    },
    {
      serviceOptions: {
        addressDispatchRetryMs: 60_000,
        dispatchAddressPrompt: async () => {
          dispatches += 1;
          throw new Error("temporary disconnect");
        },
      },
    },
  );
});

test("MultiReviewService leaves a pending address untouched after losing its fence", async () => {
  const provider = new Provider();
  let invalidateFence = false;
  await withService(
    "env-address-fence",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const validate = storage.validateMultiReviewController.bind(storage);
      storage.validateMultiReviewController = (async (...args: Parameters<typeof validate>) =>
        invalidateFence
          ? false
          : validate(...args)) as typeof storage.validateMultiReviewController;

      await service.address(started.id);
      await waitUntil(() => invalidateFence);
      await service.advanceNow(started.id);
      const pending = await snapshot(started.id);
      expect(pending).toMatchObject({
        phase: "interactive",
        addressPromptPending: true,
        addressPromptAttempts: 0,
      });
      expect(pending?.error).toBeUndefined();
      storage.validateMultiReviewController = validate;
    },
    {
      serviceOptions: {
        dispatchAddressPrompt: async () => {
          invalidateFence = true;
        },
      },
    },
  );
});

test("MultiReviewService hands off a consolidation session whose last turn failed", async () => {
  const provider = new Provider();
  await withService("env-address-failed-turn", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });
    const ready = (await snapshot(started.id))!;

    // Same liveness-only rule the native adoption path uses: a failed last turn
    // is not a missing session, and the user can still drive it interactively.
    provider.sessionFailures.set(ready.fixSession!.providerSessionId, "the last turn failed");
    expect((await service.address(started.id)).phase).toBe("interactive");
  });
});

// A Multi Review is started by hand from whatever state the environment is in,
// so the change is routinely still in the working tree. A reviewer that was
// told nothing about that reviewed the committed range, found it empty, and
// reported that there was nothing to review.
test("MultiReviewService tells every reviewer about the uncommitted change", async () => {
  const provider = new Provider();
  const commands: string[] = [];
  await withService(
    "env-dirty-worktree",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start([
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "sonnet" },
      ]);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      expect(commands).toContain("get_environment_uncommitted_paths");
      const reviewerPrompts = [...provider.sends.values()]
        .map((sent) => sent.prompt)
        .filter((prompt) => prompt.includes("You are independent reviewer"));
      expect(reviewerPrompts).toHaveLength(2);
      for (const prompt of reviewerPrompts) {
        expect(prompt).toContain("the backend observed these uncommitted paths");
        expect(prompt).toContain("- `src/feature.ts`");
        expect(prompt).toContain(
          "never review a fresh clone, checkout, or worktree that omits them",
        );
        // The authoritative state has to precede the body that tells the reviewer
        // to reconcile against it rather than re-derive it.
        expect(prompt.indexOf("**Authoritative worktree state**")).toBeLessThan(
          prompt.indexOf("## Step 1: Establish the automated review snapshot"),
        );
      }

      const consolidation = [...provider.sends.values()].find((sent) =>
        sent.prompt.includes("<multi-review-reports-json>"),
      )!;
      expect(consolidation.prompt).toContain(
        "A report whose scope covers only the committed range examined an incomplete snapshot",
      );
    },
    {
      invoke: (async (command: string) => {
        commands.push(command);
        if (command !== "get_environment_uncommitted_paths") throw new Error("unexpected command");
        return {
          head: REVIEW_HEAD,
          paths: ["src/feature.ts"],
          fingerprint: REVIEW_FINGERPRINT,
        };
      }) as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
    },
  );
});

test("MultiReviewService reports a clean worktree and dispatches without it when unprobeable", async () => {
  const clean = new Provider();
  await withService(
    "env-clean-worktree",
    clean,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const reviewer = [...clean.sends.values()].find((sent) =>
        sent.prompt.includes("You are independent reviewer"),
      )!;
      expect(reviewer.prompt).toContain("was clean when the review started");
      const consolidation = [...clean.sends.values()].find((sent) =>
        sent.prompt.includes("<multi-review-reports-json>"),
      )!;
      expect(consolidation.prompt).not.toContain("examined an incomplete snapshot");
    },
    {
      invoke: (async () => ({
        head: REVIEW_HEAD,
        paths: [],
        fingerprint: REVIEW_FINGERPRINT,
      })) as <T>() => Promise<T>,
    },
  );

  // Without a durable content identity, independent reports cannot safely be
  // combined as one review.
  const unknown = new Provider();
  await withService(
    "env-unprobeable-worktree",
    unknown,
    async ({ start }) => {
      await expect(start()).rejects.toThrow("could not capture the environment Git state");
      expect(unknown.sends.size).toBe(0);
    },
    {
      invoke: (async () => {
        throw new Error("git unavailable");
      }) as <T>() => Promise<T>,
    },
  );
});

test("MultiReviewService stops when the snapshot changes between reviewers and retries all reviewers", async () => {
  const provider = new Provider();
  const replacementFingerprint = "b".repeat(64);
  const probes: Array<Record<string, unknown> | undefined> = [];
  await withService(
    "env-reviewer-snapshot-drift",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start([
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "sonnet" },
      ]);
      await waitUntil(async () => (await snapshot(started.id))?.phase === "failed");

      const failed = (await snapshot(started.id))!;
      expect(failed.reviewSnapshotStale).toBe(true);
      expect(failed.error).toContain("worktree changed after the review started");
      expect(failed.reviewers.map((reviewer) => reviewer.status)).toEqual(["completed", "failed"]);
      expect(
        [...provider.sends.values()].filter((sent) =>
          sent.prompt.includes("You are independent reviewer"),
        ),
      ).toHaveLength(1);

      // Only the snapshot that becomes prompt evidence pays for content hashing;
      // every drift check compares HEAD and the path set.
      expect(probes[0]).toEqual({
        environmentId: "env-reviewer-snapshot-drift",
        fingerprint: true,
      });
      expect(probes.slice(1, 3)).toEqual([
        { environmentId: "env-reviewer-snapshot-drift" },
        { environmentId: "env-reviewer-snapshot-drift" },
      ]);

      const retried = await service.retry(started.id);
      expect(retried.phase).toBe("reviewing");
      expect(retried.reviewSnapshotStale).toBeUndefined();
      expect(retried.reviewWorktreeSnapshot?.fingerprint).toBe(replacementFingerprint);
      expect(retried.reviewWorktreeSnapshot?.paths).toEqual([
        "src/feature.ts",
        "src/added-while-reviewing.ts",
      ]);
      expect(retried.reviewers.every((reviewer) => reviewer.status === "pending")).toBe(true);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
    },
    {
      invoke: (async (_command: string, args?: Record<string, unknown>) => {
        probes.push(args);
        return probes.length <= 2
          ? { head: REVIEW_HEAD, paths: ["src/feature.ts"], fingerprint: REVIEW_FINGERPRINT }
          : {
              head: REVIEW_HEAD,
              paths: ["src/feature.ts", "src/added-while-reviewing.ts"],
              fingerprint: replacementFingerprint,
            };
      }) as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
    },
  );
});

// A reviewer turn that is still executing keeps writing to the very worktree
// whose state could not be trusted. Unlike a lost controller fence, no other
// controller inherits it, so this pass has to abort it on the way out.
test("MultiReviewService aborts a live reviewer turn when the snapshot drifts", async () => {
  const provider = new Provider();
  // Reviewer 1 never settles, so it is still running when reviewer 2 probes.
  provider.statusOverrides.set("session-1", "running");
  let probes = 0;
  await withService(
    "env-drift-live-turn",
    provider,
    async ({ start, snapshot }) => {
      const started = await start([
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "sonnet" },
      ]);
      await waitUntil(async () => (await snapshot(started.id))?.phase === "failed");

      expect(provider.aborted).toContain("session-1");
      const failed = (await snapshot(started.id))!;
      expect(failed.reviewSnapshotStale).toBe(true);
      expect(failed.reviewers[0]?.status).toBe("failed");
      // The id survives the abort so the read-only transcript stays reachable.
      expect(failed.reviewers[0]?.providerSessionId).toBe("session-1");
    },
    {
      invoke: (async () => {
        probes += 1;
        return probes <= 2
          ? { head: REVIEW_HEAD, paths: [], fingerprint: REVIEW_FINGERPRINT }
          : { head: REVIEW_HEAD, paths: ["src/appeared.ts"], fingerprint: "b".repeat(64) };
      }) as <T>() => Promise<T>,
    },
  );
});

test("MultiReviewService refuses to consolidate reports after snapshot drift", async () => {
  const provider = new Provider();
  let probes = 0;
  await withService(
    "env-consolidation-snapshot-drift",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => (await snapshot(started.id))?.phase === "consolidating");
      await service.advanceNow(started.id);

      const failed = (await snapshot(started.id))!;
      expect(failed.phase).toBe("failed");
      expect(failed.reviewSnapshotStale).toBe(true);
      expect(failed.consolidatedReport).toBeUndefined();
      expect(
        [...provider.sends.values()].some((sent) =>
          sent.prompt.includes("<multi-review-reports-json>"),
        ),
      ).toBe(false);
    },
    {
      invoke: (async () => {
        probes += 1;
        return probes <= 2
          ? { head: REVIEW_HEAD, paths: ["src/feature.ts"], fingerprint: REVIEW_FINGERPRINT }
          : {
              head: REVIEW_HEAD,
              paths: ["src/feature.ts", "src/appeared.ts"],
              fingerprint: "c".repeat(64),
            };
      }) as <T>() => Promise<T>,
    },
  );
});

// Reviewers are told validation "may write generated artifacts and tool
// caches". Failing the workflow over the bytes those writes changed would
// punish the reviewer for doing what it was asked, so drift is judged on HEAD
// and the uncommitted path set instead.
test("MultiReviewService tolerates content churn inside the same uncommitted paths", async () => {
  const provider = new Provider();
  let probes = 0;
  await withService(
    "env-content-churn",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      const ready = (await snapshot(started.id))!;
      expect(ready.reviewSnapshotStale).toBeUndefined();
      // The prompts still quote the fingerprint captured at the start.
      expect(ready.reviewWorktreeSnapshot?.fingerprint).toBe(REVIEW_FINGERPRINT);
      expect(
        [...provider.sends.values()].some((sent) =>
          sent.prompt.includes("<multi-review-reports-json>"),
        ),
      ).toBe(true);
    },
    {
      invoke: (async () => {
        probes += 1;
        // Same HEAD and same paths, different bytes on every observation.
        return {
          head: REVIEW_HEAD,
          paths: ["src/feature.ts"],
          fingerprint: probes <= 1 ? REVIEW_FINGERPRINT : `${probes}`.padStart(64, "d"),
        };
      }) as <T>() => Promise<T>,
    },
  );
});

// A schema repair re-sends a prompt the reviewer already answered. Re-probing
// there would convert an already-handled formatting retry into a whole-workflow
// failure, so the repair dispatch must not consult the worktree at all.
test("MultiReviewService does not re-verify the snapshot for a schema repair", async () => {
  const provider = new Provider();
  provider.invalidReviewerReports = 1;
  let probes = 0;
  await withService(
    "env-repair-no-reprobe",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      const ready = (await snapshot(started.id))!;
      expect(ready.reviewers[0]?.schemaRepairAttempts).toBe(1);
      // Start, one reviewer dispatch, one consolidation dispatch. A fourth probe
      // would mean the repair dispatch was gated.
      expect(probes).toBe(3);
    },
    {
      invoke: (async () => {
        probes += 1;
        return { head: REVIEW_HEAD, paths: ["src/feature.ts"], fingerprint: REVIEW_FINGERPRINT };
      }) as <T>() => Promise<T>,
    },
  );
});

// "Could not look" is not evidence of "has changed". Treating it as drift would
// throw away every completed report over a transient exec failure.
test("MultiReviewService keeps its reports when the snapshot cannot be verified", async () => {
  const provider = new Provider();
  let probes = 0;
  await withService(
    "env-snapshot-unverifiable",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => (await snapshot(started.id))?.phase === "consolidating");
      await service.advanceNow(started.id);

      const failed = (await snapshot(started.id))!;
      expect(failed.phase).toBe("failed");
      expect(failed.error).toContain("cannot verify its worktree snapshot");
      // Not drift: the snapshot is still trusted, so the reports survive.
      expect(failed.reviewSnapshotStale).toBeUndefined();
      expect(failed.reviewers[0]?.status).toBe("completed");
      expect(failed.reviewers[0]?.report).toBeDefined();

      // Retry therefore resumes consolidation instead of re-running every
      // reviewer against a freshly captured snapshot.
      const retried = await service.retry(started.id);
      expect(retried.phase).toBe("consolidating");
      expect(retried.reviewers[0]?.report).toBeDefined();
      expect(retried.reviewWorktreeSnapshot?.fingerprint).toBe(REVIEW_FINGERPRINT);
    },
    {
      invoke: (async () => {
        probes += 1;
        if (probes > 2) throw new Error("review-worktree-probe:git-failed");
        return { head: REVIEW_HEAD, paths: ["src/feature.ts"], fingerprint: REVIEW_FINGERPRINT };
      }) as <T>() => Promise<T>,
    },
  );
});

// A worktree big enough to blow the snapshot bound has to be refused where the
// user can see it, not truncated into a snapshot that misrepresents the change.
test("MultiReviewService refuses to start with more uncommitted paths than it can pin", async () => {
  const provider = new Provider();
  await withService(
    "env-too-many-paths",
    provider,
    async ({ start }) => {
      await expect(start()).rejects.toThrow(
        `more than ${MULTI_REVIEW_MAX_SNAPSHOT_PATHS} uncommitted paths`,
      );
      expect(provider.sends.size).toBe(0);
    },
    {
      invoke: (async () => ({
        head: REVIEW_HEAD,
        paths: Array.from(
          { length: MULTI_REVIEW_MAX_SNAPSHOT_PATHS + 1 },
          (_entry, index) => `src/file-${index}.ts`,
        ),
        fingerprint: REVIEW_FINGERPRINT,
      })) as <T>() => Promise<T>,
    },
  );
});

// A workflow persisted before snapshots existed has no baseline to drift from.
// Failing every in-flight review on upgrade would lose work for nothing, so the
// first verification adopts the current state instead.
test("MultiReviewService adopts a snapshot for a workflow persisted without one", async () => {
  const provider = new Provider();
  await withService(
    "env-legacy-workflow",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => (await snapshot(started.id))?.phase === "consolidating");

      // Rewrite the record the way a pre-upgrade backend would have left it.
      const stored = (await storage.getMultiReviewWorkflow(started.id))!;
      const legacy = { ...(stored.snapshot as MultiReviewWorkflow) };
      delete legacy.reviewWorktreeSnapshot;
      await storage.saveMultiReviewWorkflow(
        started.id,
        "env-legacy-workflow",
        1,
        legacy,
        stored.revision,
      );

      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      const ready = (await snapshot(started.id))!;
      expect(ready.reviewWorktreeSnapshot?.fingerprint).toBe(REVIEW_FINGERPRINT);
      expect(ready.reviewSnapshotStale).toBeUndefined();
    },
  );
});

async function withService(
  environmentId: string,
  provider: Provider,
  run: (context: {
    service: MultiReviewService;
    storage: StorageService;
    start: (reviewers?: MultiReviewModelSelection[]) => Promise<MultiReviewWorkflow>;
    snapshot: (workflowId: string) => Promise<MultiReviewWorkflow | undefined>;
  }) => Promise<void>,
  options: {
    createProvider?: () => Promise<BuildPipelineProvider>;
    serviceOptions?: Partial<MultiReviewServiceOptions>;
    /** Backend command runner; defaults to a stable clean review snapshot. */
    invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  } = {},
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), `ork-multi-review-${environmentId}-`));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: environmentId,
    projectId: "project-1",
    name: "review",
    branch: "change",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/review",
    setupScriptsComplete: true,
  });
  const service = new MultiReviewService(
    storage,
    options.invoke ??
      (async (command: string) => {
        if (command !== "get_environment_uncommitted_paths") throw new Error("unexpected command");
        return {
          head: REVIEW_HEAD,
          paths: [],
          fingerprint: REVIEW_FINGERPRINT,
        } as never;
      }),
    {
      autoAdvance: false,
      provider: options.createProvider ?? (async () => provider),
      ...options.serviceOptions,
    },
  );
  try {
    await run({
      service,
      storage,
      start: (reviewers = [{ agent: "claude", model: "opus" }]) =>
        service.start({
          environmentId,
          projectId: "project-1",
          targetBranch: "main",
          reviewers,
          fixModel: { agent: "claude", model: "opus" },
        }),
      snapshot: async (workflowId) =>
        (await storage.getMultiReviewWorkflow(workflowId))?.snapshot as
          | MultiReviewWorkflow
          | undefined,
    });
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Multi Review state");
    await Bun.sleep(10);
  }
}

async function mutateStoredWorkflow(
  storage: StorageService,
  workflowId: string,
  mutate: (workflow: MultiReviewWorkflow) => void,
): Promise<void> {
  const record = await storage.getMultiReviewWorkflow(workflowId);
  if (!record) throw new Error(`missing multi review workflow: ${workflowId}`);
  const snapshot = record.snapshot as MultiReviewWorkflow;
  mutate(snapshot);
  await storage.saveMultiReviewWorkflow(
    workflowId,
    snapshot.environmentId,
    snapshot.version,
    snapshot,
    record.revision,
  );
}

test("MultiReviewService keeps environment activity working until its agents settle", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  await withService("env-activity", provider, async ({ service, storage, start, snapshot }) => {
    const started = await start();
    await waitUntil(() => provider.statusCalls > 0);

    expect(await storage.getEnvironment("env-activity")).toMatchObject({
      agentActivityState: "working",
      agentActivitySources: {
        "multi-review": { state: "working" },
      },
    });

    provider.statusValue = "idle";
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });
    expect(await storage.getEnvironment("env-activity")).toMatchObject({
      agentActivityState: "idle",
      agentActivitySources: {
        "multi-review": { state: "idle" },
      },
    });
  });
});

test("MultiReviewService asks a reviewer to correct an invalid structured report", async () => {
  const provider = new Provider();
  provider.invalidReviewerReports = 1;
  await withService("env-review-repair", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });

    const repaired = await snapshot(started.id);
    expect(repaired?.reviewers[0]).toMatchObject({
      status: "completed",
      schemaRepairAttempts: 1,
    });
    const repair = [...provider.sends.values()].find((sent) =>
      sent.prompt.includes("repair attempt 1 of 3"),
    );
    expect(repair).toBeDefined();
    expect(repair?.options.schema).toBe(STRUCTURED_REVIEW_REPORT_JSON_SCHEMA);
    expect(repair?.prompt).toContain("<structured-review-expected-schema-json>");
    expect(repair?.prompt).toContain('"required"');
    expect(repair?.prompt).toContain("$.ready");
    expect(repair?.prompt).toContain('Unknown field \\"ready\\".');
  });
});

test("MultiReviewService asks the fix model to correct an invalid consolidated report", async () => {
  const provider = new Provider();
  provider.invalidConsolidatedReports = 1;
  await withService("env-consolidation-repair", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });

    const repaired = await snapshot(started.id);
    expect(repaired?.consolidatedReport).toMatchObject({
      verdict: { ready: "yes" },
    });
    expect(repaired?.fixSession?.requestIds).toHaveLength(2);
    const repair = [...provider.sends.values()].find((sent) =>
      sent.prompt.includes("repair attempt 1 of 3"),
    );
    expect(repair?.prompt).toContain("$.ready");
    expect(repair?.prompt).toContain("<structured-review-expected-schema-json>");
  });
});

test("MultiReviewService stamps reviewer findings with the configured model", async () => {
  const provider = new Provider();
  provider.reviewerReport = {
    ...consolidatedReport,
    issues: consolidatedReport.issues.map((issue) => ({
      ...issue,
      reviewModels: ["provider-invented-model"],
    })),
  };
  await withService(
    "env-review-model-attribution",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      const ready = await snapshot(started.id);
      expect(ready?.reviewers[0]?.report?.issues[0]?.reviewModels).toEqual(["claude/opus"]);
      expect(ready?.reviewers[0]?.report?.testCoverageGaps[0]?.reviewModels).toEqual([
        "claude/opus",
      ]);
    },
  );
});

test("MultiReviewService repairs consolidated findings without source provenance", async () => {
  const provider = new Provider();
  provider.missingConsolidatedProvenanceReports = 1;
  await withService(
    "env-consolidation-provenance-repair",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      const repair = [...provider.sends.values()].find((sent) =>
        sent.prompt.includes("repair attempt 1 of 3"),
      );
      expect(repair?.prompt).toContain("$.issues[0].reviewSourceIds");
      expect(repair?.prompt).toContain("source finding ID");
    },
  );
});

test("MultiReviewService derives all provenance labels from cited source IDs", async () => {
  const provider = new Provider();
  provider.consolidationReport = {
    ...consolidatedReport,
    issues: consolidatedReport.issues.map((issue) => ({
      ...issue,
      reviewSourceIds: ["reviewer-1/issue-1", "reviewer-2/issue-1"],
    })),
    testCoverageGaps: consolidatedReport.testCoverageGaps.map((gap) => ({
      ...gap,
      reviewSourceIds: ["reviewer-1/coverage-gap-1", "reviewer-2/coverage-gap-1"],
    })),
  };
  provider.reviewerReport = consolidatedReport;
  await withService(
    "env-derived-consolidation-provenance",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start([
        { agent: "claude", model: "default" },
        { agent: "codex", model: "default" },
      ]);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      const ready = await snapshot(started.id);
      expect(ready?.reviewers.map((reviewer) => reviewer.report?.issues[0]?.reviewModels)).toEqual([
        ["claude/default"],
        ["codex/default"],
      ]);
      expect(ready?.consolidatedReport?.issues[0]?.reviewModels).toEqual([
        "claude/default",
        "codex/default",
      ]);
      expect(ready?.consolidatedReport?.issues[0]).not.toHaveProperty("reviewSourceIds");
      const consolidation = [...provider.sends.values()].find((sent) =>
        sent.prompt.includes("<multi-review-reports-json>"),
      );
      expect(consolidation?.prompt).toContain('"reviewSourceIds":["reviewer-1/issue-1"]');
      expect(consolidation?.prompt).toContain('"reviewSourceIds":["reviewer-2/issue-1"]');
    },
  );
});

test("MultiReviewService rejects a participating model label supplied by the provider", async () => {
  const provider = new Provider();
  provider.reviewerReport = consolidatedReport;
  provider.providerAuthoredConsolidatedModels = 1;
  await withService(
    "env-provider-authored-consolidation-model",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start([
        { agent: "claude", model: "default" },
        { agent: "codex", model: "default" },
      ]);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      const repair = [...provider.sends.values()].find((sent) =>
        sent.prompt.includes("repair attempt 1 of 3"),
      );
      expect(repair?.prompt).toContain("$.issues[0].reviewModels");
      expect(repair?.prompt).toContain("backend derives review models");
      expect((await snapshot(started.id))?.consolidatedReport?.issues[0]?.reviewModels).toEqual([
        "claude/default",
      ]);
    },
  );
});

test("MultiReviewService repairs invalid and missing source citations", async () => {
  for (const [environmentId, configure, expectedPath] of [
    [
      "env-invalid-source-citation",
      (provider: Provider) => {
        provider.reviewerReport = consolidatedReport;
        provider.invalidConsolidatedProvenanceReports = 1;
      },
      "$.issues[0].reviewSourceIds[0]",
    ],
    [
      "env-missing-gap-citation",
      (provider: Provider) => {
        provider.reviewerReport = consolidatedReport;
        provider.missingCoverageGapProvenanceReports = 1;
      },
      "$.testCoverageGaps[0].reviewSourceIds",
    ],
  ] as const) {
    const provider = new Provider();
    configure(provider);
    await withService(environmentId, provider, async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const repair = [...provider.sends.values()].find((sent) =>
        sent.prompt.includes("repair attempt 1 of 3"),
      );
      expect(repair?.prompt).toContain(expectedPath);
    });
  }
});

test("MultiReviewService bounds repeated provenance repairs", async () => {
  const provider = new Provider();
  provider.missingConsolidatedProvenanceReports = 4;
  await withService(
    "env-provenance-repair-bound",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "failed";
      });

      const failed = await snapshot(started.id);
      expect(failed?.activeRequest?.schemaRepairAttempts).toBe(3);
      expect(failed?.error).toContain("3 repair attempts");
      expect(
        [...provider.sends.values()].filter((sent) =>
          sent.prompt.includes("<structured-review-contract-errors-json>"),
        ),
      ).toHaveLength(3);
    },
  );
});

test("MultiReviewService repairs provider-level schema failures with their details", async () => {
  const provider = new Provider();
  provider.schemaFailureReports = 1;
  await withService(
    "env-provider-schema-repair",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      const repair = [...provider.sends.values()].find((sent) =>
        sent.prompt.includes("repair attempt 1 of 3"),
      );
      expect(repair?.prompt).toContain("$.verdict.ready");
      expect(repair?.prompt).toContain("Output did not satisfy the provider schema.");
      expect(repair?.prompt).toContain("Expected an enum value.");
      expect(repair?.prompt).toContain("<structured-review-expected-schema-json>");
    },
  );
});

test("MultiReviewService refuses to address a review that is not ready", async () => {
  const provider = new Provider();
  await withService("env-address-not-ready", provider, async ({ service, start }) => {
    const started = await start();
    await expect(service.address(started.id)).rejects.toThrow("not ready to address");
  });
});

/**
 * A snapshot in the shape the pre-handoff `address()` used to persist.
 *
 * Nothing writes `fixing` any more, but the supervisor still advances it so a
 * workflow caught mid-fix by an upgrade finishes instead of stalling forever.
 * That path is only reachable from durable state, so seed it directly.
 */
async function seedLegacyFixingWorkflow(
  storage: StorageService,
  environmentId: string,
): Promise<string> {
  const workflowId = `legacy-fixing-${environmentId}`;
  const timestamp = new Date(0).toISOString();
  const snapshot: MultiReviewWorkflow = {
    version: MULTI_REVIEW_WORKFLOW_VERSION,
    controller: "backend",
    id: workflowId,
    environmentId,
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [
      {
        id: "reviewer-1",
        agent: "claude",
        model: "opus",
        status: "completed",
        report: cleanReport,
        sessionKey: `multi-review:${workflowId}:reviewer-1`,
        providerSessionId: "session-1",
      },
    ],
    fixModel: { agent: "claude", model: "opus" },
    consolidatedReport,
    fixSession: {
      agent: "claude",
      model: "opus",
      sessionKey: `multi-review:${workflowId}:fix`,
      providerSessionId: "session-legacy-fix",
      requestIds: ["consolidate-1", "fix-1"],
      status: "running",
      startedAt: timestamp,
    },
    activeRequest: { kind: "fix", requestId: "fix-1", state: "prepared", createdAt: timestamp },
    phase: "fixing",
    createdAt: timestamp,
    updatedAt: timestamp,
    backendRevision: 0,
  };
  const saved = await storage.createMultiReviewWorkflowIfNoActive(
    workflowId,
    environmentId,
    MULTI_REVIEW_WORKFLOW_VERSION,
    snapshot,
  );
  expect(saved).not.toBeNull();
  return workflowId;
}

test("MultiReviewService finishes a fix turn persisted before the interactive handoff", async () => {
  const provider = new Provider();
  await withService("env-legacy-fixing", provider, async ({ service, storage, snapshot }) => {
    const workflowId = await seedLegacyFixingWorkflow(storage, "env-legacy-fixing");
    await waitUntil(async () => {
      await service.advanceNow(workflowId);
      return (await snapshot(workflowId))?.phase === "completed";
    });

    expect(await snapshot(workflowId)).toMatchObject({
      phase: "completed",
      fixResult: { complete: true, summary: "Addressed every finding" },
      fixSession: { status: "idle" },
    });
    expect(provider.fixSends).toBe(1);
  });
});

test("MultiReviewService asks the fix model to correct an invalid fix result", async () => {
  const provider = new Provider();
  provider.invalidFixResults = 1;
  await withService("env-legacy-fix-repair", provider, async ({ service, storage, snapshot }) => {
    const workflowId = await seedLegacyFixingWorkflow(storage, "env-legacy-fix-repair");
    await waitUntil(async () => {
      await service.advanceNow(workflowId);
      return (await snapshot(workflowId))?.phase === "completed";
    });

    const completed = await snapshot(workflowId);
    expect(completed?.fixResult).toMatchObject({ complete: true });
    expect(completed?.fixSession?.requestIds).toHaveLength(3);
    const repair = [...provider.sends.values()].find(
      (sent) =>
        sent.options.schema === REVIEW_FIX_RESULT_JSON_SCHEMA &&
        sent.prompt.includes("repair attempt 1 of 3"),
    );
    expect(repair?.prompt).toContain("fix result");
    expect(repair?.prompt).toContain("Fix result cannot be complete");
    expect(repair?.prompt).toContain('"complete"');
    expect(repair?.prompt).toContain("<structured-review-expected-schema-json>");
  });
});

test("MultiReviewService does not treat provider fix failures as schema repair work", async () => {
  for (const code of ["provider_error", "interrupted"] as const) {
    const provider = new Provider();
    provider.fixStructuredFailure = code;
    await withService(
      `env-legacy-fix-${code}`,
      provider,
      async ({ service, storage, snapshot }) => {
        const workflowId = await seedLegacyFixingWorkflow(storage, `env-legacy-fix-${code}`);
        await waitUntil(async () => {
          await service.advanceNow(workflowId);
          return (await snapshot(workflowId))?.phase === "failed";
        });

        const failed = await snapshot(workflowId);
        expect(failed?.error).toBe(`Fix result failed with ${code}`);
        expect(failed?.activeRequest?.schemaRepairAttempts).toBeUndefined();
        expect(failed?.activeRequest?.schemaRepairPrompt).toBeUndefined();
        expect(failed?.fixSession?.requestIds).toHaveLength(2);
      },
    );
  }
});

test("MultiReviewService retries an incomplete legacy fix turn from the consolidated report", async () => {
  const provider = new Provider();
  provider.fixComplete = false;
  await withService("env-legacy-fix-retry", provider, async ({ service, storage, snapshot }) => {
    const workflowId = await seedLegacyFixingWorkflow(storage, "env-legacy-fix-retry");
    await waitUntil(async () => {
      await service.advanceNow(workflowId);
      return (await snapshot(workflowId))?.phase === "failed";
    });

    const failed = await snapshot(workflowId);
    expect(failed?.fixSession?.status).toBe("failed");
    expect(failed?.error).toContain("could not address every finding");

    const retried = await service.retry(workflowId);
    expect(retried.phase).toBe("ready");
    expect(retried.fixSession?.status).toBe("idle");
    expect(retried.activeRequest).toBeUndefined();
    expect(retried.error).toBeUndefined();
    expect(retried.consolidatedReport).toBeDefined();
    // The consolidated session is reused for the next attempt, never abandoned.
    expect(provider.aborted).toEqual([]);
  });
});

test("MultiReviewService bounds repeated reviewer schema corrections", async () => {
  const provider = new Provider();
  provider.invalidReviewerReports = 4;
  await withService("env-review-repair-bound", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "failed";
    });

    const failed = await snapshot(started.id);
    expect(failed?.reviewers[0]).toMatchObject({
      status: "failed",
      schemaRepairAttempts: 3,
      error: expect.stringContaining("3 repair attempts"),
    });
    expect(
      [...provider.sends.values()].filter((sent) =>
        sent.prompt.includes("<structured-review-contract-errors-json>"),
      ),
    ).toHaveLength(3);
  });
});

test("MultiReviewService clears stale review activity when it rehydrates", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-activity-rehydrate-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-rehydrate",
    projectId: "project-1",
    name: "review",
    branch: "change",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/review",
    setupScriptsComplete: true,
  });
  await storage.setEnvironmentAgentActivity(
    "env-rehydrate",
    "working",
    new Date().toISOString(),
    "multi-review",
  );
  const service = new MultiReviewService(storage, stableReviewInvoker, { autoAdvance: false });
  try {
    await service.init();
    expect(await storage.getEnvironment("env-rehydrate")).toMatchObject({
      agentActivityState: "idle",
      agentActivitySources: {
        "multi-review": { state: "idle" },
      },
    });
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("MultiReviewService rehydrates active review activity without a renderer", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-activity-active-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-active",
    projectId: "project-1",
    name: "review",
    branch: "change",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/review",
    setupScriptsComplete: true,
  });
  const provider = new Provider();
  provider.statusValue = "running";
  const first = new MultiReviewService(storage, stableReviewInvoker, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const started = await first.start({
    environmentId: "env-active",
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  await waitUntil(() => provider.statusCalls > 0);
  await first.shutdown();

  // Simulate a stale snapshot from a process that missed the workflow event.
  await storage.setEnvironmentAgentActivity(
    "env-active",
    "idle",
    new Date().toISOString(),
    "multi-review",
  );
  const restored = new MultiReviewService(storage, stableReviewInvoker, {
    autoAdvance: false,
    provider: async () => provider,
  });
  try {
    await restored.init();
    expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
      phase: "reviewing",
    });
    expect(await storage.getEnvironment("env-active")).toMatchObject({
      agentActivityState: "working",
      agentActivitySources: {
        "multi-review": { state: "working" },
      },
    });
  } finally {
    await restored.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("MultiReviewService owns fan-out, consolidation, and the interactive fix handoff", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "review",
    branch: "change",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/review",
    setupScriptsComplete: true,
  });
  const provider = new Provider();
  provider.reviewerReport = consolidatedReport;
  const service = new MultiReviewService(storage, stableReviewInvoker, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const started = await service.start({
    environmentId: "env-1",
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "sonnet" },
    ],
    fixModel: { agent: "claude", model: "opus" },
  });

  for (let attempt = 0; attempt < 8; attempt++) {
    await service.advanceNow(started.id);
    const current = await storage.getMultiReviewWorkflow(started.id);
    if ((current?.snapshot as { phase?: string })?.phase === "ready") break;
  }
  const ready = await storage.getMultiReviewWorkflow(started.id);
  expect(ready?.snapshot).toMatchObject({
    phase: "ready",
    consolidatedReport: {
      issues: [{ title: "Broken branch" }],
      testCoverageGaps: [{ file: "src/a.test.ts" }],
    },
  });
  expect(provider.sessions).toBe(3);

  await service.address(started.id);
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "interactive",
    fixSession: { status: "idle" },
  });
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).not.toHaveProperty(
    "activeRequest",
  );
  await service.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("MultiReviewService fails an idle reviewer that never returns structured output", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-idle-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-idle",
    projectId: "project-1",
    name: "review",
    branch: "change",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/review",
    setupScriptsComplete: true,
  });
  const provider = new Provider(false);
  const service = new MultiReviewService(storage, stableReviewInvoker, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const started = await service.start({
    environmentId: "env-idle",
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });

  for (let attempt = 0; attempt < 7; attempt++) await service.advanceNow(started.id);
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "failed",
    reviewers: [{ status: "failed", error: expect.stringContaining("structured report") }],
  });

  await service.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("MultiReviewService leaves an interactive handoff idle for the native tab", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-interactive-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-interactive",
    projectId: "project-1",
    name: "review",
    branch: "change",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/review",
    setupScriptsComplete: true,
  });
  const provider = new Provider();
  const service = new MultiReviewService(storage, stableReviewInvoker, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const started = await service.start({
    environmentId: "env-interactive",
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await service.advanceNow(started.id);
    const current = await storage.getMultiReviewWorkflow(started.id);
    if ((current?.snapshot as { phase?: string })?.phase === "ready") break;
  }
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "ready",
  });

  const sendsBeforeAddress = provider.sends.size;
  const addressed = await service.address(started.id);
  await service.advanceNow(started.id);
  expect(addressed.phase).toBe("interactive");
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "interactive",
    fixSession: { status: "idle" },
  });
  expect(provider.sends.size).toBe(sendsBeforeAddress);
  expect(provider.fixSends).toBe(0);
  await service.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("MultiReviewService persists cancellation until an aborting consolidation provider actually stops", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-cancel-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-cancel",
    projectId: "project-1",
    name: "review",
    branch: "change",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/review",
    setupScriptsComplete: true,
  });
  const provider = new Provider();
  // Pin the consolidation session before start() kicks the first advance so a
  // coalesced run cannot skip consolidating and land on ready.
  provider.statusOverrides.set("session-2", "running");
  const service = new MultiReviewService(storage, stableReviewInvoker, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const started = await service.start({
    environmentId: "env-cancel",
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  await waitUntil(async () => {
    await service.advanceNow(started.id);
    return (
      ((await storage.getMultiReviewWorkflow(started.id))?.snapshot as { phase?: string })
        ?.phase === "consolidating"
    );
  });

  const statusCallsBeforeCancel = provider.statusCalls;
  provider.abortError = new Error("abort unavailable");
  expect((await service.cancel(started.id)).phase).toBe("cancelling");
  await waitUntil(() => provider.statusCalls > statusCallsBeforeCancel);
  await service.advanceNow(started.id);
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "cancelling",
    error: expect.stringContaining("abort unavailable"),
  });

  provider.statusOverrides.delete("session-2");
  await service.advanceNow(started.id);
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "cancelled",
    reviewers: [{ status: "completed" }],
    fixSession: { status: "cancelled" },
  });
  const replacement = await service.start({
    environmentId: "env-cancel",
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  expect(replacement.id).not.toBe(started.id);
  await service.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

/*
 * A session whose turn ended terminally has stopped, which is exactly what the
 * abort was waiting for. Letting that read throw reported a successful abort as
 * unsettled, so cancellation stayed pending on a provider that was already done.
 */
test("MultiReviewService settles cancellation when the aborted session reports a terminal turn error", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-cancel-terminal-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-cancel-terminal",
    projectId: "project-1",
    name: "review",
    branch: "change",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/review",
    setupScriptsComplete: true,
  });
  const provider = new Provider();
  provider.statusOverrides.set("session-2", "running");
  const service = new MultiReviewService(storage, stableReviewInvoker, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const started = await service.start({
    environmentId: "env-cancel-terminal",
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  await waitUntil(async () => {
    await service.advanceNow(started.id);
    return (
      ((await storage.getMultiReviewWorkflow(started.id))?.snapshot as { phase?: string })
        ?.phase === "consolidating"
    );
  });

  const statusCallsBeforeCancel = provider.statusCalls;
  provider.abortError = new Error("abort unavailable");
  expect((await service.cancel(started.id)).phase).toBe("cancelling");
  await waitUntil(() => provider.statusCalls > statusCallsBeforeCancel);
  await service.advanceNow(started.id);
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "cancelling",
  });

  // The persisted snapshot is stored untyped; the sibling tests only ever hand
  // it to `toMatchObject`, so narrow it here to read one field back out.
  const cancelling = (await storage.getMultiReviewWorkflow(started.id))?.snapshot as
    | MultiReviewWorkflow
    | undefined;
  const fixSessionId = cancelling?.fixSession?.providerSessionId;
  expect(fixSessionId).toBeDefined();
  // The turn ends terminally rather than returning to idle: still settled.
  provider.sessionFailures.set(fixSessionId!, "Selected model is at capacity");
  await service.advanceNow(started.id);

  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "cancelled",
    fixSession: { status: "cancelled" },
  });
  await service.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("MultiReviewService coalesces repeated advances while a provider call is blocked", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-coalesce-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-coalesce",
    projectId: "project-1",
    name: "review",
    branch: "change",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/review",
    setupScriptsComplete: true,
  });
  const provider = new Provider();
  provider.statusValue = "running";
  const release = provider.blockStatus();
  const service = new MultiReviewService(storage, stableReviewInvoker, {
    autoAdvance: false,
    provider: async () => provider,
  });
  await service.start({
    environmentId: "env-coalesce",
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  await waitUntil(() => provider.statusCalls === 1);

  const first = service.advanceNow((await storage.listMultiReviewWorkflows("env-coalesce"))[0]!.id);
  const second = service.advanceNow(
    (await storage.listMultiReviewWorkflows("env-coalesce"))[0]!.id,
  );
  const third = service.advanceNow((await storage.listMultiReviewWorkflows("env-coalesce"))[0]!.id);
  expect(second).toBe(first);
  expect(third).toBe(first);
  release();
  await first;
  expect(provider.statusCalls).toBe(2);

  await service.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("MultiReviewService renews its lease while a provider call is blocked", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-lease-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-lease",
    projectId: "project-1",
    name: "review",
    branch: "change",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/review",
    setupScriptsComplete: true,
  });
  const provider = new Provider();
  provider.statusValue = "running";
  const release = provider.blockStatus();
  const service = new MultiReviewService(storage, stableReviewInvoker, {
    pollIntervalMs: 50,
    controllerLeaseMs: 2_000,
    controllerRenewMs: 100,
    provider: async () => provider,
  });
  await service.init();
  const started = await service.start({
    environmentId: "env-lease",
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  await waitUntil(() => provider.statusCalls === 1);
  await Bun.sleep(2_200);

  const competing = await storage.claimMultiReviewController(started.id, "competing-owner", 2_000);
  expect(competing.granted).toBe(false);
  let shutdownFinished = false;
  const shutdown = service.shutdown().then(() => {
    shutdownFinished = true;
  });
  await Bun.sleep(20);
  expect(shutdownFinished).toBe(false);
  release();
  await shutdown;
  expect(shutdownFinished).toBe(true);
  await fs.rm(dataDir, { recursive: true, force: true });
}, 8_000);

test("MultiReviewService atomically admits only one active workflow per environment", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-start-race-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-race",
    projectId: "project-1",
    name: "review",
    branch: "change",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/review",
    setupScriptsComplete: true,
  });
  const provider = new Provider();
  provider.statusValue = "running";
  const service = new MultiReviewService(storage, stableReviewInvoker, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const input = {
    environmentId: "env-race",
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [{ agent: "claude" as const, model: "opus" }],
    fixModel: { agent: "claude" as const, model: "opus" },
  };
  const outcomes = await Promise.allSettled([service.start(input), service.start(input)]);

  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  expect(await storage.listMultiReviewWorkflows("env-race")).toHaveLength(1);
  await service.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("MultiReviewService keeps reviewing and consolidates when another reviewer fails", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  // Reviewer 1 gets its session; reviewer 2 cannot open one.
  provider.failCreateSessionAfter = 1;
  await withService("env-attribution", provider, async ({ service, storage, start, snapshot }) => {
    const started = await start([
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "sonnet" },
    ]);
    await service.advanceNow(started.id);

    const current = await snapshot(started.id);
    expect(current?.phase).toBe("reviewing");
    expect(current?.reviewers[0]).toMatchObject({ model: "opus", status: "running" });
    expect(current?.reviewers[0]?.error).toBeUndefined();
    expect(current?.reviewers[1]).toMatchObject({
      model: "sonnet",
      status: "failed",
      error: expect.stringContaining("bridge authentication is unavailable"),
    });
    expect(await storage.getEnvironment("env-attribution")).toMatchObject({
      agentActivityState: "working",
      agentActivitySources: {
        "multi-review": { state: "working" },
      },
    });

    // Let the healthy reviewer finish and allow the consolidation session to
    // open. The failed review must not appear in the consolidation input.
    provider.failCreateSessionAfter = null;
    provider.statusValue = "idle";
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });

    const ready = await snapshot(started.id);
    expect(ready?.phase).toBe("ready");
    expect(ready?.reviewers.map((reviewer) => reviewer.status)).toEqual(["completed", "failed"]);
    expect(ready?.consolidatedReport).toBeDefined();
    const consolidation = [...provider.sends.values()].find((sent) =>
      sent.prompt.includes("<multi-review-reports-json>"),
    );
    expect(consolidation?.prompt).toContain(ready?.reviewers[0]?.id ?? "missing-reviewer");
    expect(consolidation?.prompt).not.toContain(ready?.reviewers[1]?.id ?? "missing-reviewer");
  });
});

test("MultiReviewService aborts a reviewer session that fails mid-turn while the workflow continues", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  // Reviewer 1's first post-dispatch status poll throws, as a transport error
  // while its turn may still be executing would.
  provider.statusError = new Error("The reviewer session could not be polled");
  await withService("env-mid-turn-failure", provider, async ({ service, start, snapshot }) => {
    const started = await start([
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "sonnet" },
    ]);
    await service.advanceNow(started.id);

    const current = await snapshot(started.id);
    expect(current?.reviewers[0]).toMatchObject({
      model: "opus",
      status: "failed",
      error: "The reviewer session could not be polled",
    });
    // The session id survives so the read-only transcript stays reachable.
    expect(current?.reviewers[0]?.providerSessionId).toBe("session-1");
    expect(current?.reviewers[1]).toMatchObject({ model: "sonnet", status: "running" });

    // The failed turn was aborted before the pass moved on; no healthy session
    // or the later consolidation session may be aborted.
    expect(provider.aborted).toEqual(["session-1"]);

    // The healthy reviewer still completes and the workflow consolidates.
    provider.statusValue = "idle";
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });

    const ready = await snapshot(started.id);
    expect(ready?.phase).toBe("ready");
    expect(ready?.reviewers.map((reviewer) => reviewer.status)).toEqual(["failed", "completed"]);
    expect(ready?.consolidatedReport).toBeDefined();
    expect(provider.aborted).toEqual(["session-1"]);
  });
});

test("MultiReviewService fails overall when no reviewer produces a valid report", async () => {
  const provider = new Provider();
  provider.statusOverrides.set("session-1", "error");
  provider.statusOverrides.set("session-2", "missing");
  await withService("env-all-reviewers-failed", provider, async ({ service, start, snapshot }) => {
    const started = await start([
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "sonnet" },
    ]);
    await service.advanceNow(started.id);

    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    // The distinct reviewer causes are carried up; a bare "no valid report"
    // would read as a model-quality problem rather than two dead sessions.
    expect(failed?.error).toBe(
      "No reviewer produced a valid report: The reviewer session failed;" +
        " The reviewer session no longer exists",
    );
    expect(failed?.reviewers).toMatchObject([
      { status: "failed", error: "The reviewer session failed" },
      { status: "failed", error: "The reviewer session no longer exists" },
    ]);
  });
});

test("MultiReviewService reports one shared cause once when every reviewer fails alike", async () => {
  const provider = new Provider();
  provider.statusValue = "error";
  await withService("env-shared-cause", provider, async ({ service, start, snapshot }) => {
    const started = await start([
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "sonnet" },
    ]);
    await service.advanceNow(started.id);

    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    expect(failed?.error).toBe("No reviewer produced a valid report: The reviewer session failed");
  });
});

test("MultiReviewService retries every failed reviewer, not only the first", async () => {
  const provider = new Provider();
  provider.statusOverrides.set("session-1", "error");
  provider.statusOverrides.set("session-2", "missing");
  await withService("env-retry-all-reviewers", provider, async ({ service, start, snapshot }) => {
    const started = await start([
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "sonnet" },
    ]);
    await service.advanceNow(started.id);

    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    expect(failed?.reviewers.map((reviewer) => reviewer.status)).toEqual(["failed", "failed"]);

    // Both abandoned sessions are aborted, and both reviewers return to pending.
    // Restoring only the first would consolidate from one reviewer silently.
    const retried = await service.retry(started.id);
    expect(provider.aborted).toEqual(["session-1", "session-2"]);
    expect(retried.phase).toBe("reviewing");
    expect(retried.error).toBeUndefined();
    for (const reviewer of retried.reviewers) {
      expect(reviewer.status).toBe("pending");
      expect(reviewer.error).toBeUndefined();
      expect(reviewer.providerSessionId).toBeUndefined();
      expect(reviewer.requestId).toBeUndefined();
    }

    // Both re-dispatched reviewers reach the consolidation input.
    provider.statusOverrides.clear();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });
    const ready = await snapshot(started.id);
    expect(ready?.reviewers.map((reviewer) => reviewer.status)).toEqual(["completed", "completed"]);
    const consolidation = [...provider.sends.values()].find((sent) =>
      sent.prompt.includes("<multi-review-reports-json>"),
    );
    for (const reviewer of ready?.reviewers ?? []) {
      expect(consolidation?.prompt).toContain(reviewer.id);
    }
  });
});

test("MultiReviewService restarts stopped and failed reviewers when no report survived", async () => {
  const provider = new Provider();
  provider.statusOverrides.set("session-1", "running");
  provider.statusOverrides.set("session-2", "error");
  await withService("env-retry-mixed-panel", provider, async ({ service, start, snapshot }) => {
    const started = await start([
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "sonnet" },
    ]);
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      const reviewers = (await snapshot(started.id))?.reviewers;
      return reviewers?.[0]?.status === "running" && reviewers[1]?.status === "failed";
    });

    await service.stopReviewer(started.id, started.reviewers[0]!.id);
    await waitUntil(async () => (await snapshot(started.id))?.phase === "failed");
    expect((await snapshot(started.id))?.reviewers.map((reviewer) => reviewer.status)).toEqual([
      "cancelled",
      "failed",
    ]);

    const retried = await service.retry(started.id);
    expect(retried.phase).toBe("reviewing");
    expect(retried.error).toBeUndefined();
    expect(retried.reviewers.map((reviewer) => reviewer.status)).toEqual(["pending", "pending"]);
    expect(retried.reviewers.every((reviewer) => reviewer.providerSessionId === undefined)).toBe(
      true,
    );
  });
});

test("MultiReviewService settles every running reviewer when the review stage fails", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  await withService(
    "env-review-stage-failure",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start([
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "sonnet" },
      ]);
      await service.advanceNow(started.id);
      const running = await snapshot(started.id);
      expect(running?.reviewers.map((reviewer) => reviewer.status)).toEqual(["running", "running"]);

      // Fail the reviewer pass itself: the per-reviewer handler cannot persist its
      // own local failure, so the error escapes to the workflow-level handler
      // while both reviewer sessions are still recorded as running.
      const originalSave = storage.saveMultiReviewWorkflow.bind(storage);
      let rejectNextSave = true;
      storage.saveMultiReviewWorkflow = (async (...args: Parameters<typeof originalSave>) => {
        if (rejectNextSave) {
          rejectNextSave = false;
          throw new Error("Durable write rejected");
        }
        return originalSave(...args);
      }) as typeof storage.saveMultiReviewWorkflow;
      provider.statusError = new Error("The reviewer session could not be polled");
      await service.advanceNow(started.id);
      storage.saveMultiReviewWorkflow = originalSave;

      const failed = await snapshot(started.id);
      expect(failed?.phase).toBe("failed");
      // No reviewer may stay `running` on a settled workflow: the environment
      // activity projection reads that status and would never retire.
      expect(failed?.reviewers.map((reviewer) => reviewer.status)).toEqual(["failed", "failed"]);
      expect(await storage.getEnvironment("env-review-stage-failure")).toMatchObject({
        agentActivitySources: { "multi-review": { state: "idle" } },
      });
    },
  );
});

test("MultiReviewService builds one provider for concurrent transcript reads", async () => {
  const provider = new Provider();
  let creations = 0;
  let releaseCreation = (): void => {};
  let creationGate: Promise<void> | null = null;
  await withService(
    "env-provider-dedup",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      // Reaching `ready` releases the supervisor's provider, so the next reader
      // takes the construction path rather than the cache.
      const reviewer = (await snapshot(started.id))!.reviewers[0]!;
      const creationsBeforeReads = creations;
      creationGate = new Promise<void>((resolve) => {
        releaseCreation = () => resolve();
      });

      const reads = [
        service.reviewerTranscript(started.id, reviewer.id),
        service.reviewerTranscript(started.id, reviewer.id),
      ];
      await waitUntil(() => creations > creationsBeforeReads);
      releaseCreation();
      creationGate = null;
      await Promise.all(reads);

      expect(creations).toBe(creationsBeforeReads + 1);
    },
    {
      createProvider: async () => {
        creations += 1;
        if (creationGate) await creationGate;
        return provider;
      },
    },
  );
});

test("MultiReviewService fails a reviewer whose provider session errors or disappears", async () => {
  for (const [environmentId, status, message] of [
    ["env-reviewer-error", "error", "The reviewer session failed"],
    ["env-reviewer-missing", "missing", "The reviewer session no longer exists"],
  ] as const) {
    const provider = new Provider();
    provider.statusOverrides.set("session-1", status);
    await withService(environmentId, provider, async ({ service, start, snapshot }) => {
      const started = await start();
      await service.advanceNow(started.id);

      const current = await snapshot(started.id);
      expect(current?.phase).toBe("failed");
      expect(current?.error).toBe(`No reviewer produced a valid report: ${message}`);
      expect(current?.reviewers[0]).toMatchObject({ status: "failed", error: message });
    });
  }
});

/*
 * The bridge reports a terminal turn as a throw when it can say why, and as a
 * bare `error` status only when it cannot — so branching on the status alone
 * took the graceful path exactly when the provider had declined to explain
 * itself. This reviewer must fail the same way as its bare-status sibling
 * above, and carry the explanation instead of discarding it.
 */
test("MultiReviewService fails a reviewer on a terminal turn error and reports its detail", async () => {
  const detail = "Selected model is at capacity. Please try a different model.";
  const provider = new Provider();
  provider.sessionFailures.set("session-1", detail);
  await withService("env-reviewer-terminal", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await service.advanceNow(started.id);

    const current = await snapshot(started.id);
    expect(current?.phase).toBe("failed");
    expect(current?.reviewers[0]).toMatchObject({
      status: "failed",
      error: `The reviewer session failed: ${detail}`,
    });
    expect(current?.error).toContain(detail);
  });
});

test("MultiReviewService bounds a blocked reviewer and clears the count once it progresses", async () => {
  const provider = new Provider();
  provider.statusValue = "blocked";
  await withService("env-blocked", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await service.advanceNow(started.id);

    // A provider with no interaction surface can never be unblocked from here,
    // but a single blocked poll must not fail the reviewer either.
    const blocked = await snapshot(started.id);
    expect(blocked?.phase).toBe("reviewing");
    expect(blocked?.reviewers[0]?.status).toBe("running");
    expect(blocked?.reviewers[0]?.idleResultPolls).toBeGreaterThanOrEqual(1);

    provider.statusValue = "running";
    await service.advanceNow(started.id);
    expect((await snapshot(started.id))?.reviewers[0]?.idleResultPolls).toBeUndefined();

    provider.statusValue = "blocked";
    for (let attempt = 0; attempt < 6; attempt++) await service.advanceNow(started.id);
    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    expect(failed?.reviewers[0]).toMatchObject({
      status: "failed",
      error: "The reviewer stayed blocked without a resolvable interaction",
    });
  });
});

test("MultiReviewService bounds a blocked fix model", async () => {
  const provider = new Provider();
  provider.statusOverrides.set("session-2", "blocked");
  await withService("env-blocked-fix", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    for (let attempt = 0; attempt < 8; attempt++) await service.advanceNow(started.id);

    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    expect(failed?.error).toBe("The fix model stayed blocked without a resolvable interaction");
  });
});

test("MultiReviewService retries a failed reviewer without stranding its provider session", async () => {
  const provider = new Provider(false);
  provider.idempotentSessionKeys = true;
  await withService("env-retry-reviewer", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    for (let attempt = 0; attempt < 7; attempt++) await service.advanceNow(started.id);
    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    expect(failed?.reviewers[0]).toMatchObject({
      status: "failed",
      providerSessionId: "session-1",
    });

    const retried = await service.retry(started.id);
    // The idle-result bound stops the parked session immediately; retry
    // repeats the best-effort abort before forgetting its durable id.
    expect(provider.aborted).toEqual(["session-1", "session-1"]);
    expect(retried.phase).toBe("reviewing");
    expect(retried.error).toBeUndefined();
    expect(retried.reviewers[0]?.status).toBe("pending");
    expect(retried.reviewers[0]?.providerSessionId).toBeUndefined();
    expect(retried.reviewers[0]?.requestId).toBeUndefined();
    expect(retried.reviewers[0]?.idleResultPolls).toBeUndefined();
    expect(retried.reviewers[0]?.error).toBeUndefined();

    // The retry runs against a brand new session rather than the abandoned one.
    await waitUntil(
      async () => (await snapshot(started.id))?.reviewers[0]?.providerSessionId === "session-2",
    );
  });
});

test("MultiReviewService does not abort an interactive fix session on cancel", async () => {
  const provider = new Provider();
  await withService("env-interactive-cancel", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });
    await service.address(started.id);
    const cancelled = await service.cancel(started.id);
    expect(cancelled.phase).toBe("interactive");
    expect(provider.aborted).toEqual([]);
    expect(cancelled.fixSession?.status).toBe("idle");
  });
});

test("MultiReviewService retries a failed consolidation with a fresh fix session", async () => {
  const provider = new Provider();
  provider.idempotentSessionKeys = true;
  provider.statusOverrides.set("session-2", "error");
  await withService("env-retry-consolidate", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    for (let attempt = 0; attempt < 4; attempt++) await service.advanceNow(started.id);

    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    expect(failed?.error).toBe("The consolidation session failed");
    expect(failed?.fixSession).toMatchObject({ providerSessionId: "session-2", status: "failed" });

    provider.statusOverrides.delete("session-2");
    const retried = await service.retry(started.id);
    expect(retried.phase).toBe("consolidating");
    expect(retried.fixSession).toBeUndefined();
    expect(retried.activeRequest).toBeUndefined();
    expect(provider.aborted).toEqual(["session-2"]);

    await waitUntil(async () => (await snapshot(started.id))?.phase === "ready");
    expect((await snapshot(started.id))?.fixSession?.providerSessionId).toBe("session-3");
  });
});

// Same terminal-turn contract as the reviewer path: the consolidation must fail
// on a thrown session error too, with the provider's explanation attached.
test("MultiReviewService fails a consolidation on a terminal turn error and reports its detail", async () => {
  const detail = "usage limit reached";
  const provider = new Provider();
  provider.sessionFailures.set("session-2", detail);
  await withService("env-consolidate-terminal", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    for (let attempt = 0; attempt < 4; attempt++) await service.advanceNow(started.id);

    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    expect(failed?.error).toBe(`The consolidation session failed: ${detail}`);
    expect(failed?.fixSession).toMatchObject({
      providerSessionId: "session-2",
      status: "failed",
    });
  });
});

test("MultiReviewService leaves a workflow that is not failed untouched on retry", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  await withService("env-retry-noop", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await service.advanceNow(started.id);

    const retried = await service.retry(started.id);
    expect(retried.phase).toBe("reviewing");
    expect(retried.reviewers[0]?.status).toBe("running");
    expect(retried.reviewers[0]?.providerSessionId).toBe("session-1");
    expect(provider.aborted).toEqual([]);
    expect((await snapshot(started.id))?.reviewers[0]?.providerSessionId).toBe("session-1");
  });
});

test("MultiReviewService closes every child session and pane tab before allowing a replacement", async () => {
  const provider = new Provider();
  await withService(
    "env-close-workflow",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start([
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "sonnet" },
      ]);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const ready = (await snapshot(started.id))!;
      const terminal = await service.address(ready.id);
      await storage.savePaneLayout(
        terminal.environmentId,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              {
                id: "multi-parent",
                type: "multi-review",
                multiReviewTabData: {
                  environmentId: terminal.environmentId,
                  workflowId: terminal.id,
                },
              },
              {
                id: "multi-reviewer",
                type: "multi-review",
                multiReviewTabData: {
                  environmentId: terminal.environmentId,
                  workflowId: terminal.id,
                  reviewerId: terminal.reviewers[0]!.id,
                },
              },
              { id: `multi-review-fix:${terminal.id}`, type: "agent-native" },
              { id: "unrelated", type: "file" },
            ],
            activeTabId: "multi-parent",
          },
        },
        0,
      );
      const disposalsBeforeClose = provider.disposeCalls;

      await service.close(terminal.id);

      expect(provider.closed.sort()).toEqual(["session-1", "session-2", "session-3"]);
      expect(provider.disposeCalls).toBe(disposalsBeforeClose + 1);
      expect(await storage.getMultiReviewWorkflow(terminal.id)).toBeNull();
      expect((await storage.getPaneLayout(terminal.environmentId))?.root).toMatchObject({
        tabs: [{ id: "unrelated", type: "file" }],
        activeTabId: "unrelated",
      });
      expect(await storage.getEnvironment(terminal.environmentId)).toMatchObject({
        agentActivitySources: { "multi-review": { state: "idle" } },
      });

      const replacement = await start();
      expect(replacement.id).not.toBe(terminal.id);
      expect(replacement.phase).toBe("reviewing");
    },
  );
});

test("MultiReviewService refuses to destroy a non-terminal workflow and releases its claim", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  await withService("env-close-active", provider, async ({ service, storage, start }) => {
    const started = await start();

    await expect(service.close(started.id)).rejects.toThrow("Cancel or finish");
    expect(await storage.getMultiReviewWorkflow(started.id)).not.toBeNull();
    expect((await storage.getMultiReviewWorkflow(started.id))?.controllerLease).toBeUndefined();
  });
});

test("MultiReviewService retains recovery state when provider construction fails", async () => {
  const provider = new Provider();
  let providerAvailable = false;
  await withService(
    "env-close-provider-create",
    provider,
    async ({ service, storage }) => {
      const workflowId = "terminal-provider-create";
      const timestamp = new Date(0).toISOString();
      const workflow: MultiReviewWorkflow = {
        version: MULTI_REVIEW_WORKFLOW_VERSION,
        controller: "backend",
        id: workflowId,
        environmentId: "env-close-provider-create",
        projectId: "project-1",
        targetBranch: "main",
        reviewers: [
          {
            id: "reviewer-1",
            agent: "claude",
            model: "opus",
            status: "cancelled",
            providerSessionId: "session-orphan",
          },
        ],
        fixModel: { agent: "claude", model: "opus" },
        phase: "cancelled",
        createdAt: timestamp,
        updatedAt: timestamp,
        backendRevision: 0,
      };
      await storage.createMultiReviewWorkflowIfNoActive(
        workflow.id,
        workflow.environmentId,
        workflow.version,
        workflow,
      );

      await expect(service.close(workflowId)).rejects.toThrow("bridge unavailable");
      expect(await storage.getMultiReviewWorkflow(workflowId)).not.toBeNull();
      expect((await storage.getMultiReviewWorkflow(workflowId))?.controllerLease).toBeUndefined();

      providerAvailable = true;
      await expect(service.close(workflowId)).resolves.toBeUndefined();
      expect(await storage.getMultiReviewWorkflow(workflowId)).toBeNull();
    },
    {
      createProvider: async () => {
        if (!providerAvailable) throw new Error("bridge unavailable");
        return provider;
      },
    },
  );
});

test("MultiReviewService retains workflow tabs when close and abort both fail", async () => {
  const provider = new Provider();
  await withService(
    "env-close-stop-failure",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const terminal = await service.address(started.id);
      await storage.savePaneLayout(
        terminal.environmentId,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              {
                id: "multi-parent",
                type: "multi-review",
                multiReviewTabData: {
                  environmentId: terminal.environmentId,
                  workflowId: terminal.id,
                },
              },
            ],
            activeTabId: "multi-parent",
          },
        },
        0,
      );
      provider.closeError = new Error("close failed");
      provider.abortError = new Error("abort failed");

      await expect(service.close(terminal.id)).rejects.toThrow("abort also failed");
      expect(await storage.getMultiReviewWorkflow(terminal.id)).not.toBeNull();
      expect((await storage.getPaneLayout(terminal.environmentId))?.root).toMatchObject({
        tabs: [{ id: "multi-parent" }],
        activeTabId: "multi-parent",
      });
      expect((await storage.getMultiReviewWorkflow(terminal.id))?.controllerLease).toBeUndefined();
    },
  );
});

test("MultiReviewService falls back to abort when session close fails", async () => {
  const provider = new Provider();
  await withService("env-close-abort-fallback", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });
    const terminal = await service.address(started.id);
    provider.closeError = new Error("close route unavailable");

    await expect(service.close(terminal.id)).resolves.toBeUndefined();
    expect(new Set(provider.aborted)).toEqual(new Set(["session-1", "session-2"]));
  });
});

test("MultiReviewService confirms abort-only providers have settled", async () => {
  const provider = new Provider();
  (provider as { closeSession?: BuildPipelineProvider["closeSession"] }).closeSession = undefined;
  await withService("env-close-abort-only", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });
    const terminal = await service.address(started.id);

    await expect(service.close(terminal.id)).resolves.toBeUndefined();
    expect(new Set(provider.aborted)).toEqual(new Set(["session-1", "session-2"]));
  });
});

test("MultiReviewService retains a workflow when an aborted session is still running", async () => {
  const provider = new Provider();
  await withService(
    "env-close-unconfirmed-abort",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const terminal = await service.address(started.id);
      provider.closeError = new Error("close route unavailable");
      provider.statusValue = "running";

      await expect(service.close(terminal.id)).rejects.toThrow("remained running after abort");
      expect(await storage.getMultiReviewWorkflow(terminal.id)).not.toBeNull();
      expect((await storage.getMultiReviewWorkflow(terminal.id))?.controllerLease).toBeUndefined();
    },
  );
});

test("MultiReviewService deletes durable state before attempting pane cleanup", async () => {
  const provider = new Provider();
  await withService(
    "env-close-delete-order",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const terminal = await service.address(started.id);
      let paneRemovalCalled = false;
      const originalDelete = storage.deleteMultiReviewWorkflow.bind(storage);
      const originalRemoveTabs = storage.removeMultiReviewTabs.bind(storage);
      storage.deleteMultiReviewWorkflow = async () => {
        throw new Error("sensitive store unavailable");
      };
      storage.removeMultiReviewTabs = async (...args) => {
        paneRemovalCalled = true;
        return originalRemoveTabs(...args);
      };
      try {
        await expect(service.close(terminal.id)).rejects.toThrow("sensitive store unavailable");
        expect(paneRemovalCalled).toBe(false);
        expect(await storage.getMultiReviewWorkflow(terminal.id)).not.toBeNull();
      } finally {
        storage.deleteMultiReviewWorkflow = originalDelete;
        storage.removeMultiReviewTabs = originalRemoveTabs;
      }
    },
  );
});

test("MultiReviewService reports success when pane cleanup fails after durable deletion", async () => {
  const provider = new Provider();
  await withService(
    "env-close-pane-cleanup",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const terminal = await service.address(started.id);
      const originalRemoveTabs = storage.removeMultiReviewTabs.bind(storage);
      storage.removeMultiReviewTabs = async () => {
        throw new Error("pane store unavailable");
      };
      try {
        await expect(service.close(terminal.id)).resolves.toBeUndefined();
        expect(await storage.getMultiReviewWorkflow(terminal.id)).toBeNull();
      } finally {
        storage.removeMultiReviewTabs = originalRemoveTabs;
      }
    },
  );
});

test("closing an older terminal workflow preserves a replacement workflow's activity", async () => {
  const provider = new Provider();
  await withService(
    "env-close-old-workflow",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const first = await start();
      await waitUntil(async () => {
        await service.advanceNow(first.id);
        return (await snapshot(first.id))?.phase === "ready";
      });
      const terminal = await service.address(first.id);
      provider.statusValue = "running";
      const replacement = await start();

      await service.close(terminal.id);

      expect(await storage.getMultiReviewWorkflow(replacement.id)).not.toBeNull();
      expect(await storage.getEnvironment(terminal.environmentId)).toMatchObject({
        agentActivitySources: { "multi-review": { state: "working" } },
      });
    },
  );
});

test("MultiReviewService attaches the agent before it dispatches a reviewer prompt", async () => {
  const provider = new Provider();
  await withService("env-attach", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });

    // The cold spawn is the slowest thing a dispatch can wait on, and time spent
    // on it inside the request is time the outcome is unknowable. Both supervised
    // sessions pay it before their at-most-once window opens.
    expect(provider.attached).toContain("session-1");
    expect(provider.attached).toContain("session-2");
  });
});

test("MultiReviewService keeps reviewing when a reviewer cannot be attached", async () => {
  const provider = new Provider();
  provider.prepareDispatch = async () => {
    throw new Error("bridge is warming up");
  };
  await withService("env-attach-failure", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });

    // Attach is best-effort: the prompt request performs the same work and is
    // the one that answers authoritatively.
    expect((await snapshot(started.id))?.reviewers[0]?.status).toBe("completed");
  });
});

test("MultiReviewService consolidates from the reviewers left after one is stopped", async () => {
  const provider = new Provider();
  provider.statusValue = "idle";
  // Reviewer 1 never leaves `running`, which is exactly the wedged-sub-agent
  // shape: the pass cannot consolidate while any reviewer is still running.
  provider.statusOverrides.set("session-1", "running");
  await withService("env-stop-reviewer", provider, async ({ service, start, snapshot }) => {
    const started = await start([
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "sonnet" },
    ]);
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.reviewers[1]?.status === "completed";
    });
    await service.advanceNow(started.id);
    const halted = (await snapshot(started.id))!;
    expect(halted.phase).toBe("reviewing");
    expect(halted.reviewers[0]?.status).toBe("running");

    const stopped = await service.stopReviewer(started.id, halted.reviewers[0]!.id);
    expect(stopped.reviewers[0]).toMatchObject({
      status: "cancelled",
      // The session id survives so the read-only transcript stays reachable.
      providerSessionId: "session-1",
    });
    expect(stopped.reviewers[0]?.error).toBeUndefined();
    expect(provider.aborted).toContain("session-1");

    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });
    const ready = (await snapshot(started.id))!;
    expect(ready.consolidatedReport).toBeDefined();
    // Only the reviewer that finished may reach the fix model.
    const consolidation = [...provider.sends.values()].find((sent) =>
      sent.prompt.includes("<multi-review-reports-json>"),
    )!;
    expect(consolidation.prompt).toContain(ready.reviewers[1]!.id);
    expect(consolidation.prompt).not.toContain(ready.reviewers[0]!.id);
  });
});

test("MultiReviewService restarts only the selected reviewer in a fresh session", async () => {
  const provider = new Provider();
  provider.idempotentSessionKeys = true;
  provider.statusValue = "running";
  await withService("env-restart-reviewer", provider, async ({ service, start, snapshot }) => {
    const started = await start([
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "sonnet" },
    ]);
    await service.advanceNow(started.id);
    const running = (await snapshot(started.id))!;
    const first = running.reviewers[0]!;
    const second = running.reviewers[1]!;
    const firstSessionKey = first.sessionKey!;

    const restarted = await service.restartReviewer(started.id, first.id);
    expect(provider.aborted).toContain(first.providerSessionId!);
    expect(restarted.reviewers[0]).toMatchObject({ id: first.id, status: "pending" });
    expect(restarted.reviewers[0]?.providerSessionId).toBeUndefined();
    expect(restarted.reviewers[0]?.sessionKey).not.toBe(firstSessionKey);
    expect(restarted.reviewers[0]?.startedAt).toBeUndefined();
    expect(restarted.reviewers[1]).toMatchObject({
      id: second.id,
      status: "running",
      providerSessionId: second.providerSessionId,
    });

    await waitUntil(async () => {
      await service.advanceNow(started.id);
      const reviewer = (await snapshot(started.id))?.reviewers[0];
      return (
        reviewer?.status === "running" && reviewer.providerSessionId !== first.providerSessionId
      );
    });
    const fresh = (await snapshot(started.id))!.reviewers[0]!;
    expect(fresh.providerSessionId).not.toBe(first.providerSessionId);
    expect(provider.createdSessionKeys).toContain(firstSessionKey);
    expect(provider.createdSessionKeys).toContain(fresh.sessionKey!);
    const latestPrompt = [...provider.sends.values()].at(-1)?.prompt;
    expect(latestPrompt).toContain("You are independent reviewer 1 of 2");
    expect(latestPrompt).not.toBe("Please continue");
  });
});

test("MultiReviewService rewinds consolidation when a completed reviewer is restarted", async () => {
  const provider = new Provider();
  provider.idempotentSessionKeys = true;
  await withService(
    "env-restart-ready-reviewer",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const ready = (await snapshot(started.id))!;
      const reviewerSessionId = ready.reviewers[0]!.providerSessionId!;
      const fixSessionId = ready.fixSession!.providerSessionId;
      const reviewerSessionKey = ready.reviewers[0]!.sessionKey!;
      const fixKey = ready.fixSession!.sessionKey;

      const restarted = await service.restartReviewer(started.id, ready.reviewers[0]!.id);
      expect(restarted.phase).toBe("reviewing");
      expect(restarted.reviewers[0]).toMatchObject({ status: "pending" });
      expect(restarted.reviewers[0]?.report).toBeUndefined();
      expect(restarted.consolidatedReport).toBeUndefined();
      expect(restarted.fixSession).toBeUndefined();
      expect(restarted.activeRequest).toBeUndefined();
      expect(restarted.reviewers[0]?.sessionKey).not.toBe(reviewerSessionKey);
      expect(restarted.fixSessionKey).not.toBe(fixKey);
      expect(provider.aborted).toEqual(expect.arrayContaining([reviewerSessionId, fixSessionId]));

      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const reconsolidated = (await snapshot(started.id))!;
      expect(reconsolidated.reviewers[0]?.providerSessionId).not.toBe(reviewerSessionId);
      expect(reconsolidated.fixSession?.providerSessionId).not.toBe(fixSessionId);
      expect(reconsolidated.fixSession?.sessionKey).toBe(restarted.fixSessionKey);
    },
  );
});

test("MultiReviewService preserves fix work when an incomplete fix result failed", async () => {
  const provider = new Provider();
  provider.fixComplete = false;
  await withService("env-restart-after-fix", provider, async ({ service, storage, snapshot }) => {
    const workflowId = await seedLegacyFixingWorkflow(storage, "env-restart-after-fix");
    await waitUntil(async () => {
      await service.advanceNow(workflowId);
      return (await snapshot(workflowId))?.phase === "failed";
    });
    const failed = (await snapshot(workflowId))!;
    const reviewerId = failed.reviewers[0]!.id;
    const before = {
      consolidatedReport: failed.consolidatedReport,
      fixSession: failed.fixSession,
      fixResult: failed.fixResult,
    };

    await expect(service.restartReviewer(workflowId, reviewerId)).rejects.toThrow(
      "after fix work begins",
    );
    expect(await snapshot(workflowId)).toMatchObject(before);
    expect(provider.aborted).toEqual([]);

    const claim = await storage.claimMultiReviewController(workflowId, "other-owner", 15_000);
    expect(claim.granted).toBe(true);
  });
});

test("MultiReviewService unsticks a reviewer in the same session with a continuation prompt", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  const abort = provider.abort.bind(provider);
  provider.abort = async (sessionId: string) => {
    await abort(sessionId);
    provider.statusOverrides.set(sessionId, "idle");
  };
  await withService("env-unstick-reviewer", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await service.advanceNow(started.id);
    const running = (await snapshot(started.id))!.reviewers[0]!;
    const oldRequestId = running.requestId!;

    const unstuck = await service.unstickReviewer(started.id, running.id);
    expect(provider.aborted).toEqual([running.providerSessionId!]);
    expect(unstuck.reviewers[0]).toMatchObject({
      status: "running",
      providerSessionId: running.providerSessionId,
      dispatchState: "prepared",
      continuationPrompt: "Please continue",
    });
    expect(unstuck.reviewers[0]?.requestId).not.toBe(oldRequestId);

    await waitUntil(() =>
      [...provider.sends.values()].some((entry) => entry.prompt === "Please continue"),
    );
    const continued = [...provider.sends.entries()].find(
      ([, entry]) => entry.prompt === "Please continue",
    );
    expect(continued?.[1].options.schema).toBe(STRUCTURED_REVIEW_REPORT_JSON_SCHEMA);
    expect((await snapshot(started.id))?.reviewers[0]?.providerSessionId).toBe(
      running.providerSessionId,
    );
  });
});

test("MultiReviewService refuses to unstick a missing or failed provider session", async () => {
  for (const providerStatus of ["missing", "error"] as const) {
    const provider = new Provider();
    provider.statusValue = "running";
    await withService(
      `env-unstick-${providerStatus}`,
      provider,
      async ({ service, start, snapshot }) => {
        const started = await start();
        await service.advanceNow(started.id);
        const running = (await snapshot(started.id))!.reviewers[0]!;
        const requestId = running.requestId;
        provider.abort = async (sessionId: string) => {
          provider.aborted.push(sessionId);
          if (providerStatus === "missing") {
            provider.statusOverrides.set(sessionId, "missing");
          } else {
            provider.sessionFailures.set(sessionId, "the provider turn failed");
          }
        };

        await expect(service.unstickReviewer(started.id, running.id)).rejects.toThrow(
          "restart this reviewer instead",
        );
        expect((await snapshot(started.id))?.reviewers[0]).toMatchObject({
          requestId,
          dispatchState: "sent",
        });
        expect((await snapshot(started.id))?.reviewers[0]?.continuationPrompt).toBeUndefined();
      },
    );
  }
});

test("MultiReviewService releases a settled workflow claim after Unstick is rejected", async () => {
  const provider = new Provider();
  await withService(
    "env-unstick-settled",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const reviewer = (await snapshot(started.id))!.reviewers[0]!;

      await expect(service.unstickReviewer(started.id, reviewer.id)).rejects.toThrow(
        "only be unstuck while review is running",
      );
      const claim = await storage.claimMultiReviewController(started.id, "other-owner", 15_000);
      expect(claim.granted).toBe(true);
    },
  );
});

test("MultiReviewService releases a settled workflow claim when restart saving fails", async () => {
  const provider = new Provider();
  await withService(
    "env-restart-save-failure",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const reviewer = (await snapshot(started.id))!.reviewers[0]!;
      const originalSave = storage.saveMultiReviewWorkflow.bind(storage);
      storage.saveMultiReviewWorkflow = (async () => {
        throw new Error("Durable write rejected");
      }) as typeof storage.saveMultiReviewWorkflow;
      try {
        await expect(service.restartReviewer(started.id, reviewer.id)).rejects.toThrow(
          "Durable write rejected",
        );
      } finally {
        storage.saveMultiReviewWorkflow = originalSave;
      }

      const claim = await storage.claimMultiReviewController(started.id, "other-owner", 15_000);
      expect(claim.granted).toBe(true);
    },
  );
});

test("MultiReviewService leaves a settled reviewer alone and releases its stop claim", async () => {
  const provider = new Provider();
  await withService("env-stop-settled", provider, async ({ service, storage, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });
    const completed = (await snapshot(started.id))!.reviewers[0]!;

    // A double click, or a reviewer that settled between the render and the
    // command, must not rewrite a finished result or abort a reused session.
    const stopped = await service.stopReviewer(started.id, completed.id);
    expect(stopped.reviewers[0]).toMatchObject({
      status: "completed",
      completedAt: completed.completedAt,
    });
    expect(stopped.reviewers[0]?.report).toBeDefined();
    expect(provider.aborted).toEqual([]);

    const afterNoop = await storage.claimMultiReviewController(started.id, "other-owner", 15_000);
    expect(afterNoop.granted).toBe(true);
    await storage.releaseMultiReviewController(started.id, "other-owner", afterNoop.token);

    await expect(service.stopReviewer(started.id, "not-a-reviewer")).rejects.toThrow(
      "Multi review reviewer not found",
    );
    const afterError = await storage.claimMultiReviewController(
      started.id,
      "other-owner-2",
      15_000,
    );
    expect(afterError.granted).toBe(true);
  });
});

test("MultiReviewService keeps its claim when a stale stop targets a settled reviewer", async () => {
  const provider = new Provider();
  provider.statusValue = "idle";
  // Reviewer 1 stays running, so the workflow is still supervised while the
  // command lands: exactly the shape of a click on a Stop button rendered from
  // a snapshot taken before reviewer 2 finished.
  provider.statusOverrides.set("session-1", "running");
  await withService(
    "env-stop-stale",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start([
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "sonnet" },
      ]);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.reviewers[1]?.status === "completed";
      });
      const running = (await snapshot(started.id))!;
      expect(running.phase).toBe("reviewing");
      const disposalsBefore = provider.disposeCalls;

      const noop = await service.stopReviewer(started.id, running.reviewers[1]!.id);
      expect(noop.reviewers[1]?.status).toBe("completed");

      // Releasing here would drop the lease, forget every live progress clock and
      // dispose the provider that reviewer 1 is still running on.
      const claim = await storage.claimMultiReviewController(started.id, "other-owner", 15_000);
      expect(claim.granted).toBe(false);
      expect(provider.disposeCalls).toBe(disposalsBefore);
      expect((await snapshot(started.id))?.reviewers[0]?.status).toBe("running");

      // The same holds for a reviewer id that no longer resolves.
      await expect(service.stopReviewer(started.id, "not-a-reviewer")).rejects.toThrow(
        "Multi review reviewer not found",
      );
      const afterError = await storage.claimMultiReviewController(
        started.id,
        "other-owner-2",
        15_000,
      );
      expect(afterError.granted).toBe(false);
      expect(provider.disposeCalls).toBe(disposalsBefore);
    },
    { serviceOptions: { progressProbeIntervalMs: 0 } },
  );
});

test("MultiReviewService reports a fully stopped panel as stopped, not as a bad report", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  await withService("env-stop-all", provider, async ({ service, start, snapshot }) => {
    const started = await start([
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "sonnet" },
    ]);
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (
        (await snapshot(started.id))?.reviewers.every(
          (reviewer) => reviewer.status === "running",
        ) === true
      );
    });
    const running = (await snapshot(started.id))!;
    for (const reviewer of running.reviewers) {
      await service.stopReviewer(started.id, reviewer.id);
    }

    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "failed";
    });
    const failed = (await snapshot(started.id))!;
    // A stopped reviewer carries no error, so without the stopped count this
    // would read as "the models failed to produce a report".
    expect(failed.error).toContain("2 reviewers were stopped");

    // Retrying a panel that was stopped in full means running it again: the
    // consolidation branch would otherwise merge an empty set of reports.
    const retried = await service.retry(started.id);
    expect(retried.phase).toBe("reviewing");
    expect(retried.reviewers.map((reviewer) => reviewer.status)).toEqual(["pending", "pending"]);
    expect(retried.consolidatedReport).toBeUndefined();
  });
});

test("MultiReviewService abandons a reviewer whose transcript stopped moving", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  provider.messagesValue = [{ id: "assistant-1", role: "assistant", content: "Reading" }];
  await withService(
    "env-stall-abandon",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start([
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "sonnet" },
      ]);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        const reviewers = (await snapshot(started.id))?.reviewers ?? [];
        return reviewers.length > 0 && reviewers.every((reviewer) => reviewer.status === "failed");
      });

      const failed = (await snapshot(started.id))!;
      expect(failed.reviewers[0]?.error).toContain("produced no activity");
      // The session is aborted on the way out: a turn nothing can reach again must
      // not keep running through consolidation and the fix stage.
      expect(provider.aborted).toContain("session-1");
      expect(provider.aborted).toContain("session-2");
      expect(failed.phase).toBe("failed");
    },
    { serviceOptions: { progressProbeIntervalMs: 0, stallAbandonMs: 0 } },
  );
});

test("MultiReviewService gives a fresh reviewer baseline a grace clock", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  provider.messagesValue = [{ id: "assistant-1", role: "assistant", content: "Fresh progress" }];
  await withService(
    "env-stall-baseline",
    provider,
    async ({ start, snapshot }) => {
      const started = await start();
      await waitUntil(
        async () => (await snapshot(started.id))?.reviewers[0]?.progressAt !== undefined,
      );

      const running = (await snapshot(started.id))!;
      expect(running.reviewers[0]?.status).toBe("running");
      expect(running.reviewers[0]?.progressDigest).toHaveLength(64);
      expect(provider.aborted).toEqual([]);
      expect(provider.messageOptions).toContainEqual({ limit: 1 });
    },
    { serviceOptions: { progressProbeIntervalMs: 0, stallAbandonMs: 0 } },
  );
});

test("MultiReviewService warns about a stalled reviewer and retires the warning on progress", async () => {
  const provider = new Provider(false);
  provider.statusValue = "running";
  provider.messagesValue = [{ id: "assistant-1", role: "assistant", content: "Reading" }];
  await withService(
    "env-stall-warning",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.reviewers[0]?.stalledSince !== undefined;
      });
      expect((await snapshot(started.id))?.reviewers[0]?.status).toBe("running");

      // Bridges stream sub-agent activity into the parent transcript, so a long
      // turn that is genuinely working keeps moving and must lose the warning.
      provider.messagesValue = [
        ...provider.messagesValue,
        { id: "assistant-2", role: "assistant", content: "Read src/a.ts" },
      ];
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.reviewers[0]?.stalledSince === undefined;
      });
      expect((await snapshot(started.id))?.reviewers[0]?.progressAt).toBeDefined();
    },
    {
      serviceOptions: {
        progressProbeIntervalMs: 0,
        stallWarningMs: 0,
        stallAbandonMs: 60 * 60_000,
      },
    },
  );
});

test("MultiReviewService keeps a durable stall warning across a restart baseline", async () => {
  const provider = new Provider(false);
  provider.statusValue = "running";
  provider.messagesValue = [{ id: "assistant-1", role: "assistant", content: "Reading" }];
  await withService(
    "env-stall-restart",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.reviewers[0]?.stalledSince !== undefined;
      });
      const warned = (await snapshot(started.id))!.reviewers[0]!;

      // A restart loses the in-memory fingerprints but not the durable clock, so
      // the next probe reports a fresh baseline for a session that never moved.
      await service.shutdown();
      const restarted = new MultiReviewService(
        storage,
        async () => {
          throw new Error("unexpected command");
        },
        {
          autoAdvance: false,
          provider: async () => provider,
          progressProbeIntervalMs: 0,
          stallWarningMs: 0,
          stallAbandonMs: 60 * 60_000,
        },
      );
      try {
        await restarted.advanceNow(started.id);
      } finally {
        await restarted.shutdown();
      }

      // Restarting is not evidence of progress: only an observed transcript
      // change may retire the notice the user is looking at.
      const after = (await snapshot(started.id))!.reviewers[0]!;
      expect(after.status).toBe("running");
      expect(after.stalledSince).toBe(warned.stalledSince!);
    },
    {
      serviceOptions: {
        progressProbeIntervalMs: 0,
        stallWarningMs: 0,
        stallAbandonMs: 60 * 60_000,
      },
    },
  );
});

test("MultiReviewService fails a consolidation session whose transcript stopped moving", async () => {
  const provider = new Provider();
  provider.messagesValue = [{ id: "assistant-1", role: "assistant", content: "Merging" }];
  // The reviewer (session-1) settles normally; only the consolidation session
  // wedges. Session ids are allocated in order, so this arms the second one
  // before the pass can create it.
  provider.statusOverrides.set("session-2", "running");
  await withService(
    "env-stall-consolidation",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "failed";
      });
      const failed = (await snapshot(started.id))!;
      expect(failed.error).toContain("consolidation session produced no activity");
      expect(failed.fixSession?.status).toBe("failed");
      expect(provider.aborted).toContain("session-2");
    },
    { serviceOptions: { progressProbeIntervalMs: 0, stallAbandonMs: 0 } },
  );
});

test("MultiReviewService gives a fresh consolidation baseline a grace clock", async () => {
  const provider = new Provider();
  provider.messagesValue = [{ id: "assistant-1", role: "assistant", content: "Fresh merge" }];
  provider.statusOverrides.set("session-2", "running");
  await withService(
    "env-stall-consolidation-baseline",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.fixSession?.progressAt !== undefined;
      });

      const consolidating = (await snapshot(started.id))!;
      expect(consolidating.phase).toBe("consolidating");
      expect(consolidating.fixSession?.status).toBe("running");
      expect(provider.aborted).not.toContain("session-2");
      expect(provider.messageOptions).toContainEqual({ limit: 1 });
    },
    { serviceOptions: { progressProbeIntervalMs: 0, stallAbandonMs: 0 } },
  );
});

test("MultiReviewService still abandons a reviewer when transcript reads fail", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  provider.messages = async () => {
    throw new Error("transcript is oversized");
  };
  await withService(
    "env-stall-read-failure",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.reviewers[0]?.status === "failed";
      });

      // A wedged session whose /messages route is failing is still wedged: the
      // durable clock keeps ticking even though the fingerprint cannot be read.
      expect((await snapshot(started.id))?.reviewers[0]?.error).toContain("produced no activity");
      expect(provider.aborted).toContain("session-1");
    },
    { serviceOptions: { progressProbeIntervalMs: 0, stallAbandonMs: 0 } },
  );
});

test("MultiReviewService still fails a consolidation session when transcript reads fail", async () => {
  const provider = new Provider();
  provider.statusOverrides.set("session-2", "running");
  const originalMessages = provider.messages.bind(provider);
  provider.messages = async (sessionId, options) => {
    if (sessionId === "session-2") throw new Error("transcript is oversized");
    return originalMessages(sessionId, options);
  };
  await withService(
    "env-stall-consolidation-read-failure",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "failed";
      });
      expect((await snapshot(started.id))?.error).toContain(
        "consolidation session produced no activity",
      );
      expect(provider.aborted).toContain("session-2");
    },
    { serviceOptions: { progressProbeIntervalMs: 0, stallAbandonMs: 0 } },
  );
});

test("MultiReviewService abandons a backdated reviewer after restart instead of granting grace", async () => {
  const provider = new Provider(false);
  provider.statusValue = "running";
  provider.messagesValue = [{ id: "assistant-1", role: "assistant", content: "Reading" }];
  await withService(
    "env-stall-restart-abandon",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(
        async () => (await snapshot(started.id))?.reviewers[0]?.progressDigest !== undefined,
      );
      const digest = (await snapshot(started.id))!.reviewers[0]!.progressDigest!;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      await service.shutdown();
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        workflow.reviewers[0]!.startedAt = twoHoursAgo;
        workflow.reviewers[0]!.progressAt = twoHoursAgo;
      });

      const restarted = new MultiReviewService(
        storage,
        async () => {
          throw new Error("unexpected command");
        },
        {
          autoAdvance: false,
          provider: async () => provider,
          progressProbeIntervalMs: 0,
          stallAbandonMs: 30 * 60_000,
        },
      );
      try {
        await waitUntil(async () => {
          await restarted.advanceNow(started.id);
          return (await snapshot(started.id))?.reviewers[0]?.status === "failed";
        });
      } finally {
        await restarted.shutdown();
      }

      // Ten minutes of restart grace would leave elapsed under 30 minutes and
      // keep the reviewer running. The persisted digest must compare instead.
      const failed = (await snapshot(started.id))!.reviewers[0]!;
      expect(failed.error).toContain("produced no activity");
      expect(failed.progressAt).toBe(twoHoursAgo);
      expect(failed.progressDigest).toBe(digest);
    },
    { serviceOptions: { progressProbeIntervalMs: 0, stallAbandonMs: 60 * 60_000 } },
  );
});

test("MultiReviewService does not move a durable stall clock forward across restarts", async () => {
  const provider = new Provider(false);
  provider.statusValue = "running";
  provider.messagesValue = [{ id: "assistant-1", role: "assistant", content: "Reading" }];
  await withService(
    "env-stall-restart-clock",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(
        async () => (await snapshot(started.id))?.reviewers[0]?.progressDigest !== undefined,
      );
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      await service.shutdown();
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        workflow.reviewers[0]!.startedAt = twoHoursAgo;
        workflow.reviewers[0]!.progressAt = twoHoursAgo;
      });

      const restart = async () => {
        const next = new MultiReviewService(
          storage,
          async () => {
            throw new Error("unexpected command");
          },
          {
            autoAdvance: false,
            provider: async () => provider,
            progressProbeIntervalMs: 0,
            stallWarningMs: 0,
            stallAbandonMs: 24 * 60 * 60_000,
          },
        );
        try {
          await next.advanceNow(started.id);
        } finally {
          await next.shutdown();
        }
      };

      await restart();
      await restart();

      // Each restart used to slide progressAt to now-minus-one-warning-interval,
      // which postponed abandon indefinitely. The durable clock must stay put.
      expect((await snapshot(started.id))?.reviewers[0]?.progressAt).toBe(twoHoursAgo);
      expect((await snapshot(started.id))?.reviewers[0]?.status).toBe("running");
    },
    { serviceOptions: { progressProbeIntervalMs: 0, stallAbandonMs: 60 * 60_000 } },
  );
});
