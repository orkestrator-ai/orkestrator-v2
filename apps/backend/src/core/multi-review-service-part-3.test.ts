// Part 3 of 4 of the MultiReviewService suite, split from multi-review-service.test.ts so
// `bun test --parallel` can spread it across workers. Shared helpers live in
// multi-review-service-test-support.ts.
import { multiReviewAddressFindingsIdentity } from "./multi-review-address-findings-identity.js";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { REVIEW_VALIDATION_PLAN_SCHEMA } from "./review-validation-prompts.js";
import { randomUUID } from "node:crypto";
import { captureReviewWorktreeSnapshot } from "./review-fanout.js";
import { testGeneratedReviewPackage } from "./build-pipeline-test-fixtures.js";
import { expect, jest, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REVIEW_BLOCKED_ERROR_PREFIX,
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
} from "@orkestrator/protocol/structured-review";
import { reviewerBlockedReason } from "@orkestrator/protocol/review-fanout";
import {
  MULTI_REVIEW_WORKFLOW_VERSION,
  isMultiReviewWorkflow,
  type MultiReviewModelSelection,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { reviewLensSection } from "@orkestrator/protocol/review-lens";
import { reviewerPanelSection } from "./multi-review-prompts.js";
import { newReviewValidationRun } from "@orkestrator/protocol/review-workflow";
import type {
  BuildPipelineProvider,
  ProviderSendOptions,
  ProviderStatus,
} from "./build-pipeline-provider.js";
import type {
  ReviewValidationPlan,
  ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import { AmbiguousPromptDispatchError } from "./build-pipeline-provider.js";
import { ProviderUnreachableError } from "./agent-provider-contract.js";
import { REVIEW_ADDRESS_FINDINGS_RESULT_JSON_SCHEMA } from "./review-prompts.js";
import { StorageService } from "./storage.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext } from "./commands-context.js";
import { MultiReviewService, workflowCompletionOutcome } from "./multi-review-service.js";
import { BackendRuntime } from "./backend-runtime.js";
import {
  BLOCKED_REASON,
  Provider,
  REVIEW_HEAD,
  autoPrInvoker,
  consolidatedReport,
  mutateStoredWorkflow,
  reportedFinding,
  seedLegacyFixingWorkflow,
  stableReviewInvoker,
  startLegacyReview,
  waitUntil,
  withService,
} from "./multi-review-service-test-support.js";

// This owner includes real lease timers and deliberately blocked provider
// calls. Keep Bun's outer budget wider than its own diagnostic waits.
jest.setTimeout(30_000);

test("MultiReviewService collects a live reviewer's reported findings on its next pass", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  await withService(
    "env-live-findings",
    provider,
    async ({ service, storage, snapshot, workflowResults }) => {
      const resultKey = randomUUID();
      const timestamp = new Date().toISOString();
      await workflowResults!.prepare({
        resultKey,
        kind: "review-report",
        environmentId: "env-live-findings",
        projectId: "project-1",
        provider: "claude",
      });
      const workflow: MultiReviewWorkflow = {
        version: 1,
        controller: "backend",
        id: "live-findings",
        environmentId: "env-live-findings",
        projectId: "project-1",
        targetBranch: "main",
        reviewers: [
          {
            id: "reviewer-1",
            agent: "claude",
            model: "opus",
            status: "running",
            sessionKey: "multi-review:live-findings:reviewer-1",
            providerSessionId: "session-live",
            requestId: resultKey,
            dispatchState: "sent",
            resultTransport: "tool-v1",
            startedAt: timestamp,
          },
        ],
        fixModel: { agent: "claude", model: "opus" },
        phase: "reviewing",
        createdAt: timestamp,
        updatedAt: timestamp,
        backendRevision: 0,
        reviewWorktreeSnapshot: await captureReviewWorktreeSnapshot(
          stableReviewInvoker,
          "env-live-findings",
          "Multi Review",
        ),
      };
      await storage.createMultiReviewWorkflowIfNoActive(
        workflow.id,
        workflow.environmentId,
        1,
        workflow,
      );
      const sink = service.provisionalFindingSink();
      const scope = { environmentId: "env-live-findings", projectId: "project-1" };
      // Nothing is accepted before the backend has seen the reviewer live.
      expect(sink.accepts(scope, resultKey)).toBe(false);

      await service.advanceNow(workflow.id);
      expect(sink.accepts(scope, resultKey)).toBe(true);
      expect(await sink.report(scope, resultKey, reportedFinding)).toMatchObject({
        ok: true,
        duplicate: false,
      });
      expect((await snapshot(workflow.id))!.reviewers[0]!.provisionalFindings).toBeUndefined();

      await service.advanceNow(workflow.id);
      const stored = (await snapshot(workflow.id))!.reviewers[0]!;
      expect(stored.provisionalFindings?.map((finding) => finding.issue)).toEqual([
        reportedFinding,
      ]);
      // A retry after the pass recorded it is still the same finding.
      expect(await sink.report(scope, resultKey, reportedFinding)).toMatchObject({
        ok: true,
        duplicate: true,
      });
      // Another reviewer's attempt key reaches nothing.
      expect(await sink.report(scope, randomUUID(), reportedFinding)).toMatchObject({
        ok: false,
        error: { code: "not_accepting" },
      });
    },
    { toolMode: true },
  );
});

test("MultiReviewService keeps only accepted reports once the review has run its course", async () => {
  const provider = new Provider();
  await withService("env-findings-complete", provider, async ({ service, storage, snapshot }) => {
    const workflowId = await seedLegacyFixingWorkflow(storage, "env-findings-complete");
    // A reviewer that stopped before its report was accepted left findings behind.
    await mutateStoredWorkflow(storage, workflowId, (workflow) => {
      workflow.reviewers.push({
        id: "reviewer-2",
        agent: "claude",
        model: "sonnet",
        status: "cancelled",
        provisionalFindings: [
          {
            id: "0123456789abcdef01234567",
            reportedAt: new Date(0).toISOString(),
            issue: reportedFinding,
          },
        ],
      });
    });
    for (let pass = 0; pass < 6; pass += 1) {
      await service.advanceNow(workflowId);
      if ((await snapshot(workflowId))?.phase === "completed") break;
    }
    const completed = (await snapshot(workflowId))!;
    expect(completed.phase).toBe("completed");
    expect(completed.reviewers[1]).toMatchObject({ status: "cancelled" });
    expect(completed.reviewers[1]).not.toHaveProperty("provisionalFindings");
  });
});

test("MultiReviewService finishes an Address Findings turn persisted before the interactive handoff", async () => {
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
    expect(provider.addressFindingsSends).toBe(1);
  });
});

test.each([true, false])(
  "MultiReviewService queues auto-PR only for a complete structured Address Findings (%s)",
  async (complete) => {
    const provider = new Provider();
    provider.addressFindingsComplete = complete;
    const pr = autoPrInvoker();
    const environmentId = `env-structured-auto-pr-${complete}`;
    await withService(
      environmentId,
      provider,
      async ({ service, storage, snapshot }) => {
        const workflowId = await seedLegacyFixingWorkflow(storage, environmentId, true);
        await waitUntil(async () => {
          await service.advanceNow(workflowId);
          return ["completed", "failed"].includes((await snapshot(workflowId))?.phase ?? "");
        });
        expect((await snapshot(workflowId))?.autoPrLaunch).toEqual(
          complete
            ? {
                state: "pending",
                requestId: `multi-review-pr:${workflowId}`,
                fixIdentity: multiReviewAddressFindingsIdentity(
                  (await snapshot(workflowId))?.fixSession,
                ),
              }
            : undefined,
        );
        expect(pr.launches).toHaveLength(0);
        await service.advanceNow(workflowId);
        expect(pr.launches).toHaveLength(complete ? 1 : 0);
      },
      { invoke: pr.invoke },
    );
  },
);

test("MultiReviewService publishes a PR tab through the backend job command", async () => {
  const environmentId = "env-structured-auto-pr-tab";
  const launchCommand = createCommandRegistry().get("launch_native_agent_job");
  if (!launchCommand) throw new Error("PR job command missing");
  let commandStorage: StorageService;
  const dispatched: Record<string, unknown>[] = [];
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (command === "pr_monitor_watch") return undefined as T;
    if (command !== "launch_native_agent_job") return stableReviewInvoker<T>(command, args);
    const context = {
      storage: commandStorage,
      emit: () => undefined,
      appRoot: "",
      resourceRoot: "",
      environmentLifecycleTasks: {},
      runtime: new BackendRuntime({ emit: () => undefined }),
      nativeAgents: {
        ensureSession: async () => ({ providerSessionId: "provider-pr-tab" }),
        dispatchIntent: async (input: Record<string, unknown>) => {
          dispatched.push(input);
          return { outcome: "accepted" as const };
        },
      },
    } as unknown as CommandContext;
    return (await launchCommand(args ?? {}, context)) as T;
  };
  await withService(
    environmentId,
    new Provider(),
    async ({ dataDir, service, storage, snapshot }) => {
      commandStorage = storage;
      await storage.updateEnvironment(environmentId, { setupPhase: "ready" });
      await storage.ensureNativeAgentJobTab({
        environmentId,
        tabId: "existing-tab",
        agent: "claude",
      });
      const workflowId = await seedLegacyFixingWorkflow(storage, environmentId, true);
      await waitUntil(async () => {
        await service.advanceNow(workflowId);
        return (await snapshot(workflowId))?.autoPrLaunch?.state === "pending";
      });
      await service.advanceNow(workflowId);
      const launched = (await snapshot(workflowId))?.autoPrLaunch;
      expect(launched?.state).toBe("launched");
      expect(typeof launched?.tabId).toBe("string");
      expect(dispatched).toHaveLength(1);
      const layout = await storage.getPaneLayout(environmentId);
      expect(layout?.root).toBeDefined();
      expect(JSON.stringify(layout?.root)).toContain(launched!.tabId!);
      expect(layout?.root).toMatchObject({ kind: "leaf", activeTabId: "existing-tab" });
      // A fresh storage instance reads the same tab after backend state is rehydrated.
      const reopenedStorage = new StorageService(dataDir);
      await reopenedStorage.init();
      expect(JSON.stringify((await reopenedStorage.getPaneLayout(environmentId))?.root)).toContain(
        launched!.tabId!,
      );
    },
    { invoke },
  );
});

test("MultiReviewService asks the Address Findings model to correct an invalid fix result", async () => {
  const provider = new Provider();
  provider.invalidAddressFindingsResults = 1;
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
        sent.options.schema === REVIEW_ADDRESS_FINDINGS_RESULT_JSON_SCHEMA &&
        sent.prompt.includes("repair attempt 1 of 3"),
    );
    expect(repair?.prompt).toContain("Address Findings result");
    expect(repair?.prompt).toContain("Fix result cannot be complete");
    expect(repair?.prompt).toContain('"complete"');
    expect(repair?.prompt).toContain("<structured-review-expected-schema-json>");
  });
});

test("MultiReviewService does not treat provider fix failures as schema repair work", async () => {
  for (const code of ["provider_error", "interrupted"] as const) {
    const provider = new Provider();
    provider.addressFindingsStructuredFailure = code;
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

test.each([
  ["error", "The Address Findings session failed"],
  ["missing", "The Address Findings session no longer exists"],
] as const)(
  "MultiReviewService identifies a persisted Address Findings session when it becomes %s",
  async (status, message) => {
    const environmentId = `env-legacy-fix-${status}`;
    const provider = new Provider();
    provider.statusOverrides.set("session-legacy-fix", status);
    await withService(environmentId, provider, async ({ service, storage, snapshot }) => {
      const workflowId = await seedLegacyFixingWorkflow(storage, environmentId);
      await service.advanceNow(workflowId);

      expect(await snapshot(workflowId)).toMatchObject({
        phase: "failed",
        activeRequest: { kind: "fix" },
        fixSession: { providerSessionId: "session-legacy-fix", status: "failed" },
        error: message,
      });
    });
  },
);

test("MultiReviewService reports terminal detail from a persisted Address Findings session", async () => {
  const detail = "Address Findings model reached its usage limit";
  const provider = new Provider();
  provider.sessionFailures.set("session-legacy-fix", detail);
  await withService("env-legacy-fix-terminal", provider, async ({ service, storage, snapshot }) => {
    const workflowId = await seedLegacyFixingWorkflow(storage, "env-legacy-fix-terminal");
    await service.advanceNow(workflowId);

    expect((await snapshot(workflowId))?.error).toBe(
      `The Address Findings session failed: ${detail}`,
    );
  });
});

test("MultiReviewService bounds a blocked persisted Address Findings model", async () => {
  const provider = new Provider();
  provider.statusOverrides.set("session-legacy-fix", "blocked");
  await withService("env-legacy-fix-blocked", provider, async ({ service, storage, snapshot }) => {
    const workflowId = await seedLegacyFixingWorkflow(storage, "env-legacy-fix-blocked");
    for (let attempt = 0; attempt < 6; attempt++) await service.advanceNow(workflowId);

    expect((await snapshot(workflowId))?.error).toBe(
      "The Address Findings model stayed blocked without a resolvable interaction",
    );
  });
});

test("MultiReviewService bounds a persisted Address Findings model that returns no result", async () => {
  const provider = new Provider(false);
  await withService("env-legacy-fix-idle", provider, async ({ service, storage, snapshot }) => {
    const workflowId = await seedLegacyFixingWorkflow(storage, "env-legacy-fix-idle");
    for (let attempt = 0; attempt < 6; attempt++) await service.advanceNow(workflowId);

    expect((await snapshot(workflowId))?.error).toBe(
      "The Address Findings model became idle without returning its Address Findings result",
    );
  });
});

test("MultiReviewService identifies a stalled persisted Address Findings session", async () => {
  const provider = new Provider();
  provider.statusOverrides.set("session-legacy-fix", "running");
  provider.messagesValue = [{ id: "assistant-1", role: "assistant", content: "Fixing" }];
  await withService(
    "env-legacy-fix-stall",
    provider,
    async ({ service, storage, snapshot }) => {
      const workflowId = await seedLegacyFixingWorkflow(storage, "env-legacy-fix-stall");
      await waitUntil(async () => {
        await service.advanceNow(workflowId);
        return (await snapshot(workflowId))?.phase === "failed";
      });

      expect((await snapshot(workflowId))?.error).toContain(
        "Address Findings session produced no activity",
      );
    },
    { serviceOptions: { progressProbeIntervalMs: 0, stallAbandonMs: 0 } },
  );
});

test("MultiReviewService retries an incomplete legacy Address Findings turn from the consolidated report", async () => {
  const provider = new Provider();
  provider.addressFindingsComplete = false;
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
    // No workflow is left to say the work completed.
    expect((await storage.getEnvironment("env-rehydrate"))?.hasUnreadWork ?? false).toBe(false);
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("MultiReviewService reports a failure that ended across a restart", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-multi-review-activity-failed-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-failed",
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
  const first = new MultiReviewService(storage, stableReviewInvoker, {
    autoAdvance: false,
    provider: async () => provider,
  });
  const started = await startLegacyReview(first, storage, stableReviewInvoker, {
    environmentId: "env-failed",
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  for (let attempt = 0; attempt < 7; attempt++) await first.advanceNow(started.id);
  await first.shutdown();
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "failed",
  });

  // The process stopped after saving the failure and before syncing activity.
  await storage.setEnvironmentUnread("env-failed", false);
  await storage.setEnvironmentAgentActivity(
    "env-failed",
    "working",
    new Date().toISOString(),
    "multi-review",
  );
  const restored = new MultiReviewService(storage, stableReviewInvoker, {
    autoAdvance: false,
    provider: async () => provider,
  });
  try {
    await restored.init();
    expect(await storage.getEnvironment("env-failed")).toMatchObject({
      agentActivityState: "idle",
      hasUnreadWork: true,
      unreadReason: "agent_failed",
    });
  } finally {
    await restored.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("a workflow's end says failed, nothing, or finished from its own record", () => {
  const outcome = (phase: string, fixSession?: { status: string }) =>
    workflowCompletionOutcome({ phase, fixSession } as unknown as MultiReviewWorkflow);
  expect(outcome("failed")).toBe("failed");
  expect(outcome("interactive", { status: "failed" })).toBe("failed");
  expect(outcome("cancelled")).toBe("none");
  expect(outcome("paused")).toBe("none");
  expect(outcome("interactive", { status: "cancelled" })).toBe("none");
  expect(outcome("completed")).toBeUndefined();
  expect(outcome("ready")).toBeUndefined();
  expect(outcome("interactive", { status: "idle" })).toBeUndefined();
  // Only an interactive turn ends on its Address Findings session: a completed workflow's
  // result is its own, whatever an older session record says.
  expect(outcome("completed", { status: "failed" })).toBeUndefined();
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
  const started = await startLegacyReview(first, storage, stableReviewInvoker, {
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

test("MultiReviewService owns fan-out, consolidation, and the interactive Address Findings handoff", async () => {
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
  const started = await startLegacyReview(service, storage, stableReviewInvoker, {
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
  expect(provider.creates).not.toHaveLength(0);
  for (const created of provider.creates) {
    expect(created.options?.policy).toMatchObject({
      id: "pipeline",
      sandbox: "none",
      networkAccess: "full",
    });
  }
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
  const started = await startLegacyReview(service, storage, stableReviewInvoker, {
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
  expect(await storage.getEnvironment("env-idle")).toMatchObject({
    hasUnreadWork: true,
    unreadReason: "agent_failed",
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
  const started = await startLegacyReview(service, storage, stableReviewInvoker, {
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
  expect(await storage.getEnvironment("env-interactive")).toMatchObject({
    hasUnreadWork: true,
    unreadReason: "agent_finished",
  });

  const sendsBeforeAddressFindings = provider.sends.size;
  const addressed = await service.address(started.id);
  await service.advanceNow(started.id);
  expect(addressed.phase).toBe("interactive");
  expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
    phase: "interactive",
    fixSession: { status: "idle" },
  });
  expect(provider.sends.size).toBe(sendsBeforeAddressFindings);
  expect(provider.addressFindingsSends).toBe(0);
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
  const started = await startLegacyReview(service, storage, stableReviewInvoker, {
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
  // Someone asked for the stop, and nothing completed.
  expect((await storage.getEnvironment("env-cancel"))?.agentActivityState).toBe("idle");
  expect((await storage.getEnvironment("env-cancel"))?.hasUnreadWork ?? false).toBe(false);
  const replacement = await startLegacyReview(service, storage, stableReviewInvoker, {
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
  const started = await startLegacyReview(service, storage, stableReviewInvoker, {
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
    MultiReviewWorkflow | undefined;
  const addressFindingsSessionId = cancelling?.fixSession?.providerSessionId;
  expect(addressFindingsSessionId).toBeDefined();
  // The turn ends terminally rather than returning to idle: still settled.
  provider.sessionFailures.set(addressFindingsSessionId!, "Selected model is at capacity");
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
  await startLegacyReview(service, storage, stableReviewInvoker, {
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
  const started = await startLegacyReview(service, storage, stableReviewInvoker, {
    environmentId: "env-lease",
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [{ agent: "claude", model: "opus" }],
    fixModel: { agent: "claude", model: "opus" },
  });
  await waitUntil(() => provider.statusCalls === 1);
  // The storage lease floor is 2 s, so the claim cannot be shortened. The
  // lease clock runs on `Date.now`, so run it three times faster than the wall
  // clock instead: 2.2 s of lease time passes in about 0.73 s, and the 100 ms
  // renewal timer still has to fire on the real clock to keep the lease alive.
  const realNow = Date.now.bind(Date);
  const skewOrigin = realNow();
  const LEASE_CLOCK_SPEED = 3;
  Date.now = () => skewOrigin + (realNow() - skewOrigin) * LEASE_CLOCK_SPEED;
  try {
    await Bun.sleep(Math.ceil(2_200 / LEASE_CLOCK_SPEED));

    const competing = await storage.claimMultiReviewController(
      started.id,
      "competing-owner",
      2_000,
    );
    expect(competing.granted).toBe(false);
  } finally {
    Date.now = realNow;
  }
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
      // It never had a session, so the panel reports it as unable to start.
      startFailed: true,
    });
    expect(current?.reviewers[1]?.providerSessionId).toBeUndefined();
    expect(current?.reviewers[0]?.startFailed).toBeUndefined();
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
    expect(ready?.reviewers[1]?.startFailed).toBe(true);
    expect(ready?.consolidatedReport).toBeDefined();
    const consolidation = [...provider.sends.values()].find((sent) =>
      sent.prompt.includes("<multi-review-reports-json>"),
    );
    expect(consolidation?.prompt).toContain(ready?.reviewers[0]?.id ?? "missing-reviewer");
    expect(consolidation?.prompt).not.toContain(ready?.reviewers[1]?.id ?? "missing-reviewer");
  });
});

test("MultiReviewService fails a reviewer that reports it could not review and consolidates without it", async () => {
  const provider = new Provider();
  provider.blockedReviewerSessions.add("session-1");
  await withService("env-blocked-reviewer", provider, async ({ service, start, snapshot }) => {
    const started = await start([
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "sonnet" },
    ]);
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });

    const ready = await snapshot(started.id);
    const blocked = ready?.reviewers[0];
    // A valid report that says it reviewed nothing is a failed reviewer, not
    // a clean one: no report is kept and the reason is its error.
    expect(blocked).toMatchObject({ model: "opus", status: "failed" });
    expect(blocked?.report).toBeUndefined();
    expect(blocked?.startFailed).toBeUndefined();
    expect(blocked?.error).toBe(`${REVIEW_BLOCKED_ERROR_PREFIX}${BLOCKED_REASON}`);
    expect(reviewerBlockedReason(blocked!)).toBe(BLOCKED_REASON);
    expect(ready?.reviewers[1]).toMatchObject({ model: "sonnet", status: "completed" });
    expect(reviewerBlockedReason(ready!.reviewers[1]!)).toBeNull();
    // Consolidation reads only the reviewer that reviewed.
    const consolidation = [...provider.sends.values()].find((sent) =>
      sent.prompt.includes("<multi-review-reports-json>"),
    );
    expect(consolidation?.prompt).toContain(ready?.reviewers[1]?.id ?? "missing-reviewer");
    expect(consolidation?.prompt).not.toContain(blocked?.id ?? "missing-reviewer");
  });
});

test("MultiReviewService does not consolidate when every reviewer could not review", async () => {
  const provider = new Provider();
  provider.blockedReviewerSessions.add("session-1");
  await withService("env-blocked-panel", provider, async ({ service, start, snapshot }) => {
    const started = await start([{ agent: "claude", model: "opus" }]);
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "failed";
    });
    const failed = await snapshot(started.id);
    expect(failed?.reviewers[0]?.status).toBe("failed");
    expect(failed?.consolidatedReport).toBeUndefined();
    expect(
      [...provider.sends.values()].some((sent) =>
        sent.prompt.includes("<multi-review-reports-json>"),
      ),
    ).toBe(false);
  });
});

test("MultiReviewService fails the review when the consolidator reports it could not review", async () => {
  const provider = new Provider();
  provider.blockedConsolidationReports = 1;
  await withService("env-blocked-consolidation", provider, async ({ service, start, snapshot }) => {
    const started = await start([
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "sonnet" },
    ]);
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "failed";
    });

    // A valid blocked report with no findings is a failed consolidation, not a
    // clean review: nothing becomes ready and no auto-PR is queued.
    const failed = await snapshot(started.id);
    expect(failed?.error).toBe(`${REVIEW_BLOCKED_ERROR_PREFIX}${BLOCKED_REASON}`);
    expect(failed?.consolidatedReport).toBeUndefined();
    expect(failed?.autoPrLaunch).toBeUndefined();
    expect(failed?.activeRequest).toBeUndefined();
    expect(failed?.pendingResultConsumptions).toBeUndefined();
    expect(failed?.reviewers.map((reviewer) => reviewer.status)).toEqual([
      "completed",
      "completed",
    ]);

    // Retrying consolidates again from the reviewers' surviving reports.
    await service.retry(started.id);
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });
    const ready = await snapshot(started.id);
    expect(ready?.consolidatedReport).toBeDefined();
    expect(ready?.error).toBeUndefined();
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
    // It started, so its failure is the review's, not the agent's start.
    expect(current?.reviewers[0]?.startFailed).toBeUndefined();
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
      expect(current?.reviewers[0]).toMatchObject({
        status: "failed",
        error: message,
        completedAt: expect.any(String),
      });
    });
  }
});

test("MultiReviewService retires a failed OpenCode provider after its peer dispatch and reader finish", async () => {
  const dispatch = Promise.withResolvers<void>();
  const reader = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>();
  class SharedProvider extends Provider {
    override readonly agent = "opencode" as const;
    pendingDispatch = false;
    pendingReader = false;
    unsafeDisposal = false;
    override async send(sessionId: string, prompt: string, options: ProviderSendOptions) {
      await super.send(sessionId, prompt, options);
      if (sessionId === "session-1") {
        this.pendingDispatch = true;
        await dispatch.promise;
      }
    }
    override async status(sessionId: string): Promise<ProviderStatus> {
      if (sessionId === "session-2") {
        await failed.promise;
        throw new ProviderUnreachableError("OpenCode is unreachable");
      }
      return "running";
    }
    override async messages(sessionId: string, options?: { limit?: number }) {
      if (this.pendingDispatch) {
        this.pendingReader = true;
        await reader.promise;
      }
      return super.messages(sessionId, options);
    }
    override async dispose() {
      // Model OpenCode's provider-wide abort controllers: immediate disposal
      // would cancel both the dispatch and the UI read.
      if (this.pendingDispatch || this.pendingReader) this.unsafeDisposal = true;
      await super.dispose();
    }
  }
  const provider = new SharedProvider();
  const replacement = new Provider();
  replacement.statusValue = "running";
  let creations = 0;
  await withService(
    "env-shared-provider-retirement",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start([
        { agent: "opencode", model: "provider/one" },
        { agent: "opencode", model: "provider/two" },
      ]);
      const advancing = service.advanceNow(started.id);
      let reading: Promise<unknown> | undefined;
      try {
        await waitUntil(() => provider.pendingDispatch);
        const current = (await snapshot(started.id))!;
        reading = service.reviewerTranscript(started.id, current.reviewers[0]!.id);
        await waitUntil(() => provider.pendingReader);
        failed.resolve();
        await waitUntil(
          async () => ((await snapshot(started.id))?.reviewers[1]?.idleResultPolls ?? 0) > 0,
        );
        expect(provider.disposeCalls).toBe(0);
        provider.pendingDispatch = false;
        dispatch.resolve();
        await advancing;
        expect(provider.disposeCalls).toBe(0);
        expect((await snapshot(started.id))?.reviewers[0]).toMatchObject({
          status: "running",
          dispatchState: "sent",
        });
        expect(provider.aborted).toEqual([]);
        expect(provider.sends.size).toBe(2);
        provider.pendingReader = false;
        reader.resolve();
        await reading;
        await waitUntil(() => provider.disposeCalls === 1);
        await service.advanceNow(started.id);
        expect(creations).toBe(2);
        expect(provider.disposeCalls).toBe(1);
        expect(provider.unsafeDisposal).toBe(false);
      } finally {
        provider.pendingDispatch = false;
        provider.pendingReader = false;
        failed.resolve();
        dispatch.resolve();
        reader.resolve();
        await Promise.allSettled([advancing, ...(reading ? [reading] : [])]);
      }
    },
    { createProvider: async () => (++creations === 1 ? provider : replacement) },
  );
});

/*
 * A local bridge that died cannot answer a status read. That is an
 * observation fault, not the reviewer's: the reviewer keeps its session and
 * request, and the cached provider is dropped so the next pass resolves the
 * connection again, which restarts the bridge.
 */
test("MultiReviewService reconnects a reviewer whose bridge became unreachable", async () => {
  class DeadBridgeProvider extends Provider {
    down = false;
    override async status(sessionId: string): Promise<ProviderStatus> {
      if (this.down) throw new ProviderUnreachableError("claude bridge is not reachable");
      return super.status(sessionId);
    }
  }
  const provider = new DeadBridgeProvider();
  let creations = 0;
  await withService(
    "env-reviewer-unreachable",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      provider.down = true;
      await service.advanceNow(started.id);

      const reconnecting = await snapshot(started.id);
      expect(reconnecting?.phase).toBe("reviewing");
      expect(reconnecting?.reviewers[0]).toMatchObject({
        status: "running",
        providerSessionId: "session-1",
        dispatchState: "sent",
      });
      expect(reconnecting?.reviewers[0]?.idleResultPolls).toBeGreaterThanOrEqual(1);
      expect(reconnecting?.reviewers[0]?.error).toBeUndefined();
      expect(provider.aborted).toEqual([]);
      // The unreachable instance was dropped, so the next pass reconnects.
      const creationsBeforeReconnect = creations;
      provider.down = false;
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      expect(creations).toBeGreaterThan(creationsBeforeReconnect);
      const ready = await snapshot(started.id);
      expect(ready?.reviewers[0]).toMatchObject({
        status: "completed",
        providerSessionId: "session-1",
      });
      expect(provider.aborted).toEqual([]);
    },
    {
      createProvider: async () => {
        creations += 1;
        return provider;
      },
    },
  );
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
      completedAt: expect.any(String),
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

/*
 * Claude releases a turn to idle as soon as its root result arrives, even while
 * background agents it launched keep working, and resumes the turn when they
 * settle. A reviewer that fans out that way must not be failed as idle.
 */
test("MultiReviewService accepts a reviewer report after the last background task settles", async () => {
  const provider = new Provider(false);
  provider.backgroundWorkLive = true;
  await withService("env-background-work", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    for (let attempt = 0; attempt < 8; attempt++) await service.advanceNow(started.id);

    const waiting = await snapshot(started.id);
    expect(waiting?.phase).toBe("reviewing");
    expect(waiting?.reviewers[0]?.status).toBe("running");
    expect(waiting?.reviewers[0]?.idleResultPolls).toBeUndefined();

    provider.backgroundWorkLive = false;
    provider.retainedContinuation = true;
    for (let attempt = 0; attempt < 8; attempt++) await service.advanceNow(started.id);
    expect((await snapshot(started.id))?.reviewers[0]?.status).toBe("running");
    provider.retainedContinuation = false;
    provider.returnStructured = true;
    await service.advanceNow(started.id);
    expect((await snapshot(started.id))?.reviewers[0]?.status).toBe("completed");
  });
});

test("MultiReviewService keeps a released Address Findings turn open until its result arrives", async () => {
  const provider = new Provider(false);
  provider.backgroundWorkLive = true;
  await withService("env-fix-background", provider, async ({ service, storage, snapshot }) => {
    const workflowId = await seedLegacyFixingWorkflow(storage, "env-fix-background");
    for (let attempt = 0; attempt < 8; attempt++) await service.advanceNow(workflowId);
    expect((await snapshot(workflowId))?.phase).toBe("fixing");
    expect((await snapshot(workflowId))?.fixSession?.idleResultPolls).toBeUndefined();
    provider.backgroundWorkLive = false;
    provider.retainedContinuation = true;
    for (let attempt = 0; attempt < 8; attempt++) await service.advanceNow(workflowId);
    expect((await snapshot(workflowId))?.phase).toBe("fixing");
    provider.retainedContinuation = false;
    provider.returnStructured = true;
    await service.advanceNow(workflowId);
    expect((await snapshot(workflowId))?.phase).not.toBe("failed");
  });
});

test("MultiReviewService keeps preparation open while background work finishes", async () => {
  const provider = new Provider(false);
  provider.backgroundWorkLive = true;
  await withService(
    "env-prep-background",
    provider,
    async ({ service, snapshot }) => {
      const started = await service.start({
        environmentId: "env-prep-background",
        projectId: "project-1",
        targetBranch: "main",
        reviewers: [{ agent: "claude", model: "reviewer" }],
        reviewModel: { agent: "claude", model: "preparation-model" },
        fixModel: { agent: "codex", model: "fix-model" },
      });
      for (let attempt = 0; attempt < 8; attempt++) await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.phase).not.toBe("failed");
      expect((await snapshot(started.id))?.activeRequest?.idleResultPolls).toBeUndefined();
      provider.backgroundWorkLive = false;
      provider.returnStructured = true;
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.phase).not.toBe("failed");
    },
    { packageFlow: true },
  );
});

test("MultiReviewService keeps consolidation open while background work finishes", async () => {
  const provider = new Provider();
  const send = provider.send.bind(provider);
  provider.send = async (sessionId, prompt, options) => {
    await send(sessionId, prompt, options);
    if (prompt.includes("<multi-review-reports-json>")) {
      provider.returnStructured = false;
      provider.backgroundWorkLive = true;
    }
  };
  await withService(
    "env-consolidation-background",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.activeRequest?.kind === "consolidate";
      });
      for (let attempt = 0; attempt < 8; attempt++) await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.phase).toBe("consolidating");
      expect((await snapshot(started.id))?.activeRequest?.idleResultPolls).toBeUndefined();
      provider.backgroundWorkLive = false;
      provider.returnStructured = true;
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.phase).not.toBe("failed");
    },
  );
});

test("MultiReviewService identifies the preparation model when it returns no result", async () => {
  const provider = new Provider(false);
  await withService(
    "env-idle-preparation-model",
    provider,
    async ({ service, snapshot }) => {
      const started = await service.start({
        environmentId: "env-idle-preparation-model",
        projectId: "project-1",
        targetBranch: "main",
        reviewers: [{ agent: "claude", model: "reviewer" }],
        reviewModel: { agent: "opencode", model: "preparation-model" },
        fixModel: { agent: "codex", model: "fix-model" },
      });
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "failed";
      });

      expect(await snapshot(started.id)).toMatchObject({
        phase: "failed",
        activeRequest: { kind: "prepare" },
        reviewSession: { agent: "opencode", model: "preparation-model" },
        error: "The preparation model became idle without returning its review package preparation",
      });
      expect((await snapshot(started.id))?.fixSession).toBeUndefined();
    },
    { packageFlow: true },
  );
});

test("MultiReviewService bounds a blocked consolidation model", async () => {
  const provider = new Provider();
  provider.statusOverrides.set("session-2", "blocked");
  await withService("env-blocked-fix", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    for (let attempt = 0; attempt < 8; attempt++) await service.advanceNow(started.id);

    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    expect(failed?.error).toBe(
      "The consolidation model stayed blocked without a resolvable interaction",
    );
  });
});

test("MultiReviewService retries a failed reviewer without stranding its provider session", async () => {
  const provider = new Provider(false);
  provider.idempotentSessionKeys = true;
  provider.usageTokens = 777;
  const reason = "The previous session had no command sandbox.";
  provider.commandSandboxOff = reason;
  await withService("env-retry-reviewer", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    for (let attempt = 0; attempt < 7; attempt++) await service.advanceNow(started.id);
    const failed = await snapshot(started.id);
    expect(failed?.phase).toBe("failed");
    expect(failed?.reviewers[0]).toMatchObject({
      status: "failed",
      providerSessionId: "session-1",
      tokenCount: 777,
      commandSandboxOff: reason,
    });

    provider.commandSandboxOff = undefined;
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
    expect(retried.reviewers[0]?.tokenCount).toBeUndefined();
    expect(retried.reviewers[0]?.commandSandboxOff).toBeUndefined();

    // The retry runs against a brand new session rather than the abandoned one.
    await waitUntil(
      async () => (await snapshot(started.id))?.reviewers[0]?.providerSessionId === "session-2",
    );
    await service.advanceNow(started.id);
    const fresh = (await snapshot(started.id))!.reviewers[0]!;
    expect(fresh.providerSessionId).toBe("session-2");
    expect(fresh.commandSandboxOff).toBeUndefined();
  });
});

test("MultiReviewService does not abort an interactive Address Findings session on cancel", async () => {
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

test("MultiReviewService retries a failed consolidation with a fresh Address Findings session", async () => {
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

test("MultiReviewService progresses with its session viewer closed and no active renderer, then rehydrates and cleans up", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  await withService(
    "env-hidden-review",
    provider,
    async ({ service, storage, start, snapshot, dataDir }) => {
      await service.init();
      const started = await start();
      await waitUntil(async () =>
        Boolean((await snapshot(started.id))?.reviewers[0]?.providerSessionId),
      );
      const reviewer = (await snapshot(started.id))!.reviewers[0]!;
      const logicalSessionKey = "env-env-hidden-review:reviewer-viewer";
      const key = nativeAgentSessionStorageKey(
        started.environmentId,
        reviewer.agent,
        logicalSessionKey,
      );
      await storage.adoptNativeAgentSession({
        key,
        environmentId: started.environmentId,
        agent: reviewer.agent,
        logicalSessionKey,
        providerSessionId: reviewer.providerSessionId!,
        origin: "interactive-native",
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      });
      const commands = createCommandRegistry();
      const context = { storage, multiReviews: service } as unknown as CommandContext;
      await commands.get("teardown_tab")!(
        {
          environmentId: started.environmentId,
          tabId: "reviewer-viewer",
          kind: "claude-native",
        },
        context,
      );
      expect(await storage.getNativeAgentSession(key)).toBeNull();
      expect(provider.closed).toEqual([]);
      expect(provider.aborted).toEqual([]);

      // The renderer is absent throughout this progression; no tab subscription
      // or active-environment callback drives the backend supervisor.
      provider.statusValue = "idle";
      await waitUntil(async () => (await snapshot(started.id))?.phase === "ready");
      const authoritative = (await snapshot(started.id))!;
      expect(authoritative.reviewers[0]?.status).toBe("completed");
      expect(authoritative.consolidatedReport).toBeDefined();
      // Returning to the environment reads persisted state, including a fresh
      // storage instance to prove recovery does not depend on missed events.
      const reloaded = new StorageService(dataDir);
      await reloaded.init();
      const returned = await commands.get("get_multi_review_workflow")!(
        { workflowId: started.id },
        { storage: reloaded } as CommandContext,
      );
      expect(returned).toMatchObject({
        snapshot: {
          phase: "ready",
          reviewers: [{ status: "completed" }],
          consolidatedReport: authoritative.consolidatedReport,
        },
      });
      const transcript = await service.reviewerTranscript(started.id, reviewer.id);
      expect(transcript.status).toBe("completed");
      await service.cancel(started.id);
      await commands.get("delete_multi_review_workflow")!({ workflowId: started.id }, context);
      expect(provider.closed).toContain(reviewer.providerSessionId!);
      expect(await storage.getMultiReviewWorkflow(started.id)).toBeNull();
      expect(await storage.listNativeAgentSessions()).toEqual([]);
    },
    {
      serviceOptions: {
        autoAdvance: true,
        pollIntervalMs: 10,
        observationIntervalMs: 10,
        reconcileIntervalMs: 30,
      },
    },
  );
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

test("MultiReviewService moves the queued reviewers up when one is stopped", async () => {
  const provider = new Provider();
  await withService("env-stop-queued", provider, async ({ service, storage }) => {
    const timestamp = new Date().toISOString();
    const workflow: MultiReviewWorkflow = {
      version: 1,
      controller: "backend",
      id: "queued-panel",
      environmentId: "env-stop-queued",
      projectId: "project-1",
      targetBranch: "main",
      // As a pass that stopped early leaves its panel: waiting in panel order.
      reviewers: Array.from({ length: 4 }, (_, index) => ({
        id: `reviewer-${index + 1}`,
        agent: "claude" as const,
        model: "opus",
        status: "pending" as const,
        admissionState: "queued" as const,
        queuePosition: index + 1,
      })),
      fixModel: { agent: "claude", model: "opus" },
      phase: "reviewing",
      createdAt: timestamp,
      updatedAt: timestamp,
      backendRevision: 0,
      reviewWorktreeSnapshot: await captureReviewWorktreeSnapshot(
        stableReviewInvoker,
        "env-stop-queued",
        "Multi Review",
      ),
    };
    expect(
      await storage.createMultiReviewWorkflowIfNoActive(
        workflow.id,
        workflow.environmentId,
        1,
        workflow,
      ),
    ).not.toBeNull();

    const stopped = await service.stopReviewer(workflow.id, "reviewer-2");
    expect(
      stopped.reviewers.map((reviewer) => [
        reviewer.status,
        reviewer.admissionState ?? null,
        reviewer.queuePosition ?? null,
      ]),
    ).toEqual([
      ["pending", "queued", 1],
      ["cancelled", null, null],
      ["pending", "queued", 2],
      ["pending", "queued", 3],
    ]);
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
    // Only the reviewer that finished may reach the Address Findings model.
    const consolidation = [...provider.sends.values()].find((sent) =>
      sent.prompt.includes("<multi-review-reports-json>"),
    )!;
    expect(consolidation.prompt).toContain(ready.reviewers[1]!.id);
    expect(consolidation.prompt).not.toContain(ready.reviewers[0]!.id);
  });
});

test.each(["reviewer", "prepare", "retry", "stale-retry"] as const)(
  "MultiReviewService clears spent reviewer follow-up budgets on %s",
  async (kind) => {
    const provider = new Provider(false);
    provider.statusValue = "running";
    const environmentId = `env-reminder-reset-${kind}`;
    await withService(environmentId, provider, async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await service.advanceNow(started.id);
      const stored = (await storage.getMultiReviewWorkflow(started.id))!;
      const workflow = stored.snapshot as MultiReviewWorkflow;
      const reviewer = workflow.reviewers[0]!;
      const oldSession = reviewer.providerSessionId!;
      const oldRequest = reviewer.requestId!;
      reviewer.resultReminderSent = true;
      reviewer.restartContinuationSent = true;
      reviewer.schemaRepairAttempts = 1;
      reviewer.cacheReadTokens = 600;
      reviewer.status = "failed";
      reviewer.error = "The reviewer finished without submitting its report";
      if (kind === "retry" || kind === "stale-retry") workflow.phase = "failed";
      if (kind === "stale-retry") {
        workflow.reviewPackage = testGeneratedReviewPackage({
          packageId: randomUUID(),
          round: 1,
          targetBranch: "main",
        }) as unknown as NonNullable<MultiReviewWorkflow["reviewPackage"]>;
        workflow.reviewSnapshotStale = true;
      }
      await storage.saveMultiReviewWorkflow(
        started.id,
        environmentId,
        1,
        workflow,
        stored.revision,
      );

      const reset =
        kind === "reviewer"
          ? await service.restartReviewer(started.id, reviewer.id)
          : kind === "prepare"
            ? await service.restartStep(started.id, "prepare")
            : await service.retry(started.id);
      expect(reset.reviewers[0]?.resultReminderSent).toBeUndefined();
      expect(reset.reviewers[0]?.restartContinuationSent).toBeUndefined();
      expect(reset.reviewers[0]?.schemaRepairAttempts).toBeUndefined();
      expect(reset.reviewers[0]?.status).toBe("pending");
      expect(reset.reviewers[0]).not.toHaveProperty("cacheReadTokens");
      expect((await snapshot(started.id))?.reviewers[0]).not.toHaveProperty("cacheReadTokens");
      expect(reset.reviewers[0]?.providerSessionId).toBeUndefined();
      expect(provider.aborted).toContain(oldSession);
      expect((await snapshot(started.id))?.reviewers[0]?.resultReminderSent).toBeUndefined();
      expect((await snapshot(started.id))?.reviewers[0]?.restartContinuationSent).toBeUndefined();
      if (kind === "reviewer" || kind === "retry") {
        await waitUntil(async () => {
          await service.advanceNow(started.id);
          return (await snapshot(started.id))?.reviewers[0]?.dispatchState === "sent";
        });
        const fresh = (await snapshot(started.id))!.reviewers[0]!;
        expect(fresh.providerSessionId).not.toBe(oldSession);
        expect(fresh.requestId).not.toBe(oldRequest);
        expect(fresh.resultReminderSent).toBeUndefined();
        expect(fresh.restartContinuationSent).toBeUndefined();
        expect(fresh).not.toHaveProperty("cacheReadTokens");
        expect(provider.sends.get(fresh.requestId!)?.prompt).toContain(
          "You are independent reviewer",
        );
      }
    });
  },
);

test("MultiReviewService restarts only the selected reviewer in a fresh session", async () => {
  const provider = new Provider();
  provider.idempotentSessionKeys = true;
  provider.statusValue = "running";
  provider.usageTokens = 888;
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
    expect(restarted.reviewers[0]?.tokenCount).toBeUndefined();
    expect(restarted.reviewers[1]).toMatchObject({
      id: second.id,
      status: "running",
      providerSessionId: second.providerSessionId,
      tokenCount: 888,
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

test("MultiReviewService records each reviewer's lens as launched and drops a blank one", async () => {
  await withService(
    "env-lens-record",
    new Provider(),
    async ({ start, snapshot }) => {
      const started = await start([
        { agent: "claude", model: "opus", lens: { label: " Security ", instruction: " Trace. " } },
        { agent: "claude", model: "sonnet" },
      ]);
      const saved = (await snapshot(started.id))!;
      expect(saved.reviewers[0]!.lens).toEqual({ label: "Security", instruction: "Trace." });
      expect(saved.reviewers[1]).not.toHaveProperty("lens");
      expect(isMultiReviewWorkflow(saved)).toBe(true);
    },
    { packageFlow: true },
  );
});

test("MultiReviewService keeps a reviewer's lens through dispatch, restart and later preset edits", async () => {
  const provider = new Provider();
  provider.idempotentSessionKeys = true;
  provider.statusValue = "running";
  await withService("env-lens-restart", provider, async ({ service, start, snapshot, storage }) => {
    const lens = { label: "Security", instruction: "Trace untrusted input to its sinks." };
    const started = await start([
      { agent: "claude", model: "opus", lens },
      { agent: "claude", model: "sonnet" },
    ]);
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      const current = await snapshot(started.id);
      return current?.reviewers.every((reviewer) => reviewer.dispatchState === "sent") ?? false;
    });
    const running = (await snapshot(started.id))!;
    const prompts = running.reviewers.map(
      (reviewer) => provider.sends.get(reviewer.requestId!)!.prompt,
    );
    expect(prompts[0]!.endsWith(reviewLensSection(lens))).toBe(true);
    expect(prompts[0]).toContain(`${reviewerPanelSection(1, 2)}\n\n${reviewLensSection(lens)}`);
    expect(prompts[1]!.endsWith(reviewerPanelSection(2, 2))).toBe(true);
    expect(prompts[0]!.slice(0, prompts[0]!.indexOf(reviewerPanelSection(1, 2)))).toBe(
      prompts[1]!.slice(0, prompts[1]!.indexOf(reviewerPanelSection(2, 2))),
    );

    // The preset the lens came from is edited, then deleted: the review keeps its text.
    const config = await storage.loadConfig();
    await storage.updateGlobalConfig({
      ...config.global,
      reviewLensPresets: [{ id: "security", label: "Security", instruction: "Edited later." }],
    });
    await storage.updateGlobalConfig({ ...config.global, reviewLensPresets: [] });
    expect((await snapshot(started.id))!.reviewers[0]!.lens).toEqual(lens);

    const first = running.reviewers[0]!;
    const restarted = await service.restartReviewer(started.id, first.id);
    expect(restarted.reviewers[0]!.lens).toEqual(lens);
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      const reviewer = (await snapshot(started.id))?.reviewers[0];
      return reviewer?.dispatchState === "sent" && reviewer.requestId !== first.requestId;
    });
    const fresh = (await snapshot(started.id))!.reviewers[0]!;
    expect(fresh.lens).toEqual(lens);
    const restartedPrompt = provider.sends.get(fresh.requestId!)!.prompt;
    expect(restartedPrompt.endsWith(reviewLensSection(lens))).toBe(true);
    expect(restartedPrompt).not.toContain("Edited later.");
  });
});

test("MultiReviewService rewinds consolidation when a completed reviewer is restarted", async () => {
  const provider = new Provider();
  provider.idempotentSessionKeys = true;
  provider.usageTokens = 999;
  await withService(
    "env-restart-ready-reviewer",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        workflow.stepRuntimes = {
          ...workflow.stepRuntimes,
          prepare: {
            startedAt: "2026-08-14T00:00:00.000Z",
            completedAt: "2026-08-14T00:01:00.000Z",
            tokenCount: 10_000,
            tokenBaseline: 0,
          },
          fix: { startedAt: "2026-08-14T00:10:00.000Z", tokenBaseline: 20_000 },
        };
      });
      const ready = (await snapshot(started.id))!;
      expect(ready.consolidationOverlap).toBeDefined();
      const reviewerSessionId = ready.reviewers[0]!.providerSessionId!;
      const addressFindingsSessionId = ready.fixSession!.providerSessionId;
      const reviewerSessionKey = ready.reviewers[0]!.sessionKey!;
      const addressFindingsKey = ready.fixSession!.sessionKey;

      const restarted = await service.restartReviewer(started.id, ready.reviewers[0]!.id);
      expect(restarted.phase).toBe("reviewing");
      expect(restarted.reviewers[0]).toMatchObject({ status: "pending" });
      expect(restarted.reviewers[0]?.report).toBeUndefined();
      expect(restarted.reviewers[0]?.tokenCount).toBeUndefined();
      expect(restarted.consolidatedReport).toBeUndefined();
      expect(restarted.consolidationOverlap).toBeUndefined();
      expect((await snapshot(started.id))?.consolidationOverlap).toBeUndefined();
      expect(restarted.fixSession).toBeUndefined();
      expect(restarted.activeRequest).toBeUndefined();
      expect(restarted.stepRuntimes?.prepare).toBeDefined();
      expect(restarted.stepRuntimes?.consolidate).toBeUndefined();
      expect(restarted.stepRuntimes?.fix).toBeUndefined();
      expect(restarted.reviewers[0]?.sessionKey).not.toBe(reviewerSessionKey);
      expect(restarted.fixSessionKey).not.toBe(addressFindingsKey);
      expect(provider.aborted).toEqual(
        expect.arrayContaining([reviewerSessionId, addressFindingsSessionId]),
      );

      await waitUntil(async () => {
        await service.advanceNow(started.id);
        const workflow = await snapshot(started.id);
        return workflow?.phase === "interactive" && workflow.addressPromptPending !== true;
      });
      const reconsolidated = (await snapshot(started.id))!;
      expect(reconsolidated.consolidationOverlap).toBeDefined();
      expect(reconsolidated.reviewers[0]?.providerSessionId).not.toBe(reviewerSessionId);
      expect(reconsolidated.fixSession?.providerSessionId).not.toBe(addressFindingsSessionId);
      expect(reconsolidated.fixSession?.sessionKey).toStartWith(
        `multi-review:${started.id}:interactive:`,
      );
      expect(reconsolidated.fixSessionKey).toBe(restarted.fixSessionKey);
      expect(reconsolidated.restartFixAfterConsolidation).toBeUndefined();
    },
    {
      serviceOptions: {
        dispatchAddressFindingsPrompt: async (workflow, _presentation) => ({
          tabId: workflow.addressTabId!,
          fixSession: {
            ...workflow.fixModel,
            sessionKey: workflow.addressSessionKey!,
            providerSessionId: "provider-restarted-fix",
            requestIds: [workflow.addressRequestId!],
            status: "running",
            startedAt: new Date().toISOString(),
          },
        }),
      },
    },
  );
});

test("MultiReviewService gives restarted auto-fix a fresh durable identity", async () => {
  const provider = new Provider();
  provider.reviewerReport = consolidatedReport;
  provider.idempotentSessionKeys = true;
  const dispatches: Array<{
    sessionKey: string;
    requestId: string;
    tabId: string;
  }> = [];
  await withService(
    "env-restart-auto-fix",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (
          dispatches.length === 1 && (await snapshot(started.id))?.addressPromptPending !== true
        );
      });
      const first = dispatches[0]!;
      expect(first).toEqual({
        sessionKey: `multi-review:${started.id}:interactive`,
        requestId: `multi-review-address:${started.id}`,
        tabId: `multi-review-fix:${started.id}`,
      });

      const interactive = (await snapshot(started.id))!;
      const restarted = await service.restartReviewer(started.id, interactive.reviewers[0]!.id);
      expect(restarted.restartFixAfterConsolidation).toBe(true);
      expect(restarted.phase).toBe("reviewing");

      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (
          dispatches.length === 2 && (await snapshot(started.id))?.addressPromptPending !== true
        );
      });
      const replayed = dispatches[1]!;
      expect(replayed.sessionKey).toStartWith(`multi-review:${started.id}:interactive:`);
      expect(replayed.requestId).toStartWith(`multi-review-address:${started.id}:`);
      expect(replayed.tabId).toStartWith(`multi-review-fix:${started.id}:`);
      expect(replayed).not.toEqual(first);
      expect((await snapshot(started.id))?.restartFixAfterConsolidation).toBeUndefined();
    },
    {
      autoFix: true,
      packageFlow: true,
      serviceOptions: {
        dispatchAddressFindingsPrompt: async (workflow) => {
          dispatches.push({
            sessionKey: workflow.addressSessionKey!,
            requestId: workflow.addressRequestId!,
            tabId: workflow.addressTabId!,
          });
          return {
            tabId: workflow.addressTabId!,
            fixSession: {
              ...workflow.fixModel,
              sessionKey: workflow.addressSessionKey!,
              providerSessionId: `provider-auto-fix-${dispatches.length}`,
              requestIds: [workflow.addressRequestId!],
              status: "running",
              startedAt: new Date().toISOString(),
            },
          };
        },
      },
    },
  );
});

test("MultiReviewService invalidates incomplete fix work when a reviewer restarts", async () => {
  const provider = new Provider();
  provider.addressFindingsComplete = false;
  await withService("env-restart-after-fix", provider, async ({ service, storage, snapshot }) => {
    const workflowId = await seedLegacyFixingWorkflow(storage, "env-restart-after-fix");
    await waitUntil(async () => {
      await service.advanceNow(workflowId);
      return (await snapshot(workflowId))?.phase === "failed";
    });
    const failed = (await snapshot(workflowId))!;
    const reviewerId = failed.reviewers[0]!.id;
    const restarted = await service.restartReviewer(workflowId, reviewerId);
    expect(restarted.phase).toBe("reviewing");
    expect(restarted.reviewers[0]).toMatchObject({ status: "pending" });
    expect(restarted.consolidatedReport).toBeUndefined();
    expect(restarted.fixSession).toBeUndefined();
    expect(restarted.fixResult).toBeUndefined();
    expect(restarted.restartFixAfterConsolidation).toBe(true);
    expect(provider.aborted).toContain(failed.fixSession!.providerSessionId);

    const claim = await storage.claimMultiReviewController(workflowId, "other-owner", 15_000);
    expect(claim.granted).toBe(false);
  });
});

test("MultiReviewService restarts preparation and reruns reviewers and consolidation", async () => {
  const provider = new Provider();
  await withService(
    "env-restart-preparation",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const ready = (await snapshot(started.id))!;
      expect(ready.consolidationOverlap).toBeDefined();
      const reviewerSessionId = ready.reviewers[0]!.providerSessionId!;

      const restarted = await service.restartStep(started.id, "prepare", {
        agent: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
      });
      expect(restarted.phase).toBe("preparing");
      expect(restarted.reviewModel).toEqual({
        agent: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
      });
      expect(restarted.reviewPackage).toBeUndefined();
      expect(restarted.consolidatedReport).toBeUndefined();
      expect(restarted.consolidationOverlap).toBeUndefined();
      expect((await snapshot(started.id))?.consolidationOverlap).toBeUndefined();
      expect(restarted.reviewers[0]).toMatchObject({ status: "pending" });
      expect(restarted.reviewers[0]?.providerSessionId).toBeUndefined();

      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const rerun = (await snapshot(started.id))!;
      expect(rerun.reviewers[0]?.providerSessionId).not.toBe(reviewerSessionId);
      expect(rerun.reviewers[0]?.status).toBe("completed");
      expect(rerun.consolidatedReport).toBeDefined();
      expect(rerun.consolidationOverlap).toBeDefined();
    },
    { packageFlow: true },
  );
});

test("MultiReviewService pauses and resumes preparation in the retained provider session", async () => {
  const provider = new Provider(false);
  await withService(
    "env-pause-preparation",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        const current = await snapshot(started.id);
        return current?.activeRequest?.kind === "prepare" && current.activeRequest.state === "sent";
      });
      const running = (await snapshot(started.id))!;
      const requestId = running.activeRequest!.requestId;
      const providerSessionId = (running.reviewSession ?? running.fixSession)!.providerSessionId;

      await storage.setEnvironmentUnread(started.environmentId, false);
      const paused = await service.pauseStep(started.id, "prepare");
      expect(paused).toMatchObject({
        phase: "paused",
        pausedFromPhase: "preparing",
        pausedStep: "prepare",
      });
      expect(await storage.getEnvironment(started.environmentId)).toMatchObject({
        hasUnreadWork: false,
        agentActivityState: "idle",
      });
      expect((await storage.getEnvironment(started.environmentId))!.unreadReason).toBeUndefined();
      expect(paused.activeRequest).toBeUndefined();
      expect((paused.reviewSession ?? paused.fixSession)?.status).toBe("idle");
      expect(provider.aborted).toContain(providerSessionId);
      expect(isMultiReviewWorkflow(paused)).toBe(true);

      const resumed = await service.resumeStep(started.id, "prepare");
      expect(resumed.phase).toBe("preparing");
      expect(resumed.pausedFromPhase).toBeUndefined();
      expect(resumed.pausedStep).toBeUndefined();
      await waitUntil(async () => {
        const current = await snapshot(started.id);
        return (
          current?.activeRequest?.kind === "prepare" &&
          current.activeRequest.state === "sent" &&
          current.activeRequest.requestId !== requestId
        );
      });
      const redispatched = (await snapshot(started.id))!;
      expect((redispatched.reviewSession ?? redispatched.fixSession)?.providerSessionId).toBe(
        providerSessionId,
      );
    },
    { packageFlow: true },
  );
});

test("MultiReviewService remains paused until provider stop is confirmed", async () => {
  const provider = new Provider(false);
  await withService(
    "env-pause-unconfirmed",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.activeRequest?.state === "sent";
      });
      provider.statusValue = "running";

      const paused = await service.pauseStep(started.id, "prepare");
      expect(paused.phase).toBe("paused");
      expect(paused.activeRequest?.kind).toBe("prepare");
      expect(paused.error).toContain("stopping the active work could not be confirmed");

      const stillPaused = await service.resumeStep(started.id, "prepare");
      expect(stillPaused.phase).toBe("paused");
      expect(stillPaused.error).toContain("remains paused");

      provider.statusValue = "idle";
      const resumed = await service.resumeStep(started.id, "prepare");
      expect(resumed.phase).toBe("preparing");
      expect(resumed.error).toBeUndefined();
    },
    { packageFlow: true },
  );
});

test("MultiReviewService keeps failed validation cancellation supervised until retry succeeds", async () => {
  const provider = new Provider(false);
  let cancellationAttempts = 0;
  await withService(
    "env-pause-validation-reconcile",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.activeRequest?.kind === "prepare";
      });
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        delete workflow.activeRequest;
        const session = workflow.reviewSession ?? workflow.fixSession;
        if (session) {
          session.status = "idle";
          session.completedAt = new Date().toISOString();
        }
        workflow.validationRun = newReviewValidationRun("pause-validation", {
          headRef: REVIEW_HEAD,
          commands: [
            {
              id: "check",
              command: "mise run check",
              cwd: ".",
              dependsOn: [],
              resources: ["*"],
              weight: 1,
              timeoutMs: 60_000,
            },
          ],
          limitations: [],
        });
        workflow.validationRun.status = "running";
        workflow.validationRun.results[0]!.status = "running";
      });

      const paused = await service.pauseStep(started.id, "prepare");
      expect(paused).toMatchObject({
        phase: "paused",
        pausedFromPhase: "preparing",
        pausedStep: "prepare",
        validationRun: { status: "running" },
      });
      expect(paused.error).toContain("validation: validation cancellation unavailable");
      expect(await storage.getEnvironment(started.environmentId)).toMatchObject({
        agentActivitySources: { "multi-review": { state: "working" } },
      });

      await service.advanceNow(started.id);
      const reconciled = (await snapshot(started.id))!;
      expect(reconciled.phase).toBe("paused");
      expect(reconciled.validationRun).toBeUndefined();
      expect(reconciled.error).toBeUndefined();
      expect(cancellationAttempts).toBe(2);
      expect(await storage.getEnvironment(started.environmentId)).toMatchObject({
        agentActivitySources: { "multi-review": { state: "idle" } },
      });
    },
    {
      packageFlow: true,
      invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        if (command === "cancel_review_validation") {
          cancellationAttempts += 1;
          if (cancellationAttempts === 1) throw new Error("validation cancellation unavailable");
          return {
            ...(args?.run as object),
            status: "cancelled",
            completedAt: new Date().toISOString(),
          } as T;
        }
        return stableReviewInvoker<T>(command, args);
      },
    },
  );
});

test("MultiReviewService propagates a fence loss after validation cancellation", async () => {
  const provider = new Provider(false);
  let invalidateFence = false;
  await withService(
    "env-pause-validation-fence",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.activeRequest?.kind === "prepare";
      });
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        delete workflow.activeRequest;
        const session = workflow.reviewSession ?? workflow.fixSession;
        if (session) session.status = "idle";
        workflow.validationRun = newReviewValidationRun("pause-validation-fence", {
          headRef: REVIEW_HEAD,
          commands: [
            {
              id: "check",
              command: "mise run check",
              cwd: ".",
              dependsOn: [],
              resources: ["*"],
              weight: 1,
              timeoutMs: 60_000,
            },
          ],
          limitations: [],
        });
      });
      const validate = storage.validateMultiReviewController.bind(storage);
      storage.validateMultiReviewController = (async (...args: Parameters<typeof validate>) =>
        invalidateFence
          ? false
          : validate(...args)) as typeof storage.validateMultiReviewController;
      try {
        await expect(service.pauseStep(started.id, "prepare")).rejects.toThrow(
          "Multi review controller lease was lost",
        );
      } finally {
        storage.validateMultiReviewController = validate;
      }
      expect((await snapshot(started.id))?.phase).toBe("preparing");
    },
    {
      packageFlow: true,
      invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        if (command === "cancel_review_validation") {
          invalidateFence = true;
          return args?.run as T;
        }
        return stableReviewInvoker<T>(command, args);
      },
    },
  );
});

test("MultiReviewService pauses and resumes consolidation in its retained session", async () => {
  const provider = new Provider();
  const send = provider.send.bind(provider);
  provider.send = async (sessionId, prompt, options) => {
    await send(sessionId, prompt, options);
    if (prompt.includes("<multi-review-reports-json>")) {
      provider.statusOverrides.set(sessionId, "running");
    }
  };
  await withService("env-pause-consolidation", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      const current = await snapshot(started.id);
      return (
        current?.activeRequest?.kind === "consolidate" && current.activeRequest.state === "sent"
      );
    });
    const running = (await snapshot(started.id))!;
    const requestId = running.activeRequest!.requestId;
    const providerSessionId = (running.reviewSession ?? running.fixSession)!.providerSessionId;

    provider.statusOverrides.set(providerSessionId, "idle");
    const paused = await service.pauseStep(started.id, "consolidate");
    expect(paused).toMatchObject({
      phase: "paused",
      pausedFromPhase: "consolidating",
      pausedStep: "consolidate",
    });
    expect(paused.validationRun).toBeUndefined();
    expect(paused.activeRequest).toBeUndefined();
    expect((paused.reviewSession ?? paused.fixSession)?.status).toBe("idle");

    provider.statusOverrides.set(providerSessionId, "running");
    const resumed = await service.resumeStep(started.id, "consolidate");
    expect(resumed.phase).toBe("consolidating");
    await waitUntil(async () => {
      const current = await snapshot(started.id);
      return (
        current?.activeRequest?.kind === "consolidate" &&
        current.activeRequest.state === "sent" &&
        current.activeRequest.requestId !== requestId
      );
    });
    expect((await snapshot(started.id))?.fixSession?.providerSessionId).toBe(providerSessionId);
  });
});

test("MultiReviewService rejects pause and resume controls for the wrong step", async () => {
  const provider = new Provider(false);
  await withService(
    "env-pause-wrong-step",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.activeRequest?.kind === "prepare";
      });

      await expect(service.pauseStep(started.id, "consolidate")).rejects.toThrow(
        "The consolidation step is not running",
      );
      const paused = await service.pauseStep(started.id, "prepare");
      expect(paused.phase).toBe("paused");
      await expect(service.resumeStep(started.id, "consolidate")).rejects.toThrow(
        "The consolidation step is not paused",
      );
    },
    { packageFlow: true },
  );
});

test("MultiReviewService clears paused markers when paused reconciliation fails", async () => {
  const provider = new Provider(false);
  await withService(
    "env-paused-failure-normalization",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.activeRequest?.kind === "prepare";
      });
      provider.statusValue = "idle";
      await service.pauseStep(started.id, "prepare");
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        const session = workflow.reviewSession ?? workflow.fixSession;
        if (session) session.status = "running";
      });

      const originalSave = storage.saveMultiReviewWorkflow.bind(storage);
      let rejectNextSave = true;
      storage.saveMultiReviewWorkflow = (async (...args: Parameters<typeof originalSave>) => {
        if (rejectNextSave) {
          rejectNextSave = false;
          throw new Error("paused reconciliation save failed");
        }
        return originalSave(...args);
      }) as typeof storage.saveMultiReviewWorkflow;
      try {
        await service.advanceNow(started.id);
      } finally {
        storage.saveMultiReviewWorkflow = originalSave;
      }

      const failed = (await snapshot(started.id))!;
      expect(failed.phase).toBe("failed");
      expect(failed.pausedFromPhase).toBeUndefined();
      expect(failed.pausedStep).toBeUndefined();
      expect(failed.error).toContain("paused reconciliation save failed");
      expect(isMultiReviewWorkflow(failed)).toBe(true);
      await expect(service.pauseStep(started.id, "prepare")).rejects.toThrow(
        "The preparation step is not running",
      );
    },
    { packageFlow: true },
  );
});

test("MultiReviewService rejects pausing the interactive Address Findings step", async () => {
  const provider = new Provider();
  await withService(
    "env-pause-interactive-fix",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      await service.address(started.id);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);

      await expect(service.pauseStep(started.id, "fix")).rejects.toThrow(
        "The Address Findings step is not running",
      );
    },
    {
      serviceOptions: {
        dispatchAddressFindingsPrompt: async (workflow) => ({
          tabId: workflow.addressTabId!,
          fixSession: {
            ...workflow.fixModel,
            sessionKey: workflow.addressSessionKey!,
            providerSessionId: "interactive-fix-not-pausable",
            requestIds: [workflow.addressRequestId!],
            status: "running",
            startedAt: new Date().toISOString(),
          },
        }),
      },
    },
  );
});

test("MultiReviewService restarts consolidation without rerunning completed reviewers", async () => {
  const provider = new Provider();
  await withService("env-restart-consolidation", provider, async ({ service, snapshot }) => {
    const preparationModel = {
      agent: "claude" as const,
      model: "sonnet",
      reasoningEffort: "medium",
    };
    const started = await service.start({
      environmentId: "env-restart-consolidation",
      projectId: "project-1",
      targetBranch: "main",
      reviewers: [{ agent: "claude", model: "opus" }],
      reviewModel: preparationModel,
      fixModel: { agent: "claude", model: "opus" },
    });
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });
    const ready = (await snapshot(started.id))!;
    expect(ready.consolidationOverlap).toBeDefined();
    const reviewerSessionId = ready.reviewers[0]!.providerSessionId!;
    const consolidationSessionId = ready.reviewSession!.providerSessionId;

    const restarted = await service.restartStep(started.id, "consolidate", {
      agent: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    expect(restarted.phase).toBe("consolidating");
    expect(restarted.reviewModel).toEqual(preparationModel);
    expect(restarted.consolidationModel).toEqual({
      agent: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    expect(restarted.reviewers[0]).toMatchObject({
      status: "completed",
      providerSessionId: reviewerSessionId,
    });
    expect(restarted.consolidatedReport).toBeUndefined();
    expect(restarted.consolidationOverlap).toBeUndefined();
    expect((await snapshot(started.id))?.consolidationOverlap).toBeUndefined();

    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });
    const rerun = (await snapshot(started.id))!;
    expect(rerun.reviewers[0]?.providerSessionId).toBe(reviewerSessionId);
    expect(rerun.reviewSession?.providerSessionId).not.toBe(consolidationSessionId);
    expect(rerun.consolidatedReport).toBeDefined();
    expect(rerun.consolidationOverlap).toBeDefined();

    const preparationRestart = await service.restartStep(started.id, "prepare");
    expect(preparationRestart.reviewModel).toEqual(preparationModel);
    expect(preparationRestart.consolidationModel).toEqual({
      agent: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    await service.advanceNow(started.id);
    expect((await snapshot(started.id))?.reviewSession).toMatchObject(preparationModel);
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });
    expect((await snapshot(started.id))?.reviewSession).toMatchObject({
      agent: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
  });
});

test("MultiReviewService releases old provider ownership after a cross-agent restart", async () => {
  const claudeProvider = new Provider();
  const codexProvider = new Provider();
  await withService(
    "env-restart-provider-cleanup",
    claudeProvider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const claudeDisposalsBeforeRestart = claudeProvider.disposeCalls;

      await service.restartStep(started.id, "consolidate", {
        agent: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
      });
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      expect(claudeProvider.disposeCalls).toBeGreaterThan(claudeDisposalsBeforeRestart);
      expect(codexProvider.disposeCalls).toBeGreaterThan(0);
    },
    {
      createProvider: async (_workflow, selection) =>
        selection.agent === "codex" ? codexProvider : claudeProvider,
    },
  );
});

test("MultiReviewService keeps per-step selections on ordinary restarts", async () => {
  const provider = new Provider();
  await withService("env-restart-existing-selections", provider, async ({ service, snapshot }) => {
    const reviewModel = {
      agent: "claude" as const,
      model: "sonnet",
      reasoningEffort: "medium",
    };
    const started = await service.start({
      environmentId: "env-restart-existing-selections",
      projectId: "project-1",
      targetBranch: "main",
      reviewers: [{ agent: "claude", model: "opus" }],
      reviewModel,
      fixModel: { agent: "claude", model: "opus" },
    });
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });

    const consolidation = await service.restartStep(started.id, "consolidate");
    expect(consolidation.reviewModel).toEqual(reviewModel);
    expect(consolidation.consolidationModel).toBeUndefined();
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });

    const preparation = await service.restartStep(started.id, "prepare");
    expect(preparation.reviewModel).toEqual(reviewModel);
    expect(preparation.consolidationModel).toBeUndefined();
  });
});

test("MultiReviewService restarts the Address Findings handoff with a fresh durable request", async () => {
  const provider = new Provider();
  await withService(
    "env-restart-fix",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const first = await service.address(started.id);
      const firstRequestId = first.addressRequestId!;
      const firstSessionId = first.fixSession!.providerSessionId;
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);

      const restarted = await service.restartStep(started.id, "fix");
      expect(restarted).toMatchObject({
        phase: "interactive",
        addressPromptPending: true,
        addressPromptAttempts: 0,
        fixSession: { providerSessionId: firstSessionId },
      });
      expect(restarted.addressRequestId).not.toBe(firstRequestId);
      expect(restarted.fixResult).toBeUndefined();
      expect(provider.aborted).not.toContain(firstSessionId);

      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);
      expect(await snapshot(started.id)).toMatchObject({
        phase: "interactive",
        fixSession: { providerSessionId: firstSessionId },
        stepRuntimes: { fix: { startedAt: expect.any(String) } },
      });
    },
    {
      serviceOptions: {
        dispatchAddressFindingsPrompt: async (workflow) => ({
          fixSession: workflow.fixSession!,
          tabId: workflow.addressTabId!,
        }),
      },
    },
  );
});

test("MultiReviewService restarts Address Findings in the selected model and replaces the old session", async () => {
  const provider = new Provider();
  let replacementCount = 0;
  await withService(
    "env-restart-fix-model",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      await service.address(started.id);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);
      const firstSessionId = (await snapshot(started.id))!.fixSession!.providerSessionId;
      const selectedModel = {
        agent: "codex" as const,
        model: "gpt-5.4",
        reasoningEffort: "high",
      };

      const restarted = await service.restartStep(started.id, "fix", selectedModel);
      expect(restarted.fixModel).toEqual(selectedModel);
      expect(restarted.fixSession).toBeUndefined();
      expect(provider.aborted).toContain(firstSessionId);

      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);
      expect(await snapshot(started.id)).toMatchObject({
        fixModel: selectedModel,
        fixSession: {
          ...selectedModel,
          providerSessionId: "replacement-fix-1",
        },
      });
    },
    {
      serviceOptions: {
        dispatchAddressFindingsPrompt: async (workflow) => ({
          fixSession: workflow.fixSession ?? {
            ...workflow.fixModel,
            sessionKey: workflow.addressSessionKey!,
            providerSessionId: `replacement-fix-${++replacementCount}`,
            requestIds: [workflow.addressRequestId!],
            status: "running",
            startedAt: new Date().toISOString(),
          },
          tabId: workflow.addressTabId!,
        }),
      },
    },
  );
});

test.each(["fix", "consolidate", "prepare", "reviewer"] as const)(
  "MultiReviewService aborts a custom Address Findings through its owning provider before %s restart",
  async (restartKind) => {
    const defaultProvider = new Provider();
    const customProvider = new Provider();
    const environmentId = `env-restart-custom-${restartKind}`;
    await withService(
      environmentId,
      defaultProvider,
      async ({ service, start, snapshot }) => {
        const started = await start();
        await waitUntil(async () => {
          await service.advanceNow(started.id);
          return (await snapshot(started.id))?.phase === "ready";
        });
        await service.customAddressFindings({
          workflowId: started.id,
          fixModel: { agent: "codex", model: "gpt-5.4", reasoningEffort: "high" },
          instruction: "Preserve this custom launch",
        });
        await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);
        const customSessionId = (await snapshot(started.id))!.fixSession!.providerSessionId;

        if (restartKind === "reviewer") {
          await service.restartReviewer(started.id, (await snapshot(started.id))!.reviewers[0]!.id);
        } else {
          await service.restartStep(started.id, restartKind);
        }

        expect(customProvider.aborted).toContain(customSessionId);
        expect(defaultProvider.aborted).not.toContain(customSessionId);
      },
      {
        createProvider: async (_workflow, selection) =>
          selection.agent === "codex" ? customProvider : defaultProvider,
        serviceOptions: {
          dispatchAddressFindingsPrompt: async (workflow) => ({
            tabId: workflow.addressTabId!,
            fixSession: {
              ...(workflow.customFixModel ?? workflow.fixModel),
              sessionKey: workflow.addressSessionKey!,
              providerSessionId: `custom-fix-${restartKind}`,
              requestIds: [workflow.addressRequestId!],
              status: "running",
              startedAt: new Date().toISOString(),
            },
          }),
        },
      },
    );
  },
);

test("MultiReviewService replays a restarted custom Address Findings instruction and model", async () => {
  const provider = new Provider();
  const dispatches: Array<{
    instruction: string | undefined;
    model: MultiReviewModelSelection | undefined;
  }> = [];
  await withService(
    "env-replay-custom-fix",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const model = { agent: "codex" as const, model: "gpt-5.4", reasoningEffort: "high" };
      await service.customAddressFindings({
        workflowId: started.id,
        fixModel: model,
        instruction: "Repair only the reviewed regression",
      });
      await waitUntil(() => dispatches.length === 1);

      await service.restartStep(started.id, "consolidate");
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return dispatches.length === 2;
      });

      expect(dispatches[1]).toEqual({
        instruction: "Repair only the reviewed regression",
        model,
      });
      expect((await snapshot(started.id))?.restartFixAfterConsolidation).toBeUndefined();
    },
    {
      serviceOptions: {
        dispatchAddressFindingsPrompt: async (workflow) => {
          dispatches.push({
            instruction: workflow.customFixInstruction,
            model: workflow.customFixModel,
          });
          return {
            tabId: workflow.addressTabId!,
            fixSession: {
              ...(workflow.customFixModel ?? workflow.fixModel),
              sessionKey: workflow.addressSessionKey!,
              providerSessionId: `replayed-custom-fix-${dispatches.length}`,
              requestIds: [workflow.addressRequestId!],
              status: "running",
              startedAt: new Date().toISOString(),
            },
          };
        },
      },
    },
  );
});

test("MultiReviewService leaves sessions and results intact when prepare snapshot capture fails", async () => {
  const provider = new Provider();
  let rejectSnapshot = false;
  await withService(
    "env-restart-snapshot-failure",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const before = structuredClone((await snapshot(started.id))!);
      const abortsBefore = [...provider.aborted];
      rejectSnapshot = true;

      await expect(service.restartStep(started.id, "prepare")).rejects.toThrow(
        "could not capture the environment Git state",
      );
      expect(await snapshot(started.id)).toEqual(before);
      expect(provider.aborted).toEqual(abortsBefore);
    },
    {
      invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        if (command === "get_environment_uncommitted_paths" && rejectSnapshot) {
          return { status: "unknown", error: "git probe failed" } as T;
        }
        return stableReviewInvoker<T>(command, args);
      },
    },
  );
});

test("MultiReviewService leaves preparation intact when restart model configuration fails", async () => {
  const provider = new Provider();
  await withService(
    "env-restart-configuration-failure",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const before = structuredClone((await snapshot(started.id))!);
      const abortsBefore = [...provider.aborted];
      const getEnvironment = storage.getEnvironment.bind(storage);
      storage.getEnvironment = (async () => null) as typeof storage.getEnvironment;
      try {
        await expect(
          service.restartStep(started.id, "prepare", {
            agent: "codex",
            model: "gpt-5.4",
            reasoningEffort: "high",
          }),
        ).rejects.toThrow("Review environment no longer exists");
      } finally {
        storage.getEnvironment = getEnvironment;
      }

      expect(await snapshot(started.id)).toEqual(before);
      expect(provider.aborted).toEqual(abortsBefore);
    },
    { packageFlow: true },
  );
});

test.each([
  {
    name: "cancelled workflow",
    kind: "prepare" as const,
    message: "cancelled Multi Review",
    mutate: (workflow: MultiReviewWorkflow) => {
      workflow.phase = "cancelled";
    },
  },
  {
    name: "unstarted preparation",
    kind: "prepare" as const,
    message: "preparation has not started",
    mutate: (workflow: MultiReviewWorkflow) => {
      workflow.phase = "reviewing";
      delete workflow.stepRuntimes;
      delete workflow.reviewPackage;
      delete workflow.validationRun;
      delete workflow.activeRequest;
      for (const reviewer of workflow.reviewers) {
        reviewer.status = "pending";
        delete reviewer.providerSessionId;
        delete reviewer.report;
        delete reviewer.startedAt;
        delete reviewer.completedAt;
        delete reviewer.error;
      }
    },
  },
  {
    name: "unstarted consolidation",
    kind: "consolidate" as const,
    message: "Consolidation has not started",
    mutate: (workflow: MultiReviewWorkflow) => {
      workflow.phase = "reviewing";
      delete workflow.stepRuntimes;
      delete workflow.consolidatedReport;
      delete workflow.activeRequest;
    },
  },
  {
    name: "unstarted fix",
    kind: "fix" as const,
    message: "Address Findings has not started",
    mutate: (workflow: MultiReviewWorkflow) => {
      workflow.phase = "ready";
      delete workflow.fixLaunch;
      delete workflow.stepRuntimes;
      delete workflow.fixResult;
    },
  },
  {
    name: "consolidation without reports",
    kind: "consolidate" as const,
    message: "without a reviewer report",
    mutate: (workflow: MultiReviewWorkflow) => {
      workflow.phase = "reviewing";
      workflow.stepRuntimes = { consolidate: { startedAt: new Date().toISOString() } };
      for (const reviewer of workflow.reviewers) {
        reviewer.status = "pending";
        delete reviewer.providerSessionId;
        delete reviewer.report;
        delete reviewer.startedAt;
        delete reviewer.completedAt;
        delete reviewer.error;
      }
    },
  },
  {
    name: "fix without consolidation",
    kind: "fix" as const,
    message: "without a consolidated report",
    mutate: (workflow: MultiReviewWorkflow) => {
      workflow.phase = "failed";
      workflow.error = "Previous fix failed";
      workflow.fixLaunch = { kind: "default" };
      delete workflow.consolidatedReport;
    },
  },
])(
  "MultiReviewService rejects $name before provider cleanup",
  async ({ kind, message, mutate }) => {
    const provider = new Provider();
    await withService(
      `env-restart-precondition-${kind}-${message.length}`,
      provider,
      async ({ service, storage, start, snapshot }) => {
        const started = await start();
        await waitUntil(async () => {
          await service.advanceNow(started.id);
          return (await snapshot(started.id))?.phase === "ready";
        });
        await service.shutdown();
        await mutateStoredWorkflow(storage, started.id, mutate);
        const replacement = new MultiReviewService(storage, stableReviewInvoker, {
          autoAdvance: false,
          provider: async () => provider,
        });
        try {
          const abortsBefore = [...provider.aborted];
          await expect(replacement.restartStep(started.id, kind)).rejects.toThrow(message);
          expect(provider.aborted).toEqual(abortsBefore);
        } finally {
          await replacement.shutdown();
        }
      },
    );
  },
);

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
      // not keep running through consolidation and the Address Findings stage.
      expect(provider.aborted).toContain("session-1");
      expect(provider.aborted).toContain("session-2");
      expect(failed.phase).toBe("failed");
    },
    { serviceOptions: { progressProbeIntervalMs: 0, stallAbandonMs: 0 } },
  );
});

test("MultiReviewService bounds a background reviewer with the transcript stall clock", async () => {
  const provider = new Provider(false);
  provider.backgroundWorkLive = true;
  provider.messagesValue = [{ id: "assistant-1", role: "assistant", content: "Waiting" }];
  await withService(
    "env-background-stall",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.reviewers[0]?.status === "failed";
      });
      expect((await snapshot(started.id))?.reviewers[0]?.error).toContain("produced no activity");
      expect(provider.aborted).toContain("session-1");
    },
    { serviceOptions: { progressProbeIntervalMs: 0, stallAbandonMs: 0 } },
  );
});

test("MultiReviewService warns when an idle background reviewer stops making progress", async () => {
  const provider = new Provider(false);
  provider.backgroundWorkLive = true;
  provider.messagesValue = [{ id: "assistant-1", role: "assistant", content: "Waiting" }];
  await withService(
    "env-background-warning",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.reviewers[0]?.stalledSince !== undefined;
      });
      expect((await snapshot(started.id))?.reviewers[0]?.status).toBe("running");
      expect(provider.aborted).toEqual([]);
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

test("MultiReviewService gives a fresh reviewer baseline a grace clock", async () => {
  const provider = new Provider();
  // Exercises the messages-based progress and usage path.
  delete provider.transcriptSnapshot;
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
  // Exercises the messages-based progress and usage path.
  delete provider.transcriptSnapshot;
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

test("Multi Review prepares and consolidates with its review model before opening a separate Address Findings session", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  const commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
  await withService(
    "env-package",
    provider,
    async ({ service, storage, snapshot }) => {
      const started = await service.start({
        environmentId: "env-package",
        projectId: "project-1",
        targetBranch: "main",
        reviewers: [
          { agent: "opencode", model: "review-a" },
          { agent: "codex", model: "review-b" },
        ],
        reviewModel: {
          agent: "claude",
          model: "review-coordinator",
          reasoningEffort: "medium",
        },
        fixModel: { agent: "claude", model: "fix-model", reasoningEffort: "high" },
      });
      expect(started.phase).toBe("preparing");
      await service.advanceNow(started.id);
      const preparing = (await snapshot(started.id))!;
      expect(preparing.reviewers.every((reviewer) => reviewer.status === "pending")).toBe(true);
      expect(preparing.activeRequest).toMatchObject({ kind: "prepare", state: "sent" });
      expect(provider.creates).toHaveLength(1);
      expect(provider.creates[0]?.options).toMatchObject({
        model: "review-coordinator",
        effort: "medium",
        mode: "build",
        policy: { id: "pipeline", sandbox: "none", networkAccess: "full" },
      });
      expect([...provider.sends.values()][0]?.options.schema).toEqual(
        REVIEW_VALIDATION_PLAN_SCHEMA,
      );
      expect(commands.some((entry) => entry.command === "generate_review_package")).toBe(false);
      provider.statusValue = "idle";
      await service.advanceNow(started.id);
      const reviewing = (await snapshot(started.id))!;
      expect(reviewing.phase).toBe("reviewing");
      expect(reviewing.reviewPackage?.kind).toBe("file");
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const ready = (await snapshot(started.id))!;
      expect(ready.phase).toBe("ready");
      const reviews = [...provider.sends.values()].filter((sent) =>
        sent.prompt.includes("You are independent reviewer"),
      );
      expect(reviews).toHaveLength(2);
      for (const sent of reviews) {
        expect(sent.options).toMatchObject({ mode: "plan", readOnly: true });
        if (sent.options.model === "review-a") {
          expect(sent.options.reviewShellPolicy).toMatchObject({
            id: "pipeline",
            approvals: "auto-approve",
          });
        } else {
          expect(sent.options.reviewShellPolicy).toBeUndefined();
        }
        expect(sent.prompt).toContain(reviewing.reviewPackage!.filePath);
        expect(sent.prompt).toContain("Do not modify, create, or delete files");
        // Validation ran once during preparation; every reviewer reads those
        // artifacts rather than starting its own suite in parallel.
        expect(sent.prompt).toContain("Do not rerun the full test suite");
        expect(sent.prompt).not.toContain("Validation commands may write");
      }
      const reviewerCreates = provider.creates.filter(
        (entry) => entry.options?.reviewerSession === true,
      );
      expect(reviewerCreates).toHaveLength(2);
      expect(
        reviewerCreates.every(
          (entry) =>
            entry.options?.mode === "plan" &&
            entry.options?.readOnly === true &&
            entry.options.policy?.id === "pipeline",
        ),
      ).toBe(true);
      // Preparation, two reviewers, then consolidation on a session of its own.
      expect(provider.creates.map((entry) => entry.label)).toEqual([
        "Multi Review · Prepare review package",
        expect.any(String),
        expect.any(String),
        "Multi Review · Consolidation",
      ]);
      expect(provider.creates.at(-1)?.options).toMatchObject({
        model: "review-coordinator",
        mode: "build",
        readOnly: true,
      });
      expect(commands.filter((entry) => entry.command === "generate_review_package")).toHaveLength(
        1,
      );
      // A live checkout change must not invalidate the immutable evidence after
      // preparation: pin the review, record sealing paths, then check for movement.
      expect(
        commands.filter((entry) => entry.command === "get_environment_uncommitted_paths"),
      ).toHaveLength(3);
      // One verification per phase — fan-out admission and consolidation —
      // independent of how many reviewers the panel has.
      expect(commands.filter((entry) => entry.command === "verify_review_package")).toHaveLength(2);
      const consolidation = [...provider.sends.values()].find((sent) =>
        sent.prompt.includes("<multi-review-reports-json>"),
      );
      expect(consolidation?.options).toMatchObject({
        model: "review-coordinator",
        effort: "medium",
        mode: "build",
        readOnly: true,
      });
      expect(consolidation?.options.reviewShellPolicy).toBeUndefined();
      expect(consolidation?.prompt).toContain("same backend-verified immutable review package");
      expect(consolidation?.prompt).toContain(reviewing.reviewPackage!.filePath);
      expect(ready.reviewSession).toMatchObject({
        model: "review-coordinator",
        providerSessionId: "session-4",
        openedFor: "consolidate",
        status: "idle",
      });
      // The preparation transcript stays reachable after consolidation moves on.
      expect(ready.preparationSession).toMatchObject({
        model: "review-coordinator",
        providerSessionId: "session-1",
        openedFor: "prepare",
        status: "idle",
      });
      expect(ready.fixSession).toBeUndefined();
      const interactive = await service.address(started.id);
      expect(interactive.phase).toBe("interactive");
      expect(interactive.addressPromptPending).toBe(true);
      expect(interactive.fixSession).toBeUndefined();
      expect(interactive.reviewSession?.providerSessionId).toBe("session-4");
      await service.close(started.id);
      expect(new Set(provider.closed)).toEqual(
        new Set(["session-1", "session-2", "session-3", "session-4"]),
      );
      expect(await storage.getMultiReviewWorkflow(started.id)).toBeNull();
    },
    {
      invoke: async (command, args) => {
        commands.push({ command, args });
        return stableReviewInvoker(command, args);
      },
    },
  );
});

test.each(["failed", "unconfirmed"])(
  "Multi Review retains preparation ownership after a %s close and retries teardown",
  async (failure) => {
    const provider = new Provider();
    await withService(
      `env-preparation-close-${failure}`,
      provider,
      async ({ service, storage, start, snapshot }) => {
        const started = await start();
        await waitUntil(async () => {
          await service.advanceNow(started.id);
          return (await snapshot(started.id))?.phase === "ready";
        });
        const ready = (await snapshot(started.id))!;
        const retained = ready.preparationSession!;
        expect(retained.providerSessionId).toBe("session-1");
        await service.address(started.id);
        const close = provider.closeSession.bind(provider);
        let failClose = true;
        provider.closeSession = async (sessionId) => {
          if (failClose && sessionId === retained.providerSessionId) {
            throw new Error(
              failure === "failed" ? "preparation close failed" : "preparation close pending",
            );
          }
          await close(sessionId);
        };
        // Even an idle status/working abort cannot confirm that the registered
        // conversation was closed. Keep the durable owner until close succeeds.
        await expect(service.close(started.id)).rejects.toThrow(
          `preparation close ${failure === "failed" ? "failed" : "pending"}`,
        );
        expect((await snapshot(started.id))?.preparationSession).toEqual(retained);
        expect((await storage.getMultiReviewWorkflow(started.id))?.controllerLease).toBeUndefined();
        failClose = false;
        await service.close(started.id);
        expect(provider.closed).toContain(retained.providerSessionId);
        expect(await storage.getMultiReviewWorkflow(started.id)).toBeNull();
      },
      { packageFlow: true },
    );
  },
);

test("Multi Review closes retained preparation before creating its replacement and preserves it on failure", async () => {
  const provider = new Provider();
  await withService(
    "env-preparation-replacement-close",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const retained = (await snapshot(started.id))!.preparationSession!;
      const createsBefore = provider.creates.length;
      provider.closeError = new Error("preparation close pending");
      await service.restartStep(started.id, "prepare");
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.phase).toBe("failed");
      expect((await snapshot(started.id))?.preparationSession).toEqual(retained);
      expect(provider.creates).toHaveLength(createsBefore);
      provider.closeError = null;
      provider.statusValue = "running";
      await service.retry(started.id);
      await service.advanceNow(started.id);
      const replaced = (await snapshot(started.id))!;
      expect(provider.closed).toContain(retained.providerSessionId);
      expect(replaced.preparationSession).toBeUndefined();
      expect(replaced.fixSession?.providerSessionId).not.toBe(retained.providerSessionId);
      expect(provider.creates).toHaveLength(createsBefore + 1);
    },
    { packageFlow: true },
  );
});

test.each([
  { running: true, modelChanged: false },
  { running: false, modelChanged: true },
  { running: true, modelChanged: true },
])(
  "Multi Review retains and shuts down abandoned preparation (%j)",
  async ({ running, modelChanged }) => {
    const provider = new Provider();
    const shutdowns: Array<{ agent: MultiReviewModelSelection["agent"]; sessionId: string }> = [];
    await withService(
      `env-leaving-preparation-${running}-${modelChanged}`,
      provider,
      async ({ service, storage, start, snapshot }) => {
        const started = await start();
        await waitUntil(async () => {
          await service.advanceNow(started.id);
          return (await snapshot(started.id))?.phase === "ready";
        });
        const retained = (await snapshot(started.id))!.preparationSession!;
        await mutateStoredWorkflow(storage, started.id, (workflow) => {
          workflow.phase = "consolidating";
          workflow.fixSession = { ...retained, status: running ? "running" : "idle" };
          delete workflow.preparationSession;
          delete workflow.activeRequest;
          delete workflow.consolidatedReport;
          if (modelChanged) {
            workflow.consolidationModel = { agent: "codex", model: "gpt-5.4" };
            workflow.reviewSession = workflow.fixSession;
            delete workflow.fixSession;
          }
        });
        await service.advanceNow(started.id);
        expect(provider.aborted).toContain(retained.providerSessionId);
        expect((await snapshot(started.id))?.preparationSession).toMatchObject({
          providerSessionId: retained.providerSessionId,
          agent: retained.agent,
          status: running ? "running" : "idle",
        });
        await waitUntil(async () => {
          await service.advanceNow(started.id);
          return (await snapshot(started.id))?.phase === "ready";
        });
        await service.address(started.id);
        await service.close(started.id);
        expect(provider.closed).toContain(retained.providerSessionId);
        expect(shutdowns).toContainEqual({
          agent: retained.agent,
          sessionId: retained.providerSessionId,
        });
      },
      {
        packageFlow: true,
        createProvider: async (_workflow, selection) => {
          return new Proxy(provider, {
            get(target, property) {
              if (property === "closeSession")
                return async (sessionId: string) => {
                  shutdowns.push({ agent: selection.agent, sessionId });
                  await target.closeSession(sessionId);
                };
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      },
    );
  },
);

test("MultiReviewService stops validation and advances with partial evidence", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  const plan: ReviewValidationPlan = {
    headRef: REVIEW_HEAD,
    commands: [
      {
        id: "check",
        command: "mise run check",
        cwd: ".",
        dependsOn: [],
        resources: ["workspace:check"],
        weight: 1,
        timeoutMs: 60_000,
      },
      {
        id: "test",
        command: "mise run test",
        cwd: ".",
        dependsOn: [],
        resources: ["workspace:test"],
        weight: 2,
        timeoutMs: 120_000,
      },
    ],
    limitations: [],
  };
  provider.preparationResult = plan;
  const commands: string[] = [];
  let packagedPreparation: unknown;
  let packagedArgs: Record<string, unknown> | undefined;
  const runningRun = (run: ReviewValidationRun): ReviewValidationRun => ({
    ...run,
    status: "running",
    results: run.results.map((result, index) =>
      index === 0
        ? {
            ...result,
            status: "passed",
            exitCode: 0,
            durationMs: 1_000,
          }
        : {
            ...result,
            status: "running",
            startedAt: new Date().toISOString(),
            durationMs: 500,
          },
    ),
  });

  await withService(
    "env-stop-validation",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => Boolean((await snapshot(started.id))?.activeRequest));
      provider.statusValue = "idle";
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.validationRun?.status).toBe("running");

      const requested = await service.stopValidation(started.id);
      expect(requested).toMatchObject({
        phase: "preparing",
        validationStopRequested: true,
      });

      await waitUntil(async () => (await snapshot(started.id))?.phase === "reviewing");
      const reviewing = (await snapshot(started.id))!;
      expect(reviewing.validationRun?.status).toBe("cancelled");
      expect(reviewing.validationStopRequested).toBeUndefined();
      expect(commands).toContain("cancel_review_validation");
      expect(packagedPreparation).toMatchObject({
        validation: [
          { command: "cd '.' && mise run check", status: "passed" },
          { command: "cd '.' && mise run test", status: "incomplete" },
        ],
        limitations: [
          "Validation was stopped before every command completed; partial results were preserved.",
          "Validation worker stopped; unfinished command results are uncertain",
        ],
      });
      expect(packagedArgs).toMatchObject({
        expectedHead: REVIEW_HEAD,
        validationPlan: plan,
      });
    },
    {
      packageFlow: true,
      invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        commands.push(command);
        if (command === "start_review_validation") {
          return runningRun(args!.run as ReviewValidationRun) as T;
        }
        if (command === "status_review_validation") {
          return args!.run as T;
        }
        if (command === "cancel_review_validation") {
          const run = args!.run as ReviewValidationRun;
          return {
            ...run,
            status: "cancelled",
            completedAt: new Date().toISOString(),
            error: "Validation worker stopped; unfinished command results are uncertain",
            results: run.results.map((result, index) =>
              index === 1
                ? {
                    ...result,
                    status: "skipped",
                    exitCode: null,
                    stdoutPath: null,
                    stderrPath: null,
                    limitation: "Validation was cancelled",
                  }
                : result,
            ),
          } as T;
        }
        if (command === "generate_review_package") {
          packagedArgs = args;
          packagedPreparation = args!.preparation;
        }
        return stableReviewInvoker<T>(command, args);
      },
    },
  );
});

test("MultiReviewService releases stop-validation guard claims", async () => {
  const provider = new Provider();
  await withService("env-stop-validation-guard", provider, async ({ service, storage, start }) => {
    const started = await start();
    await expect(service.stopValidation(started.id)).rejects.toThrow(
      "Validation can only be stopped while tests are running",
    );
    expect(
      (await storage.claimMultiReviewController(started.id, "other-owner", 15_000)).granted,
    ).toBe(true);
  });
});

test("MultiReviewService releases stop-validation claims for already settled runs", async () => {
  const provider = new Provider();
  await withService(
    "env-stop-validation-settled",
    provider,
    async ({ service, storage, start }) => {
      const started = await start();
      const run = newReviewValidationRun("settled-validation", {
        headRef: REVIEW_HEAD,
        commands: [],
        limitations: ["No validation commands were discovered"],
      });
      run.status = "completed";
      run.completedAt = new Date().toISOString();
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        workflow.phase = "preparing";
        workflow.validationRun = run;
      });

      await expect(service.stopValidation(started.id)).rejects.toThrow(
        "Validation can only be stopped while tests are running",
      );
      expect(
        (await storage.claimMultiReviewController(started.id, "other-owner", 15_000)).granted,
      ).toBe(true);
    },
  );
});

test("MultiReviewService treats repeated validation stops as one durable request", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  const run = newReviewValidationRun("repeated-stop-validation", {
    headRef: REVIEW_HEAD,
    commands: [],
    limitations: ["No validation commands were discovered"],
  });
  run.status = "running";
  const commands: string[] = [];
  await withService(
    "env-stop-validation-repeated",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await service.advanceNow(started.id);
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        workflow.phase = "preparing";
        workflow.validationRun = run;
        workflow.validationStopRequested = true;
      });

      const repeated = await service.stopValidation(started.id);
      expect(repeated.validationStopRequested).toBe(true);
      await waitUntil(async () => (await snapshot(started.id))?.phase === "reviewing");
      expect(commands.filter((command) => command === "cancel_review_validation")).toHaveLength(1);
    },
    {
      invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        commands.push(command);
        if (command === "cancel_review_validation") {
          return {
            ...(args!.run as ReviewValidationRun),
            status: "cancelled",
            completedAt: new Date().toISOString(),
          } as T;
        }
        return stableReviewInvoker<T>(command, args);
      },
    },
  );
});

test("MultiReviewService cancels a running worker after a validation status failure", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  const run = newReviewValidationRun("status-failure-validation", {
    headRef: REVIEW_HEAD,
    commands: [],
    limitations: ["No validation commands were discovered"],
  });
  run.status = "running";
  const commands: string[] = [];
  await withService(
    "env-validation-status-failure",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await service.advanceNow(started.id);
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        workflow.phase = "preparing";
        workflow.validationRun = run;
      });

      await service.advanceNow(started.id);
      const failed = (await snapshot(started.id))!;
      expect(failed.phase).toBe("failed");
      expect(failed.error).toBe(
        "Validation worker stopped reporting progress; execution is uncertain",
      );
      expect(failed.validationRun?.status).toBe("cancelled");
      expect(commands.filter((command) => command !== "get_environment_uncommitted_paths")).toEqual(
        ["status_review_validation", "cancel_review_validation"],
      );
    },
    {
      invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        commands.push(command);
        if (command === "status_review_validation") {
          throw new Error("Validation worker stopped reporting progress; execution is uncertain");
        }
        if (command === "cancel_review_validation") {
          return {
            ...(args!.run as ReviewValidationRun),
            status: "cancelled",
            completedAt: new Date().toISOString(),
          } as T;
        }
        return stableReviewInvoker<T>(command, args);
      },
    },
  );
});

test("MultiReviewService clears a stop request when partial-evidence packaging fails", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  const run = newReviewValidationRun("stop-package-failure", {
    headRef: REVIEW_HEAD,
    commands: [],
    limitations: ["No validation commands were discovered"],
  });
  run.status = "cancelled";
  run.completedAt = new Date().toISOString();
  await withService(
    "env-validation-stop-package-failure",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await service.advanceNow(started.id);
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        workflow.phase = "preparing";
        workflow.validationRun = run;
        workflow.validationStopRequested = true;
      });

      await service.advanceNow(started.id);
      const failed = (await snapshot(started.id))!;
      expect(failed.phase).toBe("failed");
      expect(failed.error).toBe("Partial validation package could not be sealed");
      expect(failed.validationStopRequested).toBeUndefined();
    },
    {
      invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        if (command === "generate_review_package") {
          throw new Error("Partial validation package could not be sealed");
        }
        return stableReviewInvoker<T>(command, args);
      },
    },
  );
});

test("MultiReviewService cancels a planned validation when starting it fails", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  provider.preparationResult = {
    headRef: REVIEW_HEAD,
    commands: [
      {
        id: "check",
        command: "mise run check",
        cwd: ".",
        dependsOn: [],
        resources: ["workspace:check"],
        weight: 1,
        timeoutMs: 60_000,
      },
    ],
    limitations: [],
  } satisfies ReviewValidationPlan;
  const commands: string[] = [];

  await withService(
    "env-validation-start-failure",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => Boolean((await snapshot(started.id))?.activeRequest));
      provider.statusValue = "idle";
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "failed";
      });

      const failed = (await snapshot(started.id))!;
      expect(failed.error).toBe("Validation worker start response was lost");
      expect(failed.validationRun?.status).toBe("cancelled");
      expect(failed.validationStopRequested).toBeUndefined();
      expect(commands).toEqual(
        expect.arrayContaining(["start_review_validation", "cancel_review_validation"]),
      );
      expect(
        (await storage.claimMultiReviewController(started.id, "other-owner", 15_000)).granted,
      ).toBe(true);
    },
    {
      packageFlow: true,
      invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        commands.push(command);
        if (command === "start_review_validation") {
          throw new Error("Validation worker start response was lost");
        }
        if (command === "cancel_review_validation") {
          return {
            ...(args!.run as ReviewValidationRun),
            status: "cancelled",
            completedAt: new Date().toISOString(),
          } as T;
        }
        return stableReviewInvoker<T>(command, args);
      },
    },
  );
});

test("MultiReviewService recovers a persisted validation stop after restart", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  provider.preparationResult = {
    headRef: REVIEW_HEAD,
    commands: [
      {
        id: "check",
        command: "mise run check",
        cwd: ".",
        dependsOn: [],
        resources: ["workspace:check"],
        weight: 1,
        timeoutMs: 60_000,
      },
    ],
    limitations: [],
  } satisfies ReviewValidationPlan;
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (command === "start_review_validation") {
      return {
        ...(args!.run as ReviewValidationRun),
        status: "running",
      } as T;
    }
    if (command === "status_review_validation") return args!.run as T;
    if (command === "cancel_review_validation") {
      const run = args!.run as ReviewValidationRun;
      return {
        ...run,
        status: "cancelled",
        completedAt: new Date().toISOString(),
        results: run.results.map((result) => ({
          ...result,
          status: "incomplete",
          limitation: "Validation was cancelled before this command started",
        })),
      } as T;
    }
    return stableReviewInvoker<T>(command, args);
  };

  await withService(
    "env-validation-stop-restart",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => Boolean((await snapshot(started.id))?.activeRequest));
      provider.statusValue = "idle";
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.validationRun?.status === "running";
      });
      await service.shutdown();
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        workflow.validationStopRequested = true;
      });

      const restored = new MultiReviewService(storage, invoke, {
        autoAdvance: false,
        provider: async () => provider,
      });
      try {
        await restored.init();
        await restored.advanceNow(started.id);
        const reviewing = (await snapshot(started.id))!;
        expect(reviewing.phase).toBe("reviewing");
        expect(reviewing.validationRun?.status).toBe("cancelled");
        expect(reviewing.validationStopRequested).toBeUndefined();
        expect(reviewing.reviewPackage).toBeDefined();
      } finally {
        await restored.shutdown();
      }
    },
    { packageFlow: true, invoke },
  );
});

test("MultiReviewService execution policy fails when its environment disappears", async () => {
  const provider = new Provider();
  await withService("env-policy-gone", provider, async ({ service, storage, start }) => {
    const started = await start();
    await storage.removeEnvironment("env-policy-gone");
    const internal = service as unknown as {
      executionPolicy(workflow: MultiReviewWorkflow): Promise<unknown>;
    };

    await expect(internal.executionPolicy(started)).rejects.toThrow(
      "Review environment no longer exists",
    );
  });
});

test("preparing reviewers cannot be stopped or restarted before their package exists", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  await withService(
    "env-package-action-guards",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => (await snapshot(started.id))?.activeRequest?.state === "sent");
      const reviewerId = started.reviewers[0]!.id;

      await expect(service.stopReviewer(started.id, reviewerId)).rejects.toThrow(
        "only be stopped while review is running",
      );
      await expect(service.restartReviewer(started.id, reviewerId)).rejects.toThrow(
        "finish preparing the review package",
      );
      expect((await snapshot(started.id))?.reviewers[0]).toMatchObject({ status: "pending" });
      expect(provider.aborted).toEqual([]);
    },
    { packageFlow: true },
  );
});

test("package preparation uses the durable fix-session stall clock", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  provider.messagesValue = [{ id: "assistant-1", role: "assistant", content: "Preparing" }];
  await withService(
    "env-package-stall",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "failed";
      });

      const failed = (await snapshot(started.id))!;
      expect(failed.error).toContain("preparation session produced no activity");
      expect(failed.fixSession?.status).toBe("failed");
      expect(provider.aborted).toContain(failed.fixSession!.providerSessionId);
    },
    {
      packageFlow: true,
      serviceOptions: { progressProbeIntervalMs: 0, stallAbandonMs: 0 },
    },
  );
});

test("restarting a packaged reviewer re-verifies and reuses the read-only package prompt", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  const commands: string[] = [];
  await withService(
    "env-package-restart-reviewer",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start([{ agent: "opencode", model: "default" }]);
      await waitUntil(async () => (await snapshot(started.id))?.activeRequest?.state === "sent");
      const preparing = (await snapshot(started.id))!;
      const preparationSessionId =
        preparing.reviewSession?.providerSessionId ?? preparing.fixSession?.providerSessionId;
      expect(preparationSessionId).toBeDefined();
      // start() deliberately supervises in the background. If this test joins
      // that run while it is still settling, runLocked may perform the queued
      // reviewer pass before advanceNow() resolves. Complete only the
      // preparation session so any reviewer admitted by that pass still sees
      // the provider's default running state.
      provider.statusOverrides.set(preparationSessionId!, "idle");
      await service.advanceNow(started.id);
      const reviewing = (await snapshot(started.id))!;
      expect(reviewing.phase).toBe("reviewing");

      await service.advanceNow(started.id);
      const firstRun = (await snapshot(started.id))!.reviewers[0]!;
      expect(firstRun.status).toBe("running");
      expect(commands.filter((command) => command === "verify_review_package")).toHaveLength(1);

      const restarted = await service.restartReviewer(started.id, firstRun.id);
      expect(restarted.phase).toBe("reviewing");
      expect(restarted.reviewers[0]?.status).toBe("pending");
      await service.advanceNow(started.id);

      const reviewSends = [...provider.sends.values()].filter((sent) =>
        sent.prompt.includes("You are independent reviewer"),
      );
      expect(reviewSends).toHaveLength(2);
      expect(reviewSends.at(-1)?.options).toMatchObject({ mode: "plan", readOnly: true });
      expect(reviewSends.every((sent) => sent.options.reviewShellPolicy?.id === "pipeline")).toBe(
        true,
      );
      expect(reviewSends.at(-1)?.prompt).toContain(reviewing.reviewPackage!.filePath);
      expect(commands.filter((command) => command === "verify_review_package")).toHaveLength(2);
    },
    {
      packageFlow: true,
      invoke: async (command, args) => {
        commands.push(command);
        return stableReviewInvoker(command, args);
      },
    },
  );
});

test("package preparation resumes after backend restart without redispatch or a mounted renderer", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  const send = provider.send.bind(provider);
  let ambiguous = true;
  provider.send = async (session, prompt, options) => {
    await send(session, prompt, options);
    if (ambiguous) {
      ambiguous = false;
      throw new AmbiguousPromptDispatchError("accepted but response lost");
    }
  };
  await withService(
    "env-package-resume",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(
        async () => (await snapshot(started.id))?.activeRequest?.state === "dispatching",
      );
      const requestId = (await snapshot(started.id))!.activeRequest!.requestId;
      await service.shutdown();
      const restored = new MultiReviewService(storage, stableReviewInvoker, {
        autoAdvance: false,
        provider: async () => provider,
      });
      try {
        await restored.init();
        expect((await storage.getEnvironment(started.environmentId))?.agentActivityState).toBe(
          "working",
        );
        provider.statusValue = "idle";
        await restored.advanceNow(started.id);
        expect((await snapshot(started.id))?.reviewPackage).toBeDefined();
        expect(provider.sends.size).toBe(1);
        expect(provider.sends.has(requestId)).toBe(true);
        await restored.advanceNow(started.id);
        await restored.advanceNow(started.id);
        expect((await snapshot(started.id))?.phase).toBe("ready");
      } finally {
        await restored.shutdown();
      }
    },
    { packageFlow: true },
  );
});

test("failed package generation blocks reviewers and retry runs preparation again", async () => {
  const provider = new Provider();
  let blocked = true;
  await withService(
    "env-package-failure",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.phase).toBe("failed");
      expect((await snapshot(started.id))?.error).toContain("requires a clean worktree");
      expect(provider.creates).toHaveLength(1);
      const previousKey = (await snapshot(started.id))!.fixSessionKey;
      blocked = false;
      const retried = await service.retry(started.id);
      expect(retried.phase).toBe("preparing");
      expect(retried.fixSessionKey).not.toBe(previousKey);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
    },
    {
      packageFlow: true,
      invoke: async (command, args) => {
        if (command === "generate_review_package" && blocked)
          throw new Error("Review package preparation requires a clean worktree");
        return stableReviewInvoker(command, args);
      },
    },
  );
});

test("package tampering fails closed and retry discards reports before preparing new evidence", async () => {
  const provider = new Provider();
  let valid = false;
  await withService(
    "env-package-tamper",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "failed";
      });
      const failed = (await snapshot(started.id))!;
      expect(failed.reviewSnapshotStale).toBe(true);
      expect(
        [...provider.sends.values()].filter((sent) =>
          sent.prompt.includes("You are independent reviewer"),
        ),
      ).toHaveLength(0);
      const oldId = failed.reviewPackage!.id;
      valid = true;
      const retried = await service.retry(started.id);
      expect(retried.phase).toBe("preparing");
      expect(retried.reviewPackage).toBeUndefined();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      expect((await snapshot(started.id))!.reviewPackage!.id).not.toBe(oldId);
    },
    {
      packageFlow: true,
      invoke: async (command, args) =>
        command === "verify_review_package"
          ? ({ valid, reason: "hash mismatch" } as never)
          : stableReviewInvoker(command, args),
    },
  );
});

test("stale-snapshot retry abandons both separate review and fix sessions", async () => {
  const provider = new Provider();
  await withService(
    "env-stale-separate-sessions",
    provider,
    async ({ service, storage, snapshot }) => {
      const started = await service.start({
        environmentId: "env-stale-separate-sessions",
        projectId: "project-1",
        targetBranch: "main",
        reviewers: [{ agent: "claude", model: "opus" }],
        reviewModel: { agent: "claude", model: "review-coordinator" },
        fixModel: { agent: "claude", model: "fix-model" },
      });
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const ready = (await snapshot(started.id))!;
      expect(ready.consolidationOverlap).toBeDefined();
      const oldAddressFindingsSessionKey = ready.fixSessionKey;

      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        workflow.phase = "failed";
        workflow.reviewSnapshotStale = true;
        workflow.error = "The review snapshot is stale";
        workflow.fixSession = {
          ...workflow.fixModel,
          sessionKey: workflow.fixSessionKey ?? `multi-review:${workflow.id}:fix`,
          providerSessionId: "provider-stale-fix",
          requestIds: ["fix-stale"],
          status: "idle",
          startedAt: "2026-09-08T00:00:00.000Z",
        };
      });

      const retried = await service.retry(started.id);

      expect(retried.phase).toBe("preparing");
      expect(retried.reviewSession).toBeUndefined();
      expect(retried.fixSession).toBeUndefined();
      expect(retried.reviewers.every((reviewer) => reviewer.status === "pending")).toBe(true);
      expect(retried.reviewers.every((reviewer) => reviewer.report === undefined)).toBe(true);
      expect(retried.consolidatedReport).toBeUndefined();
      expect(retried.consolidationOverlap).toBeUndefined();
      expect((await snapshot(started.id))?.consolidationOverlap).toBeUndefined();
      expect(retried.fixSessionKey).not.toBe(oldAddressFindingsSessionKey);
      expect(provider.aborted).toContain(ready.reviewSession!.providerSessionId);
      expect(provider.aborted).toContain("provider-stale-fix");
    },
    { packageFlow: true },
  );
});
