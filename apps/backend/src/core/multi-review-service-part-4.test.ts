// Part 4 of 4 of the MultiReviewService suite, split from multi-review-service.test.ts so
// `bun test --parallel` can spread it across workers. Shared helpers live in
// multi-review-service-test-support.ts.
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";
import { pipelineWorkerTabForResultKey } from "./pipeline-worker-identity.js";
import { multiReviewNativeAddressFindingsOptions } from "./multi-review-native-address-findings.js";
import { NativeAgentService, nativeAgentSessionStorageKey } from "./native-agent-service.js";
import type { NativeAgentRuntimeProvider } from "./native-agent-provider.js";
import { dispatchMultiReviewAddressFindingsPrompt } from "./multi-review-address-findings-dispatch.js";
import { TEST_REVIEW_PREPARATION } from "./build-pipeline-test-fixtures.js";
import { expect, jest, test } from "bun:test";
import {
  isMultiReviewWorkflow,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { StorageService } from "./storage.js";
import { MultiReviewService } from "./multi-review-service.js";
import {
  Provider,
  REVIEW_HEAD,
  advanceUntil,
  autoPrAddressFindingsDispatch,
  autoPrInvoker,
  cleanReport,
  completedAddressFindings,
  mutateStoredWorkflow,
  rewindGit,
  runInteractiveAddressFindings,
  stableReviewInvoker,
  startFollowUpStep,
  waitUntil,
  withService,
} from "./multi-review-service-test-support.js";

// This owner includes real lease timers and deliberately blocked provider
// calls. Keep Bun's outer budget wider than its own diagnostic waits.
jest.setTimeout(30_000);

test("preparation metadata repairs are bounded and preserve already collected evidence", async () => {
  const provider = new Provider();
  const structured = provider.structured.bind(provider);
  let invalid = true;
  provider.structured = async (session, request) =>
    invalid
      ? { ok: true, provider: "claude", requestId: request, value: {} as never }
      : structured(session, request);
  await withService(
    "env-package-repair",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(
        async () => (await snapshot(started.id))?.activeRequest?.schemaRepairAttempts === 1,
      );
      const repairing = (await snapshot(started.id))!;
      expect(repairing.activeRequest?.schemaRepairPrompt).toContain("Do not run validation");
      expect(repairing.activeRequest?.kind).toBe("prepare");
      expect(repairing.reviewPackage).toBeUndefined();
      invalid = false;
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      // Preparation, the reviewer, and consolidation's own session: the repair
      // stayed inside the preparation session.
      expect(provider.creates.map((entry) => entry.label)).toEqual([
        "Multi Review · Prepare review package",
        expect.any(String),
        "Multi Review · Consolidation",
      ]);
    },
    { packageFlow: true },
  );
});

test("cancelling package preparation stops its fix-model session before settling", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  await withService(
    "env-package-cancel",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await service.advanceNow(started.id);
      const sessionId = (await snapshot(started.id))!.fixSession!.providerSessionId;
      provider.statusOverrides.set(sessionId, "idle");
      await service.cancel(started.id);
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.phase).toBe("cancelled");
      expect((await snapshot(started.id))?.stepRuntimes?.prepare?.completedAt).toBeDefined();
      expect(provider.aborted).toContain(sessionId);
      expect(provider.creates).toHaveLength(1);
    },
    { packageFlow: true },
  );
});

test("read-only reviewers and consolidation record a missing command sandbox (todo 0190)", async () => {
  const reason = "Claude's command sandbox cannot run commands on this host: bwrap is missing.";
  const provider = new Provider();
  provider.commandSandboxOff = reason;
  await withService(
    "env-sandbox-off",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      // Read back through storage, so the field also passes the record validators.
      const ready = (await snapshot(started.id))!;
      expect(ready.reviewers.length).toBeGreaterThan(0);
      for (const reviewer of ready.reviewers) {
        expect(reviewer.status).toBe("completed");
        expect(reviewer.commandSandboxOff).toBe(reason);
      }
      expect(ready.stepRuntimes?.consolidate?.commandSandboxOff).toBe(reason);
      // Preparation is not a read-only turn, so its step never claims one.
      expect(ready.stepRuntimes?.prepare?.commandSandboxOff).toBeUndefined();
      // Both turns were sent read-only, which is why the bridge chose the hook.
      const readOnlySends = Array.from(provider.sends.values()).filter(
        (send) => send.options.readOnly === true,
      );
      expect(readOnlySends.length).toBe(ready.reviewers.length + 1);
    },
    { packageFlow: true },
  );
});

test("a host with a working sandbox leaves the review's steps without a note", async () => {
  const provider = new Provider();
  await withService(
    "env-sandbox-on",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const ready = (await snapshot(started.id))!;
      for (const reviewer of ready.reviewers) expect(reviewer.commandSandboxOff).toBeUndefined();
      expect(ready.stepRuntimes?.consolidate?.commandSandboxOff).toBeUndefined();
    },
    { packageFlow: true },
  );
});

test("preparation and consolidation each keep their own runtime and token count", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  provider.usageTokens = 40_000;
  await withService(
    "env-step-runtimes",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await service.advanceNow(started.id);

      const preparing = (await snapshot(started.id))!;
      expect(preparing.phase).toBe("preparing");
      // A fresh session starts from nothing, so preparation owns the whole total.
      expect(preparing.stepRuntimes?.prepare).toMatchObject({ tokenCount: 40_000 });
      expect(preparing.stepRuntimes?.prepare?.startedAt).toBeDefined();
      expect(preparing.stepRuntimes?.prepare?.completedAt).toBeUndefined();
      expect(preparing.fixSession?.tokenCount).toBe(40_000);

      provider.statusValue = "idle";
      await service.advanceNow(started.id);
      const prepared = (await snapshot(started.id))!;
      expect(prepared.phase).toBe("reviewing");
      const prepare = prepared.stepRuntimes!.prepare!;
      expect(prepare.completedAt).toBeDefined();

      // Consolidation runs on a session of its own with its own counter.
      provider.usageTokensBySession.set(prepared.fixSession!.providerSessionId, 90_000);
      provider.usageTokens = 25_000;
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });

      const ready = (await snapshot(started.id))!;
      // Preparation finished before consolidation was dispatched, so its
      // session's later growth may not be added to it.
      expect(ready.stepRuntimes?.prepare).toMatchObject({
        startedAt: prepare.startedAt,
        completedAt: prepare.completedAt,
        tokenCount: 40_000,
      });
      expect(ready.stepRuntimes?.consolidate).toMatchObject({ tokenCount: 25_000 });
      expect(ready.stepRuntimes?.consolidate?.completedAt).toBeDefined();
      expect(ready.fixSession?.tokenCount).toBe(25_000);
      expect(ready.preparationSession?.tokenCount).toBe(40_000);
    },
    { packageFlow: true },
  );
});

test("finalizes delayed preparation usage before baselining consolidation", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  await withService(
    "env-step-runtimes-delayed-usage",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await service.advanceNow(started.id);

      provider.statusValue = "idle";
      provider.usagePending = true;
      await service.advanceNow(started.id);
      const pending = (await snapshot(started.id))!;
      expect(pending.phase).toBe("preparing");
      expect(pending.activeRequest?.usageFinalizationPolls).toBe(1);
      expect(pending.stepRuntimes?.prepare?.tokenCount).toBeUndefined();

      provider.usageTokens = 40_000;
      provider.usagePending = false;
      await service.advanceNow(started.id);
      const prepared = (await snapshot(started.id))!;
      expect(prepared.phase).toBe("reviewing");
      expect(prepared.stepRuntimes?.prepare?.tokenCount).toBe(40_000);

      provider.usageTokensBySession.set(prepared.fixSession!.providerSessionId, 90_000);
      provider.usageTokens = 25_000;
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const ready = (await snapshot(started.id))!;
      expect(ready.stepRuntimes?.prepare?.tokenCount).toBe(40_000);
      expect(ready.stepRuntimes?.consolidate?.tokenCount).toBe(25_000);
    },
    { packageFlow: true },
  );
});

test("consolidation's own session is counted from zero when preparation usage was never read", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  await withService(
    "env-step-runtimes-unknown-baseline",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await service.advanceNow(started.id);
      provider.statusValue = "idle";
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.stepRuntimes?.prepare?.tokenCount).toBeUndefined();

      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "consolidating";
      });
      provider.statusValue = "running";
      await service.advanceNow(started.id);
      provider.usageTokens = 65_000;
      await service.advanceNow(started.id);

      const consolidating = (await snapshot(started.id))!;
      expect(consolidating.fixSession?.tokenCount).toBe(65_000);
      expect(consolidating.fixSession?.openedFor).toBe("consolidate");
      expect(consolidating.stepRuntimes?.consolidate?.tokenBaseline).toBe(0);
      expect(consolidating.stepRuntimes?.consolidate?.tokenCount).toBe(65_000);
      expect(consolidating.stepRuntimes?.prepare?.tokenCount).toBeUndefined();
    },
    { packageFlow: true },
  );
});

test("a failed consolidation keeps the step's clock and preparation's numbers", async () => {
  const provider = new Provider();
  provider.usageTokens = 10_000;
  await withService(
    "env-step-runtimes-failure",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "consolidating";
      });
      provider.statusValue = "running";
      await service.advanceNow(started.id);
      const consolidating = (await snapshot(started.id))!;
      expect(consolidating.stepRuntimes?.consolidate?.startedAt).toBeDefined();
      expect(consolidating.stepRuntimes?.consolidate?.completedAt).toBeUndefined();

      provider.sessionFailures.set(consolidating.fixSession!.providerSessionId, "bridge crashed");
      await service.advanceNow(started.id);

      const failed = (await snapshot(started.id))!;
      expect(failed.phase).toBe("failed");
      expect(failed.stepRuntimes?.consolidate?.completedAt).toBeDefined();
      expect(failed.stepRuntimes?.prepare?.tokenCount).toBe(10_000);
    },
    { packageFlow: true },
  );
});

test("retrying consolidation restarts its numbers and preserves preparation's", async () => {
  const provider = new Provider();
  provider.usageTokens = 12_000;
  await withService(
    "env-step-runtimes-retry",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "consolidating";
      });
      provider.statusValue = "running";
      await service.advanceNow(started.id);
      const consolidating = (await snapshot(started.id))!;
      provider.sessionFailures.set(consolidating.fixSession!.providerSessionId, "bridge crashed");
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.phase).toBe("failed");

      provider.sessionFailures.clear();
      const retried = await service.retry(started.id);
      expect(retried.phase).toBe("consolidating");
      // The retry runs on a new session, so consolidation is measured again.
      expect(retried.stepRuntimes?.consolidate).toBeUndefined();
      expect(retried.stepRuntimes?.prepare?.tokenCount).toBe(12_000);
    },
    { packageFlow: true },
  );
});

test("fix-session usage falls back to the transcript and never fails the turn", async () => {
  const provider = new Provider();
  // Exercises the messages-based progress and usage path.
  delete provider.transcriptSnapshot;
  provider.statusValue = "running";
  provider.usageMessageLimit = 32;
  provider.messagesValue = [{ id: "assistant-1", role: "assistant", content: "Preparing" }];
  provider.usageFromMessages = () => {
    throw new Error("usage unavailable");
  };
  await withService(
    "env-step-runtimes-transcript-usage",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await service.advanceNow(started.id);

      const unmetered = (await snapshot(started.id))!;
      expect(unmetered.phase).toBe("preparing");
      expect(unmetered.stepRuntimes?.prepare?.startedAt).toBeDefined();
      expect(unmetered.stepRuntimes?.prepare?.tokenCount).toBeUndefined();

      provider.usageFromMessages = () => ({ usedTokens: 120, sessionTokens: 5_000 });
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.stepRuntimes?.prepare?.tokenCount).toBe(5_000);
      // The progress probe reuses the transcript the usage read already fetched.
      expect(provider.messageOptions.every((options) => options?.limit === 32)).toBe(true);
    },
    { packageFlow: true, serviceOptions: { progressProbeIntervalMs: 0 } },
  );
});

test("throttles transcript-derived fix-session usage to the progress probe cadence", async () => {
  const provider = new Provider();
  // Exercises the messages-based progress and usage path.
  delete provider.transcriptSnapshot;
  provider.statusValue = "running";
  provider.usageMessageLimit = 64;
  provider.messagesValue = [{ id: "assistant-1", role: "assistant", content: "Preparing" }];
  provider.usageFromMessages = () => ({ usedTokens: 120, sessionTokens: 5_000 });
  await withService(
    "env-step-runtimes-transcript-throttle",
    provider,
    async ({ service, start }) => {
      const started = await start();
      await service.advanceNow(started.id);
      const readsAfterProbe = provider.messagesCalls;
      expect(readsAfterProbe).toBeGreaterThan(0);

      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);

      expect(provider.messagesCalls).toBe(readsAfterProbe);
      expect(provider.messageOptions.at(-1)).toEqual({ limit: 64 });
    },
    { packageFlow: true },
  );
});

test("a failed fix-session transcript read does not reset the progress baseline", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  provider.usageMessageLimit = 64;
  provider.messagesValue = [{ id: "assistant-1", role: "assistant", content: "Preparing" }];
  provider.usageFromMessages = () => ({ usedTokens: 120, sessionTokens: 5_000 });
  await withService(
    "env-step-runtimes-transcript-failure",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await service.advanceNow(started.id);
      const baseline = (await snapshot(started.id))!.fixSession!;
      expect(baseline.progressDigest).toBeDefined();

      const stalledSince = "2026-08-14T00:10:00.000Z";
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        workflow.fixSession!.stalledSince = stalledSince;
      });
      provider.messagesError = new Error("transcript unavailable");
      await service.advanceNow(started.id);

      expect((await snapshot(started.id))?.fixSession).toMatchObject({
        progressAt: baseline.progressAt,
        progressDigest: baseline.progressDigest,
        stalledSince,
      });
    },
    { packageFlow: true, serviceOptions: { progressProbeIntervalMs: 0 } },
  );
});

test("backfills a runtime for a preparation request persisted before step accounting", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  await withService(
    "env-step-runtimes-legacy-active",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await service.advanceNow(started.id);
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        delete workflow.stepRuntimes;
      });

      provider.statusValue = "idle";
      await service.advanceNow(started.id);
      const prepared = (await snapshot(started.id))!;
      expect(prepared.phase).toBe("reviewing");
      expect(prepared.stepRuntimes?.prepare).toMatchObject({
        startedAt: expect.any(String),
        completedAt: expect.any(String),
      });

      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      expect((await snapshot(started.id))?.stepRuntimes?.prepare).toBeDefined();
    },
    { packageFlow: true },
  );
});

// Use the same production mapping as Backend, with real dispatch journals and
// durable queues. No renderer is mounted during settlement or publication.
test.each(["delivery", "retry", "restart"] as const)(
  "native follow-up invalidates interactive PR authorization at %s",
  async (timing) => {
    for (const mutation of ["follow-up", "queued", "stop-then-follow-up", "identity"] as const) {
      const provider = new Provider();
      const pr = autoPrInvoker({ failures: timing === "retry" ? 1 : 0 });
      let native!: NativeAgentService;
      let nativeStorage!: StorageService;
      const mapping = multiReviewNativeAddressFindingsOptions({
        sessionRequestOutcome: (input) => native.sessionRequestOutcome(input),
        withSessionWorkFence: (input, operation) => native.withSessionWorkFence(input, operation),
      });
      await withService(
        `env-native-pr-${timing}-${mutation}`,
        provider,
        async ({ service, storage, start, snapshot }) => {
          const newNative = () =>
            new NativeAgentService(storage, pr.invoke, {
              provider: async () => provider as NativeAgentRuntimeProvider,
            });
          nativeStorage = storage;
          native = newNative();
          let restarted: MultiReviewService | undefined;
          try {
            const started = await start();
            const settled = await runInteractiveAddressFindings(
              service,
              provider,
              snapshot,
              started.id,
            );
            expect(settled.autoPrLaunch).toMatchObject({ state: "pending" });
            const fix = settled.fixSession!;
            const input = {
              environmentId: settled.environmentId,
              agent: fix.agent,
              logicalSessionKey: fix.sessionKey,
            };
            const key = nativeAgentSessionStorageKey(
              input.environmentId,
              input.agent,
              input.logicalSessionKey,
            );
            expect((await storage.getNativeAgentSession(key))?.dispatchedRequestIds).toContain(
              `multi-review-address:${started.id}`,
            );
            if (timing === "retry") {
              await service.advanceNow(started.id);
              expect((await snapshot(started.id))?.autoPrLaunch).toMatchObject({
                state: "pending",
                attempts: 1,
              });
            }
            if (mutation === "queued") {
              await storage.enqueuePromptQueueMessage(
                `${fix.agent}\0${fix.sessionKey}`,
                settled.environmentId,
                { id: "user-follow-up", text: "continue fixing" },
              );
            } else if (mutation === "identity") {
              await native.adoptSession({
                ...input,
                providerSessionId: "replacement",
                expectedProviderSessionId: fix.providerSessionId,
              });
            } else {
              if (mutation === "stop-then-follow-up") {
                provider.statusValue = "running";
                const abort = provider.abort.bind(provider);
                provider.abort = async (id) => {
                  await abort(id);
                  provider.statusValue = "idle";
                };
                await native.stopProjectionSession(input);
              }
              await native.dispatchIntent({
                ...input,
                prompt: "continue fixing",
                requestId: "user-follow-up",
              });
              provider.statusValue = "running";
            }
            let driver = service;
            if (timing === "restart") {
              await service.shutdown();
              await native.shutdown();
              native = newNative();
              restarted = new MultiReviewService(storage, pr.invoke, {
                autoAdvance: false,
                provider: async () => provider,
                ...mapping,
                addressFindingsDispatchRetryMs: 0,
              });
              driver = restarted;
            }
            // Unknown identity and queued work use the bounded polling budget.
            await waitUntil(async () => {
              await driver.advanceNow(started.id);
              return (await snapshot(started.id))?.autoPrLaunch?.state === "skipped";
            });
            expect(pr.launches).toHaveLength(timing === "retry" ? 1 : 0);
            const launch = (await snapshot(started.id))?.autoPrLaunch;
            expect(launch?.state).toBe("skipped");
            expect(launch?.message).toContain(
              mutation === "queued" || mutation === "identity"
                ? "could not be confirmed"
                : mutation === "stop-then-follow-up"
                  ? "stopped before it finished"
                  : "conversation continued",
            );
          } finally {
            await restarted?.shutdown();
            await native.shutdown();
          }
        },
        {
          autoPr: true,
          packageFlow: true,
          invoke: pr.invoke,
          serviceOptions: {
            ...mapping,
            addressFindingsDispatchRetryMs: 0,
            dispatchAddressFindingsPrompt: async (workflow) => {
              const delivered = await dispatchMultiReviewAddressFindingsPrompt(native, {
                ...workflow,
                reviewModel: workflow.fixModel,
              });
              const fix = delivered.fixSession;
              // Simulate the provider's natural completion before the workflow's idle observation.
              await nativeStorage.recordNativeAgentTurnOutcome(
                nativeAgentSessionStorageKey(workflow.environmentId, fix.agent, fix.sessionKey),
                fix.providerSessionId,
                {
                  requestId: fix.requestIds.at(-1)!,
                  outcome: "completed",
                  observedAt: new Date().toISOString(),
                },
              );
              return delivered;
            },
          },
        },
      );
    }
  },
);

test.each(["interrupted", "failed", "completed"] as const)(
  "recovery supersedes pending PR before replacement settles as %s",
  async (outcome) => {
    const provider = new Provider();
    const pr = autoPrInvoker({ failures: 1 });
    let currentOutcome: "completed" | "interrupted" | "failed" = "completed";
    await withService(
      `env-pr-recovery-${outcome}`,
      provider,
      async ({ service, storage, start, snapshot }) => {
        const started = await start();
        const settled = await runInteractiveAddressFindings(
          service,
          provider,
          snapshot,
          started.id,
        );
        await service.advanceNow(started.id);
        expect((await snapshot(started.id))?.autoPrLaunch).toMatchObject({
          state: "pending",
          attempts: 1,
        });
        currentOutcome = outcome;
        const recovered = await service.recoverAddressFindingsSession(settled.environmentId, {
          tabId: settled.fixTabId!,
          expectedProviderSessionId: settled.fixSession!.providerSessionId,
          replacementProviderSessionId: "replacement",
        });
        expect(recovered.autoPrLaunch).toBeUndefined();
        expect(recovered.fixSession?.completedAt).toBeUndefined();
        expect(
          (service as unknown as { autoPrRetryAt: Map<string, number> }).autoPrRetryAt.has(
            started.id,
          ),
        ).toBe(false);
        provider.statusValue = "idle";
        await waitUntil(async () => {
          await service.advanceNow(started.id);
          return (await snapshot(started.id))?.fixSession?.completedAt !== undefined;
        });
        expect((await snapshot(started.id))?.autoPrLaunch?.state).toBe(
          outcome === "completed" ? "pending" : "skipped",
        );
        await service.advanceNow(started.id);
        expect(pr.launches).toHaveLength(outcome === "completed" ? 2 : 1);
        expect((await storage.getMultiReviewWorkflow(started.id))?.snapshot).toMatchObject({
          fixSession: { providerSessionId: "replacement" },
        });
      },
      {
        autoPr: true,
        invoke: pr.invoke,
        serviceOptions: {
          dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch,
          interactiveAddressFindingsTurnOutcome: async () => currentOutcome,
          addressFindingsDispatchRetryMs: 60_000,
          recoverAddressFindingsSession: async (workflow, replacement) => ({
            tabId: replacement.tabId,
            fixSession: {
              ...workflow.fixSession!,
              providerSessionId: replacement.replacementProviderSessionId,
              requestIds: [...workflow.fixSession!.requestIds, "replacement-request"],
            },
          }),
        },
      },
    );
  },
);

test.each(["unknown", "throws"] as const)(
  "interactive Address Findings retries %s outcome evidence and recovers",
  async (failure) => {
    const provider = new Provider();
    const pr = autoPrInvoker();
    let reads = 0;
    await withService(
      `env-outcome-recover-${failure}`,
      provider,
      async ({ service, start, snapshot }) => {
        const started = await start();
        const settled = await runInteractiveAddressFindings(
          service,
          provider,
          snapshot,
          started.id,
        );
        expect(reads).toBe(3);
        expect(settled.autoPrLaunch?.state).toBe("pending");
        await service.advanceNow(started.id);
        expect(pr.launches).toHaveLength(1);
      },
      {
        autoPr: true,
        invoke: pr.invoke,
        serviceOptions: {
          dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch,
          interactiveAddressFindingsTurnOutcome: async () => {
            reads += 1;
            if (reads <= 2) {
              if (failure === "throws") throw new Error("temporary reader failure");
              return "unknown";
            }
            return "completed";
          },
        },
      },
    );
  },
);

test("an outcome reader that always throws exhausts bounded polling without publishing", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker();
  let reads = 0;
  await withService(
    "env-outcome-throws",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      const settled = await runInteractiveAddressFindings(service, provider, snapshot, started.id);
      expect(reads).toBe(20);
      expect(settled.autoPrLaunch).toMatchObject({
        state: "skipped",
        message: expect.stringContaining("could not be confirmed"),
      });
      expect(pr.launches).toHaveLength(0);
    },
    {
      autoPr: true,
      invoke: pr.invoke,
      serviceOptions: {
        dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch,
        interactiveAddressFindingsTurnOutcome: async () => {
          reads += 1;
          throw new Error("reader unavailable");
        },
      },
    },
  );
});

test.each(["queued", "dispatch"] as const)(
  "revalidates %s work admitted while PR settings are loading",
  async (mutation) => {
    const provider = new Provider();
    const pr = autoPrInvoker();
    let native!: NativeAgentService;
    let nativeStorage!: StorageService;
    const mapping = multiReviewNativeAddressFindingsOptions({
      sessionRequestOutcome: (input) => native.sessionRequestOutcome(input),
      withSessionWorkFence: (input, operation) => native.withSessionWorkFence(input, operation),
    });
    await withService(
      `env-pr-admission-${mutation}`,
      provider,
      async ({ service, storage, start, snapshot }) => {
        nativeStorage = storage;
        native = new NativeAgentService(storage, pr.invoke, {
          provider: async () => provider as NativeAgentRuntimeProvider,
        });
        try {
          const started = await start();
          const settled = await runInteractiveAddressFindings(
            service,
            provider,
            snapshot,
            started.id,
          );
          expect(settled.autoPrLaunch?.state).toBe("pending");
          const config = storage.loadConfig.bind(storage);
          let entered!: () => void;
          let release!: () => void;
          const loading = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let firstRead = true;
          storage.loadConfig = async () => {
            if (firstRead) {
              firstRead = false;
              entered();
              await gate;
            }
            return config();
          };
          const delivery = service.advanceNow(started.id);
          await loading;
          const fix = settled.fixSession!;
          let followUp: Promise<unknown> | undefined;
          if (mutation === "queued") {
            await storage.enqueuePromptQueueMessage(
              `${fix.agent}\0${fix.sessionKey}`,
              settled.environmentId,
              { id: "later", text: "continue fixing" },
            );
          } else {
            followUp = native.dispatchIntent({
              environmentId: settled.environmentId,
              agent: fix.agent,
              logicalSessionKey: fix.sessionKey,
              prompt: "continue fixing",
              requestId: "later",
            });
            // Intent is visible even before the prompt acquires the session fence.
            expect(await mapping.interactiveAddressFindingsTurnOutcome!(settled, fix)).toBe(
              "pending",
            );
          }
          release();
          await delivery;
          await followUp;
          storage.loadConfig = config;
          expect(pr.launches).toHaveLength(0);
          expect((await snapshot(started.id))?.autoPrLaunch?.state).toBe("pending");
          expect((await snapshot(started.id))?.autoPrLaunch?.attempts).toBeUndefined();
          if (mutation === "dispatch") {
            await service.advanceNow(started.id);
            expect((await snapshot(started.id))?.autoPrLaunch?.state).toBe("skipped");
          }
        } finally {
          await native.shutdown();
        }
      },
      {
        autoPr: true,
        packageFlow: true,
        invoke: pr.invoke,
        serviceOptions: {
          ...mapping,
          addressFindingsDispatchRetryMs: 0,
          dispatchAddressFindingsPrompt: async (workflow) => {
            const delivered = await dispatchMultiReviewAddressFindingsPrompt(native, {
              ...workflow,
              reviewModel: workflow.fixModel,
            });
            const fix = delivered.fixSession;
            await nativeStorage.recordNativeAgentTurnOutcome(
              nativeAgentSessionStorageKey(workflow.environmentId, fix.agent, fix.sessionKey),
              fix.providerSessionId,
              {
                requestId: fix.requestIds.at(-1)!,
                outcome: "completed",
                observedAt: new Date().toISOString(),
              },
            );
            return delivered;
          },
        },
      },
    );
  },
);

for (const kind of ["prepare", "consolidate", "fix"] as const) {
  test(`${kind} re-sends a recovered dispatch the provider proves never arrived, once`, async () => {
    const provider = new Provider(false);
    provider.statusValue = "running";
    const environmentId = `env-dispatch-absent-${kind}`;
    await withService(
      environmentId,
      provider,
      async (context) => {
        const { service, storage, snapshot, workflowResults } = context;
        let first: MultiReviewWorkflow;
        if (kind === "consolidate") {
          const selection = { agent: "codex" as const, model: "default" };
          const started = await context.start([selection], selection);
          const reviewing = await advanceUntil(service, snapshot, started.id, (workflow) =>
            Boolean(workflow.reviewers[0]?.requestId),
          );
          provider.statusValue = "idle";
          await workflowResults!.submit(
            { environmentId, projectId: "project-1" },
            reviewing.reviewers[0]!.requestId!,
            cleanReport,
          );
          first = await advanceUntil(
            service,
            snapshot,
            started.id,
            (workflow) =>
              workflow.activeRequest?.kind === "consolidate" &&
              workflow.activeRequest.state === "sent",
          );
        } else {
          first = await startFollowUpStep(kind, context, environmentId, true);
        }
        provider.statusValue = "running";
        const requestId = first.activeRequest!.requestId;
        const initial = provider.sends.get(requestId)!;
        // The checkpoint before the send reached the provider.
        provider.sends.delete(requestId);
        first.activeRequest!.state = "dispatching";
        const stored = (await storage.getMultiReviewWorkflow(first.id))!;
        await storage.saveMultiReviewWorkflow(first.id, environmentId, 1, first, stored.revision);
        await service.shutdown();
        provider.provesAbsence = true;
        const restored = new MultiReviewService(storage, stableReviewInvoker, {
          autoAdvance: false,
          provider: async () => provider,
          workflowResults,
          resolveAgentToolConnection: () => ({
            url: "http://127.0.0.1:1234/mcp",
            token: "test-token",
          }),
        });
        try {
          await restored.init();
          await restored.advanceNow(first.id);
          expect((await snapshot(first.id))!.activeRequest).toMatchObject({
            requestId,
            state: "prepared",
          });
          expect(provider.sends.has(requestId)).toBe(false);
          await restored.advanceNow(first.id);
          const resent = (await snapshot(first.id))!;
          expect(resent.activeRequest).toMatchObject({ requestId, state: "sent" });
          expect(resent.phase).toBe(first.phase);
          expect(provider.sends.get(requestId)?.prompt).toBe(initial.prompt);
        } finally {
          await restored.shutdown();
        }
      },
      { toolMode: true },
    );
  });
}

for (const kind of ["prepare", "consolidate", "fix"] as const) {
  test.each([false, true])(
    `${kind} reconciles a recovered dispatch before observing the old restart (continuation %s)`,
    async (continuation) => {
      const provider = new Provider(false);
      provider.statusValue = "running";
      const environmentId = `env-dispatch-proof-${kind}-${continuation}`;
      await withService(
        environmentId,
        provider,
        async (context) => {
          const { service, storage, snapshot, workflowResults } = context;
          let first: MultiReviewWorkflow;
          if (kind === "consolidate") {
            const selection = { agent: "codex" as const, model: "default" };
            const started = await context.start([selection], selection);
            const reviewing = await advanceUntil(service, snapshot, started.id, (workflow) =>
              Boolean(workflow.reviewers[0]?.requestId),
            );
            provider.statusValue = "idle";
            await workflowResults!.submit(
              { environmentId, projectId: "project-1" },
              reviewing.reviewers[0]!.requestId!,
              cleanReport,
            );
            first = await advanceUntil(
              service,
              snapshot,
              started.id,
              (workflow) =>
                workflow.activeRequest?.kind === "consolidate" &&
                workflow.activeRequest.state === "sent",
            );
          } else {
            first = await startFollowUpStep(kind, context, environmentId, true);
          }
          provider.statusValue = "running";
          const sessionId = (first.reviewSession ?? first.fixSession)!.providerSessionId;
          const initial = provider.sends.get(first.activeRequest!.requestId)!;
          let current = first;
          if (continuation) {
            provider.sessionFailures.set(sessionId, "provider restarted the original request");
            provider.restartInterrupted.add(sessionId);
            await service.advanceNow(first.id);
            current = (await snapshot(first.id))!;
            expect(current.activeRequest).toMatchObject({
              state: "prepared",
              restartContinuationSent: true,
            });
          } else {
            // Restore the checkpoint before send accepted the original request.
            provider.sends.delete(first.activeRequest!.requestId);
          }
          const requestId = current.activeRequest!.requestId;
          const prompt = current.activeRequest!.continuationPrompt;
          current.activeRequest!.state = "dispatching";
          const stored = (await storage.getMultiReviewWorkflow(first.id))!;
          await storage.saveMultiReviewWorkflow(
            first.id,
            environmentId,
            1,
            current,
            stored.revision,
          );
          await service.shutdown();
          const restored = new MultiReviewService(storage, stableReviewInvoker, {
            autoAdvance: false,
            provider: async () => provider,
            workflowResults,
            resolveAgentToolConnection: () => ({
              url: "http://127.0.0.1:1234/mcp",
              token: "test-token",
            }),
          });
          try {
            await restored.init();
            const statusCalls = provider.statusCalls;
            await restored.advanceNow(first.id);
            const parked = (await snapshot(first.id))!;
            expect(parked.phase).toBe(first.phase);
            expect(parked.activeRequest).toMatchObject({ requestId, state: "dispatching" });
            expect(parked.activeRequest!.continuationPrompt).toBe(prompt);
            expect(parked.activeRequest!.resultReminderSent).toBeUndefined();
            expect(provider.statusCalls).toBe(statusCalls);
            expect(provider.sends.has(requestId)).toBe(false);
            if (!continuation) {
              const failed = await advanceUntil(
                restored,
                snapshot,
                first.id,
                (workflow) => workflow.phase === "failed",
              );
              expect(failed.error).toContain("dispatch acceptance could not be confirmed");
              expect(failed.activeRequest!.state).toBe("dispatching");
              expect(failed.activeRequest!.resultReminderSent).toBeUndefined();
              return;
            }
            // The old owner's pending send lands. It is only now safe to inspect
            // the session, whose old restart notice clears when the turn starts.
            await provider.send(sessionId, prompt!, { ...initial.options, requestId });
            // Request acceptance can precede the session's visible transition.
            const settlingProvider: BuildPipelineProvider = provider;
            settlingProvider.settleTurn = async () => false;
            await restored.advanceNow(first.id);
            expect((await snapshot(first.id))!.phase).toBe(first.phase);
            delete settlingProvider.settleTurn;
            provider.sessionFailures.delete(sessionId);
            provider.restartInterrupted.delete(sessionId);
            await restored.advanceNow(first.id);
            expect((await snapshot(first.id))!.activeRequest).toMatchObject({
              requestId,
              state: "sent",
              restartContinuationSent: true,
            });
            expect((await snapshot(first.id))!.phase).toBe(first.phase);
            provider.sessionFailures.set(sessionId, "a second request was interrupted");
            provider.restartInterrupted.add(sessionId);
            await restored.advanceNow(first.id);
            expect((await snapshot(first.id))!.phase).toBe("failed");
            expect((await snapshot(first.id))!.error).toContain("a second request was interrupted");
          } finally {
            await restored.shutdown();
          }
        },
        { toolMode: true },
      );
    },
  );
}

for (const kind of ["prepare", "consolidate", "fix"] as const) {
  for (const toolMode of [false, true]) {
    test.each(["absent", "lost"] as const)(
      `${kind} accepts a saved ${toolMode ? "tool-v1" : "structured"} result over %s dispatch status`,
      async (answer) => {
        const provider = new Provider(false);
        provider.statusValue = "running";
        const environmentId = `env-result-proof-${kind}-${toolMode}-${answer}`;
        await withService(
          environmentId,
          provider,
          async (context) => {
            const { service, storage, snapshot, workflowResults } = context;
            let first: MultiReviewWorkflow;
            if (kind === "consolidate") {
              const selection = { agent: "codex" as const, model: "default" };
              const started = await context.start([selection], selection);
              const reviewing = await advanceUntil(service, snapshot, started.id, (workflow) =>
                Boolean(workflow.reviewers[0]?.requestId),
              );
              provider.statusValue = "idle";
              if (toolMode) {
                await workflowResults!.submit(
                  { environmentId, projectId: "project-1" },
                  reviewing.reviewers[0]!.requestId!,
                  cleanReport,
                );
              } else {
                provider.structured = async <T>(_sessionId: string, requestId: string) => ({
                  ok: true,
                  provider: "codex",
                  requestId,
                  value: cleanReport as T,
                });
              }
              await advanceUntil(service, snapshot, started.id, (workflow) =>
                workflow.reviewers.every((reviewer) => reviewer.status === "completed"),
              );
              provider.statusValue = "running";
              first = await advanceUntil(
                service,
                snapshot,
                started.id,
                (workflow) =>
                  workflow.activeRequest?.kind === "consolidate" &&
                  workflow.activeRequest.state === "sent",
              );
            } else {
              first = await startFollowUpStep(kind, context, environmentId, toolMode);
            }
            provider.statusValue = "running";
            const requestId = first.activeRequest!.requestId;
            const sessionId = (first.reviewSession ?? first.fixSession)!.providerSessionId;
            const value =
              kind === "prepare"
                ? toolMode
                  ? {
                      headRef: REVIEW_HEAD,
                      commands: [],
                      limitations: ["No validation commands were discovered"],
                    }
                  : TEST_REVIEW_PREPARATION
                : kind === "fix"
                  ? completedAddressFindings
                  : cleanReport;
            if (toolMode) {
              expect(
                await workflowResults!.submit(
                  { environmentId, projectId: "project-1" },
                  requestId,
                  value,
                ),
              ).toMatchObject({ ok: true });
            }
            first.activeRequest!.state = "dispatching";
            const stored = (await storage.getMultiReviewWorkflow(first.id))!;
            await storage.saveMultiReviewWorkflow(
              first.id,
              environmentId,
              1,
              first,
              stored.revision,
            );
            await service.shutdown();
            const dispatch = jest.spyOn(provider, "dispatchStatus").mockResolvedValue(answer);
            const result = toolMode
              ? undefined
              : jest
                  .spyOn(provider, "structured")
                  .mockResolvedValue({ ok: true, provider: "codex", requestId, value });
            const send = jest.spyOn(provider, "send");
            const restored = new MultiReviewService(storage, stableReviewInvoker, {
              autoAdvance: false,
              provider: async () => provider,
              workflowResults,
            });
            try {
              await restored.init();
              await restored.advanceNow(first.id);
              expect((await snapshot(first.id))!.activeRequest).toMatchObject({
                requestId,
                state: "sent",
              });
              expect(dispatch).toHaveBeenCalledWith(sessionId, requestId);
              expect(send).not.toHaveBeenCalled();
            } finally {
              dispatch.mockRestore();
              result?.mockRestore();
              send.mockRestore();
              await restored.shutdown();
            }
          },
          { toolMode },
        );
      },
    );
  }
}

test.each(["pending", "running"] as const)(
  "workflow failure clears stale startup diagnostics on %s reviewers",
  async (status) => {
    const provider = new Provider();
    provider.statusValue = "running";
    await withService(
      `env-start-failure-cleanup-${status}`,
      provider,
      async ({ service, storage, start, snapshot }) => {
        const started = await start();
        const stored = (await storage.getMultiReviewWorkflow(started.id))!;
        const workflow = (await snapshot(started.id))!;
        workflow.phase = "reviewing";
        for (const reviewer of workflow.reviewers) {
          reviewer.status = status;
          reviewer.startFailed = true;
        }
        await storage.saveMultiReviewWorkflow(
          workflow.id,
          workflow.environmentId,
          1,
          workflow,
          stored.revision,
        );
        await (service as unknown as { fail(id: string, error: unknown): Promise<void> }).fail(
          started.id,
          new Error("Workflow abandoned"),
        );
        const failed = (await snapshot(started.id))!;
        expect(failed.phase).toBe("failed");
        expect(failed.reviewers[0]).toMatchObject({
          status: "failed",
          error: "Workflow abandoned",
        });
        expect(failed.reviewers[0]!.startFailed).toBeUndefined();
      },
    );
  },
);

test("Multi Review reports initial send refusal after allocation while peers continue", async () => {
  const provider = new Provider();
  provider.statusValue = "running";
  const send = provider.send.bind(provider);
  provider.send = async (sessionId, prompt, options) => {
    if (options.model === "sonnet") throw new Error("Initial authentication refused");
    await send(sessionId, prompt, options);
  };
  await withService(
    "env-allocated-startup-failure",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start([
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "sonnet" },
      ]);
      await service.advanceNow(started.id);
      const current = (await snapshot(started.id))!;
      expect(current.reviewers[0]!.status).toBe("running");
      expect(current.reviewers[1]).toMatchObject({
        status: "failed",
        startFailed: true,
        agentStarted: false,
        error: "Initial authentication refused",
      });
      expect(current.reviewers[1]!.providerSessionId).toBeDefined();
    },
  );
});

test("MultiReviewService denies a late result from a stopped reviewer", async () => {
  const provider = new Provider();
  provider.statusOverrides.set("session-1", "running");
  await withService(
    "env-stop-closes-slot",
    provider,
    async ({ service, start, snapshot, workflowResults }) => {
      const started = await start([{ agent: "claude", model: "opus" }]);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.reviewers[0]?.dispatchState === "sent";
      });
      const reviewer = (await snapshot(started.id))!.reviewers[0]!;
      expect(reviewer.resultTransport).toBe("tool-v1");

      await service.stopReviewer(started.id, reviewer.id);

      expect(
        await workflowResults!.status(
          { environmentId: "env-stop-closes-slot", projectId: "project-1" },
          reviewer.requestId!,
        ),
      ).toMatchObject({ lifecycle: "superseded" });
    },
    { toolMode: true },
  );
});

test("MultiReviewService skip stops the reviewers still working and consolidates the rest", async () => {
  const provider = new Provider();
  provider.statusOverrides.set("session-2", "running");
  await withService("env-skip-review", provider, async ({ service, start, snapshot }) => {
    const started = await start([
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "sonnet" },
    ]);
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      const reviewers = (await snapshot(started.id))?.reviewers;
      return reviewers?.[0]?.status === "completed" && reviewers[1]?.status === "running";
    });

    const skipped = await service.skipStep(started.id, "review");

    expect(skipped.reviewers.map((reviewer) => reviewer.status)).toEqual([
      "completed",
      "cancelled",
    ]);
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.phase === "ready";
    });
    await expect(service.skipStep(started.id, "review")).rejects.toThrow("not running");
    await expect(service.skipStep(started.id, "fix")).rejects.toThrow("not running");
  });
});

test("MultiReviewService restarts one reviewer on another model, keeping its focus", async () => {
  const provider = new Provider();
  provider.statusOverrides.set("session-1", "running");
  provider.statusOverrides.set("session-2", "running");
  await withService("env-restart-reviewer-in", provider, async ({ service, start, snapshot }) => {
    const lens = { label: "Security", instruction: "Look for injection." };
    const started = await start([
      { agent: "claude", model: "opus", lens },
      { agent: "claude", model: "sonnet" },
    ]);
    await waitUntil(async () => {
      await service.advanceNow(started.id);
      return (await snapshot(started.id))?.reviewers.every((r) => r.status === "running") === true;
    });
    const before = (await snapshot(started.id))!.reviewers;

    const restarted = await service.restartReviewer(started.id, before[0]!.id, {
      agent: "claude",
      model: "haiku",
    });

    expect(restarted.reviewers[0]).toMatchObject({ model: "haiku", status: "pending", lens });
    expect(restarted.reviewers[1]!.providerSessionId).toBe(before[1]!.providerSessionId);
  });
});

test("MultiReviewService rewinds code to preparation's starting commit and restarts it", async () => {
  const provider = new Provider();
  const head = { value: "" };
  const { git, calls } = rewindGit(head);
  await withService(
    "env-rewind-prepare",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const ready = (await snapshot(started.id))!;
      const target = ready.reviewWorktreeSnapshot!.head;
      expect((await service.previewCodeRewind(started.id, "fix")).blocked).toContain(
        "has not started",
      );
      await expect(service.rewindCode(started.id, "fix", target)).rejects.toThrow(
        "has not started",
      );
      expect(calls.some((args) => args[0] === "reset")).toBe(false);
      head.value = target;
      const preview = await service.previewCodeRewind(started.id, "prepare");
      expect(preview.blocked).toBeUndefined();
      expect(preview.targetCommit).toBe(target);

      await expect(service.rewindCode(started.id, "prepare", "f".repeat(40))).rejects.toThrow(
        "The branch moved",
      );
      expect(calls.some((args) => args[0] === "reset")).toBe(false);

      const rewound = await service.rewindCode(started.id, "prepare", preview.head!);

      expect(calls).toContainEqual(["reset", "--hard", target]);
      expect(calls.some((args) => args[0] === "update-ref")).toBe(true);
      expect(rewound.phase).toBe("preparing");
    },
    { packageFlow: true, serviceOptions: { environmentGit: git } },
  );
});

test("MultiReviewService refuses a code rewind while running, or over pushed commits", async () => {
  const provider = new Provider();
  provider.statusOverrides.set("session-1", "running");
  const head = { value: "" };
  await withService(
    "env-rewind-refused",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.reviewWorktreeSnapshot !== undefined;
      });
      const preview = await service.previewCodeRewind(started.id, "prepare");
      expect(preview.blocked).toContain("A running step");
      await expect(service.rewindCode(started.id, "prepare", "a".repeat(40))).rejects.toThrow(
        "A running step",
      );
      provider.statusOverrides.clear();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      expect((await service.previewCodeRewind(started.id, "prepare")).blocked).toContain(
        "cannot force-push",
      );
    },
    { packageFlow: true, serviceOptions: { environmentGit: rewindGit(head, { pushed: 2 }).git } },
  );
});

test("MultiReviewService refuses a code rewind without a Git port", async () => {
  await withService("env-rewind-no-git", new Provider(), async ({ service, start }) => {
    const started = await start();
    await expect(service.rewindCode(started.id, "prepare", "a".repeat(40))).rejects.toThrow(
      "not available",
    );
  });
});

test("MultiReviewService marks a review stale when the worktree moves, and stops nothing", async () => {
  const provider = new Provider();
  let moved = false;
  await withService(
    "env-review-worktree-changed",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const ready = (await snapshot(started.id))!;
      expect(ready.reviewWorktreeChanged).toBe(true);
      expect(ready.reviewSnapshotStale).toBeUndefined();
      expect(ready.error).toBeUndefined();
    },
    {
      packageFlow: true,
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        if (moved && command === "get_environment_uncommitted_paths") {
          return { head: "9".repeat(40), paths: [], fingerprint: "b".repeat(64) } as T;
        }
        // A reviewer commits as soon as the package is sealed.
        if (command === "generate_review_package") moved = true;
        return stableReviewInvoker<T>(command, args);
      },
    },
  );
});

test("MultiReviewService reviewers are mail workers while they review", async () => {
  const provider = new Provider();
  provider.statusOverrides.set("session-1", "running");
  await withService(
    "env-reviewer-mail",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start([{ agent: "claude", model: "opus" }]);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.reviewers[0]?.status === "running";
      });
      const reviewer = (await snapshot(started.id))!.reviewers[0]!;
      const address = pipelineWorkerTabId(reviewer.sessionKey!);

      const [entry] = await storage.listMultiReviewWorkers("env-reviewer-mail");
      expect(entry?.workers.map((worker) => worker.address)).toEqual([address]);
      expect(await service.workerMail.state("env-reviewer-mail", address)).toBe("running");
      expect(
        await service.workerMail.state("env-reviewer-mail", "pipeline-worker:other"),
      ).toBeNull();
      expect(
        await pipelineWorkerTabForResultKey(
          storage,
          { environmentId: "env-reviewer-mail", projectId: "project-1" },
          reviewer.requestId!,
        ),
      ).toBe(address);

      // The turn ends with mail queued: the mail becomes the reviewer's next turn,
      // under a new result key, before any result is accepted.
      const settled: string[] = [];
      let claims = 0;
      service.setWorkerMailbox({
        claim: async (_environmentId, tabId) => {
          expect(tabId).toBe(address);
          claims += 1;
          return claims === 1
            ? { text: "Check the migration too." + "x".repeat(5000), messageIds: ["m1"] }
            : null;
        },
        settle: async (_environmentId, _tabId, _messageIds, outcome) => {
          settled.push(outcome);
        },
      });
      provider.statusOverrides.clear();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return settled.length > 0;
      });
      expect(settled).toEqual(["accepted"]);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return [...provider.sends.values()].some((sent) =>
          sent.prompt.includes("Check the migration too."),
        );
      });
      expect(isMultiReviewWorkflow((await snapshot(started.id))!)).toBe(true);
      const transcript = await service.workerTranscript({
        environmentId: "env-reviewer-mail",
        tabId: address,
        limit: 1,
      });
      expect(transcript?.workflowId).toBe(started.id);
      const after = (await snapshot(started.id))!.reviewers[0]!;
      expect(after.requestId).not.toBe(reviewer.requestId);

      await service.cancel(started.id);
      expect(await storage.listMultiReviewWorkers("env-reviewer-mail")).toEqual([]);
    },
  );
});

test("MultiReviewService skips normal interactive Address Findings without a result", async () => {
  await withService(
    "env-skip-interactive",
    new Provider(),
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      await service.address(started.id);
      expect((await snapshot(started.id))?.phase).toBe("interactive");
      const skipped = await service.skipStep(started.id, "fix");
      expect(skipped.phase).toBe("ready");
      expect(skipped.fixResult).toBeUndefined();
      expect(skipped.addressPromptPending).toBeUndefined();
      expect(skipped.fixSession?.status).not.toBe("running");
    },
  );
});

test("MultiReviewService refused skip keeps a supervised controller", async () => {
  const provider = new Provider();
  provider.statusOverrides.set("session-1", "running");
  await withService("env-skip-claim", provider, async ({ service, storage, start }) => {
    const started = await start();
    await service.advanceNow(started.id);
    await expect(service.skipStep(started.id, "fix")).rejects.toThrow("not running");
    expect(
      (await storage.claimMultiReviewController(started.id, "other-owner", 15000)).granted,
    ).toBe(false);
  });
});

test("MultiReviewService recovers reset after restart persistence fails exactly once", async () => {
  const provider = new Provider();
  const head = { value: "" };
  const base = rewindGit(head);
  const refs = new Map<string, string>();
  const git: typeof base.git = async (env, args) => {
    if (args[0] === "update-ref") refs.set(args[1]!, args[2]!);
    if (args[0] === "rev-parse" && refs.has(args[1]!)) return refs.get(args[1]!)!;
    return base.git(env, args);
  };
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    const result = await stableReviewInvoker<T>(command, args);
    return command === "get_environment_uncommitted_paths" && head.value
      ? ({ ...result, head: head.value } as T)
      : result;
  };
  await withService(
    "env-rewind-recovery",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      head.value = "a".repeat(40);
      const save = storage.saveMultiReviewWorkflow.bind(storage);
      storage.saveMultiReviewWorkflow = (async (...args: Parameters<typeof save>) => {
        const value = args[3] as MultiReviewWorkflow;
        if (value.phase === "preparing" && !value.pendingCodeRewind)
          throw new Error("restart save failed");
        return save(...args);
      }) as typeof save;
      try {
        await expect(service.rewindCode(started.id, "prepare", head.value)).rejects.toThrow(
          "restart save failed",
        );
      } finally {
        storage.saveMultiReviewWorkflow = save;
      }
      expect((await snapshot(started.id))?.pendingCodeRewind?.from).toBe("a".repeat(40));
      await service.shutdown();
      const recovered = new MultiReviewService(storage, invoke, {
        autoAdvance: false,
        provider: async () => provider,
        environmentGit: git,
      });
      try {
        await recovered.advanceNow(started.id);
        expect((await snapshot(started.id))?.pendingCodeRewind).toBeUndefined();
        expect(["preparing", "reviewing"]).toContain((await snapshot(started.id))!.phase);
        expect((await snapshot(started.id))?.reviewWorktreeSnapshot?.head).toBe(REVIEW_HEAD);
        expect(base.calls.filter((args) => args[0] === "reset")).toHaveLength(1);
      } finally {
        await recovered.shutdown();
      }
    },
    { packageFlow: true, invoke, serviceOptions: { environmentGit: git } },
  );
});

test("MultiReviewService uses package-sealing paths as the stale baseline", async () => {
  let sealed = false;
  await withService(
    "env-preparation-leftovers",
    new Provider(),
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      expect((await snapshot(started.id))?.reviewPackagePaths).toEqual(["preparation.txt"]);
      expect((await snapshot(started.id))?.reviewWorktreeChanged).toBeUndefined();
    },
    {
      packageFlow: true,
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        if (command === "generate_review_package") sealed = true;
        const result = await stableReviewInvoker<T>(command, args);
        if (sealed && command === "get_environment_uncommitted_paths") {
          return { ...result, paths: ["preparation.txt"] } as T;
        }
        return result;
      },
    },
  );
});

test("MultiReviewService refuses rewind for a running paused session or sibling review", async () => {
  const head = { value: "a".repeat(40) };
  const { git, calls } = rewindGit(head);
  await withService(
    "env-rewind-sibling",
    new Provider(),
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      const ready = (await snapshot(started.id))!;
      const sibling = { ...ready, id: "sibling-review", phase: "preparing" as const };
      await storage.saveMultiReviewWorkflow(sibling.id, sibling.environmentId, 1, sibling);
      expect((await service.previewCodeRewind(started.id, "prepare")).blocked).toContain(
        "Another Multi Review",
      );
      await expect(service.rewindCode(started.id, "prepare", head.value)).rejects.toThrow(
        "Another Multi Review",
      );
      expect(calls.some((args) => args[0] === "reset")).toBe(false);
      const { multiReviewRewindStateBlocker } = await import("./multi-review-code-rewind.js");
      expect(
        multiReviewRewindStateBlocker({
          ...ready,
          phase: "paused",
          pausedStep: "prepare",
          reviewSession: { ...ready.fixSession!, status: "running" },
        }),
      ).toContain("still running");
    },
    { packageFlow: true, serviceOptions: { environmentGit: git } },
  );
});

test("MultiReviewService rewinds an attempted Address Findings step to the package head", async () => {
  const head = { value: REVIEW_HEAD };
  const { git, calls } = rewindGit(head);
  await withService(
    "env-rewind-fix",
    new Provider(),
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      await service.address(started.id);
      const preview = await service.previewCodeRewind(started.id, "fix");
      expect(preview.blocked).toBeUndefined();
      expect(preview.targetCommit).toBe((await snapshot(started.id))?.reviewPackage?.headRef);
      const restarted = await service.rewindCode(started.id, "fix", head.value);
      expect(restarted.phase).toBe("interactive");
      expect(restarted.fixResult).toBeUndefined();
      expect(restarted.pendingCodeRewind).toBeUndefined();
      expect(calls).toContainEqual(["reset", "--hard", preview.targetCommit!]);
    },
    { packageFlow: true, serviceOptions: { environmentGit: git } },
  );
});
