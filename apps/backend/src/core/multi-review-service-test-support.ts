import { REVIEW_VALIDATION_PLAN_SCHEMA } from "./review-validation-prompts.js";
import { randomUUID } from "node:crypto";
import { captureReviewWorktreeSnapshot } from "./review-fanout.js";
import {
  TEST_REVIEW_PREPARATION,
  testGeneratedReviewPackage,
} from "./build-pipeline-test-fixtures.js";
import { expect } from "bun:test";
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
  MULTI_REVIEW_WORKFLOW_VERSION,
  type MultiReviewModelSelection,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { NativeAgentContextUsage } from "@orkestrator/protocol/native-agent";
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
import { type ProviderDispatchStatus } from "./agent-provider-contract.js";
import { codexConnection, httpProvider } from "./agent-provider-test-support.js";
import {
  REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
  REVIEW_ADDRESS_FINDINGS_RESULT_JSON_SCHEMA,
} from "./review-prompts.js";
import { StorageService } from "./storage.js";
import { MultiReviewService, type MultiReviewServiceOptions } from "./multi-review-service.js";
import { WorkflowResultService } from "./workflow-result-service.js";

export const REVIEW_HEAD = "1111111111111111111111111111111111111111";
export const REVIEW_FINGERPRINT = "a".repeat(64);

export async function stableReviewInvoker<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (command === "generate_review_package") return testGeneratedReviewPackage(args!) as T;
  if (command === "verify_review_package") return { valid: true } as T;
  if (command !== "get_environment_uncommitted_paths") throw new Error("unexpected command");
  return {
    head: REVIEW_HEAD,
    paths: [],
    fingerprint: REVIEW_FINGERPRINT,
  } as T;
}

export const cleanReport: StructuredReviewReport = {
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

export const consolidatedReport: StructuredReviewReport = {
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

export const BLOCKED_REASON =
  "No shell command could run in this environment, so no file could be read.";
/** A valid report from a reviewer that could not review. */
export const blockedReport: StructuredReviewReport = {
  ...cleanReport,
  reviewScope: {
    ...cleanReport.reviewScope,
    filesReviewed: [],
    outcome: "blocked",
    blockedReason: BLOCKED_REASON,
  },
  verdict: { ready: "no", reasoning: "The change could not be reviewed." },
};

export class Provider implements BuildPipelineProvider {
  /** Answer `absent` for an id never sent: a bridge whose journal is complete. */
  provesAbsence = false;
  async dispatchStatus(_sessionId: string, requestId: string): Promise<ProviderDispatchStatus> {
    if (this.sends.has(requestId)) return "dispatched" as const;
    return this.provesAbsence ? ("absent" as const) : ("unknown" as const);
  }
  readonly agent: BuildPipelineProvider["agent"] = "claude";
  readonly creates: Array<{ label: string; options?: ProviderCreateSessionOptions }> = [];
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
  /** `settleTurn`'s answer; unset leaves the read as a provider without settlement. */
  turnSettledValue: boolean | undefined;
  async settleTurn(_sessionId: string, _requestId: string): Promise<boolean> {
    return this.turnSettledValue as boolean;
  }
  /** Sessions whose `sessionFailures` entry is a provider restart's interruption. */
  readonly restartInterrupted = new Set<string>();
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
  ambiguousAddressFindingsOnce = false;
  addressFindingsSends = 0;
  addressFindingsComplete = true;
  invalidReviewerReports = 0;
  invalidConsolidatedReports = 0;
  missingConsolidatedProvenanceReports = 0;
  invalidConsolidatedProvenanceReports = 0;
  missingCoverageGapProvenanceReports = 0;
  providerAuthoredConsolidatedModels = 0;
  schemaFailureReports = 0;
  invalidAddressFindingsResults = 0;
  addressFindingsStructuredFailure: StructuredOutputFailureCode | null = null;
  preparationResult: unknown = TEST_REVIEW_PREPARATION;
  messagesValue: unknown[] = [];
  messagesError: Error | null = null;
  reviewerReport: StructuredReviewReport = cleanReport;
  /** Reviewer sessions whose report says the reviewer could not review. */
  blockedReviewerSessions = new Set<string>();
  /** Consolidation reports that say the consolidator could not review. */
  blockedConsolidationReports = 0;
  consolidationReport: StructuredReviewReport = consolidatedReport;
  messagesCalls = 0;
  usageTokens: number | undefined;
  /** Cumulative tokens for one session, overriding `usageTokens`. */
  readonly usageTokensBySession = new Map<string, number>();
  usageUsedTokens: number | undefined;
  usagePending = false;
  backgroundWorkLive = false;
  retainedContinuation = false;
  /** What every session reports as its read-only turn's missing command sandbox. */
  commandSandboxOff: string | undefined;
  usageFromMessages?: (messages: readonly unknown[]) => NativeAgentContextUsage | undefined;
  usageMessageLimit?: number;
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
  constructor(public returnStructured = true) {}
  async createSession(
    _phase: "build" | "review" | "verify" | "fix" | "pr" | "resolve-conflicts",
    _label: string,
    options?: ProviderCreateSessionOptions,
  ) {
    this.creates.push({ label: _label, options });
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
      this.addressFindingsSends += 1;
      if (this.ambiguousAddressFindingsOnce) {
        this.ambiguousAddressFindingsOnce = false;
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
    if (failure) {
      throw new ProviderSessionFailedError(
        this.agent,
        failure,
        this.restartInterrupted.has(sessionId) ? { interruption: "restart" } : {},
      );
    }
    return this.statusOverrides.get(sessionId) ?? this.statusValue;
  }
  async observeSession(sessionId: string) {
    const status = await this.status(sessionId);
    const sessionTokens = this.usageTokensBySession.get(sessionId) ?? this.usageTokens;
    const contextUsage: NativeAgentContextUsage | undefined =
      sessionTokens === undefined && this.usageUsedTokens === undefined
        ? undefined
        : {
            usedTokens: this.usageUsedTokens ?? sessionTokens ?? 0,
            ...(sessionTokens === undefined ? {} : { sessionTokens }),
          };
    return {
      status,
      ...(contextUsage ? { contextUsage } : {}),
      ...(this.usagePending ? { usagePending: true } : {}),
      ...(this.backgroundWorkLive ? { backgroundWorkLive: true } : {}),
      ...(this.retainedContinuation
        ? { retainedContinuationRequestIds: Array.from(this.sends.keys()) }
        : {}),
      ...(this.commandSandboxOff === undefined
        ? {}
        : { commandSandboxOff: this.commandSandboxOff }),
    };
  }
  /**
   * The bounded snapshot surface every reviewer provider has, served from the
   * same messages. It never answers unchanged.
   */
  transcriptSnapshot?: (
    sessionId: string,
    options: { limit: number },
  ) => Promise<{ messages: unknown[]; complete: boolean }> = async (sessionId, options) => {
    const messages = await this.messages(sessionId, { limit: options.limit });
    return { messages: messages.slice(-options.limit), complete: messages.length < options.limit };
  };
  async messages(_sessionId: string, options?: { limit?: number }): Promise<unknown[]> {
    this.messagesCalls += 1;
    this.messageOptions.push(options);
    if (this.messagesGate) await this.messagesGate;
    if (this.messagesError) throw this.messagesError;
    return this.messagesValue;
  }
  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null> {
    if (!this.returnStructured) return null;
    const sent = this.sends.get(requestId)!;
    const isConsolidation = this.consolidationSessions.has(sessionId);
    if (
      sent.options.schema === REVIEW_PREPARATION_RESULT_JSON_SCHEMA ||
      sent.options.schema === REVIEW_VALIDATION_PLAN_SCHEMA
    )
      return { ok: true, provider: "claude", requestId, value: this.preparationResult as T };
    if (sent.options.schema === REVIEW_ADDRESS_FINDINGS_RESULT_JSON_SCHEMA) {
      if (this.addressFindingsStructuredFailure) {
        const code = this.addressFindingsStructuredFailure;
        this.addressFindingsStructuredFailure = null;
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
      if (this.invalidAddressFindingsResults > 0) {
        this.invalidAddressFindingsResults -= 1;
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
          complete: this.addressFindingsComplete,
          summary: this.addressFindingsComplete
            ? "Addressed every finding"
            : "Two findings remain unresolved",
          filesChanged: ["src/a.ts", "src/a.test.ts"],
          commandsRun: [],
          notes: [],
          limitations: this.addressFindingsComplete ? [] : ["Two findings need product input"],
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
      if (isConsolidation && this.blockedConsolidationReports > 0) {
        this.blockedConsolidationReports -= 1;
        return {
          ok: true,
          provider: "claude",
          requestId,
          value: { ...blockedReport, issues: [], testCoverageGaps: [] } as T,
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
      if (!isConsolidation && this.blockedReviewerSessions.has(sessionId)) {
        return {
          ok: true,
          provider: "claude",
          requestId,
          value: blockedReport as T,
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
            complete: this.addressFindingsComplete,
            summary: this.addressFindingsComplete
              ? "Addressed every finding"
              : "Two findings remain unresolved",
            filesChanged: ["src/a.ts", "src/a.test.ts"],
            commandsRun: [],
            notes: [],
            // An incomplete result is only valid alongside a failed validation
            // or an explicit limitation.
            limitations: this.addressFindingsComplete ? [] : ["Two findings need product input"],
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

/** Records auto-PR launches; the first `failures` launches throw, as a full tab strip does. */
export function autoPrInvoker(
  options: {
    failures?: number;
    status?: "accepted" | "rejected" | "unknown" | "accepted-without-tab";
    failWatch?: boolean;
  } = {},
) {
  const launches: Record<string, unknown>[] = [];
  const watches: Record<string, unknown>[] = [];
  let failures = options.failures ?? 0;
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (command === "launch_native_agent_job") {
      launches.push(args!);
      if (failures > 0) {
        failures -= 1;
        throw new Error("Environment already has the maximum of 12 tabs");
      }
      if (options.status === "rejected")
        return { status: "rejected", tabId: "agent-job-pr", error: "provider refused" } as T;
      if (options.status === "unknown") return { status: "unknown" } as T;
      if (options.status === "accepted-without-tab") return { status: "accepted" } as T;
      return { status: "accepted", tabId: "agent-job-pr" } as T;
    }
    if (command === "pr_monitor_watch") {
      watches.push(args!);
      if (options.failWatch) throw new Error("monitor unavailable");
      return undefined as T;
    }
    return stableReviewInvoker<T>(command, args);
  };
  return { invoke, launches, watches };
}

export const autoPrAddressFindingsDispatch: NonNullable<
  MultiReviewServiceOptions["dispatchAddressFindingsPrompt"]
> = async (workflow) => ({
  tabId: workflow.addressTabId!,
  fixSession: {
    ...workflow.fixModel,
    sessionKey: workflow.addressSessionKey!,
    providerSessionId: `provider-auto-pr-${workflow.id}`,
    requestIds: [workflow.addressRequestId!],
    status: "running",
    startedAt: new Date().toISOString(),
  },
});

/** Consolidate, hand off Address Findings, and observe it run to `finalStatus`. */
export async function runInteractiveAddressFindings(
  service: MultiReviewService,
  provider: Provider,
  snapshot: (workflowId: string) => Promise<MultiReviewWorkflow | undefined>,
  workflowId: string,
  finalStatus: ProviderStatus = "idle",
  abortBeforeIdle = false,
): Promise<MultiReviewWorkflow> {
  await waitUntil(async () => {
    await service.advanceNow(workflowId);
    return (await snapshot(workflowId))?.phase === "ready";
  });
  await service.address(workflowId);
  await waitUntil(async () => {
    await service.advanceNow(workflowId);
    return (await snapshot(workflowId))?.addressPromptPending !== true;
  });
  provider.statusValue = "running";
  await service.advanceNow(workflowId);
  if (abortBeforeIdle) {
    await provider.abort((await snapshot(workflowId))!.fixSession!.providerSessionId);
  }
  provider.statusValue = finalStatus;
  await service.advanceNow(workflowId);
  await waitUntil(async () => {
    if ((await snapshot(workflowId))?.stepRuntimes?.fix?.completedAt !== undefined) return true;
    await service.advanceNow(workflowId);
    return false;
  });
  const settled = (await snapshot(workflowId))!;
  expect(settled.stepRuntimes?.fix?.completedAt).toEqual(expect.any(String));
  return settled;
}

/** Simulate a durable launch from a saved workflow for supersession tests. */
export async function restorePendingAutoPr(
  storage: StorageService,
  workflowId: string,
): Promise<void> {
  await mutateStoredWorkflow(storage, workflowId, (workflow) => {
    workflow.autoPrLaunch = { state: "pending", requestId: `multi-review-pr:${workflowId}` };
  });
}

/** Restore a launch with the structured completion proof required for delivery. */
export async function restoreCompletedAutoPr(
  storage: StorageService,
  workflowId: string,
): Promise<void> {
  await mutateStoredWorkflow(storage, workflowId, (workflow) => {
    workflow.phase = "completed";
    workflow.fixResult = {
      complete: true,
      summary: "Addressed every finding",
      filesChanged: [],
      commandsRun: [],
      notes: [],
      limitations: [],
    };
    workflow.autoPrLaunch = { state: "pending", requestId: `multi-review-pr:${workflowId}` };
  });
}

/**
 * Run explicit supervisor passes until `done` holds, recording every phase seen.
 * Passes are driven directly, so no timer has to elapse.
 */
export async function advanceUntil(
  service: MultiReviewService,
  snapshot: (workflowId: string) => Promise<MultiReviewWorkflow | undefined>,
  workflowId: string,
  done: (workflow: MultiReviewWorkflow) => boolean,
  seen: string[] = [],
  passes = 60,
): Promise<MultiReviewWorkflow> {
  for (let pass = 0; pass < passes; pass += 1) {
    const workflow = (await snapshot(workflowId))!;
    if (seen.at(-1) !== workflow.phase) seen.push(workflow.phase);
    if (done(workflow)) return workflow;
    await service.advanceNow(workflowId);
  }
  throw new Error(`Multi Review ${workflowId} did not reach the expected state`);
}

/** An Address Findings run dispatch and PR launcher that log their order, for the auto-fix → auto-PR flow. */
export function orderedAutoFlow(events: string[]) {
  const pr = autoPrInvoker();
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (command === "launch_native_agent_job") events.push("pr");
    return pr.invoke<T>(command, args);
  };
  const dispatchAddressFindingsPrompt: NonNullable<
    MultiReviewServiceOptions["dispatchAddressFindingsPrompt"]
  > = (workflow, ...rest) => {
    events.push("fix");
    return autoPrAddressFindingsDispatch(workflow, ...rest);
  };
  return { pr, invoke, dispatchAddressFindingsPrompt };
}

/**
 * Several workflows, each handed to an interactive Address Findings on one HTTP bridge
 * connection, advanced together. `observations` answers the batch route;
 * `undefined` makes it an older bridge without one.
 */
export async function withInteractiveFixes(
  label: string,
  observations: Record<string, string> | undefined,
  run: (context: {
    service: MultiReviewService;
    workflowIds: string[];
    requests: string[];
    batchBodies: string[][];
    snapshot: (workflowId: string) => Promise<MultiReviewWorkflow | undefined>;
  }) => Promise<void>,
): Promise<void> {
  const fallbackProvider = new Provider();
  const requests: string[] = [];
  const batchBodies: string[][] = [];
  const activityOf = (sessionId: string) =>
    observations?.[sessionId.replace(/^http-fix-.*-(\d)$/, "fix-$1")] ?? "working";
  const { provider: http } = httpProvider((request, init) => {
    const url = new URL(request);
    requests.push(url.pathname);
    if (url.pathname === "/sessions/activity") {
      if (!observations) return new Response("", { status: 404 });
      const { sessionIds } = JSON.parse(String(init.body)) as { sessionIds: string[] };
      batchBodies.push(sessionIds);
      return Response.json({
        version: 1,
        observations: Object.fromEntries(
          sessionIds.map((id) => [id, { activity: activityOf(id) }]),
        ),
      });
    }
    if (url.pathname.endsWith("/activity")) {
      const sessionId = decodeURIComponent(url.pathname.split("/")[2]!);
      return Response.json({ activity: activityOf(sessionId) });
    }
    return Response.json({ status: "running", contextUsage: { usedTokens: 1, sessionTokens: 1 } });
  }, codexConnection);
  const environmentIds = [0, 1, 2].map((index) => `env-${label}-${index}`);
  await withService(
    environmentIds[0]!,
    fallbackProvider,
    async ({ service, storage, snapshot }) => {
      for (const environmentId of environmentIds.slice(1)) {
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
      }
      const workflowIds: string[] = [];
      for (const environmentId of environmentIds) {
        const started = await service.start({
          environmentId,
          projectId: "project-1",
          targetBranch: "main",
          reviewers: [{ agent: "claude", model: "opus" }],
          reviewModel: { agent: "claude", model: "opus" },
          fixModel: { agent: "codex", model: "gpt-5.6" },
        });
        await waitUntil(async () => {
          await service.advanceNow(started.id);
          return (await snapshot(started.id))?.phase === "ready";
        });
        await service.address(started.id);
        await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);
        workflowIds.push(started.id);
      }
      // Drain the handoff's own follow-up passes before measuring.
      await Promise.all(workflowIds.map((id) => service.advanceNow(id)));
      requests.length = 0;
      batchBodies.length = 0;
      await run({ service, workflowIds, requests, batchBodies, snapshot });
    },
    {
      packageFlow: true,
      createProvider: async (_workflow, selection) =>
        selection.agent === "codex" ? http : fallbackProvider,
      serviceOptions: {
        // Generous, so three concurrent passes always meet in one window.
        activityReadCoalesceWindowMs: 250,
        dispatchAddressFindingsPrompt: async (workflow) => ({
          tabId: workflow.addressTabId!,
          fixSession: {
            ...workflow.fixModel,
            sessionKey: workflow.addressSessionKey!,
            providerSessionId: `http-fix-${workflow.id}-${environmentIds.indexOf(workflow.environmentId)}`,
            requestIds: [workflow.addressRequestId!],
            status: "running",
            startedAt: new Date().toISOString(),
          },
        }),
      },
    },
  );
}

export const singleActivityRead = (path: string) => /^\/session\/[^/]+\/activity$/.test(path);

export async function withService(
  environmentId: string,
  provider: Provider,
  run: (context: {
    dataDir: string;
    service: MultiReviewService;
    storage: StorageService;
    start: (
      reviewers?: MultiReviewModelSelection[],
      fixModel?: MultiReviewModelSelection,
    ) => Promise<MultiReviewWorkflow>;
    snapshot: (workflowId: string) => Promise<MultiReviewWorkflow | undefined>;
    workflowResults?: WorkflowResultService;
  }) => Promise<void>,
  options: {
    packageFlow?: boolean;
    autoFix?: boolean;
    autoPr?: boolean;
    createProvider?: NonNullable<MultiReviewServiceOptions["provider"]>;
    serviceOptions?: Partial<MultiReviewServiceOptions>;
    /** Backend command runner; defaults to a stable clean review snapshot. */
    invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    toolMode?: boolean;
    /** Defaults to a local worktree environment. */
    environmentType?: "local" | "containerized";
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
    containerId: options.environmentType === "containerized" ? "container-1" : null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: options.environmentType ?? "local",
    worktreePath: "/tmp/review",
    setupScriptsComplete: true,
  });
  const workflowResults = options.toolMode ? new WorkflowResultService(dataDir) : undefined;
  const service = new MultiReviewService(storage, options.invoke ?? stableReviewInvoker, {
    autoAdvance: false,
    provider: options.createProvider ?? (async () => provider),
    ...(workflowResults
      ? {
          workflowResults,
          resolveAgentToolConnection: (_environmentId, _projectId, _target, _resultKey, agent) => ({
            url: "http://127.0.0.1:1234/mcp",
            token: agent === "opencode" ? "broker-token" : "test-token",
            ...(agent === "opencode"
              ? { workflowResultCapability: "signed-attempt-capability" }
              : {}),
          }),
        }
      : {}),
    ...options.serviceOptions,
  });
  try {
    await run({
      dataDir,
      service,
      storage,
      workflowResults,
      start: (
        reviewers = [{ agent: "claude", model: "opus" }],
        fixModel = { agent: "claude", model: "opus" },
      ) =>
        (options.packageFlow
          ? service.start.bind(service)
          : (input: Parameters<MultiReviewService["start"]>[0]) =>
              startLegacyReview(service, storage, options.invoke ?? stableReviewInvoker, input))({
          environmentId,
          projectId: "project-1",
          targetBranch: "main",
          autoFix: options.autoFix,
          ...(options.autoPr !== undefined ? { autoPr: options.autoPr } : {}),
          reviewers,
          fixModel,
        }),
      snapshot: async (workflowId) =>
        (await storage.getMultiReviewWorkflow(workflowId))?.snapshot as
          MultiReviewWorkflow | undefined,
    });
  } finally {
    await service.shutdown();
    workflowResults?.closeStorage();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Multi Review state");
    await Bun.sleep(10);
  }
}

// Start the two step runners directly: Address Findings here exercises the persisted legacy
// structured-step path, rather than the newer interactive addressing handoff.
export async function startFollowUpStep(
  kind: "prepare" | "fix",
  context: {
    service: MultiReviewService;
    storage: StorageService;
    snapshot: (id: string) => Promise<MultiReviewWorkflow | undefined>;
  },
  environmentId: string,
  toolMode: boolean,
): Promise<MultiReviewWorkflow> {
  const { service, storage, snapshot } = context;
  const codex = { agent: "codex" as const, model: "default" };
  let id: string;
  if (kind === "prepare") {
    id = (
      await service.start({
        environmentId,
        projectId: "project-1",
        targetBranch: "main",
        reviewers: [codex],
        reviewModel: codex,
        fixModel: codex,
      })
    ).id;
  } else {
    id = await seedLegacyFixingWorkflow(storage, environmentId);
    const stored = (await storage.getMultiReviewWorkflow(id))!;
    const workflow = stored.snapshot as MultiReviewWorkflow;
    workflow.fixModel = codex;
    workflow.fixSession!.agent = "codex";
    workflow.activeRequest!.resultTransport = toolMode ? "tool-v1" : "structured-output-v1";
    await storage.saveMultiReviewWorkflow(id, environmentId, 1, workflow, stored.revision);
  }
  return advanceUntil(
    service,
    snapshot,
    id,
    (workflow) => workflow.activeRequest?.state === "sent",
  );
}

export const completedAddressFindings = {
  complete: true,
  summary: "Addressed every finding",
  filesChanged: ["src/a.ts"],
  commandsRun: [],
  notes: [],
  limitations: [],
};

export async function mutateStoredWorkflow(
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

/**
 * A snapshot in the shape the pre-handoff `address()` used to persist.
 *
 * Nothing writes `fixing` any more, but the supervisor still advances it so a
 * workflow caught mid-fix by an upgrade finishes instead of stalling forever.
 * That path is only reachable from durable state, so seed it directly.
 */
export async function seedLegacyFixingWorkflow(
  storage: StorageService,
  environmentId: string,
  autoPr = false,
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
    autoPr,
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

export const reportedFinding = {
  severity: "P1" as const,
  confidence: 85,
  category: "correctness" as const,
  title: "Restart resets the shared clock",
  file: "src/review.ts",
  line: 12,
  symbol: "restartStep",
  description: "Restarting a step clears the runtime the shared session still uses.",
  evidence: "restartStep deletes stepRuntimes",
  suggestion: "Keep the previous runtime",
  verification: "Restart a step and read its runtime",
};

/** Exercise pre-package snapshots through the real supervisor, as on upgrade. */
export async function startLegacyReview(
  service: MultiReviewService,
  storage: StorageService,
  invoke: typeof stableReviewInvoker,
  input: Parameters<MultiReviewService["start"]>[0],
): Promise<MultiReviewWorkflow> {
  const timestamp = new Date().toISOString();
  const workflow: MultiReviewWorkflow = {
    ...input,
    version: 1,
    controller: "backend",
    id: randomUUID(),
    reviewers: input.reviewers.map((selection) => ({
      ...selection,
      id: randomUUID(),
      status: "pending",
    })),
    phase: "reviewing",
    createdAt: timestamp,
    updatedAt: timestamp,
    backendRevision: 0,
    reviewWorktreeSnapshot: await captureReviewWorktreeSnapshot(
      invoke,
      input.environmentId,
      "Multi Review",
    ),
  };
  const saved = await storage.createMultiReviewWorkflowIfNoActive(
    workflow.id,
    workflow.environmentId,
    1,
    workflow,
  );
  if (!saved)
    throw new Error("Finish, cancel, or delete the existing Multi Review before starting another");
  workflow.backendRevision = saved.revision;
  void service.advanceNow(workflow.id);
  return workflow;
}

export function rewindGit(head: { value: string }, options: { pushed?: number } = {}) {
  const calls: string[][] = [];
  const git = async (_environmentId: string, args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "HEAD") return `${head.value}\n`;
    if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) {
      if (options.pushed === undefined) throw new Error("no upstream");
      return "origin/change\n";
    }
    if (args[0] === "rev-parse") throw new Error("no backup");
    if (args[0] === "status") return "";
    if (args[0] === "rev-list" && args[2]?.startsWith("HEAD..")) return "0\n";
    if (args[0] === "rev-list" && args[2]?.endsWith("..@{upstream}")) {
      return `${options.pushed ?? 0}\n`;
    }
    if (args[0] === "rev-list") return "1\n";
    if (args[0] === "log") return `${"c".repeat(40)}\tfix: dropped\n`;
    if (args[0] === "reset") head.value = args[2]!;
    return "";
  };
  return { git, calls };
}
