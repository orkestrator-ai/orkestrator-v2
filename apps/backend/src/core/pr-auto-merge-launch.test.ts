import { expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { createEnvironment, StorageService } from "./storage.js";
import { nativeTabsOfLayout } from "./public-api/summaries.js";

const prUrl = "https://github.com/o/r/pull/1";

async function fixture(
  run: (storage: StorageService, context: CommandContext, dir: string) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), "auto-resolve-launch-"));
  const storage = new StorageService(dir);
  await storage.init();
  await storage.addEnvironment({
    ...createEnvironment("project"),
    id: "env",
    environmentType: "local",
    worktreePath: dir,
    status: "running",
    setupPhase: "ready",
    prUrl,
    prState: "open",
    hasMergeConflicts: true,
  });
  await storage.updateEnvironment("env", { autoMerge: true });
  const context = {
    storage,
    prAutoMerge: { isActive: () => true },
    nativeAgents: {
      ensureSession: mock(async () => ({ providerSessionId: "session" })),
      dispatchIntent: mock(async () => ({ outcome: "accepted" })),
      promptReadiness: mock(async () => "idle"),
    },
  } as unknown as CommandContext;
  try {
    await run(storage, context, dir);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const launch = createCommandRegistry().get("launch_native_agent_job")!;
const args = {
  environmentId: "env",
  requestId: "attempt-1",
  agent: "claude",
  prompt: "Resolve conflicts",
  title: "Resolve",
  completionAction: "refresh-pr-after-agent-completion",
  autoMergePrUrl: prUrl,
};

test("automatic Resolve conditionally claims the episode and preserves a manual owner's token", async () => {
  await fixture(async (storage, context) => {
    const manual = await launch(
      { ...args, autoMergePrUrl: undefined, requestId: "manual" },
      context,
    );
    expect(manual).toMatchObject({ status: "accepted" });
    const token = (await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt;
    expect(await launch(args, context)).toMatchObject({ status: "skipped" });
    expect(context.nativeAgents!.dispatchIntent).toHaveBeenCalledTimes(1);
    expect((await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt).toBe(token);
  });
});

test("pre-dispatch setup failures reuse the durable tab and recover across changing retry IDs", async () => {
  await fixture(async (storage, context) => {
    const ensure = mock(async () => {
      throw new Error("setup unavailable");
    });
    context.nativeAgents!.ensureSession = ensure as never;
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(launch({ ...args, requestId: `retry-${attempt}` }, context)).rejects.toThrow(
        "setup unavailable",
      );
      expect(
        (await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt,
      ).toBeUndefined();
      const layout = await storage.getPaneLayout("env");
      expect(layout!.root).toMatchObject({
        kind: "leaf",
        tabs: [expect.objectContaining({ displayTitle: "Resolve" })],
      });
    }
    context.nativeAgents!.ensureSession = mock(async () => ({
      providerSessionId: "session",
    })) as never;
    expect(await launch({ ...args, requestId: "recovered" }, context)).toMatchObject({
      status: "accepted",
    });
    expect(context.nativeAgents!.dispatchIntent).toHaveBeenCalledTimes(1);
    expect((await storage.getPaneLayout("env"))!.root).toMatchObject({
      kind: "leaf",
      tabs: [
        expect.objectContaining({
          nativeAgentData: expect.objectContaining({ sessionId: "session" }),
        }),
      ],
    });
  });
});

for (const outcome of ["unknown", "throw"] as const) {
  test(`uncertain dispatch (${outcome}) retains ownership and cannot duplicate Resolve`, async () => {
    await fixture(async (storage, context) => {
      context.nativeAgents!.dispatchIntent = mock(async () => {
        if (outcome === "throw") throw new Error("transport lost");
        return { outcome: "unknown" };
      }) as never;
      if (outcome === "throw")
        await expect(launch(args, context)).rejects.toThrow("transport lost");
      else expect(await launch(args, context)).toMatchObject({ status: "unknown" });
      const token = (await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt;
      expect(token).toBeTruthy();
      expect(await launch({ ...args, requestId: "retry" }, context)).toMatchObject({
        status: "skipped",
      });
      expect(context.nativeAgents!.dispatchIntent).toHaveBeenCalledTimes(1);
      expect((await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt).toBe(
        token,
      );
    });
  });
}

for (const action of ["disable", "dispose", "manual"] as const) {
  test(`command preparation fences ${action} before any tab or prompt is published`, async () => {
    await fixture(async (storage, context) => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => (entered = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      const config = await storage.loadConfig();
      const loading = spyOn(storage, "loadConfig").mockImplementationOnce(async () => {
        entered();
        await gate;
        return config;
      });
      try {
        const automatic = launch(args, context);
        await started;
        if (action === "disable") await storage.updateEnvironment("env", { autoMerge: false });
        if (action === "dispose") context.prAutoMerge = { isActive: () => false } as never;
        let token: string | undefined;
        if (action === "manual") {
          expect(
            await launch({ ...args, autoMergePrUrl: undefined, requestId: "manual" }, context),
          ).toMatchObject({ status: "accepted" });
          token = (await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt;
        }
        release();
        expect(await automatic).toMatchObject({ status: "skipped" });
        expect(context.nativeAgents!.dispatchIntent).toHaveBeenCalledTimes(
          action === "manual" ? 1 : 0,
        );
        if (action !== "manual") expect(await storage.getPaneLayout("env")).toBeNull();
        else
          expect((await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt).toBe(
            token,
          );
      } finally {
        release();
        loading.mockRestore();
      }
    });
  });
}

test("rollback of a failed setup leaves a newer manual Resolve token intact", async () => {
  await fixture(async (storage, context) => {
    let token: string | null = null;
    context.nativeAgents!.ensureSession = mock(async () => {
      token = (await storage.armPrRecheckAfterAgentCompletion("env")).armedAt;
      throw new Error("failed setup");
    }) as never;
    await expect(launch(args, context)).rejects.toThrow("failed setup");
    expect(token).toBeTruthy();
    expect((await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt).toBe(
      token!,
    );
  });
});

test("a failed Resolve keeps its recoverable identity through storage restart", async () => {
  await fixture(async (storage, context, dir) => {
    context.nativeAgents!.ensureSession = mock(async () => {
      throw new Error("not ready");
    }) as never;
    await expect(launch(args, context)).rejects.toThrow("not ready");
    const requestId = (await storage.getEnvironment("env"))!.autoMergeResolveRequestId;
    const reopened = new StorageService(dir);
    try {
      await reopened.init();
      context.storage = reopened;
      context.nativeAgents!.ensureSession = mock(async () => ({
        providerSessionId: "session",
      })) as never;
      expect(await launch({ ...args, requestId: "after-restart" }, context)).toMatchObject({
        status: "accepted",
      });
      expect((await reopened.getEnvironment("env"))!.autoMergeResolveRequestId).toBe(requestId);
      expect((await reopened.getPaneLayout("env"))!.root).toMatchObject({
        kind: "leaf",
        tabs: [expect.anything()],
      });
    } finally {
      reopened.close();
    }
  });
});

test("a later conflict episode sends Resolve again to the same settled tab", async () => {
  await fixture(async (storage, context) => {
    // Each dispatch runs and settles, the way a finished Resolve turn is recorded.
    const dispatchIntent = mock(
      async (input: {
        environmentId: string;
        agent: "claude";
        logicalSessionKey: string;
        requestId: string;
      }) => {
        const key = nativeAgentSessionStorageKey(
          input.environmentId,
          input.agent,
          input.logicalSessionKey,
        );
        if (!(await storage.getNativeAgentSession(key)))
          await storage.adoptNativeAgentSession({
            key,
            environmentId: input.environmentId,
            agent: input.agent,
            logicalSessionKey: input.logicalSessionKey,
            providerSessionId: "session",
          });
        await storage.dispatchNativeAgentPromptOnce(key, input.requestId, async () => {});
        await storage.recordNativeAgentTurnOutcome(key, "session", {
          requestId: input.requestId,
          outcome: "completed",
          observedAt: new Date().toISOString(),
        });
        return { outcome: "accepted" };
      },
    );
    context.nativeAgents!.dispatchIntent = dispatchIntent as never;
    const automatic = { ...args, tabReuse: "any-agent" };

    const first = (await launch({ ...automatic, requestId: "episode-1" }, context)) as Record<
      string,
      unknown
    >;
    expect(first).toMatchObject({ status: "accepted" });
    const tabId = first.tabId;
    expect(tabId).toEqual(expect.any(String));

    // GitHub reports the conflict resolved, which ends the episode.
    await storage.updateEnvironment("env", {
      hasMergeConflicts: false,
      prRecheckAfterAgentCompletionArmedAt: undefined,
    });
    expect((await storage.getEnvironment("env"))!.autoMergeResolveRequestId).toBeUndefined();
    // A new conflict starts the next episode.
    await storage.updateEnvironment("env", { hasMergeConflicts: true });

    const second = (await launch({ ...automatic, requestId: "episode-2" }, context)) as Record<
      string,
      unknown
    >;
    expect(second).toMatchObject({ status: "accepted", tabId, reused: true });
    expect(second.queued).toBeUndefined();
    expect(dispatchIntent).toHaveBeenCalledTimes(2);
    expect(dispatchIntent.mock.calls[1]?.[0]).toMatchObject({
      logicalSessionKey: `env-env:${tabId}`,
      requestId: "episode-2",
      prompt: args.prompt,
    });
    expect((await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt).toEqual(
      expect.any(String),
    );
    const layout = await storage.getPaneLayout("env");
    expect(layout!.root).toMatchObject({ kind: "leaf", tabs: [expect.anything()] });

    // The same episode does not send it a third time.
    expect(await launch({ ...automatic, requestId: "episode-2-again" }, context)).toMatchObject({
      status: "skipped",
    });
    expect(dispatchIntent).toHaveBeenCalledTimes(2);
  });
});

async function nextEpisode(storage: StorageService) {
  await storage.updateEnvironment("env", {
    hasMergeConflicts: false,
    prRecheckAfterAgentCompletionArmedAt: undefined,
  });
  await storage.updateEnvironment("env", { hasMergeConflicts: true });
}

for (const readiness of ["idle", "busy"] as const) {
  for (const revoke of ["disable", "dispose", "replace-pr", "clear-conflicts"] as const) {
    test(`automatic reused-tab ${readiness} launch fences ${revoke} during readiness`, async () => {
      await fixture(async (storage, context) => {
        await launch(args, context);
        await nextEpisode(storage);
        context.nativeAgents!.promptReadiness = mock(async () => {
          if (revoke === "disable") await storage.updateEnvironment("env", { autoMerge: false });
          if (revoke === "dispose") context.prAutoMerge = { isActive: () => false } as never;
          if (revoke === "replace-pr")
            await storage.updateEnvironment("env", { prUrl: prUrl + "2" });
          if (revoke === "clear-conflicts")
            await storage.updateEnvironment("env", { hasMergeConflicts: false });
          return readiness;
        }) as never;
        expect(
          await launch({ ...args, tabReuse: "any-agent", requestId: "revoked" }, context),
        ).toMatchObject({ status: "skipped" });
        expect(context.nativeAgents!.dispatchIntent).toHaveBeenCalledTimes(1);
        expect((await storage.listPromptQueues("env")).flatMap((q) => q.messages)).toEqual([]);
        expect(
          (await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt,
        ).toBeUndefined();
      });
    });
  }
}

for (const reuse of [false, true]) {
  test(`cancellation after ${reuse ? "reused" : "new"} tab receipt reservation permits a fresh launch`, async () => {
    await fixture(async (storage, context) => {
      if (reuse) {
        await launch(args, context);
        await nextEpisode(storage);
      }
      const reserve = storage.reserveNativeAgentJobRequest.bind(storage);
      const reserving = spyOn(storage, "reserveNativeAgentJobRequest").mockImplementationOnce(
        async (...input) => {
          const receipt = await reserve(...input);
          await storage.updateEnvironment("env", { autoMerge: false });
          return receipt;
        },
      );
      try {
        expect(await launch({ ...args, tabReuse: "any-agent" }, context)).toMatchObject({
          status: "skipped",
        });
      } finally {
        reserving.mockRestore();
      }
      expect((await storage.listPromptQueues("env")).flatMap((q) => q.jobReceipts ?? [])).toEqual(
        [],
      );
      await storage.updateEnvironment("env", { autoMerge: true });
      expect(
        await launch({ ...args, tabReuse: "any-agent", requestId: "reenabled" }, context),
      ).toMatchObject({ status: "accepted" });
      expect(context.nativeAgents!.dispatchIntent).toHaveBeenCalledTimes(reuse ? 2 : 1);
    });
  });
}

test("a busy previous Resolve cannot absorb a later episode's queued prompt", async () => {
  await fixture(async (storage, context) => {
    context.nativeAgents!.dispatchIntent = mock(
      async (input: {
        environmentId: string;
        agent: "claude";
        logicalSessionKey: string;
        requestId: string;
      }) => {
        const key = nativeAgentSessionStorageKey(
          input.environmentId,
          input.agent,
          input.logicalSessionKey,
        );
        await storage.adoptNativeAgentSession({ ...input, key, providerSessionId: "session" });
        await storage.dispatchNativeAgentPromptOnce(key, input.requestId, async () => {});
        return { outcome: "accepted" };
      },
    ) as never;
    const automatic = { ...args, tabReuse: "any-agent" };
    const first = (await launch(automatic, context)) as { tabId: string };
    await nextEpisode(storage);
    context.nativeAgents!.promptReadiness = mock(async () => "busy") as never;
    expect(await launch({ ...automatic, requestId: "episode-2" }, context)).toMatchObject({
      status: "accepted",
      reused: true,
      queued: true,
      tabId: first.tabId,
    });
    expect(context.nativeAgents!.dispatchIntent).toHaveBeenCalledTimes(1);
    const queues = await storage.listPromptQueues("env");
    expect(queues.flatMap((q) => q.messages)).toEqual([
      expect.objectContaining({ requestId: "episode-2", text: args.prompt }),
    ]);
    expect(
      queues.flatMap((q) => q.jobReceipts ?? []).find((r) => r.requestId === "episode-2")
        ?.dispatchRequestId,
    ).toBeUndefined();
    expect(await launch({ ...automatic, requestId: "same-episode" }, context)).toMatchObject({
      status: "skipped",
    });
  });
});

for (const state of ["closed", "unavailable"] as const) {
  test(`automatic Resolve creates one replacement when the old tab is ${state}`, async () => {
    await fixture(async (storage, context) => {
      await launch(args, context);
      await nextEpisode(storage);
      if (state === "closed") {
        const layout = (await storage.getPaneLayout("env"))!;
        layout.root = { kind: "leaf", id: "empty", tabs: [], activeTabId: null };
        await storage.savePaneLayout("env", layout, layout.revision);
      } else {
        context.nativeAgents!.promptReadiness = mock(async () => "unavailable") as never;
      }
      const result = await launch(
        { ...args, tabReuse: "any-agent", requestId: "replacement" },
        context,
      );
      expect(result).toMatchObject({ status: "accepted" });
      expect(context.nativeAgents!.dispatchIntent).toHaveBeenCalledTimes(2);
      expect(
        await launch({ ...args, tabReuse: "any-agent", requestId: "repeat" }, context),
      ).toMatchObject({ status: "skipped" });
      const layout = (await storage.getPaneLayout("env"))!;
      expect(layout.root).toMatchObject({ kind: "leaf" });
      expect(nativeTabsOfLayout(layout)).toHaveLength(state === "closed" ? 1 : 2);
    });
  });
}

test("a later automatic episode queues behind an ambiguous earlier receipt", async () => {
  await fixture(async (storage, context) => {
    context.nativeAgents!.dispatchIntent = mock(async () => ({ outcome: "unknown" })) as never;
    const automatic = { ...args, tabReuse: "any-agent" };
    await launch(automatic, context);
    await nextEpisode(storage);
    context.nativeAgents!.promptReadiness = mock(async () => "busy") as never;
    expect(await launch({ ...automatic, requestId: "later-episode" }, context)).toMatchObject({
      status: "accepted",
      reused: true,
      queued: true,
    });
    expect((await storage.listPromptQueues("env")).flatMap((q) => q.messages)).toEqual([
      expect.objectContaining({ requestId: "later-episode" }),
    ]);
    expect(context.nativeAgents!.dispatchIntent).toHaveBeenCalledTimes(1);
  });
});

test("a thrown reused-tab dispatch retains episode ownership and its ambiguous receipt", async () => {
  await fixture(async (storage, context) => {
    await launch(args, context);
    await nextEpisode(storage);
    context.nativeAgents!.dispatchIntent = mock(async () => {
      throw new Error("acknowledgement lost");
    }) as never;
    const automatic = { ...args, tabReuse: "any-agent", requestId: "uncertain-reuse" };
    await expect(launch(automatic, context)).rejects.toThrow("acknowledgement lost");
    expect(
      (await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt,
    ).toBeTruthy();
    expect((await storage.listPromptQueues("env")).flatMap((q) => q.jobReceipts ?? [])).toEqual([
      expect.objectContaining({ requestId: "uncertain-reuse", status: "unknown" }),
    ]);
    expect(await launch({ ...automatic, requestId: "retry" }, context)).toMatchObject({
      status: "skipped",
    });
    expect(context.nativeAgents!.dispatchIntent).toHaveBeenCalledTimes(1);
  });
});
