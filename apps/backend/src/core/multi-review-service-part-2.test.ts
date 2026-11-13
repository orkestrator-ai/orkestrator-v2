// Part 2 of 4 of the MultiReviewService suite, split from multi-review-service.test.ts so
// `bun test --parallel` can spread it across workers. Shared helpers live in
// multi-review-service-test-support.ts.
import {
  CODEX_SERVER_OVERLOADED_MESSAGE,
  capacityRetriesExhaustedError,
} from "../../../../bridges/codex-bridge/src/sessions/capacity-retry.js";
import { multiReviewStatus } from "./coordinator-status-wakes.js";
import { multiReviewAutomation } from "./control-workflow-summary.js";
import { TEST_REVIEW_PREPARATION } from "./build-pipeline-test-fixtures.js";
import { expect, jest, test } from "bun:test";
import { STRUCTURED_REVIEW_REPORT_JSON_SCHEMA } from "@orkestrator/protocol/structured-review";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import {
  MULTI_REVIEW_MAX_SNAPSHOT_PATHS,
  isMultiReviewWorkflow,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { ProviderStatus } from "./build-pipeline-provider.js";
import type { ReviewValidationRun } from "@orkestrator/protocol/review-workflow";
import { AmbiguousPromptDispatchError } from "./build-pipeline-provider.js";
import { ProviderUnreachableError } from "./agent-provider-contract.js";
import {
  MissingMultiReviewAddressFindingsSessionError,
  MultiReviewAddressFindingsDispatchError,
} from "./multi-review-address-findings-dispatch.js";
import { StorageService } from "./storage.js";
import { MultiReviewService } from "./multi-review-service.js";
import { WorkflowResultService } from "./workflow-result-service.js";
import {
  Provider,
  REVIEW_FINGERPRINT,
  REVIEW_HEAD,
  advanceUntil,
  autoPrAddressFindingsDispatch,
  autoPrInvoker,
  cleanReport,
  completedAddressFindings,
  consolidatedReport,
  mutateStoredWorkflow,
  orderedAutoFlow,
  seedLegacyFixingWorkflow,
  singleActivityRead,
  stableReviewInvoker,
  startFollowUpStep,
  waitUntil,
  withInteractiveFixes,
  withService,
} from "./multi-review-service-test-support.js";

// This owner includes real lease timers and deliberately blocked provider
// calls. Keep Bun's outer budget wider than its own diagnostic waits.
jest.setTimeout(30_000);

test("MultiReviewService reads interactive Address Findings activity per session on an older bridge", async () => {
  await withInteractiveFixes(
    "fix-batch-old-bridge",
    undefined,
    async ({ service, workflowIds, requests, snapshot }) => {
      await Promise.all(workflowIds.map((id) => service.advanceNow(id)));
      await Promise.all(workflowIds.map((id) => service.advanceNow(id)));

      // Nothing remembers an absent batch route: each sweep tries it once
      // (three concurrent reads coalesce into one request), then falls back to
      // the single route for every session.
      expect(requests.filter((path) => path === "/sessions/activity")).toHaveLength(2);
      expect(requests.filter(singleActivityRead)).toHaveLength(6);
      for (const id of workflowIds) {
        expect((await snapshot(id))?.fixSession).toMatchObject({ status: "running" });
      }
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

      const statusCallsBeforeAddressFindings = provider.statusCalls;
      const handedOff = await service.address(started.id);
      expect(handedOff.addressPromptPending).toBe(true);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptAttempts === 1);

      // Repeating the command is idempotent and never asks a renderer to resume
      // the durable dispatch half.
      const resumed = await service.address(started.id);
      expect(resumed.addressPromptPending).toBe(true);
      expect(provider.statusCalls).toBe(statusCallsBeforeAddressFindings);
      await waitUntil(async () => {
        if ((await snapshot(started.id))?.addressPromptPending !== true) {
          await service.advanceNow(started.id);
        }
        const [workflow, environment] = await Promise.all([
          snapshot(started.id),
          storage.getEnvironment("env-address-resume"),
        ]);
        return (
          workflow?.addressPromptPending !== true &&
          environment?.agentActivitySources?.["multi-review"]?.state === "idle"
        );
      });
      expect(dispatches).toBe(2);
      await expect(service.address(started.id)).resolves.toMatchObject({ phase: "interactive" });
      expect(dispatches).toBe(2);

      // Both terminal operations release their short-lived controller claims.
      const claimed = await storage.claimMultiReviewController(started.id, "other-owner", 15_000);
      expect(claimed.granted).toBe(true);
    },
    {
      serviceOptions: {
        addressFindingsDispatchRetryMs: 60_000,
        dispatchAddressFindingsPrompt: async () => {
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
        dispatchAddressFindingsPrompt: async () => {
          throw new MissingMultiReviewAddressFindingsSessionError();
        },
      },
    },
  );
});

test.each([undefined, false, true])(
  "MultiReviewService snapshots auto-fix opt-in independently of saved defaults (%s)",
  async (autoFix) => {
    const provider = new Provider();
    provider.reviewerReport = consolidatedReport;
    let dispatches = 0;
    await withService(
      "env-auto-fix-default",
      provider,
      async ({ service, storage, start, snapshot }) => {
        const config = await storage.loadConfig();
        await storage.updateGlobalConfig({
          ...config.global,
          agentSettings: { multiReview: { autoFix: true } },
        });
        const started = await start();
        expect(started.autoFix).toBe(autoFix ?? false);
        // Later settings edits must not change a launched review's authorization.
        await storage.updateGlobalConfig({
          ...config.global,
          agentSettings: { multiReview: { autoFix: false } },
        });
        await waitUntil(async () => {
          await service.advanceNow(started.id);
          const workflow = await snapshot(started.id);
          return autoFix !== true
            ? workflow?.phase === "ready"
            : workflow?.phase === "interactive" && !workflow.addressPromptPending;
        });
        await service.advanceNow(started.id);
        expect(dispatches).toBe(autoFix !== true ? 0 : 1);
        expect((await snapshot(started.id))?.autoFix).toBe(autoFix ?? false);
      },
      {
        packageFlow: true,
        autoFix,
        serviceOptions: {
          dispatchAddressFindingsPrompt: async () => {
            dispatches += 1;
          },
        },
      },
    );
  },
);

test("MultiReviewService does not auto-fix a clean consolidated report", async () => {
  const provider = new Provider();
  provider.consolidationReport = cleanReport;
  let dispatches = 0;
  await withService(
    "env-auto-fix-clean",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      const ready = (await snapshot(started.id))!;
      expect(ready.autoFix).toBe(true);
      expect(ready.consolidatedReport).toMatchObject({ issues: [], testCoverageGaps: [] });
      expect(ready.addressPromptPending).toBeUndefined();
      expect(dispatches).toBe(0);
    },
    {
      autoFix: true,
      packageFlow: true,
      serviceOptions: {
        dispatchAddressFindingsPrompt: async () => {
          dispatches += 1;
        },
      },
    },
  );
});

test.each([true, false])(
  "MultiReviewService opens the PR straight after a clean consolidated report (auto-fix %s)",
  async (autoFix) => {
    const provider = new Provider();
    provider.consolidationReport = cleanReport;
    const events: string[] = [];
    const flow = orderedAutoFlow(events);
    await withService(
      `env-clean-auto-pr-${autoFix}`,
      provider,
      async ({ service, start, snapshot }) => {
        const started = await start();
        expect(started).toMatchObject({ autoPr: true });
        // The PR intent is saved with the clean report, before any PR launch.
        const queued = await advanceUntil(
          service,
          snapshot,
          started.id,
          (workflow) => workflow.autoPrLaunch !== undefined,
        );
        expect(queued.phase).toBe("ready");
        expect(queued.autoPrLaunch).toEqual({
          basis: "clean-review",
          state: "pending",
          requestId: `multi-review-pr:${started.id}`,
        });
        expect(events).toEqual([]);

        const launched = await advanceUntil(
          service,
          snapshot,
          started.id,
          (workflow) => workflow.autoPrLaunch?.state === "launched",
        );
        expect(launched.phase).toBe("ready");
        expect(launched.autoPrLaunch).toEqual({
          basis: "clean-review",
          state: "launched",
          requestId: `multi-review-pr:${started.id}`,
          tabId: "agent-job-pr",
        });
        expect(launched.addressPromptPending).toBeUndefined();
        expect(flow.pr.launches[0]).toMatchObject({ title: "PR", activateTab: false });
        // No Address Findings ran, and the delivered PR is never repeated.
        await service.advanceNow(started.id);
        expect(events).toEqual(["pr"]);
      },
      {
        autoFix,
        autoPr: true,
        packageFlow: true,
        invoke: flow.invoke,
        serviceOptions: { dispatchAddressFindingsPrompt: flow.dispatchAddressFindingsPrompt },
      },
    );
  },
);

test.each(["reviewer", "consolidation"] as const)(
  "a launched clean-review PR survives %s restart without hiding new findings after reload",
  async (kind) => {
    const provider = new Provider();
    // Consolidation can initially resolve findings, then find them on the next attempt.
    provider.reviewerReport = consolidatedReport;
    provider.consolidationReport = cleanReport;
    const pr = autoPrInvoker();
    await withService(
      `env-clean-pr-restart-${kind}`,
      provider,
      async ({ service, storage, start, snapshot }) => {
        const started = await start();
        const launched = await advanceUntil(
          service,
          snapshot,
          started.id,
          (workflow) => workflow.autoPrLaunch?.state === "launched",
        );
        provider.consolidationReport = consolidatedReport;
        if (kind === "reviewer") {
          await service.restartReviewer(started.id, launched.reviewers[0]!.id);
        } else {
          await service.restartStep(started.id, "consolidate");
        }
        await service.shutdown();
        const replacement = new MultiReviewService(storage, pr.invoke, {
          autoAdvance: false,
          provider: async () => provider,
        });
        try {
          const ready = await advanceUntil(
            replacement,
            snapshot,
            started.id,
            (workflow) => workflow.phase === "ready",
          );
          expect(ready.consolidatedReport?.issues).toHaveLength(1);
          expect(ready.autoPrLaunch).toEqual(launched.autoPrLaunch);
          // Both the live result and the stored result after reload reflect this report.
          for (const current of [ready, (await snapshot(started.id))!]) {
            const status = multiReviewStatus(current, started.id)!;
            expect(status).toMatchObject({ state: "ready", headline: "is ready to address" });
            expect(status.tools.join(" ")).toContain("address_multi_review");
            expect(multiReviewAutomation({ ...current }).next).toContain(
              "Waiting for address_multi_review",
            );
          }
          await replacement.advanceNow(started.id);
          expect(pr.launches).toHaveLength(1);
        } finally {
          await replacement.shutdown();
        }
      },
      { autoPr: true, packageFlow: true, invoke: pr.invoke },
    );
  },
);

test("restores a pending clean-review PR and retries its delivery without a renderer", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker({ failures: 1 });
  await withService(
    "env-clean-pr-background-restart",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      const queued = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) => workflow.autoPrLaunch?.state === "pending",
      );
      await service.shutdown();
      const replacement = new MultiReviewService(storage, pr.invoke, {
        autoAdvance: false,
        provider: async () => provider,
        addressFindingsDispatchRetryMs: 0,
      });
      try {
        await replacement.advanceNow(started.id);
        expect((await snapshot(started.id))?.autoPrLaunch).toMatchObject({
          ...queued.autoPrLaunch,
          basis: "clean-review",
          state: "pending",
          attempts: 1,
        });
      } finally {
        await replacement.shutdown();
      }
      const background = new MultiReviewService(storage, pr.invoke, {
        autoAdvance: true,
        pollIntervalMs: 5,
        provider: async () => provider,
        addressFindingsDispatchRetryMs: 0,
      });
      try {
        // Only the backend supervisor is running; no UI or caller advances delivery.
        await background.init();
        await waitUntil(
          async () => (await snapshot(started.id))?.autoPrLaunch?.state === "launched",
        );
        expect((await snapshot(started.id))?.autoPrLaunch).toMatchObject({
          basis: "clean-review",
          state: "launched",
          requestId: queued.autoPrLaunch!.requestId,
          tabId: "agent-job-pr",
        });
        expect(pr.launches).toHaveLength(2);
        expect(new Set(pr.launches.map((launch) => launch.requestId))).toEqual(
          new Set([queued.autoPrLaunch!.requestId]),
        );
        expect(pr.launches.every((launch) => launch.activateTab === false)).toBe(true);
      } finally {
        await background.shutdown();
      }
    },
    { autoPr: true, packageFlow: true, invoke: pr.invoke },
  );
});

test("retry restores a clean report's PR intent after a failed Address Findings superseded it", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker();
  await withService(
    "env-clean-pr-retry-fix",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      const queued = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) => workflow.autoPrLaunch?.state === "pending",
      );
      const addressed = await service.address(started.id);
      expect(addressed.autoPrLaunch).toBeUndefined();
      await advanceUntil(service, snapshot, started.id, (workflow) => workflow.phase === "failed");
      const restored = await service.retry(started.id);
      expect(restored.phase).toBe("ready");
      expect(restored.autoPrLaunch).toEqual(queued.autoPrLaunch);
      const launched = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) => workflow.autoPrLaunch?.state === "launched",
      );
      expect(launched.autoPrLaunch?.basis).toBe("clean-review");
      expect(pr.launches).toHaveLength(1);
    },
    {
      autoPr: true,
      packageFlow: true,
      invoke: pr.invoke,
      serviceOptions: {
        maxAddressFindingsDispatchAttempts: 1,
        dispatchAddressFindingsPrompt: async () => {
          throw new Error("Address Findings delivery failed");
        },
      },
    },
  );
});

test("MultiReviewService leaves a clean report at ready when auto-PR is off", async () => {
  const provider = new Provider();
  provider.consolidationReport = cleanReport;
  const pr = autoPrInvoker();
  await withService(
    "env-clean-no-auto-pr",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      const ready = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) => workflow.phase === "ready",
      );
      await service.advanceNow(started.id);
      expect(ready.autoPrLaunch).toBeUndefined();
      expect(pr.launches).toHaveLength(0);
    },
    { autoFix: true, packageFlow: true, invoke: pr.invoke },
  );
});

test("MultiReviewService drops a clean report's pending PR when an Address Findings run starts first", async () => {
  const provider = new Provider();
  provider.consolidationReport = cleanReport;
  const pr = autoPrInvoker();
  await withService(
    "env-clean-auto-pr-fix-first",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) => workflow.autoPrLaunch?.state === "pending",
      );
      const addressed = await service.address(started.id);
      expect(addressed.phase).toBe("interactive");
      expect(addressed.autoPrLaunch).toBeUndefined();
      await service.advanceNow(started.id);
      expect(pr.launches).toHaveLength(0);
    },
    {
      autoFix: true,
      autoPr: true,
      packageFlow: true,
      invoke: pr.invoke,
      serviceOptions: { dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch },
    },
  );
});

test("MultiReviewService skips a clean report's PR once the review has moved on", async () => {
  const provider = new Provider();
  provider.consolidationReport = cleanReport;
  const pr = autoPrInvoker();
  await withService(
    "env-clean-auto-pr-stale",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) => workflow.autoPrLaunch?.state === "pending",
      );
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        workflow.consolidatedReport = consolidatedReport;
      });
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.autoPrLaunch).toMatchObject({
        basis: "clean-review",
        state: "skipped",
        message: expect.stringContaining("moved on from its clean report"),
      });
      expect(pr.launches).toHaveLength(0);
    },
    { autoFix: true, autoPr: true, packageFlow: true, invoke: pr.invoke },
  );
});

test("MultiReviewService skips a clean report's PR when the environment already has one", async () => {
  const provider = new Provider();
  provider.consolidationReport = cleanReport;
  const pr = autoPrInvoker();
  await withService(
    "env-clean-auto-pr-existing",
    provider,
    async ({ service, storage, start, snapshot }) => {
      await storage.updateEnvironment("env-clean-auto-pr-existing", {
        prUrl: "https://github.com/acme/app/pull/7",
        prState: "open",
      });
      const started = await start();
      const skipped = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) => workflow.autoPrLaunch?.state === "skipped",
      );
      expect(skipped.phase).toBe("ready");
      expect(skipped.autoPrLaunch?.message).toContain("already exists");
      expect(pr.launches).toHaveLength(0);
    },
    { autoFix: true, autoPr: true, packageFlow: true, invoke: pr.invoke },
  );
});

test.each([false, true])(
  "MultiReviewService dispatches a durable address intent without a renderer (auto-fix %s)",
  async (autoFix) => {
    const provider = new Provider();
    provider.reviewerReport = consolidatedReport;
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
          return (await snapshot(started.id))?.phase === (autoFix ? "interactive" : "ready");
        });

        const addressed = autoFix
          ? (await snapshot(started.id))!
          : await service.address(started.id);
        if (autoFix) void service.advanceNow(started.id);
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
        expect(await storage.getEnvironment("env-address-backend")).toMatchObject({
          agentActivitySources: { "multi-review": { state: "working" } },
        });
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0]?.consolidatedReport?.issues).toHaveLength(1);
        expect(dispatched[0]?.consolidatedReport?.testCoverageGaps).toHaveLength(1);
        await service.advanceNow(started.id);
        await service.address(started.id);
        expect(dispatched).toHaveLength(1);
        expect((await snapshot(started.id))?.stepRuntimes?.fix).toMatchObject({
          startedAt: expect.any(String),
        });
        expect(await storage.getEnvironment("env-address-backend")).toMatchObject({
          agentActivitySources: { "multi-review": { state: "working" } },
        });
      },
      {
        autoFix,
        packageFlow: autoFix,
        serviceOptions: {
          dispatchAddressFindingsPrompt: async (workflow) => {
            dispatched.push(workflow);
            dispatchStarted();
            await dispatchGate;
          },
        },
      },
    );
  },
);

test("MultiReviewService persists a seeded replacement for a missing interactive Address Findings session", async () => {
  const provider = new Provider();
  const recoverAddressFindingsSession = jest.fn(
    async (workflow: MultiReviewWorkflow, replacement: { tabId: string }) => ({
      tabId: replacement.tabId,
      fixSession: {
        ...workflow.fixSession!,
        sessionKey: workflow.fixSession!.sessionKey.startsWith(
          `multi-review:${workflow.id}:interactive`,
        )
          ? workflow.fixSession!.sessionKey
          : `multi-review:${workflow.id}:interactive`,
        providerSessionId: "provider-replacement",
        requestIds: [...workflow.fixSession!.requestIds, "replacement-request"],
        status: "idle" as const,
      },
    }),
  );
  await withService(
    "env-address-replacement",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const ready = (await snapshot(started.id))!;
      await service.address(started.id);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);
      const interactive = (await snapshot(started.id))!;
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        workflow.fixSession!.tokenCount = 50_000;
        workflow.stepRuntimes!.fix!.tokenCount = 50_000;
      });
      provider.statusValue = "running";
      provider.usageTokens = 125;

      const recovered = await service.recoverAddressFindingsSession("env-address-replacement", {
        tabId: interactive.fixTabId!,
        expectedProviderSessionId: ready.fixSession!.providerSessionId,
        replacementProviderSessionId: "provider-replacement",
      });

      expect(recoverAddressFindingsSession).toHaveBeenCalledTimes(1);
      expect(recovered.fixSession).toMatchObject({
        providerSessionId: "provider-replacement",
        sessionKey: `multi-review:${started.id}:interactive`,
        status: "running",
      });
      expect(recovered.fixSession?.tokenCount).toBeUndefined();
      expect(recovered.stepRuntimes?.fix).toMatchObject({ tokenBaseline: 0 });
      expect(recovered.fixSessionKey).toBe(`multi-review:${started.id}:interactive`);
      expect(recovered.presentationError).toContain(
        "fresh Address Findings session was created and seeded with the consolidated findings",
      );

      await expect(
        service.recoverAddressFindingsSession("env-address-replacement", {
          tabId: interactive.fixTabId!,
          expectedProviderSessionId: ready.fixSession!.providerSessionId,
          replacementProviderSessionId: "provider-replacement",
        }),
      ).resolves.toMatchObject({
        fixSession: { providerSessionId: "provider-replacement" },
      });
      expect(recoverAddressFindingsSession).toHaveBeenCalledTimes(1);

      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.fixSession?.tokenCount).toBe(125);
      expect((await snapshot(started.id))?.stepRuntimes?.fix?.tokenCount).toBe(125);
    },
    {
      serviceOptions: {
        dispatchAddressFindingsPrompt: async (workflow) => ({
          fixSession: workflow.fixSession!,
          tabId: workflow.addressTabId!,
        }),
        recoverAddressFindingsSession,
      },
    },
  );
});

test("MultiReviewService owns a custom-fix launch after the renderer records intent", async () => {
  const provider = new Provider();
  let releaseDispatch!: () => void;
  const dispatchGate = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  let dispatchStarted!: () => void;
  const startedDispatch = new Promise<void>((resolve) => {
    dispatchStarted = resolve;
  });
  await withService(
    "env-custom-fix-backend",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const previousProviderSessionId = (await snapshot(started.id))!.fixSession!.providerSessionId;
      const disposalsBeforeCustomAddressFindings = provider.disposeCalls;

      const requested = await service.customAddressFindings({
        workflowId: started.id,
        fixModel: { agent: "codex", model: "gpt-5.4", reasoningEffort: "high" },
        instruction: "Fix the inactive-environment regression",
      });
      expect(requested).toMatchObject({
        phase: "interactive",
        addressPromptPending: true,
        customFixInstruction: "Fix the inactive-environment regression",
        customFixModel: { agent: "codex", model: "gpt-5.4", reasoningEffort: "high" },
      });
      expect(
        requested.addressSessionKey?.startsWith(`multi-review:${started.id}:interactive:`),
      ).toBe(true);
      expect(requested.addressRequestId?.startsWith(`multi-review-address:${started.id}:`)).toBe(
        true,
      );
      expect(requested.addressTabId?.startsWith(`multi-review-fix:${started.id}:`)).toBe(true);

      await startedDispatch;
      expect(await snapshot(started.id)).toMatchObject({
        phase: "interactive",
        addressPromptPending: true,
        customFixInstruction: "Fix the inactive-environment regression",
      });

      releaseDispatch();
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);
      const delivered = (await snapshot(started.id))!;
      expect(delivered.customFixInstruction).toBeUndefined();
      expect(delivered.customFixModel).toBeUndefined();
      expect(delivered.fixModel).toEqual({
        agent: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
      });
      expect(delivered.fixSession).toMatchObject({
        agent: "codex",
        model: "gpt-5.4",
        providerSessionId: "provider-custom-fix",
        sessionKey: requested.addressSessionKey,
        status: "running",
      });
      expect(delivered.fixTabId).toBe(requested.addressTabId);
      expect(delivered.presentationError).toBe(
        "The Address Findings request was delivered, but its tab could not be opened.",
      );
      await waitUntil(() => provider.aborted.includes(previousProviderSessionId));
      expect(provider.disposeCalls).toBeGreaterThan(disposalsBeforeCustomAddressFindings);
    },
    {
      serviceOptions: {
        dispatchAddressFindingsPrompt: async (workflow) => {
          dispatchStarted();
          await dispatchGate;
          return {
            fixSession: {
              ...(workflow.customFixModel ?? workflow.fixModel),
              sessionKey: workflow.addressSessionKey!,
              providerSessionId: "provider-custom-fix",
              requestIds: [workflow.addressRequestId!],
              status: "idle",
              startedAt: "2026-08-29T00:00:00.000Z",
            },
            tabId: workflow.addressTabId!,
            presentationError:
              "The Address Findings request was delivered, but its tab could not be opened.",
          };
        },
      },
    },
  );
});

test("MultiReviewService reissues only an identical pending custom Address Findings", async () => {
  const provider = new Provider();
  let dispatches = 0;
  await withService(
    "env-custom-fix-idempotent",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const input = {
        workflowId: started.id,
        fixModel: { agent: "codex" as const, model: "gpt-5.4", reasoningEffort: "high" },
        instruction: "Fix the inactive-environment regression",
      };
      await service.customAddressFindings(input);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptAttempts === 1);
      const pending = (await snapshot(started.id))!;

      await expect(
        service.customAddressFindings({ ...input, instruction: "Use a different implementation" }),
      ).rejects.toThrow("not ready for a custom Address Findings");
      const reissued = await service.customAddressFindings(input);
      expect(reissued.addressSessionKey).toBe(pending.addressSessionKey);
      expect(reissued.addressRequestId).toBe(pending.addressRequestId);
      expect(reissued.addressTabId).toBe(pending.addressTabId);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);
      expect(dispatches).toBe(2);
    },
    {
      serviceOptions: {
        addressFindingsDispatchRetryMs: 60_000,
        dispatchAddressFindingsPrompt: async () => {
          dispatches += 1;
          if (dispatches === 1) throw new Error("bridge is restarting");
        },
      },
    },
  );
});

test("MultiReviewService cleans up an exhausted custom launch and rotates the next identity", async () => {
  const provider = new Provider();
  const invalidated: string[] = [];
  let fail = true;
  let failedSessionKey = "";
  let failedRequestId = "";
  await withService(
    "env-custom-fix-failure",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const originalSessionId = (await snapshot(started.id))!.fixSession!.providerSessionId;

      await service.customAddressFindings({
        workflowId: started.id,
        fixModel: { agent: "codex", model: "gpt-5.4", reasoningEffort: "high" },
        instruction: "First custom Address Findings",
      });
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "failed";
      });
      const failed = (await snapshot(started.id))!;
      expect(failed.addressPromptPending).toBeUndefined();
      expect(failed.addressSessionKey).toBeUndefined();
      expect(failed.addressRequestId).toBeUndefined();
      expect(failed.addressTabId).toBeUndefined();
      expect(failed.customFixInstruction).toBeUndefined();
      expect(failed.customFixModel).toBeUndefined();
      expect(failed.fixModel.agent).toBe("claude");
      expect(failed.fixSession?.providerSessionId).toBe(originalSessionId);
      expect(provider.aborted).toContain("provider-failed-custom");
      expect(invalidated).toEqual(["provider-failed-custom"]);

      const ready = await service.retry(started.id);
      expect(ready.phase).toBe("ready");
      fail = false;
      const second = await service.customAddressFindings({
        workflowId: started.id,
        fixModel: { agent: "codex", model: "gpt-5.4", reasoningEffort: "high" },
        instruction: "Second custom Address Findings",
      });
      expect(second.addressSessionKey).not.toBe(failedSessionKey);
      expect(second.addressRequestId).not.toBe(failedRequestId);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);
    },
    {
      serviceOptions: {
        addressFindingsDispatchRetryMs: 0,
        maxAddressFindingsDispatchAttempts: 3,
        invalidateAddressFindingsSession: async (_workflow, session) => {
          invalidated.push(session.providerSessionId);
        },
        dispatchAddressFindingsPrompt: async (workflow) => {
          if (!fail) return;
          failedSessionKey = workflow.addressSessionKey!;
          failedRequestId = workflow.addressRequestId!;
          throw new MultiReviewAddressFindingsDispatchError("credentials are invalid", {
            ...workflow.customFixModel!,
            sessionKey: workflow.addressSessionKey!,
            providerSessionId: "provider-failed-custom",
            requestIds: [workflow.addressRequestId!],
            status: "idle",
            startedAt: "2026-08-29T00:00:00.000Z",
          });
        },
      },
    },
  );
});

test("MultiReviewService cleans up an exhausted standard separate Address Findings handoff", async () => {
  const provider = new Provider();
  const invalidated: string[] = [];
  await withService(
    "env-standard-fix-failure",
    provider,
    async ({ service, storage, snapshot }) => {
      const started = await service.start({
        environmentId: "env-standard-fix-failure",
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

      await service.address(started.id);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "failed";
      });

      const failed = (await snapshot(started.id))!;
      expect(failed.fixSession).toBeUndefined();
      expect(failed.addressPromptPending).toBeUndefined();
      expect(provider.aborted).toContain("provider-failed-standard");
      expect(invalidated).toEqual(["provider-failed-standard"]);

      await service.cancel(started.id);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "cancelled";
      });
      await service.close(started.id);
      expect(await storage.getMultiReviewWorkflow(started.id)).toBeNull();
    },
    {
      packageFlow: true,
      serviceOptions: {
        addressFindingsDispatchRetryMs: 0,
        maxAddressFindingsDispatchAttempts: 3,
        invalidateAddressFindingsSession: async (_workflow, session) => {
          invalidated.push(session.providerSessionId);
        },
        dispatchAddressFindingsPrompt: async (workflow) => {
          throw new MultiReviewAddressFindingsDispatchError("credentials are invalid", {
            ...workflow.fixModel,
            sessionKey: workflow.addressSessionKey!,
            providerSessionId: "provider-failed-standard",
            requestIds: [workflow.addressRequestId!],
            status: "idle",
            startedAt: "2026-09-08T00:00:00.000Z",
          });
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
        addressFindingsDispatchRetryMs: 60_000,
        dispatchAddressFindingsPrompt: async () => {
          dispatches += 1;
          if (dispatches === 1) throw new Error("bridge is restarting");
        },
      },
    },
  );
});

test.each([false, true])(
  "MultiReviewService bounds permanent address failures and retry does not re-arm auto-fix (%s)",
  async (autoFix) => {
    const provider = new Provider();
    provider.reviewerReport = consolidatedReport;
    let dispatches = 0;
    const environmentId = `env-address-permanent-${autoFix}`;
    await withService(
      environmentId,
      provider,
      async ({ service, storage, start, snapshot }) => {
        const started = await start();
        if (!autoFix) {
          await waitUntil(async () => {
            await service.advanceNow(started.id);
            return (await snapshot(started.id))?.phase === "ready";
          });
          await service.address(started.id);
        }
        await waitUntil(async () => {
          await service.advanceNow(started.id);
          return (await snapshot(started.id))?.phase === "failed";
        });
        expect(dispatches).toBe(3);
        expect(await snapshot(started.id)).toMatchObject({
          phase: "failed",
          autoFix,
          error: "credentials are invalid",
        });
        expect((await snapshot(started.id))?.addressPromptPending).toBeUndefined();
        expect(await storage.getEnvironment(environmentId)).toMatchObject({
          agentActivitySources: { "multi-review": { state: "idle" } },
        });

        const retried = await service.retry(started.id);
        expect(retried).toMatchObject({ phase: "ready", autoFix });
        expect(retried.addressPromptPending).toBeUndefined();
        await service.advanceNow(started.id);
        expect(dispatches).toBe(3);
      },
      {
        autoFix,
        packageFlow: autoFix,
        serviceOptions: {
          addressFindingsDispatchRetryMs: 0,
          maxAddressFindingsDispatchAttempts: 3,
          dispatchAddressFindingsPrompt: async () => {
            dispatches += 1;
            throw new Error("credentials are invalid");
          },
        },
      },
    );
  },
);

test.each([false, true])(
  "MultiReviewService resumes a persisted address attempt after restart (auto-fix %s)",
  async (autoFix) => {
    const provider = new Provider();
    provider.reviewerReport = consolidatedReport;
    let dispatches = 0;
    const activationRequests: boolean[] = [];
    await withService(
      "env-address-restart",
      provider,
      async ({ service, storage, start, snapshot }) => {
        const started = await start();
        await waitUntil(async () => {
          await service.advanceNow(started.id);
          return (await snapshot(started.id))?.phase === (autoFix ? "interactive" : "ready");
        });
        await storage.savePaneLayout(
          started.environmentId,
          {
            version: PANE_LAYOUT_VERSION,
            containerId: null,
            activePaneId: "default",
            root: {
              kind: "leaf",
              id: "default",
              tabs: [{ id: "stay-active", type: "plain" }],
              activeTabId: "stay-active",
            },
          },
          0,
        );
        if (autoFix) await service.advanceNow(started.id);
        else await service.address(started.id);
        await waitUntil(async () => (await snapshot(started.id))?.addressPromptAttempts === 1);
        await service.shutdown();

        const restarted = new MultiReviewService(storage, stableReviewInvoker, {
          autoAdvance: true,
          pollIntervalMs: 5,
          provider: async () => provider,
          dispatchAddressFindingsPrompt: async (workflow, presentation) => {
            dispatches += 1;
            activationRequests.push(presentation.activateTab);
            await storage.ensureNativeAgentJobTab({
              environmentId: workflow.environmentId,
              tabId: workflow.addressTabId ?? `multi-review-fix:${workflow.id}`,
              agent: workflow.fixModel.agent,
              providerSessionId: workflow.fixSession?.providerSessionId,
              title: "Address Findings",
              isReviewTab: true,
              activate: presentation.activateTab,
            });
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
          expect(activationRequests).toEqual([!autoFix, false]);
          await restarted.advanceNow(started.id);
          expect(dispatches).toBe(2);
          const layout = await storage.getPaneLayout(started.environmentId);
          expect(layout?.root).toMatchObject({
            kind: "leaf",
            activeTabId: "stay-active",
            tabs: [
              { id: "stay-active" },
              { id: `multi-review-fix:${started.id}`, type: "agent-native" },
            ],
          });
          expect(await storage.getEnvironment("env-address-restart")).toMatchObject({
            agentActivitySources: { "multi-review": { state: "idle" } },
          });
        } finally {
          await restarted.shutdown();
        }
      },
      {
        autoFix,
        packageFlow: autoFix,
        serviceOptions: {
          addressFindingsDispatchRetryMs: 60_000,
          dispatchAddressFindingsPrompt: async (_workflow, presentation) => {
            dispatches += 1;
            activationRequests.push(presentation.activateTab);
            throw new Error("temporary disconnect");
          },
        },
      },
    );
  },
);

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
        dispatchAddressFindingsPrompt: async () => {
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

test("MultiReviewService notes snapshot changes after reviewer admission and continues", async () => {
  const provider = new Provider();
  provider.usageTokens = 444;
  const probes: Array<Record<string, unknown> | undefined> = [];
  await withService(
    "env-reviewer-snapshot-drift",
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

      const ready = (await snapshot(started.id))!;
      expect(ready.reviewSnapshotStale).toBe(true);
      expect(ready.error).toBeUndefined();
      expect(ready.reviewers.map((reviewer) => reviewer.status)).toEqual([
        "completed",
        "completed",
      ]);
      expect(ready.reviewers[0]?.tokenCount).toBe(444);
      expect(
        [...provider.sends.values()].filter((sent) =>
          sent.prompt.includes("You are independent reviewer"),
        ),
      ).toHaveLength(2);
      const initialReviewerPrompts = [...provider.sends.values()].filter((sent) =>
        sent.prompt.includes("You are independent reviewer"),
      );
      // One check admits the whole panel, so both prompts share its answer;
      // the change made after it is first seen by consolidation's check.
      expect(initialReviewerPrompts[0]?.prompt).toContain("**Authoritative worktree state**");
      expect(initialReviewerPrompts[1]?.prompt).toContain("**Authoritative worktree state**");
      const consolidation = [...provider.sends.values()].find((sent) =>
        sent.prompt.includes("<multi-review-reports-json>"),
      );
      expect(consolidation?.prompt).toContain(
        "The repository worktree changed after this Multi Review started",
      );
      expect(consolidation?.prompt).toContain("Preserve that fact as a limitation");
      expect(provider.aborted).toEqual([]);

      // Only the snapshot that becomes prompt evidence pays for content hashing;
      // drift checks compare HEAD and the path set: one for the reviewer
      // admission pass, one for consolidation. Once drift is known, later
      // dispatches retain the original evidence without repeatedly probing.
      expect(probes[0]).toEqual({
        environmentId: "env-reviewer-snapshot-drift",
        fingerprint: true,
      });
      expect(probes.slice(1, 3)).toEqual([
        { environmentId: "env-reviewer-snapshot-drift" },
        { environmentId: "env-reviewer-snapshot-drift" },
      ]);
      expect(probes).toHaveLength(3);

      const restarted = await service.restartReviewer(started.id, ready.reviewers[0]!.id);
      expect(restarted.phase).toBe("reviewing");
      expect(restarted.reviewSnapshotStale).toBe(true);
      expect(restarted.reviewers[0]?.status).toBe("pending");
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      // Once recorded, drift is a note rather than a gate for later dispatches.
      expect(probes).toHaveLength(3);
      const restartedPrompt = [...provider.sends.values()].filter((sent) =>
        sent.prompt.includes("You are independent reviewer"),
      )[2]?.prompt;
      expect(restartedPrompt).toContain("**Pinned worktree state (known stale)**");
      expect(restartedPrompt).toContain("This recorded path set is no longer authoritative");
      expect(restartedPrompt).not.toContain("**Authoritative worktree state**");
      expect(restartedPrompt).toContain("Reconcile it against the live worktree");
    },
    {
      invoke: (async (_command: string, args?: Record<string, unknown>) => {
        if (_command !== "get_environment_uncommitted_paths")
          return stableReviewInvoker(_command, args);
        probes.push(args);
        return probes.length <= 2
          ? { head: REVIEW_HEAD, paths: ["src/feature.ts"], fingerprint: REVIEW_FINGERPRINT }
          : {
              head: REVIEW_HEAD,
              paths: ["src/feature.ts", "src/added-while-reviewing.ts"],
              fingerprint: "b".repeat(64),
            };
      }) as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
    },
  );
});

test("MultiReviewService leaves live reviewer turns running when the snapshot changes", async () => {
  const provider = new Provider();
  // Reviewer 1 never settles, so it is still running when the restarted
  // reviewer 2 is admitted by a later pass whose check sees the change.
  provider.statusOverrides.set("session-1", "running");
  let probes = 0;
  await withService(
    "env-drift-live-turn",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start([
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "sonnet" },
      ]);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.reviewers[1]?.status === "completed";
      });
      expect((await snapshot(started.id))?.reviewSnapshotStale).toBeUndefined();
      await service.restartReviewer(started.id, started.reviewers[1]!.id);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        const current = await snapshot(started.id);
        return (
          current?.reviewSnapshotStale === true && current.reviewers[1]?.status === "completed"
        );
      });

      // Only the restart retired reviewer 2's earlier session; the drift did not
      // abort the turn still running against the changed worktree.
      expect(provider.aborted).toEqual(["session-2"]);
      const reviewing = (await snapshot(started.id))!;
      expect(reviewing.phase).toBe("reviewing");
      expect(reviewing.reviewers[0]?.status).toBe("running");
      expect(reviewing.reviewers[0]?.providerSessionId).toBe("session-1");

      provider.statusOverrides.delete("session-1");
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
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

test("MultiReviewService consolidates reports after snapshot drift with a limitation note", async () => {
  const provider = new Provider();
  let probes = 0;
  await withService(
    "env-consolidation-snapshot-drift",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => (await snapshot(started.id))?.phase === "consolidating");
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      const ready = (await snapshot(started.id))!;
      expect(ready.phase).toBe("ready");
      expect(ready.reviewSnapshotStale).toBe(true);
      expect(ready.consolidatedReport).toBeDefined();
      const consolidation = [...provider.sends.values()].find((sent) =>
        sent.prompt.includes("<multi-review-reports-json>"),
      );
      expect(consolidation?.prompt).toContain(
        "The repository worktree changed after this Multi Review started",
      );
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

test("MultiReviewService preserves completed reports when retrying an unrelated failure after drift", async () => {
  const provider = new Provider();
  let probes = 0;
  await withService(
    "env-drift-unrelated-retry",
    provider,
    async ({ service, start, snapshot }) => {
      // Reviewers are admitted on the pinned snapshot; consolidation's own
      // check is the first to see the change, and its reports never validate.
      provider.invalidConsolidatedReports = 4;
      const started = await start([
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "sonnet" },
      ]);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "failed";
      });

      const failed = (await snapshot(started.id))!;
      expect(failed.reviewPackage).toBeUndefined();
      expect(failed.reviewSnapshotStale).toBe(true);
      expect(failed.reviewers.every((reviewer) => reviewer.status === "completed")).toBe(true);
      expect(failed.reviewers.every((reviewer) => reviewer.report !== undefined)).toBe(true);

      const reports = failed.reviewers.map((reviewer) => reviewer.report);
      const retried = await service.retry(started.id);
      expect(retried.phase).toBe("consolidating");
      expect(retried.reviewSnapshotStale).toBe(true);
      expect(retried.reviewers.map((reviewer) => reviewer.report)).toEqual(reports);
      expect(retried.reviewers.every((reviewer) => reviewer.status === "completed")).toBe(true);
    },
    {
      invoke: (async () => {
        probes += 1;
        return probes <= 2
          ? { head: REVIEW_HEAD, paths: [], fingerprint: REVIEW_FINGERPRINT }
          : { head: REVIEW_HEAD, paths: ["src/appeared.ts"], fingerprint: "d".repeat(64) };
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

test("MultiReviewService persists a resolved speed its own supervisor can still load", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  const catalogReads: string[] = [];
  await withService(
    "env-fast-round-trip",
    provider,
    async ({ service, storage, start, snapshot }) => {
      // The environment tier is the one a coordinator writes when it launches,
      // so it has to reach the reviewer and fix selections.
      await storage.updateEnvironment("env-fast-round-trip", {
        agentSettings: { platforms: { claude: { fastMode: true } } },
      });

      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        const current = await snapshot(started.id);
        return Boolean(current?.fixSession?.providerSessionId);
      });

      const current = (await snapshot(started.id))!;
      expect(current.fixModel.fastMode).toBe(true);
      expect(current.reviewers[0]?.fastMode).toBe(true);
      // The session record is spread from its whole selection, so the speed
      // lands in persisted state alongside the model and effort.
      expect(current.fixSession?.fastMode).toBe(true);

      // The guard gates `tick`, `advance`, and `claim`. A snapshot it rejects
      // is not merely missing a field: the workflow stops being supervised at
      // all, so this has to hold against the record as actually stored.
      const stored = await storage.getMultiReviewWorkflow(started.id);
      expect(isMultiReviewWorkflow(stored?.snapshot)).toBe(true);

      // The catalogue read is best-effort. This harness rejects the command,
      // and an unreadable catalogue must leave the Fast choice with the
      // provider rather than downgrading it or failing the start.
      expect(catalogReads).toEqual(["env-fast-round-trip"]);
    },
    {
      packageFlow: true,
      invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        if (command === "get_native_agent_model_catalog") {
          catalogReads.push(String(args?.environmentId));
          throw new Error("catalogue unavailable");
        }
        return stableReviewInvoker<T>(command, args);
      },
    },
  );
});

test("MultiReviewService leaves the model catalogue unread when no speed is configured", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  const commands: string[] = [];
  await withService(
    "env-no-speed-catalogue",
    provider,
    async ({ start, snapshot }) => {
      const started = await start();

      // Most workflows configure no speed at all, and the catalogue command can
      // wait on live bridge fetches. Nothing should pay for it here.
      expect((await snapshot(started.id))?.fixModel.fastMode).toBeUndefined();
      expect(commands).not.toContain("get_native_agent_model_catalog");
    },
    {
      packageFlow: true,
      invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        commands.push(command);
        return stableReviewInvoker<T>(command, args);
      },
    },
  );
});

test("supervision keeps a running review scheduled until consolidation finishes", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  await withService(
    "env-adaptive-review",
    provider,
    async ({ service, start, snapshot }) => {
      await service.init();
      const started = await start();
      await waitUntil(async () => (await snapshot(started.id))?.reviewers[0]?.status === "running");
      const callsWhileRunning = provider.statusCalls;
      await waitUntil(() => provider.statusCalls > callsWhileRunning);
      provider.statusValue = "idle";
      await waitUntil(async () => (await snapshot(started.id))?.phase === "ready");
      expect((await snapshot(started.id))?.consolidatedReport).toBeDefined();
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

// The keyed supervisor is the only driver: the adaptive due scheduler that
// ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK=multi-review selected was removed by
// todo 0048 task 13, so a retired rollback value changes nothing.
test.each(["multi-review", "all"])(
  "a retired rollback value (%s) still runs Multi Review on the keyed supervisor",
  async (value) => {
    const previous = process.env.ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK;
    process.env.ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK = value;
    const provider = new Provider();
    provider.statusValue = "running";
    try {
      await withService(
        `env-retired-rollback-${value}`,
        provider,
        async ({ service, start, snapshot }) => {
          await service.init();
          expect(service.schedulingStatus()).not.toBeNull();
          const started = await start();
          await waitUntil(
            async () => (await snapshot(started.id))?.reviewers[0]?.status === "running",
          );
          provider.statusValue = "idle";
          await waitUntil(async () => (await snapshot(started.id))?.phase === "ready");
          expect(service.schedulingStatus()?.domain).toBe("multi-review");
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
    } finally {
      if (previous === undefined) delete process.env.ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK;
      else process.env.ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK = previous;
    }
  },
);

test.each(["grok", "cursor", "pi", "codex"] as const)(
  "MultiReviewService delivers %s reviewer and consolidation reports through MCP tools",
  async (agent) => {
    const provider = new Provider(false);
    const environmentId = `env-tool-results-${agent}`;
    await withService(
      environmentId,
      provider,
      async ({ service, start, snapshot, workflowResults }) => {
        const selection = { agent, model: agent === "grok" ? "grok-4.6" : "default" };
        const started = await start([selection], selection);
        await waitUntil(async () => {
          await service.advanceNow(started.id);
          return Boolean((await snapshot(started.id))?.reviewers[0]?.requestId);
        });
        let current = (await snapshot(started.id))!;
        const reviewerRequestId = current.reviewers[0]!.requestId!;
        expect(current.reviewers[0]?.resultTransport).toBe("tool-v1");
        const reviewerDispatch = provider.sends.get(reviewerRequestId);
        expect(reviewerDispatch?.prompt).toContain("submit_review_report");
        expect(reviewerDispatch?.options.schema).toBeUndefined();
        expect(reviewerDispatch?.options.workflowResultTool).toBe("submit_review_report");
        expect(reviewerDispatch?.options.workflowResultKey).toBe(reviewerRequestId);
        expect(reviewerDispatch?.options.agentMcp).toEqual({
          url: "http://127.0.0.1:1234/mcp",
          token: "test-token",
        });

        await workflowResults!.submit(
          { environmentId, projectId: "project-1" },
          reviewerRequestId,
          cleanReport,
        );
        await waitUntil(async () => {
          await service.advanceNow(started.id);
          return (await snapshot(started.id))?.reviewers[0]?.status === "completed";
        });
        current = (await snapshot(started.id))!;
        expect(current.reviewers[0]?.status).toBe("completed");
        expect(
          await workflowResults!.status(
            { environmentId, projectId: "project-1" },
            reviewerRequestId,
          ),
        ).toMatchObject({ lifecycle: "consumed" });

        await waitUntil(async () => {
          await service.advanceNow(started.id);
          return (await snapshot(started.id))?.activeRequest?.kind === "consolidate";
        });
        current = (await snapshot(started.id))!;
        const consolidationRequestId = current.activeRequest!.requestId;
        expect(current.activeRequest?.resultTransport).toBe("tool-v1");
        const consolidationDispatch = provider.sends.get(consolidationRequestId);
        expect(consolidationDispatch?.prompt).toContain("submit_consolidated_review");
        expect(consolidationDispatch?.options.schema).toBeUndefined();
        expect(consolidationDispatch?.options.workflowResultTool).toBe(
          "submit_consolidated_review",
        );
        // Consolidation is read-only, so Grok and Pi let its result tools
        // through only for a call naming the attempt the turn declared.
        expect(consolidationDispatch?.options.readOnly).toBe(true);
        expect(consolidationDispatch?.options.workflowResultKey).toBe(consolidationRequestId);
        expect(consolidationDispatch?.options.agentMcp).toEqual({
          url: "http://127.0.0.1:1234/mcp",
          token: "test-token",
        });
        await workflowResults!.submit(
          { environmentId, projectId: "project-1" },
          consolidationRequestId,
          cleanReport,
        );
        await service.advanceNow(started.id);

        expect((await snapshot(started.id))?.phase).toBe("ready");
        expect(
          await workflowResults!.status(
            { environmentId, projectId: "project-1" },
            consolidationRequestId,
          ),
        ).toMatchObject({ lifecycle: "consumed" });
      },
      { toolMode: true },
    );
  },
);

test("a preparation model that finishes without submitting gets one reminder turn", async () => {
  const provider = new Provider(false);
  const environmentId = "env-preparation-reminder";
  await withService(
    environmentId,
    provider,
    async ({ service, snapshot, workflowResults }) => {
      const codex = { agent: "codex" as const, model: "default" };
      const started = await service.start({
        environmentId,
        projectId: "project-1",
        targetBranch: "main",
        reviewers: [codex],
        reviewModel: codex,
        fixModel: codex,
      });
      const first = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) =>
          workflow.activeRequest?.kind === "prepare" && workflow.activeRequest.state === "sent",
      );
      const firstRequestId = first.activeRequest!.requestId;
      const sessionId = first.reviewSession!.providerSessionId;
      expect(first.activeRequest?.resultTransport).toBe("tool-v1");

      // The turn ends idle and nothing reaches submit_validation_plan.
      const reminded = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) =>
          workflow.phase === "failed" ||
          (workflow.activeRequest?.resultReminderSent === true &&
            workflow.activeRequest.state === "sent"),
      );
      expect(reminded.phase).toBe("preparing");
      const reminderRequestId = reminded.activeRequest!.requestId;
      expect(reminderRequestId).not.toBe(firstRequestId);
      expect(reminded.reviewSession?.providerSessionId).toBe(sessionId);
      expect(reminded.activeRequest?.continuationPrompt).toBeUndefined();
      expect(
        await workflowResults!.status({ environmentId, projectId: "project-1" }, firstRequestId),
      ).toMatchObject({ lifecycle: "superseded" });
      const reminder = provider.sends.get(reminderRequestId)!;
      expect(reminder.prompt).toContain(
        "Orkestrator has not received your review package preparation.",
      );
      expect(reminder.prompt).toContain("Your discovery work is already done");
      expect(reminder.prompt).toContain(reminderRequestId);
      expect(reminder.options.workflowResultTool).toBe("submit_validation_plan");
      expect(reminder.options.workflowResultKey).toBe(reminderRequestId);

      // The reminder is spent once: a second miss fails the step as before.
      const failed = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) => workflow.phase === "failed",
      );
      expect(failed.error).toBe(
        "The preparation model finished without calling submit_validation_plan to submit its review package preparation",
      );
      expect(provider.sends.size).toBe(2);
    },
    { toolMode: true, packageFlow: true },
  );
});

test("MultiReviewService continues a consolidation a provider restart cut short", async () => {
  const provider = new Provider(false);
  const environmentId = "env-consolidation-restart";
  const scope = { environmentId, projectId: "project-1" };
  const restarted =
    "Codex restarted before this turn finished, so its work stopped partway. Send a message to continue.";
  await withService(
    environmentId,
    provider,
    async ({ service, start, snapshot, workflowResults }) => {
      const codex = { agent: "codex" as const, model: "default" };
      const started = await start([codex], codex);
      const reviewing = await advanceUntil(service, snapshot, started.id, (workflow) =>
        Boolean(workflow.reviewers[0]?.requestId),
      );
      await workflowResults!.submit(scope, reviewing.reviewers[0]!.requestId!, cleanReport);
      const consolidating = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) =>
          workflow.activeRequest?.kind === "consolidate" && workflow.activeRequest.state === "sent",
      );
      const firstRequestId = consolidating.activeRequest!.requestId;
      const sessionId = (consolidating.reviewSession ?? consolidating.fixSession)!
        .providerSessionId;

      provider.sessionFailures.set(sessionId, restarted);
      provider.restartInterrupted.add(sessionId);
      await service.advanceNow(started.id);
      const queued = (await snapshot(started.id))!;
      expect(queued.phase).toBe("consolidating");
      expect(queued.activeRequest).toMatchObject({
        kind: "consolidate",
        state: "prepared",
        restartContinuationSent: true,
      });
      expect(queued.activeRequest?.requestId).not.toBe(firstRequestId);
      expect(queued.activeRequest?.continuationPrompt).toContain("Continue the consolidation");

      // The bridge clears its notice once the next turn is accepted.
      provider.sessionFailures.delete(sessionId);
      provider.restartInterrupted.delete(sessionId);
      await service.advanceNow(started.id);
      const continuationRequestId = queued.activeRequest!.requestId;
      const continuation = provider.sends.get(continuationRequestId)!;
      expect(continuation.prompt).toContain("stopped partway");
      expect(continuation.prompt).toContain("submit_consolidated_review");
      expect(continuation.prompt).not.toContain("<multi-review-reports-json>");
      expect((await snapshot(started.id))?.activeRequest?.state).toBe("sent");

      await workflowResults!.submit(scope, continuationRequestId, cleanReport);
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.phase).toBe("ready");
    },
    { toolMode: true },
  );
});

test("a step the weekly limit stopped continues on the new account, then the budget ends it", async () => {
  const provider = new Provider(false);
  const environmentId = "env-consolidation-usage-limit";
  const scope = { environmentId, projectId: "project-1" };
  const limit = "You've hit your usage limit.";
  const verdicts = ["wait", "resend", "stop"];
  const calls: Array<{ environmentId: string; resends: number; error?: string }> = [];
  Object.assign(provider, {
    usageLimitStop: async (input: { environmentId: string; resends: number; error?: string }) => {
      calls.push(input);
      return verdicts.shift() ?? "stop";
    },
  });
  await withService(
    environmentId,
    provider,
    async ({ service, start, snapshot, workflowResults }) => {
      const codex = { agent: "codex" as const, model: "default" };
      const started = await start([codex], codex);
      const reviewing = await advanceUntil(service, snapshot, started.id, (workflow) =>
        Boolean(workflow.reviewers[0]?.requestId),
      );
      await workflowResults!.submit(scope, reviewing.reviewers[0]!.requestId!, cleanReport);
      const consolidating = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) =>
          workflow.activeRequest?.kind === "consolidate" && workflow.activeRequest.state === "sent",
      );
      const firstRequestId = consolidating.activeRequest!.requestId;
      const sessionId = (consolidating.reviewSession ?? consolidating.fixSession)!
        .providerSessionId;

      provider.sessionFailures.set(sessionId, limit);
      // Waiting on the verdict neither fails the step nor sends anything.
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.activeRequest?.requestId).toBe(firstRequestId);

      await service.advanceNow(started.id);
      const queued = (await snapshot(started.id))!;
      expect(queued.phase).toBe("consolidating");
      expect(queued.activeRequest).toMatchObject({
        kind: "consolidate",
        state: "prepared",
        usageLimitResends: 1,
      });
      expect(queued.activeRequest?.restartContinuationSent).toBeUndefined();
      expect(queued.activeRequest?.requestId).not.toBe(firstRequestId);
      expect(calls[0]).toMatchObject({ environmentId, resends: 0 });
      expect(calls[0]?.error).toContain(limit);

      provider.sessionFailures.delete(sessionId);
      await service.advanceNow(started.id);
      const continuationRequestId = queued.activeRequest!.requestId;
      const continuation = provider.sends.get(continuationRequestId)!;
      expect(continuation.prompt).toContain("weekly usage limit ran out");
      expect(continuation.prompt).toContain("submit_consolidated_review");
      expect(continuation.prompt).not.toContain("<multi-review-reports-json>");

      // The new account refuses too and the verdict is to stop: the step fails.
      provider.sessionFailures.set(sessionId, limit);
      await service.advanceNow(started.id);
      expect(calls.at(-1)?.resends).toBe(1);
      expect((await snapshot(started.id))?.phase).toBe("failed");
    },
    { toolMode: true },
  );
});

test("a second restart during a step's continuation fails the step", async () => {
  const provider = new Provider(false);
  const environmentId = "env-consolidation-second-restart";
  const restarted = "Codex restarted before this turn finished.";
  await withService(
    environmentId,
    provider,
    async ({ service, start, snapshot, workflowResults }) => {
      const codex = { agent: "codex" as const, model: "default" };
      const started = await start([codex], codex);
      const reviewing = await advanceUntil(service, snapshot, started.id, (workflow) =>
        Boolean(workflow.reviewers[0]?.requestId),
      );
      await workflowResults!.submit(
        { environmentId, projectId: "project-1" },
        reviewing.reviewers[0]!.requestId!,
        cleanReport,
      );
      const consolidating = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) =>
          workflow.activeRequest?.kind === "consolidate" && workflow.activeRequest.state === "sent",
      );
      const sessionId = (consolidating.reviewSession ?? consolidating.fixSession)!
        .providerSessionId;
      provider.sessionFailures.set(sessionId, restarted);
      provider.restartInterrupted.add(sessionId);

      // The first interruption is continued; the bridge still reports the
      // continuation cut short, so the next one fails closed.
      const failed = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) => workflow.phase === "failed",
      );
      expect(failed.error).toBe(`The consolidation session failed: ${restarted}`);
      expect(
        [...provider.sends.values()].filter((send) => send.prompt.includes("stopped partway")),
      ).toHaveLength(1);
    },
    { toolMode: true },
  );
});

/*
 * A step's bridge that dies mid-turn is unreachable until the next pass
 * reconnects. That is an observation fault, as it is for a reviewer: the step
 * keeps its request, and the reconnected bridge's own report (here, that a
 * restart cut the turn short) decides what happens next.
 */
test("MultiReviewService reconnects a step whose bridge became unreachable", async () => {
  class DeadBridgeProvider extends Provider {
    down = false;
    override async status(sessionId: string): Promise<ProviderStatus> {
      if (this.down) throw new ProviderUnreachableError("claude bridge is not reachable");
      return super.status(sessionId);
    }
  }
  const provider = new DeadBridgeProvider(false);
  const environmentId = "env-step-unreachable";
  const scope = { environmentId, projectId: "project-1" };
  let creations = 0;
  let startupFailures = 0;
  await withService(
    environmentId,
    provider,
    async ({ service, start, snapshot, workflowResults }) => {
      const started = await start();
      const reviewing = await advanceUntil(service, snapshot, started.id, (workflow) =>
        Boolean(workflow.reviewers[0]?.requestId),
      );
      await workflowResults!.submit(scope, reviewing.reviewers[0]!.requestId!, cleanReport);
      const consolidating = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) =>
          workflow.activeRequest?.kind === "consolidate" && workflow.activeRequest.state === "sent",
      );
      const firstRequestId = consolidating.activeRequest!.requestId;
      const sessionId = (consolidating.reviewSession ?? consolidating.fixSession)!
        .providerSessionId;

      provider.down = true;
      await service.advanceNow(started.id);
      const reconnecting = (await snapshot(started.id))!;
      expect(reconnecting.phase).toBe("consolidating");
      expect(reconnecting.error).toBeUndefined();
      expect(reconnecting.activeRequest).toMatchObject({
        requestId: firstRequestId,
        state: "sent",
      });
      expect(reconnecting.activeRequest?.idleResultPolls).toBeGreaterThanOrEqual(1);
      expect(provider.aborted).toEqual([]);

      startupFailures = 2;
      for (let pass = 0; pass < 2; pass++) {
        await service.advanceNow(started.id);
        const waiting = (await snapshot(started.id))!;
        expect(waiting.phase).toBe("consolidating");
        expect(waiting.activeRequest).toMatchObject({ requestId: firstRequestId, state: "sent" });
        expect(waiting.activeRequest!.idleResultPolls).toBeGreaterThan(
          reconnecting.activeRequest!.idleResultPolls!,
        );
      }
      expect(startupFailures).toBe(0);
      // The restarted bridge reports the turn cut short; the step continues it.
      const creationsBeforeReconnect = creations;
      provider.down = false;
      provider.sessionFailures.set(sessionId, "Claude restarted before this turn finished.");
      provider.restartInterrupted.add(sessionId);
      const queued = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) => workflow.activeRequest?.restartContinuationSent === true,
      );
      expect(creations).toBeGreaterThan(creationsBeforeReconnect);
      expect(queued.phase).toBe("consolidating");
      expect(queued.activeRequest?.requestId).not.toBe(firstRequestId);
    },
    {
      toolMode: true,
      createProvider: async () => {
        creations += 1;
        if (startupFailures > 0) {
          startupFailures -= 1;
          throw Object.assign(new Error("bridge startup backoff"), { retryable: true });
        }
        return provider;
      },
    },
  );
});

test.each(["status", "startup"] as const)(
  "MultiReviewService bounds unreachable step %s failures",
  async (failureAt) => {
    class DeadBridgeProvider extends Provider {
      down = false;
      override async status(sessionId: string): Promise<ProviderStatus> {
        if (this.down) throw new ProviderUnreachableError("claude bridge is not reachable");
        return super.status(sessionId);
      }
    }
    const provider = new DeadBridgeProvider(false);
    const environmentId = "env-step-unreachable-bound";
    await withService(
      environmentId,
      provider,
      async ({ service, start, snapshot, workflowResults }) => {
        const started = await start();
        const reviewing = await advanceUntil(service, snapshot, started.id, (workflow) =>
          Boolean(workflow.reviewers[0]?.requestId),
        );
        await workflowResults!.submit(
          { environmentId, projectId: "project-1" },
          reviewing.reviewers[0]!.requestId!,
          cleanReport,
        );
        await advanceUntil(
          service,
          snapshot,
          started.id,
          (workflow) =>
            workflow.activeRequest?.kind === "consolidate" &&
            workflow.activeRequest.state === "sent",
        );
        provider.down = true;
        const failed = await advanceUntil(
          service,
          snapshot,
          started.id,
          (workflow) => workflow.phase === "failed",
        );
        expect(failed.error).toContain(
          failureAt === "startup"
            ? "provider stayed unreachable: bridge startup backoff"
            : "provider stayed unreachable: claude bridge is not reachable",
        );
        expect(failed.activeRequest?.idleResultPolls).toBeGreaterThan(1);
      },
      {
        toolMode: true,
        createProvider: async () => {
          if (provider.down && failureAt === "startup")
            throw Object.assign(new Error("bridge startup backoff"), { retryable: true });
          return provider;
        },
      },
    );
  },
);

for (const kind of ["prepare", "fix"] as const) {
  for (const toolMode of [true, false]) {
    test.each(["continue", "second-restart", "accepted"] as const)(
      `${kind} handles %s after a restart (${toolMode ? "tool-v1" : "structured-output-v1"})`,
      async (outcome) => {
        const provider = new Provider(false);
        provider.statusValue = "running";
        if (!toolMode) {
          provider.structured = async <T>(
            _sessionId: string,
            requestId: string,
          ): Promise<StructuredOutputResult<T> | null> =>
            provider.sessionFailures.has(_sessionId)
              ? {
                  ok: false,
                  provider: "codex",
                  requestId,
                  error: {
                    code: "interrupted",
                    message: "Turn interrupted by restart",
                    provider: "codex",
                    retryable: true,
                  },
                }
              : null;
        }
        const environmentId = `env-step-${kind}-${toolMode}-${outcome}`;
        await withService(
          environmentId,
          provider,
          async (context) => {
            const { service, snapshot, workflowResults } = context;
            const first = await startFollowUpStep(kind, context, environmentId, toolMode);
            const sessionId = (first.reviewSession ?? first.fixSession)!.providerSessionId;
            const requestId = first.activeRequest!.requestId;
            const value =
              kind === "prepare"
                ? toolMode
                  ? {
                      headRef: REVIEW_HEAD,
                      commands: [],
                      limitations: ["No validation commands were discovered"],
                    }
                  : TEST_REVIEW_PREPARATION
                : completedAddressFindings;
            const accept = async (resultKey: string) => {
              if (toolMode) {
                expect(
                  await workflowResults!.submit(
                    { environmentId, projectId: "project-1" },
                    resultKey,
                    value,
                  ),
                ).toMatchObject({ ok: true });
              } else {
                provider.structured = async <T>(_sessionId: string, key: string) => ({
                  ok: true,
                  provider: "codex",
                  requestId: key,
                  value: value as T,
                });
              }
            };
            if (outcome === "accepted") await accept(requestId);
            provider.sessionFailures.set(sessionId, "Codex restarted before this turn finished.");
            provider.restartInterrupted.add(sessionId);
            await service.advanceNow(first.id);
            if (outcome !== "accepted") {
              const queued = (await snapshot(first.id))!;
              expect(queued.phase).toBe(kind === "prepare" ? "preparing" : "fixing");
              expect(queued.activeRequest).toMatchObject({
                kind,
                state: "prepared",
                restartContinuationSent: true,
                resultTransport: toolMode ? "tool-v1" : "structured-output-v1",
              });
              const nextId = queued.activeRequest!.requestId;
              expect(nextId).not.toBe(requestId);
              expect(queued.activeRequest!.continuationPrompt).toContain(
                kind === "prepare"
                  ? "Continue the discovery work"
                  : "Continue the Address Findings",
              );
              if (toolMode)
                expect(
                  await workflowResults!.status(
                    { environmentId, projectId: "project-1" },
                    requestId,
                  ),
                ).toMatchObject({ lifecycle: "superseded" });
              provider.sessionFailures.delete(sessionId);
              provider.restartInterrupted.delete(sessionId);
              await service.advanceNow(first.id);
              expect((await snapshot(first.id))!.activeRequest?.state).toBe("sent");
              expect(
                (await snapshot(first.id))!.fixSession?.providerSessionId ??
                  (await snapshot(first.id))!.reviewSession?.providerSessionId,
              ).toBe(sessionId);
              expect(provider.sends.get(nextId)!.options.workflowResultTool).toBe(
                toolMode
                  ? kind === "prepare"
                    ? "submit_validation_plan"
                    : "submit_fix_result"
                  : undefined,
              );
              expect(provider.sends.get(nextId)!.options.workflowResultKey).toBe(
                toolMode ? nextId : undefined,
              );
              if (outcome === "second-restart") {
                provider.sessionFailures.set(sessionId, "Codex restarted again.");
                provider.restartInterrupted.add(sessionId);
                await service.advanceNow(first.id);
                expect((await snapshot(first.id))!).toMatchObject({
                  phase: "failed",
                  error: `The ${kind === "prepare" ? "preparation" : "Address Findings"} session failed: Codex restarted again.`,
                });
                expect(provider.sends.size).toBe(2);
                return;
              }
              await accept(nextId);
              provider.statusValue = "idle";
              await service.advanceNow(first.id);
            }
            if (kind === "prepare" && toolMode) await service.advanceNow(first.id);
            const finished = (await snapshot(first.id))!;
            expect(finished.phase).toBe(kind === "prepare" ? "reviewing" : "completed");
            expect(finished.activeRequest).toBeUndefined();
            expect(kind === "prepare" ? finished.reviewPackage : finished.fixResult).toBeDefined();
            expect(provider.sends.size).toBe(outcome === "accepted" ? 1 : 2);
          },
          {
            toolMode,
            invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
              if (command === "start_review_validation")
                return {
                  ...(args!.run as ReviewValidationRun),
                  status: "completed",
                } as T;
              return stableReviewInvoker<T>(command, args);
            },
          },
        );
      },
    );
  }
}

/*
 * The Codex bridge continues a turn the model refused for capacity
 * (`bridges/codex-bridge/src/app-server-runtime-capacity-retry.ts`). It keeps
 * the session `running` until the last attempt ends, and a result submitted
 * during a continuation lands under the original request's key. So an
 * unattended Address Findings keeps waiting and completes; only a refusal that outlasts
 * the retries fails it, with the bridge's exhausted message.
 */
test.each(["recovers", "exhausted"] as const)(
  "an unattended Address Findings survives a Codex capacity retry (%s)",
  async (outcome) => {
    const provider = new Provider(false);
    provider.statusValue = "running";
    const environmentId = `env-fix-capacity-${outcome}`;
    await withService(
      environmentId,
      provider,
      async (context) => {
        const { service, snapshot, workflowResults } = context;
        const first = await startFollowUpStep("fix", context, environmentId, true);
        const sessionId = first.fixSession!.providerSessionId;
        const requestId = first.activeRequest!.requestId;
        // The bridge's backoff and its continuation: every pass reads running.
        for (let pass = 0; pass < 3; pass += 1) await service.advanceNow(first.id);
        expect(await snapshot(first.id)).toMatchObject({
          phase: "fixing",
          activeRequest: { requestId, state: "sent" },
        });
        if (outcome === "exhausted") {
          const exhausted = capacityRetriesExhaustedError(
            { message: CODEX_SERVER_OVERLOADED_MESSAGE, code: "serverOverloaded" },
            5,
          ).message;
          provider.sessionFailures.set(sessionId, exhausted);
          await service.advanceNow(first.id);
          expect(await snapshot(first.id)).toMatchObject({
            phase: "failed",
            error: `The Address Findings session failed: ${exhausted}`,
          });
          expect(provider.sends.size).toBe(1);
          return;
        }
        expect(
          await workflowResults!.submit(
            { environmentId, projectId: "project-1" },
            requestId,
            completedAddressFindings,
          ),
        ).toMatchObject({ ok: true });
        provider.statusValue = "idle";
        await service.advanceNow(first.id);
        const finished = (await snapshot(first.id))!;
        expect(finished.phase).toBe("completed");
        expect(finished.fixResult).toBeDefined();
        // No hand-typed "Please continue": the step sent its prompt once.
        expect(provider.sends.size).toBe(1);
      },
      {
        toolMode: true,
        invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
          if (command === "start_review_validation")
            return {
              ...(args!.run as ReviewValidationRun),
              status: "completed",
            } as T;
          return stableReviewInvoker<T>(command, args);
        },
      },
    );
  },
);

test.each(["recovers", "exhausted"] as const)(
  "an unattended Address Findings waits out an OpenCode capacity retry (%s)",
  async (outcome) => {
    const provider = new Provider(false);
    provider.statusValue = "running";
    const environmentId = `env-fix-opencode-capacity-${outcome}`;
    await withService(
      environmentId,
      provider,
      async (context) => {
        const { service, snapshot, workflowResults } = context;
        const first = await startFollowUpStep("fix", context, environmentId, true);
        const sessionId = first.fixSession!.providerSessionId;
        const requestId = first.activeRequest!.requestId;
        // The provider's backoff: OpenCode reads idle, the request has not
        // settled. Far more passes than the idle-result bound would allow.
        provider.statusValue = "idle";
        provider.turnSettledValue = false;
        for (let pass = 0; pass < 12; pass += 1) await service.advanceNow(first.id);
        const waiting = await snapshot(first.id);
        expect(waiting).toMatchObject({
          phase: "fixing",
          activeRequest: { requestId, state: "sent" },
        });
        expect(waiting!.activeRequest!.idleResultPolls).toBeUndefined();
        provider.turnSettledValue = undefined;
        if (outcome === "exhausted") {
          provider.sessionFailures.set(sessionId, "Service Unavailable");
          await service.advanceNow(first.id);
          expect(await snapshot(first.id)).toMatchObject({
            phase: "failed",
            error: "The Address Findings session failed: Service Unavailable",
          });
          expect(provider.sends.size).toBe(1);
          return;
        }
        expect(
          await workflowResults!.submit(
            { environmentId, projectId: "project-1" },
            requestId,
            completedAddressFindings,
          ),
        ).toMatchObject({ ok: true });
        await service.advanceNow(first.id);
        expect((await snapshot(first.id))!.phase).toBe("completed");
        // The workflow itself sent its prompt once; the continuation is the provider's.
        expect(provider.sends.size).toBe(1);
      },
      {
        toolMode: true,
        invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
          if (command === "start_review_validation")
            return {
              ...(args!.run as ReviewValidationRun),
              status: "completed",
            } as T;
          return stableReviewInvoker<T>(command, args);
        },
      },
    );
  },
);

test("Address Findings gets one result reminder in its existing session and fails after a second miss", async () => {
  const provider = new Provider(false);
  provider.statusValue = "running";
  const environmentId = "env-fix-result-reminder";
  await withService(
    environmentId,
    provider,
    async (context) => {
      const { service, snapshot, workflowResults } = context;
      const first = await startFollowUpStep("fix", context, environmentId, true);
      provider.statusValue = "idle";
      const reminded = await advanceUntil(
        service,
        snapshot,
        first.id,
        (workflow) => workflow.activeRequest?.resultReminderSent === true,
      );
      const requestId = reminded.activeRequest!.requestId;
      expect(requestId).not.toBe(first.activeRequest!.requestId);
      expect(reminded.fixSession!.providerSessionId).toBe(first.fixSession!.providerSessionId);
      expect(
        await workflowResults!.status(
          { environmentId, projectId: "project-1" },
          first.activeRequest!.requestId,
        ),
      ).toMatchObject({ lifecycle: "superseded" });
      const failed = await advanceUntil(
        service,
        snapshot,
        first.id,
        (workflow) => workflow.phase === "failed",
      );
      expect(provider.sends.get(requestId)!.prompt).toContain(
        "Your Address Findings work is already done",
      );
      expect(provider.sends.get(requestId)!.options.workflowResultTool).toBe("submit_fix_result");
      expect(provider.sends.get(requestId)!.options.workflowResultKey).toBe(requestId);
      expect(failed.error).toContain("without calling submit_fix_result");
      expect(provider.sends.size).toBe(2);
    },
    { toolMode: true },
  );
});

test.each(["received", "needs-attention"] as const)(
  "an Address Findings run with %s submission never sends a result reminder",
  async (submission) => {
    const provider = new Provider(false);
    provider.statusValue = "running";
    const environmentId = `env-fix-no-reminder-${submission}`;
    await withService(
      environmentId,
      provider,
      async (context) => {
        const { service, snapshot, workflowResults } = context;
        const first = await startFollowUpStep("fix", context, environmentId, true);
        // Exercise the delivery guard independently of result hydration: an
        // accepted but temporarily unreadable slot must not trigger another turn.
        const projection = jest.spyOn(workflowResults!, "projection").mockResolvedValue(submission);
        const structured = jest.spyOn(workflowResults!, "structured").mockResolvedValue(null);
        try {
          provider.statusValue = "idle";
          const failed = await advanceUntil(
            service,
            snapshot,
            first.id,
            (workflow) => workflow.phase === "failed",
          );
          expect(failed.activeRequest?.resultSubmission).toBe(submission);
          expect(failed.activeRequest?.resultReminderSent).toBeUndefined();
          expect(provider.sends.size).toBe(1);
        } finally {
          projection.mockRestore();
          structured.mockRestore();
        }
      },
      { toolMode: true },
    );
  },
);

for (const owner of ["reviewer", "step"] as const) {
  for (const followUp of ["reminder", "continuation"] as const) {
    test.each(["prepared", "dispatching", "sent"] as const)(
      `${owner} retains its ${followUp} identity and budget after reloading %s`,
      async (boundary) => {
        const provider = new Provider(false);
        provider.statusValue = "running";
        const sends: string[] = [];
        const send = provider.send.bind(provider);
        let ambiguousRequest: string | undefined;
        provider.send = async (sessionId, prompt, options) => {
          sends.push(options.requestId);
          await send(sessionId, prompt, options);
          if (options.requestId === ambiguousRequest) {
            throw new AmbiguousPromptDispatchError("Accepted before backend stopped");
          }
        };
        const environmentId = `env-reload-${owner}-${followUp}-${boundary}`;
        await withService(
          environmentId,
          provider,
          async (context) => {
            const { service, start, snapshot, workflowResults, dataDir } = context;
            const codex = { agent: "codex" as const, model: "default" };
            const first =
              owner === "step"
                ? await startFollowUpStep("prepare", context, environmentId, true)
                : await start([codex], codex).then((workflow) =>
                    advanceUntil(
                      service,
                      snapshot,
                      workflow.id,
                      (current) => current.reviewers[0]?.dispatchState === "sent",
                    ),
                  );
            const record = (workflow: MultiReviewWorkflow) =>
              owner === "step" ? workflow.activeRequest! : workflow.reviewers[0]!;
            const initialSessions = provider.sessions;
            const requestId = record(first).requestId!;
            const sessionId =
              owner === "step"
                ? first.reviewSession!.providerSessionId
                : first.reviewers[0]!.providerSessionId!;
            provider.statusValue = "idle";
            if (followUp === "continuation") {
              provider.sessionFailures.set(sessionId, "Codex restarted mid-turn");
              provider.restartInterrupted.add(sessionId);
            }
            const flag = followUp === "reminder" ? "resultReminderSent" : "restartContinuationSent";
            const queued = await advanceUntil(
              service,
              snapshot,
              first.id,
              (workflow) => record(workflow)[flag] === true,
            );
            const nextId = record(queued).requestId!;
            expect(nextId).not.toBe(requestId);
            expect(
              owner === "step" ? queued.activeRequest!.state : queued.reviewers[0]!.dispatchState,
            ).toBe("prepared");
            expect(
              await workflowResults!.status({ environmentId, projectId: "project-1" }, requestId),
            ).toMatchObject({ lifecycle: "superseded" });
            provider.sessionFailures.delete(sessionId);
            provider.restartInterrupted.delete(sessionId);
            provider.statusValue = "running";
            if (boundary !== "prepared") {
              if (boundary === "dispatching") ambiguousRequest = nextId;
              await service.advanceNow(first.id);
            }
            const before = (await snapshot(first.id))!;
            expect(
              owner === "step" ? before.activeRequest!.state : before.reviewers[0]!.dispatchState,
            ).toBe(boundary);
            await service.shutdown();
            workflowResults!.closeStorage();

            // Reopen both stores, rather than carrying any service's cached
            // projection or workflow-result slot through the simulated reload.
            const restoredStorage = new StorageService(dataDir);
            await restoredStorage.init();
            const restoredResults = new WorkflowResultService(dataDir);
            const restored = new MultiReviewService(restoredStorage, stableReviewInvoker, {
              autoAdvance: false,
              provider: async () => provider,
              workflowResults: restoredResults,
              resolveAgentToolConnection: () => ({
                url: "http://127.0.0.1:1234/mcp",
                token: "test-token",
              }),
            });
            const read = async (id: string) =>
              (await restoredStorage.getMultiReviewWorkflow(id))?.snapshot as MultiReviewWorkflow;
            try {
              await restored.init();
              expect(record(await read(first.id))).toMatchObject({
                requestId: nextId,
                [flag]: true,
              });
              await restored.advanceNow(first.id);
              expect(record(await read(first.id)).requestId).toBe(nextId);
              expect(sends.filter((id) => id === nextId)).toHaveLength(1);
              expect(provider.sessions).toBe(initialSessions);
              if (followUp === "continuation") {
                provider.sessionFailures.set(sessionId, "Codex restarted a second time");
                provider.restartInterrupted.add(sessionId);
              } else {
                provider.statusValue = "idle";
              }
              const failed = await advanceUntil(restored, read, first.id, (workflow) =>
                owner === "step"
                  ? workflow.phase === "failed"
                  : workflow.reviewers[0]?.status === "failed",
              );
              expect(record(failed)).toMatchObject({ requestId: nextId, [flag]: true });
              expect(owner === "step" ? failed.error : failed.reviewers[0]!.error).toContain(
                followUp === "continuation" ? "Codex restarted a second time" : "without calling",
              );
              expect(sends).toEqual([requestId, nextId]);
              // Both budgets must remain independent when one has been spent.
              expect(
                record(failed)[
                  followUp === "reminder" ? "restartContinuationSent" : "resultReminderSent"
                ],
              ).toBeUndefined();
            } finally {
              await restored.shutdown();
              restoredResults.closeStorage();
            }
            restoredStorage.close();
          },
          { toolMode: true },
        );
      },
    );
  }
}

test("a consolidation that pastes its report instead of submitting it says so", async () => {
  const provider = new Provider(false);
  const originalMessages = provider.messages.bind(provider);
  provider.messages = async (id, options) => {
    const rows = await originalMessages(id, options);
    return options?.limit ? rows.slice(-options.limit) : rows;
  };
  const environmentId = "env-tool-results-pasted";
  await withService(
    environmentId,
    provider,
    async ({ service, start, snapshot, workflowResults }) => {
      const selection = { agent: "codex" as const, model: "default" };
      const started = await start([selection], selection);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return Boolean((await snapshot(started.id))?.reviewers[0]?.requestId);
      });
      await workflowResults!.submit(
        { environmentId, projectId: "project-1" },
        (await snapshot(started.id))!.reviewers[0]!.requestId!,
        cleanReport,
      );
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.activeRequest?.kind === "consolidate";
      });
      // The model could not reach its submit tool and answered in text.
      provider.messagesValue = [
        { role: "assistant", parts: [{ type: "text", content: JSON.stringify(cleanReport) }] },
        ...Array.from({ length: 17 }, () => ({
          role: "assistant",
          content: "",
          parts: [{ type: "tool-invocation", toolName: "read" }],
        })),
      ];
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "failed";
      });

      expect((await snapshot(started.id))?.error).toBe(
        "The consolidation model replied with its consolidated report as text instead of calling submit_consolidated_review",
      );
      // It was reminded once, by name, before the step failed.
      const reminders = [...provider.sends.values()].filter((send) =>
        send.prompt.includes("You wrote the consolidated report as reply text."),
      );
      expect(reminders).toHaveLength(1);
      expect((await snapshot(started.id))?.activeRequest?.resultReminderSent).toBe(true);
    },
    { toolMode: true },
  );
});

test("MultiReviewService sends OpenCode the stable broker capability and exact turn tool", async () => {
  const provider = new Provider(false);
  await withService(
    "env-opencode-tool-results",
    provider,
    async ({ service, start, snapshot }) => {
      const opencode = { agent: "opencode" as const, model: "default" };
      const started = await start([opencode], opencode);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return Boolean((await snapshot(started.id))?.reviewers[0]?.requestId);
      });
      const reviewer = (await snapshot(started.id))!.reviewers[0]!;
      expect(reviewer.resultTransport).toBe("tool-v1");
      const dispatch = provider.sends.get(reviewer.requestId!);
      expect(dispatch?.prompt).toContain('capability "signed-attempt-capability"');
      expect(dispatch?.options).toMatchObject({
        schema: undefined,
        workflowResultTool: "submit_review_report",
        agentMcp: {
          url: "http://127.0.0.1:1234/mcp",
          token: "broker-token",
          workflowResultCapability: "signed-attempt-capability",
        },
      });
    },
    { toolMode: true },
  );
});

test("MultiReviewService fails a container stage at once when its agent tools are unreachable", async () => {
  const unreachable =
    "Orkestrator did not start the stage: the container can't reach the agent tools server.";
  const preflights: Array<{ environmentId: string; stage: string }> = [];
  for (const packageFlow of [false, true]) {
    const provider = new Provider(false);
    preflights.length = 0;
    await withService(
      `env-unreachable-tools-${packageFlow ? "package" : "legacy"}`,
      provider,
      async ({ service, start, snapshot }) => {
        const started = await start();
        await waitUntil(async () => {
          await service.advanceNow(started.id);
          const current = await snapshot(started.id);
          return (
            current?.phase === "failed" ||
            current?.reviewers.some((reviewer) => reviewer.status === "failed") === true
          );
        });
        const current = (await snapshot(started.id))!;
        const failure =
          current.error ?? current.reviewers.find((reviewer) => reviewer.error)?.error;
        expect(failure).toContain(unreachable);
        // Nothing was dispatched to an agent that could never report back.
        expect(provider.sends.size).toBe(0);
        expect(preflights[0]?.stage).toBe(
          packageFlow ? "Multi Review preparation step" : "Multi Review reviewer",
        );
      },
      {
        toolMode: true,
        packageFlow,
        environmentType: "containerized",
        serviceOptions: {
          assertAgentToolsReachable: async (environmentId, stage) => {
            preflights.push({ environmentId, stage });
            throw new Error(unreachable);
          },
        },
      },
    );
  }
});

test("MultiReviewService skips the agent tools preflight for local worktrees", async () => {
  const provider = new Provider(false);
  let preflights = 0;
  await withService(
    "env-local-tools",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return Boolean((await snapshot(started.id))?.reviewers[0]?.requestId);
      });
      expect(preflights).toBe(0);
    },
    {
      toolMode: true,
      serviceOptions: {
        assertAgentToolsReachable: async () => {
          preflights += 1;
        },
      },
    },
  );
});

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

test("MultiReviewService asks the Address Findings model to correct an invalid consolidated report", async () => {
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
      // The source IDs are gone from the stored report, so overlap is counted
      // at certification: both reviewers substantiated every finding.
      const findings =
        consolidatedReport.issues.length + consolidatedReport.testCoverageGaps.length;
      expect(ready?.consolidationOverlap).toMatchObject({
        version: 1,
        reviewers: 2,
        sourceFindings: findings * 2,
        citedSourceFindings: findings * 2,
        consolidatedFindings: findings,
        singleSourceFindings: 0,
      });
      expect(ready?.consolidationOverlap?.positions.map((entry) => entry.novelFindings)).toEqual([
        findings,
        0,
      ]);
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
      expect(failed?.error).toContain(
        "The consolidation model could not produce a valid consolidated report in 3 repair attempts.",
      );
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

test("MultiReviewService reads a step's session tail only for the step using it", async () => {
  const provider = new Provider();
  provider.messagesValue = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "Fixing the findings",
      parts: [{ type: "text", content: "Fixing the findings" }],
    },
  ];
  await withService("env-step-tail", provider, async ({ service, storage }) => {
    // Every step of this older workflow ran in the one Address Findings session.
    const workflowId = await seedLegacyFixingWorkflow(storage, "env-step-tail");

    await expect(service.stepTranscript(workflowId, "fix")).resolves.toMatchObject({
      workflowId,
      step: "fix",
      workflowPhase: "fixing",
      session: "own",
      agent: "claude",
      sessionStatus: "running",
      transcript: "snapshot",
      messages: provider.messagesValue,
    });
    await expect(service.stepTranscript(workflowId, "consolidate")).resolves.toMatchObject({
      session: "other-step",
      sessionStep: "fix",
      messages: [],
    });
    await expect(service.stepTranscript("missing-workflow", "fix")).rejects.toThrow(
      "Multi review workflow not found",
    );
  });
});
