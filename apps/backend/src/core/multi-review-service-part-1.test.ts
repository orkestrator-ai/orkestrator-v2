// Part 1 of 4 of the MultiReviewService suite, split from multi-review-service.test.ts so
// `bun test --parallel` can spread it across workers. Shared helpers live in
// multi-review-service-test-support.ts.
import { multiReviewAddressFindingsIdentity } from "./multi-review-address-findings-identity.js";
import { expect, jest, test } from "bun:test";
import type { ArtifactPublication } from "@orkestrator/protocol/transcript-artifacts";
import { codexConnection, httpProvider } from "./agent-provider-test-support.js";
import { MultiReviewService, type MultiReviewServiceOptions } from "./multi-review-service.js";
import {
  Provider,
  advanceUntil,
  autoPrAddressFindingsDispatch,
  autoPrInvoker,
  consolidatedReport,
  mutateStoredWorkflow,
  orderedAutoFlow,
  restoreCompletedAutoPr,
  restorePendingAutoPr,
  runInteractiveAddressFindings,
  singleActivityRead,
  waitUntil,
  withInteractiveFixes,
  withService,
} from "./multi-review-service-test-support.js";

// This owner includes real lease timers and deliberately blocked provider
// calls. Keep Bun's outer budget wider than its own diagnostic waits.
jest.setTimeout(30_000);

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

test("MultiReviewService places a reviewer's own publications beside their publish calls", async () => {
  const provider = new Provider(false);
  provider.statusValue = "running";
  const publishRow = (id: string, toolUseId: string, artifactId: string) => ({
    id,
    role: "assistant",
    content: "",
    parts: [
      {
        type: "tool-invocation",
        toolName: "mcp__orkestrator-artifacts__publish_artifact",
        toolUseId,
        toolState: "success",
        toolArgs: { artifactId, expectedRevision: 1 },
      },
    ],
  });
  provider.messagesValue = [
    publishRow("assistant-1", "toolu_own", "art_own"),
    publishRow("assistant-2", "toolu_other", "art_other"),
  ];
  const publications: ArtifactPublication[] = [];
  const publication = (
    owner: { environmentId: string; conversationKey: string },
    artifactId: string,
    toolCallId: string,
  ): ArtifactPublication => {
    const publicationId = `pub_mr${String(publications.length + 1).padStart(8, "0")}`;
    return {
      schemaVersion: 1,
      publicationId,
      artifactId,
      revision: 1,
      receiptId: `rcpt_${publicationId}`,
      owner: { backendId: "backend-test", projectId: "project-1", ...owner },
      conversationSequence: publications.length + 1,
      publishedAt: "2026-10-20T00:00:01.000Z",
      anchor: { toolCallId },
      ref: {
        schemaVersion: 1,
        artifactId,
        revision: 1,
        publicationId,
        kind: "chart",
        title: "Findings chart",
        summary: "A chart the reviewer published.",
        provenance: { backendId: "backend-test", origin: "agent" },
      },
    };
  };
  // A ledger that returns everything: the read path must refuse what it does not own.
  const artifactLedger = () => ({
    publicationsForConversation: () => publications,
    ledgerRevision: () => publications.length,
  });

  await withService(
    "env-reviewer-artifacts",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () =>
        Boolean((await snapshot(started.id))?.reviewers[0]?.providerSessionId),
      );
      const reviewer = (await snapshot(started.id))!.reviewers[0]!;
      // Read once before anything is published: the next read must still see
      // the publications, because the ledger revision moved.
      const before = await service.reviewerTranscript(started.id, reviewer.id);
      expect(before.messages.flatMap((row) => (row as { parts: unknown[] }).parts)).toHaveLength(2);

      publications.push(
        publication(
          { environmentId: started.environmentId, conversationKey: reviewer.sessionKey! },
          "art_own",
          "toolu_own",
        ),
        // Another reviewer's conversation and another environment never appear.
        publication(
          { environmentId: started.environmentId, conversationKey: `${reviewer.sessionKey}-x` },
          "art_other",
          "toolu_other",
        ),
        publication(
          { environmentId: "env-elsewhere", conversationKey: reviewer.sessionKey! },
          "art_other",
          "toolu_other",
        ),
      );
      const read = await service.reviewerTranscript(started.id, reviewer.id);
      const kinds = (read.messages as Array<{ parts: Array<{ type: string }> }>).map((row) =>
        row.parts.map((part) => part.type),
      );
      expect(kinds).toEqual([["tool-invocation", "artifact"], ["tool-invocation"]]);
      expect(
        (read.messages[0] as { parts: Array<{ artifact?: { artifactId: string } }> }).parts[1]
          ?.artifact?.artifactId,
      ).toBe("art_own");
    },
    { serviceOptions: { artifactLedger } },
  );
});

test("MultiReviewService pages earlier reviewer history bound to the reviewer's session", async () => {
  const provider = new Provider(false);
  provider.statusValue = "running";
  provider.messagesValue = Array.from({ length: 620 }, (_, index) => ({
    id: `assistant-${index}`,
    role: "assistant",
    content: `step ${index}`,
    parts: [{ type: "text", content: `step ${index}` }],
  }));

  await withService("env-reviewer-history", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await waitUntil(async () =>
      Boolean((await snapshot(started.id))?.reviewers[0]?.providerSessionId),
    );
    const reviewer = (await snapshot(started.id))!.reviewers[0]!;

    const tail = await service.reviewerTranscript(started.id, reviewer.id);
    expect(tail).toMatchObject({ truncated: true, historyEpoch: "legacy" });
    expect((tail.messages[0] as { id: string }).id).toBe("assistant-120");
    expect(typeof tail.historyCursor).toBe("string");

    const page = await service.reviewerHistoryPage(started.id, reviewer.id, tail.historyCursor!, {
      limit: 100,
    });
    expect(page).toMatchObject({ status: "page", historyEpoch: "legacy", truncated: true });
    if (page.status !== "page") throw new Error("expected a page");
    expect(page.messages.map((message) => (message as { id: string }).id)).toEqual(
      Array.from({ length: 100 }, (_, index) => `assistant-${20 + index}`),
    );
    const last = await service.reviewerHistoryPage(started.id, reviewer.id, page.nextCursor!);
    expect(last).toMatchObject({ status: "page", complete: true, truncated: false });

    // Another reviewer's cursor is refused, not served against this history.
    await expect(
      service.reviewerHistoryPage(started.id, "no-such-reviewer", tail.historyCursor!),
    ).rejects.toThrow("Multi review reviewer not found");
    const foreign = Buffer.from(
      JSON.stringify({
        v: 1,
        key: "0".repeat(24),
        session: "0".repeat(24),
        epoch: "legacy",
        before: "x",
      }),
    ).toString("base64url");
    await expect(service.reviewerHistoryPage(started.id, reviewer.id, foreign)).rejects.toThrow(
      "does not belong to this reviewer",
    );

    // Rewritten history: the cursor's message is gone, so it expires.
    provider.messagesValue = provider.messagesValue.map((message) => ({
      ...(message as Record<string, unknown>),
      id: `rewritten-${(message as { id: string }).id}`,
    }));
    await expect(
      service.reviewerHistoryPage(started.id, reviewer.id, page.nextCursor!),
    ).resolves.toEqual({ status: "expired", reason: "history-changed" });
  });
});

test("MultiReviewService persists reviewer token usage while the review is running", async () => {
  const provider = new Provider(false);
  provider.statusValue = "running";
  provider.usageTokens = 12_345;
  provider.usageUsedTokens = 999;

  await withService("env-reviewer-usage", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await service.advanceNow(started.id);

    expect((await snapshot(started.id))?.reviewers[0]).toMatchObject({
      status: "running",
      tokenCount: 12_345,
    });
  });
});

test("MultiReviewService ignores context occupancy when cumulative usage is unavailable", async () => {
  const provider = new Provider(false);
  provider.statusValue = "running";
  provider.usageUsedTokens = 98_765;

  await withService("env-reviewer-occupancy", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await service.advanceNow(started.id);

    expect((await snapshot(started.id))?.reviewers[0]?.tokenCount).toBeUndefined();
  });
});

test("MultiReviewService keeps reviewer usage monotonic and rejects malformed totals", async () => {
  const provider = new Provider(false);
  provider.statusValue = "running";
  provider.usageTokens = 12_345;

  await withService("env-reviewer-usage-guard", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await service.advanceNow(started.id);
    expect((await snapshot(started.id))?.reviewers[0]?.tokenCount).toBe(12_345);

    provider.usageTokens = 1_234;
    await service.advanceNow(started.id);
    expect((await snapshot(started.id))?.reviewers[0]?.tokenCount).toBe(12_345);

    for (const malformed of [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      provider.usageTokens = malformed;
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.reviewers[0]?.tokenCount).toBe(12_345);
    }
  });
});

test("MultiReviewService treats transcript-derived usage failures as non-fatal", async () => {
  const provider = new Provider(false);
  // Exercises the messages-based progress and usage path.
  delete provider.transcriptSnapshot;
  provider.statusValue = "running";
  provider.usageMessageLimit = 64;
  provider.usageFromMessages = () => {
    throw new Error("usage unavailable");
  };

  await withService("env-reviewer-usage-error", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await service.advanceNow(started.id);

    expect((await snapshot(started.id))?.reviewers[0]).toMatchObject({ status: "running" });
    expect((await snapshot(started.id))?.reviewers[0]?.tokenCount).toBeUndefined();
    // Transcript-derived usage shares the throttled progress probe instead of
    // reading the transcript on every status observation.
    expect(provider.messagesCalls).toBe(1);
    expect(provider.statusCalls).toBeGreaterThanOrEqual(provider.messagesCalls);
    expect(provider.messageOptions.every((options) => options?.limit === 64)).toBe(true);
  });
});

test("MultiReviewService waits for a terminal cumulative total before settling", async () => {
  const provider = new Provider();
  provider.usageUsedTokens = 2_000;
  provider.usagePending = true;

  await withService("env-reviewer-final-usage", provider, async ({ service, start, snapshot }) => {
    const started = await start();
    await service.advanceNow(started.id);
    expect((await snapshot(started.id))?.reviewers[0]).toMatchObject({
      status: "running",
    });
    expect((await snapshot(started.id))?.reviewers[0]?.usageFinalizationPolls).toBeGreaterThan(0);
    while (((await snapshot(started.id))?.reviewers[0]?.usageFinalizationPolls ?? 0) < 6) {
      await service.advanceNow(started.id);
    }
    expect((await snapshot(started.id))?.reviewers[0]).toMatchObject({
      status: "running",
      usageFinalizationPolls: 6,
    });

    provider.usagePending = false;
    provider.usageTokens = 4_321;
    await service.advanceNow(started.id);
    expect((await snapshot(started.id))?.reviewers[0]).toMatchObject({
      status: "completed",
      tokenCount: 4_321,
    });
  });
});

test("MultiReviewService persists usage and transcript progress in one workflow save", async () => {
  const provider = new Provider(false);
  provider.statusValue = "running";
  provider.messagesValue = [{ text: "baseline" }];

  await withService(
    "env-reviewer-single-save",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await service.advanceNow(started.id);
      const before = (await snapshot(started.id))!;

      provider.usageTokens = 222;
      provider.messagesValue = [{ text: "progress" }];
      await service.advanceNow(started.id);
      const after = (await snapshot(started.id))!;

      expect(after.backendRevision).toBe(before.backendRevision + 1);
      expect(after.reviewers[0]).toMatchObject({ tokenCount: 222 });
    },
    { serviceOptions: { progressProbeIntervalMs: 0 } },
  );
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
      expect(
        provider.creates.find((entry) => entry.label === "Multi Review · Consolidation")?.options,
      ).toMatchObject({ mode: "build", readOnly: true });

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

// The keyed supervisor settles the interactive Address Findings handoff with no
// renderer attached.
test("MultiReviewService settles the interactive Address Findings card in the background with final usage", async () => {
  const provider = new Provider();
  provider.usageTokens = 23_456;
  await withService(
    "env-interactive-fix-settlement",
    provider,
    async ({ service, storage, start, snapshot }) => {
      await service.init();
      const started = await start();
      await waitUntil(async () => (await snapshot(started.id))?.phase === "ready");

      provider.statusValue = "running";
      await service.address(started.id);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);
      const running = (await snapshot(started.id))!;
      expect(running).toMatchObject({
        phase: "interactive",
        fixSession: { status: "running" },
        stepRuntimes: { fix: { tokenBaseline: 0 } },
      });

      provider.statusValue = "idle";
      await waitUntil(async () => (await snapshot(started.id))?.fixSession?.status === "idle");
      await waitUntil(async () => {
        const environment = await storage.getEnvironment("env-interactive-fix-settlement");
        return environment?.agentActivitySources?.["multi-review"]?.state === "idle";
      });

      const settled = (await snapshot(started.id))!;
      expect(settled).toMatchObject({
        phase: "interactive",
        fixSession: {
          status: "idle",
          tokenCount: 23_456,
          completedAt: expect.any(String),
        },
        stepRuntimes: {
          fix: {
            tokenBaseline: 0,
            tokenCount: 23_456,
            completedAt: expect.any(String),
          },
        },
      });
      // The workflow snapshot is committed before its derived environment
      // projection. Observe both authoritative stores settling instead of
      // racing the second write after the session itself becomes idle.
      await waitUntil(async () => {
        const environment = await storage.getEnvironment("env-interactive-fix-settlement");
        return environment?.agentActivitySources?.["multi-review"]?.state === "idle";
      });
      expect(await storage.getEnvironment("env-interactive-fix-settlement")).toMatchObject({
        agentActivitySources: { "multi-review": { state: "idle" } },
      });
    },
    {
      serviceOptions: {
        autoAdvance: true,
        pollIntervalMs: 5,
        dispatchAddressFindingsPrompt: async (workflow) => ({
          tabId: workflow.addressTabId!,
          fixSession: {
            ...workflow.fixModel,
            sessionKey: workflow.addressSessionKey!,
            providerSessionId: "provider-interactive-fix",
            requestIds: [workflow.addressRequestId!],
            status: "running",
            startedAt: new Date().toISOString(),
          },
        }),
      },
    },
  );
});

test("MultiReviewService delivers a persisted pending PR launch once", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker();
  await withService(
    "env-auto-pr-launch",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      expect(started.autoPr).toBe(true);
      const settled = await runInteractiveAddressFindings(service, provider, snapshot, started.id);
      expect(settled.autoPrLaunch?.state).toBe("skipped");
      await restoreCompletedAutoPr(storage, started.id);
      expect((await snapshot(started.id))?.autoPrLaunch).toEqual({
        state: "pending",
        requestId: `multi-review-pr:${started.id}`,
      });
      expect(pr.launches).toHaveLength(0);

      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.autoPrLaunch).toEqual({
        state: "launched",
        requestId: `multi-review-pr:${started.id}`,
        tabId: "agent-job-pr",
      });
      expect(pr.launches).toHaveLength(1);
      expect(pr.launches[0]).toMatchObject({
        requestId: `multi-review-pr:${started.id}`,
        environmentId: "env-auto-pr-launch",
        agent: "claude",
        title: "PR",
        conversationMode: "build",
        activateTab: false,
      });
      expect(String(pr.launches[0]!.prompt)).toContain("gh pr create --base main");
      expect(pr.watches).toEqual([{ environmentId: "env-auto-pr-launch", mode: "create-pending" }]);

      // A delivered launch owes nothing more and is never repeated.
      await service.advanceNow(started.id);
      expect(pr.launches).toHaveLength(1);
      const afterCancel = await service.cancel(started.id);
      expect(afterCancel.autoPrLaunch?.state).toBe("launched");
      expect(pr.launches).toHaveLength(1);
      const claimed = await storage.claimMultiReviewController(started.id, "other-owner", 15_000);
      expect(claimed.granted).toBe(true);
    },
    {
      autoPr: true,
      invoke: pr.invoke,
      serviceOptions: { dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch },
    },
  );
});

test("MultiReviewService skips a PR intent whose Address Findings has not settled", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker();
  await withService(
    "env-auto-pr-unproven",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await runInteractiveAddressFindings(service, provider, snapshot, started.id);
      await restorePendingAutoPr(storage, started.id);
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        workflow.fixSession!.status = "running";
      });
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.autoPrLaunch).toMatchObject({
        state: "skipped",
        message: expect.stringContaining("requires a completed Address Findings run"),
      });
      expect(pr.launches).toHaveLength(0);
    },
    {
      autoPr: true,
      invoke: pr.invoke,
      serviceOptions: { dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch },
    },
  );
});

test("MultiReviewService launches a PR once an interactive Address Findings finishes on its own", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker();
  const reads: Array<{ workflowId: string; sessionKey: string; requestIds: string[] }> = [];
  await withService(
    "env-auto-pr-interactive",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      const settled = await runInteractiveAddressFindings(service, provider, snapshot, started.id);
      expect(settled.phase).toBe("interactive");
      expect(settled.autoPrLaunch).toEqual({
        state: "pending",
        fixIdentity: multiReviewAddressFindingsIdentity(settled.fixSession),
        requestId: `multi-review-pr:${started.id}`,
      });
      expect(reads).toEqual([
        {
          workflowId: started.id,
          sessionKey: `multi-review:${started.id}:interactive`,
          requestIds: [`multi-review-address:${started.id}`],
        },
      ]);

      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.autoPrLaunch).toEqual({
        state: "launched",
        fixIdentity: multiReviewAddressFindingsIdentity(settled.fixSession),
        requestId: `multi-review-pr:${started.id}`,
        tabId: "agent-job-pr",
      });
      expect(pr.launches).toHaveLength(1);
      expect(pr.launches[0]).toMatchObject({
        requestId: `multi-review-pr:${started.id}`,
        title: "PR",
        activateTab: false,
      });
      await service.advanceNow(started.id);
      expect(pr.launches).toHaveLength(1);
    },
    {
      autoPr: true,
      invoke: pr.invoke,
      serviceOptions: {
        dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch,
        interactiveAddressFindingsTurnOutcome: async (workflow, session) => {
          reads.push({
            workflowId: workflow.id,
            sessionKey: session.sessionKey,
            requestIds: [...session.requestIds],
          });
          return "completed";
        },
      },
    },
  );
});

test.each([
  ["interrupted", "stopped before it finished"],
  ["superseded", "conversation continued"],
  ["failed", "Address Findings turn failed"],
  ["unknown", "could not be confirmed"],
] as const)(
  "MultiReviewService launches no PR when the interactive Address Findings turn was %s",
  async (outcome, message) => {
    const provider = new Provider();
    const pr = autoPrInvoker();
    await withService(
      `env-auto-pr-interactive-${outcome}`,
      provider,
      async ({ service, start, snapshot }) => {
        const started = await start();
        const settled = await runInteractiveAddressFindings(
          service,
          provider,
          snapshot,
          started.id,
        );
        expect(settled.autoPrLaunch).toMatchObject({
          state: "skipped",
          message: expect.stringContaining(message),
        });
        await service.advanceNow(started.id);
        expect(pr.launches).toHaveLength(0);
      },
      {
        autoPr: true,
        invoke: pr.invoke,
        serviceOptions: {
          dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch,
          interactiveAddressFindingsTurnOutcome: async () => outcome,
        },
      },
    );
  },
);

test("MultiReviewService holds the interactive Address Findings open until its turn outcome settles", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker();
  const outcomes: Array<"pending" | "completed"> = ["pending", "pending", "completed"];
  await withService(
    "env-auto-pr-interactive-pending",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      await service.address(started.id);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.addressPromptPending !== true;
      });
      provider.statusValue = "running";
      await service.advanceNow(started.id);
      provider.statusValue = "idle";
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      const waiting = (await snapshot(started.id))!;
      expect(waiting.stepRuntimes?.fix?.completedAt).toBeUndefined();
      expect(waiting.autoPrLaunch).toBeUndefined();

      await service.advanceNow(started.id);
      const settled = (await snapshot(started.id))!;
      expect(settled.stepRuntimes?.fix?.completedAt).toEqual(expect.any(String));
      expect(settled.autoPrLaunch?.state).toBe("pending");
      await service.advanceNow(started.id);
      expect(pr.launches).toHaveLength(1);
    },
    {
      autoPr: true,
      invoke: pr.invoke,
      serviceOptions: {
        dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch,
        interactiveAddressFindingsTurnOutcome: async () => outcomes.shift() ?? "completed",
      },
    },
  );
});

test("MultiReviewService treats a turn outcome that never settles as unknown", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker();
  await withService(
    "env-auto-pr-interactive-stuck",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      await service.address(started.id);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.addressPromptPending !== true;
      });
      provider.statusValue = "running";
      await service.advanceNow(started.id);
      provider.statusValue = "idle";
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.stepRuntimes?.fix?.completedAt !== undefined;
      });
      expect((await snapshot(started.id))?.autoPrLaunch).toMatchObject({
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
        interactiveAddressFindingsTurnOutcome: async () => "pending",
      },
    },
  );
});

test("MultiReviewService leaves the PR to the user after a custom Address Findings", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker();
  let reads = 0;
  await withService(
    "env-auto-pr-interactive-custom",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await runInteractiveAddressFindings(service, provider, snapshot, started.id);
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        workflow.fixLaunch = {
          kind: "custom",
          instruction: "Address only the first finding",
          model: workflow.fixModel,
        };
        delete workflow.autoPrLaunch;
        delete workflow.stepRuntimes!.fix!.completedAt;
        workflow.fixSession!.status = "running";
        workflow.fixSession!.observedRunning = true;
      });
      reads = 0;
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.autoPrLaunch).toMatchObject({
        state: "skipped",
        message: expect.stringContaining("use the PR button"),
      });
      expect(reads).toBe(0);
      expect(pr.launches).toHaveLength(0);
    },
    {
      autoPr: true,
      invoke: pr.invoke,
      serviceOptions: {
        dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch,
        interactiveAddressFindingsTurnOutcome: async () => {
          reads += 1;
          return "completed";
        },
      },
    },
  );
});

test("MultiReviewService delivers auto-PR in the background with no renderer", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker();
  await withService(
    "env-auto-pr-background",
    provider,
    async ({ service, start, snapshot }) => {
      await service.init();
      const started = await start();
      await waitUntil(async () => (await snapshot(started.id))?.phase === "ready");
      provider.statusValue = "running";
      await service.address(started.id);
      await waitUntil(async () => (await snapshot(started.id))?.fixSession?.status === "running");
      provider.statusValue = "idle";
      await waitUntil(async () => (await snapshot(started.id))?.autoPrLaunch?.state === "launched");
      expect(pr.launches).toHaveLength(1);
    },
    {
      autoPr: true,
      invoke: pr.invoke,
      serviceOptions: {
        autoAdvance: true,
        pollIntervalMs: 5,
        dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch,
        interactiveAddressFindingsTurnOutcome: async () => "completed",
      },
    },
  );
});

test("MultiReviewService uses the pull request action default for the auto-PR agent", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker();
  await withService(
    "env-auto-pr-action-default",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const config = await storage.loadConfig();
      await storage.saveConfig({
        ...config,
        global: {
          ...config.global,
          enabledAgentPlatforms: ["claude", "codex"],
          agentSettings: {
            actionDefaults: {
              pr: { platform: "codex", model: "gpt-5.6", reasoningEffort: "high" },
            },
          },
        },
      });
      const started = await start();
      await runInteractiveAddressFindings(service, provider, snapshot, started.id);
      await restoreCompletedAutoPr(storage, started.id);
      await service.advanceNow(started.id);
      expect(pr.launches[0]).toMatchObject({
        agent: "codex",
        modelId: "gpt-5.6",
        reasoningId: "high",
      });
    },
    {
      autoPr: true,
      invoke: pr.invoke,
      serviceOptions: { dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch },
    },
  );
});

test.each([
  ["auto-PR is off", undefined, "idle" as const],
  ["Address Findings was stopped by the user", true, "idle" as const],
  ["Address Findings failed", true, "error" as const],
])("MultiReviewService does not launch a PR when %s", async (_label, autoPr, finalStatus) => {
  const provider = new Provider();
  const pr = autoPrInvoker();
  await withService(
    `env-auto-pr-none-${finalStatus}`,
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      const stopped = autoPr === true && finalStatus === "idle";
      const settled = await runInteractiveAddressFindings(
        service,
        provider,
        snapshot,
        started.id,
        finalStatus,
        stopped,
      );
      expect(settled.autoPrLaunch?.state).toBe(stopped ? "skipped" : undefined);
      if (stopped) expect(provider.aborted).toContain(settled.fixSession!.providerSessionId);
      await service.advanceNow(started.id);
      expect(pr.launches).toHaveLength(0);
    },
    {
      ...(autoPr !== undefined ? { autoPr } : {}),
      invoke: pr.invoke,
      serviceOptions: { dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch },
    },
  );
});

test("MultiReviewService skips auto-PR when the environment already has a pull request", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker();
  await withService(
    "env-auto-pr-existing",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await runInteractiveAddressFindings(service, provider, snapshot, started.id);
      await restoreCompletedAutoPr(storage, started.id);
      await storage.updateEnvironment("env-auto-pr-existing", {
        prUrl: "https://github.com/acme/app/pull/7",
        prState: "open",
      });
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.autoPrLaunch).toMatchObject({
        state: "skipped",
        message: expect.stringContaining("already exists"),
      });
      expect(pr.launches).toHaveLength(0);
    },
    {
      autoPr: true,
      invoke: pr.invoke,
      serviceOptions: { dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch },
    },
  );
});

test("MultiReviewService keeps the review intact when auto-PR cannot read its settings", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker();
  await withService(
    "env-auto-pr-config-error",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await runInteractiveAddressFindings(service, provider, snapshot, started.id);
      await restoreCompletedAutoPr(storage, started.id);
      const loadConfig = storage.loadConfig.bind(storage);
      storage.loadConfig = async () => {
        throw new Error("config unreadable");
      };
      try {
        await service.advanceNow(started.id);
      } finally {
        storage.loadConfig = loadConfig;
      }
      const retried = (await snapshot(started.id))!;
      expect(retried.phase).toBe("completed");
      expect(retried.error).toBeUndefined();
      expect(retried.autoPrLaunch).toMatchObject({
        state: "pending",
        attempts: 1,
        message: "config unreadable",
      });
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.autoPrLaunch?.state).toBe("launched");
    },
    {
      autoPr: true,
      invoke: pr.invoke,
      serviceOptions: {
        dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch,
        addressFindingsDispatchRetryMs: 0,
      },
    },
  );
});

test("MultiReviewService retries a failed auto-PR launch under one request id", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker({ failures: 2 });
  await withService(
    "env-auto-pr-retry",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await runInteractiveAddressFindings(service, provider, snapshot, started.id);
      await restoreCompletedAutoPr(storage, started.id);
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.autoPrLaunch).toMatchObject({
        state: "pending",
        attempts: 1,
        message: expect.stringContaining("maximum"),
      });
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.autoPrLaunch).toMatchObject({
        state: "launched",
        tabId: "agent-job-pr",
      });
      expect(pr.launches).toHaveLength(3);
      expect(new Set(pr.launches.map((launch) => launch.requestId))).toEqual(
        new Set([`multi-review-pr:${started.id}`]),
      );
    },
    {
      autoPr: true,
      invoke: pr.invoke,
      serviceOptions: {
        dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch,
        addressFindingsDispatchRetryMs: 0,
      },
    },
  );
});

test.each([
  ["exhausts its retry budget", { failures: 10 }, 3, "maximum"],
  ["is rejected", { status: "rejected" as const }, 1, "provider refused"],
  ["returns unknown", { status: "unknown" as const }, 3, "did not acknowledge"],
  [
    "accepts without a tab id",
    { status: "accepted-without-tab" as const },
    3,
    "did not acknowledge",
  ],
])(
  "MultiReviewService marks auto-PR failed when the launch %s",
  async (_label, invokerOptions, expectedLaunches, message) => {
    const provider = new Provider();
    const pr = autoPrInvoker(invokerOptions);
    await withService(
      `env-auto-pr-failed-${expectedLaunches}`,
      provider,
      async ({ service, storage, start, snapshot }) => {
        const started = await start();
        await runInteractiveAddressFindings(service, provider, snapshot, started.id);
        await restoreCompletedAutoPr(storage, started.id);
        for (let pass = 0; pass < 5; pass += 1) await service.advanceNow(started.id);
        const failed = (await snapshot(started.id))!;
        expect(failed.autoPrLaunch).toMatchObject({
          state: "failed",
          message: expect.stringContaining(message),
        });
        // The review itself stays usable; only the follow-up failed.
        expect(failed.phase).toBe("completed");
        expect(failed.error).toBeUndefined();
        expect(pr.launches).toHaveLength(expectedLaunches);
      },
      {
        autoPr: true,
        invoke: pr.invoke,
        serviceOptions: {
          dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch,
          addressFindingsDispatchRetryMs: 0,
        },
      },
    );
  },
);

test("MultiReviewService treats PR monitoring failure as advisory", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker({ failWatch: true });
  await withService(
    "env-auto-pr-monitor-error",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await runInteractiveAddressFindings(service, provider, snapshot, started.id);
      await restoreCompletedAutoPr(storage, started.id);
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.autoPrLaunch?.state).toBe("launched");
      expect(pr.launches).toHaveLength(1);
      expect(pr.watches).toHaveLength(1);
    },
    {
      autoPr: true,
      invoke: pr.invoke,
      serviceOptions: { dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch },
    },
  );
});

test.each([false, true])(
  "MultiReviewService cancels a pending PR before delivery (retry backoff %s)",
  async (retryBackoff) => {
    const provider = new Provider();
    const pr = autoPrInvoker({ failures: retryBackoff ? 1 : 0 });
    await withService(
      `env-auto-pr-cancel-${retryBackoff}`,
      provider,
      async ({ service, storage, start, snapshot }) => {
        const started = await start();
        await runInteractiveAddressFindings(service, provider, snapshot, started.id);
        if (retryBackoff) await restoreCompletedAutoPr(storage, started.id);
        else await restorePendingAutoPr(storage, started.id);
        if (retryBackoff) {
          await service.advanceNow(started.id);
          expect((await snapshot(started.id))?.autoPrLaunch).toMatchObject({
            state: "pending",
            attempts: 1,
          });
        }
        const priorLaunches = pr.launches.length;
        expect((await service.cancel(started.id)).phase).toBe("cancelling");
        await waitUntil(async () => {
          await service.advanceNow(started.id);
          return (await snapshot(started.id))?.phase === "cancelled";
        });
        expect((await snapshot(started.id))?.autoPrLaunch).toBeUndefined();
        expect(pr.launches).toHaveLength(priorLaunches);
      },
      {
        autoPr: true,
        invoke: pr.invoke,
        serviceOptions: {
          dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch,
          addressFindingsDispatchRetryMs: 60_000,
        },
      },
    );
  },
);

test.each(["prepare", "consolidate", "fix", "reviewer"] as const)(
  "MultiReviewService supersedes a pending PR before restarting %s",
  async (kind) => {
    const provider = new Provider();
    const pr = autoPrInvoker();
    await withService(
      `env-auto-pr-restart-${kind}`,
      provider,
      async ({ service, storage, start, snapshot }) => {
        const started = await start();
        await runInteractiveAddressFindings(service, provider, snapshot, started.id);
        await restoreCompletedAutoPr(storage, started.id);
        if (kind === "reviewer") {
          await service.restartReviewer(started.id, started.reviewers[0]!.id);
        } else {
          await service.restartStep(started.id, kind);
        }
        expect((await snapshot(started.id))?.autoPrLaunch).toBeUndefined();
        await service.advanceNow(started.id);
        expect(pr.launches).toHaveLength(0);
      },
      {
        autoPr: true,
        invoke: pr.invoke,
        serviceOptions: { dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch },
      },
    );
  },
);

test("MultiReviewService re-delivers a pending PR after service restart", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker();
  await withService(
    "env-auto-pr-service-restart",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await runInteractiveAddressFindings(service, provider, snapshot, started.id);
      await restoreCompletedAutoPr(storage, started.id);
      await service.shutdown();
      const replacement = new MultiReviewService(storage, pr.invoke, {
        autoAdvance: false,
        provider: async () => provider,
      });
      try {
        await replacement.advanceNow(started.id);
        expect((await snapshot(started.id))?.autoPrLaunch).toMatchObject({
          state: "launched",
          tabId: "agent-job-pr",
        });
        expect(pr.launches).toHaveLength(1);
      } finally {
        await replacement.shutdown();
      }
    },
    {
      autoPr: true,
      invoke: pr.invoke,
      serviceOptions: { dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch },
    },
  );
});

test("MultiReviewService drops a pending PR when a custom Address Findings is queued", async () => {
  const provider = new Provider();
  const pr = autoPrInvoker();
  await withService(
    "env-auto-pr-custom-fix",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      await restorePendingAutoPr(storage, started.id);
      const queued = await service.customAddressFindings({
        workflowId: started.id,
        fixModel: { agent: "claude", model: "opus" },
        instruction: "Address the remaining finding",
      });
      expect(queued.autoPrLaunch).toBeUndefined();
      await service.advanceNow(started.id);
      expect(pr.launches).toHaveLength(0);
    },
    {
      autoPr: true,
      invoke: pr.invoke,
      serviceOptions: { dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch },
    },
  );
});

test("MultiReviewService drops a pending PR when auto-fix is queued after consolidation", async () => {
  const provider = new Provider();
  provider.reviewerReport = consolidatedReport;
  const pr = autoPrInvoker();
  await withService(
    "env-auto-pr-default-fix",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "consolidating";
      });
      await restorePendingAutoPr(storage, started.id);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "interactive";
      });
      expect((await snapshot(started.id))?.autoPrLaunch?.state).toBe("skipped");
      expect(pr.launches).toHaveLength(0);
    },
    {
      packageFlow: true,
      autoFix: true,
      autoPr: true,
      invoke: pr.invoke,
      serviceOptions: { dispatchAddressFindingsPrompt: autoPrAddressFindingsDispatch },
    },
  );
});

test("MultiReviewService runs auto-fix then auto-PR in order without stopping at ready", async () => {
  const provider = new Provider();
  provider.reviewerReport = consolidatedReport;
  const events: string[] = [];
  const flow = orderedAutoFlow(events);
  await withService(
    "env-auto-fix-pr-flow",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      expect(started).toMatchObject({ autoFix: true, autoPr: true });
      const addressFindingsSessionId = `provider-auto-pr-${started.id}`;
      provider.statusOverrides.set(addressFindingsSessionId, "running");
      const seen: string[] = [];
      const fixing = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) => workflow.fixSession?.status === "running",
        seen,
      );
      // Consolidation hands straight to the ordinary Address Findings; the review never waits at ready.
      expect(seen).not.toContain("ready");
      expect(fixing).toMatchObject({ phase: "interactive", fixLaunch: { kind: "default" } });
      expect(fixing.addressPromptPending).toBeUndefined();
      expect(events).toEqual(["fix"]);
      await service.advanceNow(started.id);
      expect(flow.pr.launches).toHaveLength(0);

      provider.statusOverrides.set(addressFindingsSessionId, "idle");
      const queued = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) => workflow.autoPrLaunch !== undefined,
      );
      // The PR intent is saved with Address Findings's completion, before any PR launch.
      expect(queued.fixSession?.status).toBe("idle");
      expect(queued.autoPrLaunch?.state).toBe("pending");
      expect(events).toEqual(["fix"]);

      const launched = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) => workflow.autoPrLaunch?.state === "launched",
      );
      expect(launched.autoPrLaunch).toMatchObject({ tabId: "agent-job-pr" });
      expect(events).toEqual(["fix", "pr"]);
      await service.advanceNow(started.id);
      expect(events).toEqual(["fix", "pr"]);
    },
    {
      packageFlow: true,
      autoFix: true,
      autoPr: true,
      invoke: flow.invoke,
      serviceOptions: {
        dispatchAddressFindingsPrompt: flow.dispatchAddressFindingsPrompt,
        interactiveAddressFindingsTurnOutcome: async () => "completed",
      },
    },
  );
});

test("MultiReviewService raises no PR when the automatic Address Findings fails", async () => {
  const provider = new Provider();
  provider.reviewerReport = consolidatedReport;
  const events: string[] = [];
  const flow = orderedAutoFlow(events);
  await withService(
    "env-auto-fix-pr-failed-fix",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      const addressFindingsSessionId = `provider-auto-pr-${started.id}`;
      provider.statusOverrides.set(addressFindingsSessionId, "running");
      await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) => workflow.fixSession?.status === "running",
      );
      provider.statusOverrides.set(addressFindingsSessionId, "missing");
      const failed = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) => workflow.fixSession?.status === "failed",
      );
      for (let pass = 0; pass < 5; pass += 1) await service.advanceNow(started.id);
      // The workflow stops at Address Findings and reports it; it never skips ahead to the PR.
      expect(failed.phase).toBe("interactive");
      expect(failed.fixSession?.error).toContain("no longer exists");
      expect((await snapshot(started.id))?.autoPrLaunch).toBeUndefined();
      expect(events).toEqual(["fix"]);
      expect(flow.pr.launches).toHaveLength(0);
    },
    {
      packageFlow: true,
      autoFix: true,
      autoPr: true,
      invoke: flow.invoke,
      serviceOptions: {
        dispatchAddressFindingsPrompt: flow.dispatchAddressFindingsPrompt,
        interactiveAddressFindingsTurnOutcome: async () => "completed",
      },
    },
  );
});

test("MultiReviewService resumes auto-fix and auto-PR after a restart at each stage", async () => {
  const provider = new Provider();
  provider.reviewerReport = consolidatedReport;
  const events: string[] = [];
  const flow = orderedAutoFlow(events);
  // The first Address Findings dispatch is lost, as if the backend stopped mid-handoff.
  let dropFirstDispatch = true;
  const dispatchAddressFindingsPrompt: NonNullable<
    MultiReviewServiceOptions["dispatchAddressFindingsPrompt"]
  > = (...args) => {
    if (dropFirstDispatch) {
      dropFirstDispatch = false;
      throw new Error("backend stopped before Address Findings was acknowledged");
    }
    return flow.dispatchAddressFindingsPrompt(...args);
  };
  const options = {
    autoAdvance: false,
    provider: async () => provider,
    dispatchAddressFindingsPrompt,
    interactiveAddressFindingsTurnOutcome: async () => "completed" as const,
  };
  await withService(
    "env-auto-fix-pr-restart",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      const addressFindingsSessionId = `provider-auto-pr-${started.id}`;
      provider.statusOverrides.set(addressFindingsSessionId, "running");
      const restart = async (current: MultiReviewService) => {
        await current.shutdown();
        return new MultiReviewService(storage, flow.invoke, options);
      };

      // Stage 1: consolidation queued Address Findings, but it was not delivered.
      const handoff = await advanceUntil(
        service,
        snapshot,
        started.id,
        (workflow) => workflow.addressPromptAttempts === 1,
      );
      expect(handoff).toMatchObject({ phase: "interactive", addressPromptPending: true });
      let current = await restart(service);

      // Stage 2: the restarted supervisor delivers the same Address Findings once; restart while it runs.
      await advanceUntil(
        current,
        snapshot,
        started.id,
        (workflow) => workflow.fixSession?.status === "running",
      );
      expect(events).toEqual(["fix"]);
      current = await restart(current);
      provider.statusOverrides.set(addressFindingsSessionId, "idle");

      // Stage 3: Address Findings finishes and queues its PR; restart before the launch.
      const queued = await advanceUntil(
        current,
        snapshot,
        started.id,
        (workflow) => workflow.autoPrLaunch !== undefined,
      );
      expect(queued.autoPrLaunch?.state).toBe("pending");
      expect(events).toEqual(["fix"]);
      current = await restart(current);

      // Stage 4: the restarted supervisor launches the PR exactly once, after Address Findings.
      try {
        await advanceUntil(
          current,
          snapshot,
          started.id,
          (workflow) => workflow.autoPrLaunch?.state === "launched",
        );
        for (let pass = 0; pass < 3; pass += 1) await current.advanceNow(started.id);
        expect(events).toEqual(["fix", "pr"]);
      } finally {
        await current.shutdown();
      }
    },
    {
      packageFlow: true,
      autoFix: true,
      autoPr: true,
      invoke: flow.invoke,
      serviceOptions: {
        dispatchAddressFindingsPrompt,
        interactiveAddressFindingsTurnOutcome: async () => "completed",
      },
    },
  );
});

test("MultiReviewService bounds delayed interactive Address Findings usage finalization", async () => {
  const provider = new Provider();
  provider.usagePending = true;
  await withService(
    "env-interactive-fix-delayed-usage",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      await service.address(started.id);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);

      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.fixSession?.usageFinalizationPolls === 1;
      });
      expect((await snapshot(started.id))?.fixSession).toMatchObject({
        status: "running",
        usageFinalizationPolls: 1,
      });

      provider.usagePending = false;
      provider.usageTokens = 9_876;
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.fixSession).toMatchObject({
        status: "idle",
        tokenCount: 9_876,
      });
      expect((await snapshot(started.id))?.fixSession?.usageFinalizationPolls).toBeUndefined();
    },
    {
      serviceOptions: {
        dispatchAddressFindingsPrompt: async (workflow) => ({
          tabId: workflow.addressTabId!,
          fixSession: {
            ...workflow.fixModel,
            sessionKey: workflow.addressSessionKey!,
            providerSessionId: "provider-interactive-delayed",
            requestIds: [workflow.addressRequestId!],
            status: "running",
            startedAt: new Date().toISOString(),
          },
        }),
      },
    },
  );
});

test("MultiReviewService does not settle an interactive Address Findings from one startup-racing idle read", async () => {
  const provider = new Provider();
  await withService(
    "env-interactive-fix-idle-race",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      await service.address(started.id);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);

      provider.statusValue = "idle";
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.fixSession).toMatchObject({
        status: "running",
        idleResultPolls: 1,
      });
      expect((await snapshot(started.id))?.stepRuntimes?.fix?.completedAt).toBeUndefined();

      provider.statusValue = "running";
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.fixSession).toMatchObject({
        status: "running",
        observedRunning: true,
      });
      expect((await snapshot(started.id))?.fixSession?.idleResultPolls).toBeUndefined();
      expect((await snapshot(started.id))?.fixSession?.completedAt).toBeUndefined();
    },
    {
      serviceOptions: {
        dispatchAddressFindingsPrompt: async (workflow) => ({
          tabId: workflow.addressTabId!,
          fixSession: {
            ...workflow.fixModel,
            sessionKey: workflow.addressSessionKey!,
            providerSessionId: "provider-interactive-idle-race",
            requestIds: [workflow.addressRequestId!],
            status: "running",
            startedAt: new Date().toISOString(),
          },
        }),
      },
    },
  );
});

test("MultiReviewService adopts a legacy interactive Address Findings stored idle with an unsettled runtime", async () => {
  const provider = new Provider();
  await withService(
    "env-interactive-fix-legacy-idle",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      provider.statusValue = "running";
      await service.address(started.id);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);
      await mutateStoredWorkflow(storage, started.id, (workflow) => {
        workflow.fixSession!.status = "idle";
        delete workflow.fixSession!.completedAt;
        delete workflow.fixSession!.observedRunning;
        delete workflow.stepRuntimes!.fix!.completedAt;
      });

      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.fixSession).toMatchObject({
        status: "running",
        observedRunning: true,
      });
      expect((await snapshot(started.id))?.stepRuntimes?.fix?.completedAt).toBeUndefined();
    },
    {
      serviceOptions: {
        dispatchAddressFindingsPrompt: async (workflow) => ({
          tabId: workflow.addressTabId!,
          fixSession: {
            ...workflow.fixModel,
            sessionKey: workflow.addressSessionKey!,
            providerSessionId: "provider-interactive-legacy-idle",
            requestIds: [workflow.addressRequestId!],
            status: "running",
            startedAt: new Date().toISOString(),
          },
        }),
      },
    },
  );
});

test("MultiReviewService releases its controller claim while an interactive Address Findings keeps running", async () => {
  const provider = new Provider();
  provider.usageTokens = 321;
  await withService(
    "env-interactive-fix-running-lease",
    provider,
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      provider.statusValue = "running";
      await service.address(started.id);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);
      await service.advanceNow(started.id);

      expect((await snapshot(started.id))?.fixSession).toMatchObject({
        status: "running",
        tokenCount: 321,
      });
      const claimed = await storage.claimMultiReviewController(started.id, "other-owner", 15_000);
      expect(claimed.granted).toBe(true);
    },
    {
      serviceOptions: {
        dispatchAddressFindingsPrompt: async (workflow) => ({
          tabId: workflow.addressTabId!,
          fixSession: {
            ...workflow.fixModel,
            sessionKey: workflow.addressSessionKey!,
            providerSessionId: "provider-interactive-running-lease",
            requestIds: [workflow.addressRequestId!],
            status: "running",
            startedAt: new Date().toISOString(),
          },
        }),
      },
    },
  );
});

test("MultiReviewService keeps a blocked interactive Address Findings running and resets terminal usage polls", async () => {
  const provider = new Provider();
  await withService(
    "env-interactive-fix-blocked",
    provider,
    async ({ service, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "ready";
      });
      await service.address(started.id);
      await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);

      provider.statusValue = "idle";
      provider.usagePending = true;
      await service.advanceNow(started.id);
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.fixSession?.usageFinalizationPolls).toBe(1);

      provider.statusValue = "blocked";
      provider.usageTokens = 444;
      await service.advanceNow(started.id);
      const blocked = (await snapshot(started.id))!;
      expect(blocked.fixSession).toMatchObject({
        status: "running",
        tokenCount: 444,
        observedRunning: true,
      });
      expect(blocked.fixSession?.completedAt).toBeUndefined();
      expect(blocked.fixSession?.usageFinalizationPolls).toBeUndefined();

      provider.statusValue = "idle";
      await service.advanceNow(started.id);
      expect((await snapshot(started.id))?.fixSession?.usageFinalizationPolls).toBe(1);
    },
    {
      serviceOptions: {
        dispatchAddressFindingsPrompt: async (workflow) => ({
          tabId: workflow.addressTabId!,
          fixSession: {
            ...workflow.fixModel,
            sessionKey: workflow.addressSessionKey!,
            providerSessionId: "provider-interactive-blocked",
            requestIds: [workflow.addressRequestId!],
            status: "running",
            startedAt: new Date().toISOString(),
          },
        }),
      },
    },
  );
});

test.each([
  ["missing" as const, undefined, "The interactive Address Findings session no longer exists"],
  [
    "error" as const,
    "provider exploded",
    "The interactive Address Findings session failed: provider exploded",
  ],
  ["error" as const, undefined, "The interactive Address Findings session failed"],
])(
  "MultiReviewService settles a %s interactive Address Findings observation as failed",
  async (status, detail, expectedError) => {
    const provider = new Provider();
    await withService(
      `env-interactive-fix-${status}`,
      provider,
      async ({ service, storage, start, snapshot }) => {
        const started = await start();
        await waitUntil(async () => {
          await service.advanceNow(started.id);
          return (await snapshot(started.id))?.phase === "ready";
        });
        await service.address(started.id);
        await waitUntil(async () => (await snapshot(started.id))?.addressPromptPending !== true);
        const sessionId = (await snapshot(started.id))!.fixSession!.providerSessionId;
        if (detail) provider.sessionFailures.set(sessionId, detail);
        else provider.statusValue = status;

        await service.advanceNow(started.id);
        const failed = (await snapshot(started.id))!;
        expect(failed.fixSession).toMatchObject({
          status: "failed",
          error: expectedError,
          completedAt: expect.any(String),
        });
        expect(failed.stepRuntimes?.fix?.completedAt).toEqual(expect.any(String));
        const claimed = await storage.claimMultiReviewController(started.id, "other-owner", 15_000);
        expect(claimed.granted).toBe(true);
      },
      {
        serviceOptions: {
          dispatchAddressFindingsPrompt: async (workflow) => ({
            tabId: workflow.addressTabId!,
            fixSession: {
              ...workflow.fixModel,
              sessionKey: workflow.addressSessionKey!,
              providerSessionId: `provider-interactive-${status}`,
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

test("MultiReviewService polls an HTTP interactive Address Findings through the no-touch activity route", async () => {
  const fallbackProvider = new Provider();
  const requests: string[] = [];
  let activityState: "working" | "idle" = "working";
  const { provider: http } = httpProvider((request, init) => {
    const url = new URL(request);
    requests.push(url.pathname);
    if (url.pathname === "/sessions/activity") {
      const { sessionIds } = JSON.parse(String(init.body)) as { sessionIds: string[] };
      return Response.json({
        version: 1,
        observations: Object.fromEntries(sessionIds.map((id) => [id, { activity: activityState }])),
      });
    }
    if (url.pathname.endsWith("/activity")) {
      return Response.json({ activity: activityState });
    }
    if (url.pathname.endsWith("/usage")) {
      return Response.json({ contextUsage: { usedTokens: 12, sessionTokens: 12 } });
    }
    return Response.json({
      status: "idle",
      contextUsage: { usedTokens: 12, sessionTokens: 12 },
    });
  }, codexConnection);
  await withService(
    "env-interactive-fix-http-activity",
    fallbackProvider,
    async ({ service, snapshot }) => {
      const started = await service.start({
        environmentId: "env-interactive-fix-http-activity",
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

      requests.length = 0;
      await service.advanceNow(started.id);
      expect(requests.filter((path) => path.endsWith("/activity"))).toEqual(["/sessions/activity"]);
      expect(
        requests.some(
          (path) =>
            path === "/session/http-interactive-fix" ||
            path === "/session/http-interactive-fix/status",
        ),
      ).toBe(false);

      activityState = "idle";
      await service.advanceNow(started.id);
      expect(requests.filter((path) => path.endsWith("/activity"))).toEqual([
        "/sessions/activity",
        "/sessions/activity",
      ]);
      expect(
        requests.filter(
          (path) =>
            path === "/session/http-interactive-fix" ||
            path === "/session/http-interactive-fix/status",
        ),
      ).toHaveLength(1);
      expect((await snapshot(started.id))?.fixSession).toMatchObject({
        status: "idle",
        tokenCount: 12,
      });
    },
    {
      packageFlow: true,
      createProvider: async (_workflow, selection) =>
        selection.agent === "codex" ? http : fallbackProvider,
      serviceOptions: {
        dispatchAddressFindingsPrompt: async (workflow) => ({
          tabId: workflow.addressTabId!,
          fixSession: {
            ...workflow.fixModel,
            sessionKey: workflow.addressSessionKey!,
            providerSessionId: "http-interactive-fix",
            requestIds: [workflow.addressRequestId!],
            status: "running",
            startedAt: new Date().toISOString(),
          },
        }),
      },
    },
  );
});

test("MultiReviewService batches concurrent interactive Address Findings activity reads per bridge", async () => {
  await withInteractiveFixes(
    "fix-batch",
    { "fix-0": "working", "fix-1": "working", "fix-2": "waiting" },
    async ({ service, workflowIds, requests, batchBodies, snapshot }) => {
      await Promise.all(workflowIds.map((id) => service.advanceNow(id)));

      expect(requests.filter((path) => path === "/sessions/activity")).toHaveLength(1);
      expect(batchBodies[0]).toHaveLength(3);
      expect(requests.filter(singleActivityRead)).toEqual([]);
      for (const id of workflowIds) {
        expect((await snapshot(id))?.fixSession).toMatchObject({
          status: "running",
          observedRunning: true,
        });
      }
    },
  );
});

test("MultiReviewService keeps missing and unavailable Address Findings activity distinct in a batch", async () => {
  await withInteractiveFixes(
    "fix-batch-partial",
    { "fix-0": "working", "fix-1": "missing", "fix-2": "unavailable" },
    async ({ service, workflowIds, requests, snapshot }) => {
      await Promise.all(workflowIds.map((id) => service.advanceNow(id)));

      expect(requests.filter((path) => path === "/sessions/activity")).toHaveLength(1);
      const [working, missing, unavailable] = await Promise.all(workflowIds.map(snapshot));
      expect(working?.fixSession).toMatchObject({ status: "running", observedRunning: true });
      // Only the bridge's proof of nonexistence settles an Address Findings run as gone.
      expect(missing?.fixSession).toMatchObject({
        status: "failed",
        error: "The interactive Address Findings session no longer exists",
      });
      // Uncertainty is a failed read of that workflow alone: nothing settles.
      expect(unavailable?.fixSession?.status).toBe("running");
      expect(unavailable?.fixSession?.error).toBeUndefined();
      expect(unavailable?.fixSession?.completedAt).toBeUndefined();
    },
  );
});
