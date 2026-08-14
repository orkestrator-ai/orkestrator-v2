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
import type {
  MultiReviewModelSelection,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type {
  BuildPipelineProvider,
  ProviderCreateSessionOptions,
  ProviderSendOptions,
  ProviderStatus,
} from "./build-pipeline-provider.js";
import { AmbiguousPromptDispatchError } from "./build-pipeline-provider.js";
import { REVIEW_FIX_RESULT_JSON_SCHEMA } from "./looped-review-prompts.js";
import { StorageService } from "./storage.js";
import { MultiReviewService } from "./multi-review-service.js";

const cleanReport: StructuredReviewReport = {
  reviewScope: { targetBranch: "main", baseRef: "origin/main...HEAD", commit: null,
    filesReviewed: ["src/a.ts"], filesSkipped: [], filesLeftUncommitted: [], commandsRun: [],
    commandsNotRun: [], limitations: [] },
  whatChanged: { overview: "Change", before: "Before", after: "After", keyCodeChanges: [], userImpact: "Impact" },
  riskProfile: { changeTypes: ["feature"], riskAreas: [], overallRisk: "medium", reasoning: "Changed" },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [], issues: [], testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Ready" },
  summaryOfChange: "Change", reviewSummary: "Clean",
};

const consolidatedReport: StructuredReviewReport = {
  ...cleanReport,
  issues: [{ severity: "P1", confidence: 92, category: "correctness", title: "Broken branch",
    file: "src/a.ts", line: 10, symbol: "run", description: "Wrong branch", evidence: "Returns false",
    suggestion: "Correct it", verification: "Add a regression test" }],
  testCoverageGaps: [{ file: "src/a.test.ts", untestedBehavior: "Failure branch" }],
  verdict: { ready: "with-fixes", reasoning: "One fix remains" },
  reviewSummary: "One consolidated issue and one coverage gap.",
};

class Provider implements BuildPipelineProvider {
  readonly agent = "claude" as const;
  readonly sends = new Map<string, { prompt: string; options: ProviderSendOptions }>();
  readonly aborted: string[] = [];
  /** Per-session status, overriding `statusValue`; keeps tests pass-count independent. */
  readonly statusOverrides = new Map<string, ProviderStatus>();
  sessions = 0;
  statusValue: ProviderStatus = "idle";
  statusCalls = 0;
  abortError: Error | null = null;
  /** Thrown by the next `status` call, then cleared. */
  statusError: Error | null = null;
  ambiguousFixOnce = false;
  fixSends = 0;
  fixComplete = true;
  invalidReviewerReports = 0;
  invalidConsolidatedReports = 0;
  schemaFailureReports = 0;
  invalidFixResults = 0;
  fixStructuredFailure: StructuredOutputFailureCode | null = null;
  messagesValue: unknown[] = [];
  messagesCalls = 0;
  disposeCalls = 0;
  /** Throws from `createSession` once this many sessions already exist. */
  failCreateSessionAfter: number | null = null;
  private statusGate: Promise<void> | null = null;
  private releaseStatusGate: (() => void) | null = null;
  private messagesGate: Promise<void> | null = null;
  private releaseMessagesGate: (() => void) | null = null;
  constructor(private readonly returnStructured = true) {}
  async createSession(_phase: "build" | "review" | "verify" | "fix" | "pr" | "resolve-conflicts", _label: string, _options?: ProviderCreateSessionOptions) {
    if (this.failCreateSessionAfter !== null && this.sessions >= this.failCreateSessionAfter) {
      throw new Error("claude bridge authentication is unavailable");
    }
    this.sessions += 1;
    return `session-${this.sessions}`;
  }
  async send(_sessionId: string, prompt: string, options: ProviderSendOptions) {
    this.sends.set(options.requestId, { prompt, options });
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
    return this.statusOverrides.get(sessionId) ?? this.statusValue;
  }
  async messages(): Promise<unknown[]> {
    this.messagesCalls += 1;
    if (this.messagesGate) await this.messagesGate;
    return this.messagesValue;
  }
  async structured<T>(sessionId: string, requestId: string): Promise<StructuredOutputResult<T> | null> {
    if (!this.returnStructured) return null;
    const sent = this.sends.get(requestId)!;
    const isConsolidation = sent.prompt.includes("<multi-review-reports-json>");
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
        return { ok: true, provider: "claude", requestId, value: {
          complete: true,
          summary: "Addressed every finding",
          filesChanged: ["src/a.ts"],
          commandsRun: [],
          notes: [],
          limitations: ["A blocker remains"],
        } as T };
      }
      return { ok: true, provider: "claude", requestId, value: {
        complete: this.fixComplete,
        summary: this.fixComplete
          ? "Addressed every finding"
          : "Two findings remain unresolved",
        filesChanged: ["src/a.ts", "src/a.test.ts"],
        commandsRun: [],
        notes: [],
        limitations: this.fixComplete ? [] : ["Two findings need product input"],
      } as T };
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
        return { ok: true, provider: "claude", requestId,
          value: { ...consolidatedReport, ready: true } as T };
      }
      if (sessionId === "session-1" && this.invalidReviewerReports > 0) {
        this.invalidReviewerReports -= 1;
        return { ok: true, provider: "claude", requestId,
          value: { ...cleanReport, ready: true } as T };
      }
    }
    const value = sent.prompt.includes("<multi-review-reports-json>")
      ? consolidatedReport
      : sent.prompt.includes("<structured-review-findings-json>")
        ? { complete: this.fixComplete,
            summary: this.fixComplete ? "Addressed every finding" : "Two findings remain unresolved",
            filesChanged: ["src/a.ts", "src/a.test.ts"],
            commandsRun: [], notes: [],
            // An incomplete result is only valid alongside a failed validation
            // or an explicit limitation.
            limitations: this.fixComplete ? [] : ["Two findings need product input"] }
        : cleanReport;
    return { ok: true, provider: "claude", requestId, value: value as T };
  }
  async abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId);
    if (this.abortError) throw this.abortError;
  }
  async dispose(): Promise<void> { this.disposeCalls += 1; }

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
  provider.messagesValue = [{
    id: "assistant-1",
    role: "assistant",
    content: "Inspecting the changed files",
    parts: [{ type: "tool-invocation", toolName: "Read", content: "Read" }],
  }];

  await withService("env-transcript", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () => Boolean(
      (await snapshot(started.id))?.reviewers[0]?.providerSessionId,
    ));
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

test("MultiReviewService keeps a provider alive while a transcript read overlaps fix execution", async () => {
  const provider = new Provider();
  await withService("env-transcript-provider-race", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });
    const ready = (await snapshot(started.id))!;
    const reviewer = ready.reviewers[0]!;
    const disposalsAfterReady = provider.disposeCalls;

    const releaseMessages = provider.blockMessages();
    const transcript = service.reviewerTranscript(started.id, reviewer.id);
    await waitUntil(() => provider.messagesCalls > 0);

    const statusCallsBeforeFix = provider.statusCalls;
    const releaseStatus = provider.blockStatus();
    await service.address(started.id);
    await waitUntil(() => provider.statusCalls > statusCallsBeforeFix);

    releaseMessages();
    await transcript;
    expect(provider.disposeCalls).toBe(disposalsAfterReady);

    releaseStatus();
    await waitUntil(async () => (await snapshot(started.id))?.phase === "completed");
    expect(provider.disposeCalls).toBe(disposalsAfterReady + 1);
  });
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
  options: { createProvider?: () => Promise<BuildPipelineProvider> } = {},
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), `ork-multi-review-${environmentId}-`));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: environmentId, projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const service = new MultiReviewService(storage, async () => { throw new Error("unexpected command"); }, {
    autoAdvance: false,
    provider: options.createProvider ?? (async () => provider),
  });
  try {
    await run({
      service,
      storage,
      start: (reviewers = [{ agent: "claude", model: "opus" }]) => service.start({
        environmentId, projectId: "project-1", targetBranch: "main",
        reviewers, fixModel: { agent: "claude", model: "opus" },
      }),
      snapshot: async (workflowId) =>
        (await storage.getMultiReviewWorkflow(workflowId))?.snapshot as MultiReviewWorkflow | undefined,
    });
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Multi Review state");
    await Bun.sleep(10);
  }
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
      sent.prompt.includes("repair attempt 1 of 3"));
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
      sent.prompt.includes("repair attempt 1 of 3"));
    expect(repair?.prompt).toContain("$.ready");
    expect(repair?.prompt).toContain("<structured-review-expected-schema-json>");
  });
});

test("MultiReviewService repairs provider-level schema failures with their details", async () => {
  const provider = new Provider();
  provider.schemaFailureReports = 1;
  await withService("env-provider-schema-repair", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });

    const repair = [...provider.sends.values()].find((sent) =>
      sent.prompt.includes("repair attempt 1 of 3"));
    expect(repair?.prompt).toContain("$.verdict.ready");
    expect(repair?.prompt).toContain("Output did not satisfy the provider schema.");
    expect(repair?.prompt).toContain("Expected an enum value.");
    expect(repair?.prompt).toContain("<structured-review-expected-schema-json>");
  });
});

test("MultiReviewService asks the fix model to correct an invalid fix result", async () => {
  const provider = new Provider();
  await withService("env-fix-result-repair", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });

    provider.invalidFixResults = 1;
    await service.address(started.id);
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "completed";
    });

    const completed = await snapshot(started.id);
    expect(completed?.fixResult).toMatchObject({ complete: true });
    expect(completed?.fixSession?.requestIds).toHaveLength(3);
    const repair = [...provider.sends.values()].find((sent) =>
      sent.options.schema === REVIEW_FIX_RESULT_JSON_SCHEMA
      && sent.prompt.includes("repair attempt 1 of 3"));
    expect(repair?.prompt).toContain("fix result");
    expect(repair?.prompt).toContain("Fix result cannot be complete");
    expect(repair?.prompt).toContain('"complete"');
    expect(repair?.prompt).toContain("<structured-review-expected-schema-json>");
  });
});

test("MultiReviewService does not treat provider fix failures as schema repair work", async () => {
  for (const code of ["provider_error", "interrupted"] as const) {
    const provider = new Provider();
    await withService(`env-fix-${code}`, provider, async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      provider.fixStructuredFailure = code;
      await service.address(started.id);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "failed";
      });

      const failed = await snapshot(started.id);
      expect(failed?.error).toBe(`Fix result failed with ${code}`);
      expect(failed?.activeRequest?.schemaRepairAttempts).toBeUndefined();
      expect(failed?.activeRequest?.schemaRepairPrompt).toBeUndefined();
      expect(failed?.fixSession?.requestIds).toHaveLength(2);
    });
  }
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
    expect([...provider.sends.values()].filter((sent) =>
      sent.prompt.includes("<structured-review-contract-errors-json>"))).toHaveLength(3);
  });
});

test("MultiReviewService clears stale review activity when it rehydrates", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-activity-rehydrate-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-rehydrate", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  await storage.setEnvironmentAgentActivity(
    "env-rehydrate",
    "working",
    new Date().toISOString(),
    "multi-review",
  );
  const service = new MultiReviewService(
    storage,
    async () => { throw new Error("unexpected command"); },
    { autoAdvance: false },
  );
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
    id: "env-active", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const provider = new Provider();
  provider.statusValue = "running";
  const first = new MultiReviewService(
    storage,
    async () => { throw new Error("unexpected command"); },
    { autoAdvance: false, provider: async () => provider },
  );
  const started = await first.start({
    environmentId: "env-active", projectId: "project-1", targetBranch: "main",
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
  const restored = new MultiReviewService(
    storage,
    async () => { throw new Error("unexpected command"); },
    { autoAdvance: false, provider: async () => provider },
  );
  try {
    await restored.init();
    expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot)
      .toMatchObject({ phase: "reviewing" });
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

test("MultiReviewService owns fan-out, consolidation, and the explicit fix turn", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const provider = new Provider();
  const service = new MultiReviewService(storage, async () => { throw new Error("unexpected command"); }, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const started = await service.start({
    environmentId: "env-1", projectId: "project-1", targetBranch: "main",
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
    consolidatedReport: { issues: [{ title: "Broken branch" }], testCoverageGaps: [{ file: "src/a.test.ts" }] },
  });
  expect(provider.sessions).toBe(3);

  await service.address(started.id);
  for (let attempt = 0; attempt < 4; attempt++) await service.advanceNow(started.id);
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "completed",
    fixResult: { complete: true, summary: "Addressed every finding" },
  });
  await service.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("MultiReviewService fails an idle reviewer that never returns structured output", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-idle-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-idle", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const provider = new Provider(false);
  const service = new MultiReviewService(storage, async () => { throw new Error("unexpected command"); }, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const started = await service.start({
    environmentId: "env-idle", projectId: "project-1", targetBranch: "main",
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

test("MultiReviewService reconciles an ambiguously accepted fix without sending it twice", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-ambiguous-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-ambiguous", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const provider = new Provider();
  const service = new MultiReviewService(storage, async () => { throw new Error("unexpected command"); }, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const started = await service.start({
    environmentId: "env-ambiguous", projectId: "project-1", targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await service.advanceNow(started.id);
    const current = await storage.getMultiReviewWorkflow(started.id);
    if ((current?.snapshot as { phase?: string })?.phase === "ready") break;
  }
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot)
    .toMatchObject({ phase: "ready" });

  provider.ambiguousFixOnce = true;
  await service.address(started.id);
  await service.advanceNow(started.id);
  await waitUntil(async () => ((await storage.getMultiReviewWorkflow(started.id))?.snapshot as { phase?: string })?.phase === "completed");

  expect(provider.fixSends).toBe(1);
  await service.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("MultiReviewService persists cancellation until an aborting fix provider actually stops", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-cancel-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-cancel", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const provider = new Provider();
  const service = new MultiReviewService(storage, async () => { throw new Error("unexpected command"); }, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const started = await service.start({
    environmentId: "env-cancel", projectId: "project-1", targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  for (let attempt = 0; attempt < 4; attempt += 1) await service.advanceNow(started.id);
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot)
    .toMatchObject({ phase: "ready" });

  const statusCallsBeforeFix = provider.statusCalls;
  provider.statusValue = "running";
  provider.abortError = new Error("abort unavailable");
  await service.address(started.id);
  await waitUntil(() => provider.statusCalls > statusCallsBeforeFix);

  expect((await service.cancel(started.id)).phase).toBe("cancelling");
  await service.advanceNow(started.id);
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "cancelling",
    error: expect.stringContaining("abort unavailable"),
  });

  provider.statusValue = "idle";
  await service.advanceNow(started.id);
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "cancelled",
    reviewers: [{ status: "completed" }],
    fixSession: { status: "cancelled" },
  });
  const replacement = await service.start({
    environmentId: "env-cancel", projectId: "project-1", targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  expect(replacement.id).not.toBe(started.id);
  await service.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("MultiReviewService coalesces repeated advances while a provider call is blocked", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-coalesce-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-coalesce", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const provider = new Provider();
  provider.statusValue = "running";
  const release = provider.blockStatus();
  const service = new MultiReviewService(storage, async () => { throw new Error("unexpected command"); }, {
    autoAdvance: false,
    provider: async () => provider,
  });
  await service.start({
    environmentId: "env-coalesce", projectId: "project-1", targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  await waitUntil(() => provider.statusCalls === 1);

  const first = service.advanceNow((await storage.listMultiReviewWorkflows("env-coalesce"))[0]!.id);
  const second = service.advanceNow((await storage.listMultiReviewWorkflows("env-coalesce"))[0]!.id);
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
    id: "env-lease", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const provider = new Provider();
  provider.statusValue = "running";
  const release = provider.blockStatus();
  const service = new MultiReviewService(storage, async () => { throw new Error("unexpected command"); }, {
    pollIntervalMs: 50,
    controllerLeaseMs: 2_000,
    controllerRenewMs: 100,
    provider: async () => provider,
  });
  await service.init();
  const started = await service.start({
    environmentId: "env-lease", projectId: "project-1", targetBranch: "main",
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
    id: "env-race", projectId: "project-1", name: "review", branch: "change",
    containerId: null, status: "running", prUrl: null, prState: null,
    hasMergeConflicts: null, createdAt: new Date(0).toISOString(), networkAccessMode: "full",
    order: 0, environmentType: "local", worktreePath: "/tmp/review", setupScriptsComplete: true,
  });
  const provider = new Provider();
  provider.statusValue = "running";
  const service = new MultiReviewService(storage, async () => { throw new Error("unexpected command"); }, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const input = {
    environmentId: "env-race", projectId: "project-1", targetBranch: "main",
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
    expect(ready?.reviewers.map((reviewer) => reviewer.status)).toEqual([
      "completed",
      "failed",
    ]);
    expect(ready?.consolidatedReport).toBeDefined();
    const consolidation = [...provider.sends.values()].find((sent) =>
      sent.prompt.includes("<multi-review-reports-json>"));
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
    expect(ready?.reviewers.map((reviewer) => reviewer.status)).toEqual([
      "failed",
      "completed",
    ]);
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
      "No reviewer produced a valid report: The reviewer session failed;"
      + " The reviewer session no longer exists",
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
    expect(failed?.error).toBe(
      "No reviewer produced a valid report: The reviewer session failed",
    );
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
      sent.prompt.includes("<multi-review-reports-json>"));
    for (const reviewer of ready?.reviewers ?? []) {
      expect(consolidation?.prompt).toContain(reviewer.id);
    }
  });
});

test("MultiReviewService settles every running reviewer when the review stage fails", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  await withService("env-review-stage-failure", provider, async ({ service, storage, start, snapshot }) => {
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
  });
});

test("MultiReviewService builds one provider for concurrent transcript reads", async () => {
  const provider = new Provider();
  let creations = 0;
  let releaseCreation = (): void => {};
  let creationGate: Promise<void> | null = null;
  await withService("env-provider-dedup", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });
    // Reaching `ready` releases the supervisor's provider, so the next reader
    // takes the construction path rather than the cache.
    const reviewer = (await snapshot(started.id))!.reviewers[0]!;
    const creationsBeforeReads = creations;
    creationGate = new Promise<void>((resolve) => { releaseCreation = () => resolve(); });

    const reads = [
      service.reviewerTranscript(started.id, reviewer.id),
      service.reviewerTranscript(started.id, reviewer.id),
    ];
    await waitUntil(() => creations > creationsBeforeReads);
    releaseCreation();
    creationGate = null;
    await Promise.all(reads);

    expect(creations).toBe(creationsBeforeReads + 1);
  }, {
    createProvider: async () => {
      creations += 1;
      if (creationGate) await creationGate;
      return provider;
    },
  });
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
  await withService("env-retry-reviewer", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    for (let attempt = 0; attempt < 7; attempt++) await service.advanceNow(started.id);
    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    expect(failed?.reviewers[0]).toMatchObject({ status: "failed", providerSessionId: "session-1" });

    const retried = await service.retry(started.id);
    expect(provider.aborted).toEqual(["session-1"]);
    expect(retried.phase).toBe("reviewing");
    expect(retried.error).toBeUndefined();
    expect(retried.reviewers[0]?.status).toBe("pending");
    expect(retried.reviewers[0]?.providerSessionId).toBeUndefined();
    expect(retried.reviewers[0]?.requestId).toBeUndefined();
    expect(retried.reviewers[0]?.idleResultPolls).toBeUndefined();
    expect(retried.reviewers[0]?.error).toBeUndefined();

    // The retry runs against a brand new session rather than the abandoned one.
    await waitUntil(async () => (await snapshot(started.id))?.reviewers[0]?.providerSessionId === "session-2");
  });
});

test("MultiReviewService retries an incomplete fix turn from the consolidated report", async () => {
  const provider = new Provider();
  provider.fixComplete = false;
  await withService("env-retry-fix", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    for (let attempt = 0; attempt < 4; attempt++) {
      await service.advanceNow(started.id);
      if ((await snapshot(started.id))?.phase === "ready") break;
    }
    await service.address(started.id);
    for (let attempt = 0; attempt < 4; attempt++) await service.advanceNow(started.id);

    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    expect(failed?.fixSession?.status).toBe("failed");
    expect(failed?.error).toContain("could not address every finding");

    const retried = await service.retry(started.id);
    expect(retried.phase).toBe("ready");
    expect(retried.fixSession?.status).toBe("idle");
    expect(retried.activeRequest).toBeUndefined();
    expect(retried.error).toBeUndefined();
    expect(retried.consolidatedReport).toBeDefined();
    // The consolidated session is reused for the next attempt, never abandoned.
    expect(provider.aborted).toEqual([]);
  });
});

test("MultiReviewService retries a failed consolidation with a fresh fix session", async () => {
  const provider = new Provider();
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
